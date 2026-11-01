#!/usr/bin/env node
/**
 * server.test.mjs — Node 에서 모의 GAS(dev/gas-mock.js) 위에 gas/*.gs 를 올려 서버 API 시나리오를 시험한다. SPEC.md §10.
 * 외부 의존성 없음. 실패가 하나라도 있으면 종료 코드 1.
 *
 *   node dev/test/server.test.mjs           요약 출력
 *   VERBOSE=1 node dev/test/server.test.mjs 서버 로그까지 출력
 *   node dev/test/server.test.mjs --paste   gas/ 대신 붙여넣기 묶음 paste/(Code.gs·FormsData.html …)을 올려 같은 시나리오 (SPEC §12)
 *
 * GAS 처럼 서버 호출마다 새 실행(전역 다시 평가)으로 돌린다 — 전역 변수 캐시에 기대는 버그를 잡기 위해.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { GAS, MOCK_PATH, gsFiles, htmlFileNames, topLevelNames, mockGlobalNames, serverFactorySource, mapBundleLine, syntaxCheck } from '../build-preview.mjs';

const VERBOSE = !!process.env.VERBOSE;
const PASTE_MODE = process.argv.includes('--paste');
const SRC_DIR = PASTE_MODE ? path.join(GAS, '..', 'paste') : GAS;
const T0 = Date.now();
if (PASTE_MODE) {
  if (!fs.existsSync(path.join(SRC_DIR, 'Code.gs'))) {
    console.error('paste/Code.gs 가 없습니다. 먼저 `node dev/build-paste.mjs` 를 실행하세요.');
    process.exit(1);
  }
  const code = fs.readFileSync(path.join(SRC_DIR, 'Code.gs'), 'utf8');
  const stale = gsFiles().filter((f) => !code.includes(f.src.replace(/\r\n/g, '\n').replace(/\s+$/, ''))).map((f) => f.name);
  if (stale.length) console.log(`주의: paste/Code.gs 가 gas/ 와 다릅니다(${stale.join(', ')}) — \`node dev/build-paste.mjs\` 로 다시 만드세요.\n`);
}

/* ---------------- 모의 + 서버 올리기 ---------------- */

const logBuf = [];
function sinkLine(kind, args) {
  const s = args.map((a) => (typeof a === 'string' ? a : a && a.stack ? String(a.stack) : safeJson(a))).join(' ')
    .replace(/server-bundle\.js:(\d+)(?::\d+)?/g, (m, ln) => (lineMap ? mapBundleLine(lineMap, Number(ln), 0) || m : m));
  logBuf.push(`[${kind}] ${s}`);
  if (logBuf.length > 400) logBuf.shift();
  if (VERBOSE) console.log(`      ${kind}: ${s}`);
}
function safeJson(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }
const sink = {
  log: (...a) => sinkLine('log', a), info: (...a) => sinkLine('info', a),
  warn: (...a) => sinkLine('warn', a), error: (...a) => sinkLine('error', a), debug: (...a) => sinkLine('debug', a)
};

const mockSrc = fs.readFileSync(MOCK_PATH, 'utf8');
const files = gsFiles(SRC_DIR);
const formsHtml = fs.readFileSync(path.join(SRC_DIR, 'FormsData.html'), 'utf8');
const names = topLevelNames(files);
const { src: factorySrc, map: lineMap } = serverFactorySource(files, mockGlobalNames(mockSrc), names);
const BUNDLE_OFFSET = 1; // 'var __factory = (' 앞줄 없음 → 팩토리 첫 줄이 1행

const memStore = (() => {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, _m: m };
})();

const ctx = vm.createContext({ console: sink });
vm.runInContext(mockSrc, ctx, { filename: 'gas-mock.js' });
let bundleOk = true;
try {
  vm.runInContext('var __factory = (' + factorySrc + ');', ctx, { filename: 'server-bundle.js' });
} catch (e) {
  bundleOk = false;
  console.error('서버 번들을 올리지 못했습니다: ' + e.message);
  for (const err of syntaxCheck(files)) console.error(`  ${err.file}: ${err.message}`);
}

const mails = [];
function newMock(storage) {
  return ctx.createGasMock({
    storage, autoSave: false, formsHtml, htmlFiles: htmlFileNames(SRC_DIR), log: sink,
    onMail: (m) => mails.push(m)
  });
}
let mock = newMock(memStore);

function rewriteStack(e) {
  const s = String((e && e.stack) || e);
  return s.replace(/server-bundle\.js:(\d+)(?::\d+)?/g, (m, ln) => mapBundleLine(lineMap, Number(ln), BUNDLE_OFFSET - 1) || m);
}
function instance() {
  if (!bundleOk) throw new Error('서버 번들이 없습니다(문법 오류)');
  return ctx.__factory(mock.globals);
}
function exec(name, ...args) {
  const inst = instance();
  if (typeof inst[name] !== 'function') throw new Error(`서버 함수 ${name}() 이 없습니다`);
  try {
    return inst[name](...args);
  } catch (e) {
    const err = new Error(`${name}() 예외: ${e && e.message}\n${rewriteStack(e).split('\n').slice(1, 6).join('\n')}`);
    err.inner = e;
    throw err;
  }
}
/** api 호출 → 응답 객체 {ok, data|error, code}. 계약 위반(문자열 아님·모양 틀림)은 예외. */
function api(method, payload, token) {
  const raw = exec('api', method, JSON.stringify(payload === undefined ? {} : payload), token || '');
  if (typeof raw !== 'string') throw new Error(`api('${method}') 가 JSON 문자열이 아니라 ${typeof raw} 를 돌려줬습니다`);
  let res;
  try { res = JSON.parse(raw); } catch (e) { throw new Error(`api('${method}') 응답이 JSON 이 아닙니다: ${raw.slice(0, 120)}`); }
  if (!res || typeof res.ok !== 'boolean') throw new Error(`api('${method}') 응답에 ok 가 없습니다: ${raw.slice(0, 120)}`);
  if (!res.ok) {
    const CODES = ['AUTH', 'FORBIDDEN', 'NOTFOUND', 'INVALID', 'CONFLICT', 'SERVER'];
    if (!CODES.includes(res.code)) throw new Error(`api('${method}') 오류 code 가 계약 밖입니다: ${res.code} (${res.error})`);
    if (typeof res.error !== 'string' || !res.error) throw new Error(`api('${method}') 오류 문장이 없습니다`);
  }
  return res;
}
function ok(res, what) {
  if (!res.ok) throw new Error(`${what || ''} 실패 — ${res.code}: ${res.error}`.trim());
  return res.data;
}
function denied(res, codes, what) {
  if (res.ok) throw new Error(`${what || '요청'}이 거부돼야 하는데 성공했습니다`);
  if (codes && !codes.includes(res.code)) throw new Error(`${what || '요청'} 거부 code 가 ${res.code} 입니다(기대: ${codes.join('|')}) — ${res.error}`);
  return res;
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: 기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`); }

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}
function deepEq(a, b) { return JSON.stringify(canon(a)) === JSON.stringify(canon(b)); }
function firstDiff(a, b, p = '') {
  if (deepEq(a, b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], p + '.' + k);
      if (d) return d;
    }
  }
  const show = (v) => { const s = JSON.stringify(v); return s && s.length > 60 ? s.slice(0, 60) + '…' : s; };
  return `${p || '(값)'}: ${show(a)} ≠ ${show(b)}`;
}

/* ---------------- 날짜 ---------------- */
function kst(d = new Date()) { return new Date(d.getTime() + 9 * 3600 * 1000); }
function ymd(d) { return d.toISOString().slice(0, 10); }
const TODAY = ymd(kst());
function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
const YYMMDD = TODAY.slice(2).replace(/-/g, '');

/* ---------------- 단계 실행기 ---------------- */
const results = [];
async function step(name, fn, { optional = false } = {}) {
  logBuf.length = 0;
  const t = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, optional });
    console.log(`  [통과] ${name}${note ? ' — ' + note : ''}  (${Date.now() - t}ms)`);
  } catch (e) {
    results.push({ name, ok: false, optional, error: e.message });
    console.log(`  [${optional ? '참고' : '실패'}] ${name} — ${e.message.split('\n')[0]}`);
    const rest = e.message.split('\n').slice(1).filter(Boolean);
    for (const l of rest) console.log('         ' + l.trim());
    if (!VERBOSE) {
      const tail = logBuf.filter((l) => /^\[(warn|error)\]/.test(l)).slice(-6);
      for (const l of tail) console.log('         서버 ' + l.slice(0, 300));
    }
  }
}
function need(v, what) {
  if (v === undefined || v === null || v === '') throw new Error(`앞 단계 실패로 건너뜀(${what} 없음)`);
  return v;
}

/* ---------------- 시나리오 ---------------- */
const S = {};               // 단계 사이에 넘기는 값
const PW = 'pw1234';
const SITE1 = 'S001', SITE2 = 'S002', SITE3 = 'S003';
const MAIL1 = 's001.manager@site.test', MAIL2 = 's002.manager@site.test', HQMAIL = 'hq.safety@hds.test';
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

console.log(`HDS 안전장부 서버 시험${PASTE_MODE ? ' (붙여넣기 묶음 paste/)' : ''} — 서버 파일 ${files.length}개(${files.map((f) => f.name).join(', ')}), 함수 ${names.functions.join(', ')}`);
console.log(`오늘(KST) ${TODAY}\n`);

await step('서버 번들 올리기(문법·전역 이름)', () => {
  assert(bundleOk, '서버 .gs 를 이어 붙인 번들에 문법 오류가 있습니다');
  const inst = instance();
  for (const n of ['api', 'setup', 'cronDaily', 'cronWeekly', 'doGet', 'include']) assert(typeof inst[n] === 'function', `전역 함수 ${n}() 이 없습니다`);
  return `${files.length}개 파일`;
});

await step('GAS 처럼 파일마다 따로 올리기(역순·한 전역 범위) — 파일 순서 무관', () => {
  // 실제 GAS 는 .gs 파일을 하나씩 같은 전역에 실행한다. 최상위에서 다른 파일 객체를 바로 부르면 순서에 따라 깨진다(SPEC §12).
  const c2 = vm.createContext({ console: sink });
  vm.runInContext(mockSrc, c2, { filename: 'gas-mock.js' });
  const m2 = c2.createGasMock({ autoSave: false, formsHtml, htmlFiles: htmlFileNames(SRC_DIR), log: sink });
  Object.assign(c2, m2.globals);
  for (const f of [...files].reverse()) {
    try { vm.runInContext(f.src, c2, { filename: f.name }); } catch (e) { throw new Error(`${f.name} 를 단독(역순)으로 올리다 오류: ${e.message}`); }
  }
  for (const n of ['api', 'setup', 'cronDaily', 'cronWeekly', 'doGet', 'include']) assert(typeof c2[n] === 'function', `전역 함수 ${n}() 이 없습니다`);
  c2.setup({ adminPassword: 'iso-pw-1', triggers: false });
  const r = JSON.parse(c2.api('auth.login', JSON.stringify({ id: 'admin', password: 'iso-pw-1' }), ''));
  assert(r.ok && r.data && r.data.token, '역순으로 올린 서버에서 로그인 실패: ' + (r.error || ''));
  const b = JSON.parse(c2.api('boot', '{}', r.data.token));
  assert(b.ok, '역순으로 올린 서버에서 boot 실패: ' + (b.error || ''));
  return `${files.length}개 파일 역순`;
});

await step('setup 전 auth.status → ready:false', () => {
  const d = ok(api('auth.status', {}), 'auth.status');
  eq(d.ready, false, 'ready');
  assert(d.appName, 'appName 없음');
});

await step('setup({adminPassword}) — DB·폴더·관리자 생성', () => {
  exec('setup', { adminPassword: PW });
  const props = mock.globals.PropertiesService.getScriptProperties();
  assert(props.getProperty('DB_ID'), 'DB_ID 속성이 없습니다');
  assert(props.getProperty('FOLDER_ID'), 'FOLDER_ID 속성이 없습니다');
  const sheets = mock.sheetNames();
  for (const t of ['sites', 'people', 'users', 'sessions', 'records', 'acts', 'requests', 'reads', 'files', 'log', 'kv']) assert(sheets.includes(t), `시트 ${t} 없음`);
  const users = mock.table('users');
  const admin = users.find((u) => String(u.id).toLowerCase() === 'admin');
  assert(admin, 'admin 사용자 없음');
  assert(!JSON.stringify(admin).includes(PW), '비밀번호가 평문으로 저장됐습니다');
  exec('setup', { adminPassword: 'other999' }); // 두 번 실행해도 안전(idempotent)
  eq(mock.table('users').length, users.length, '두 번째 setup 뒤 사용자 수');
  return `시트 ${sheets.length}개`;
});

await step('doGet — BOOT 템플릿(ready·url)', () => {
  mock.lastTemplate = null;
  exec('doGet', { parameter: {}, parameters: {} });
  const t = mock.lastTemplate;
  assert(t && typeof t.vars.BOOT === 'string', 'Index 템플릿에 BOOT 문자열이 없습니다');
  const b = JSON.parse(t.vars.BOOT);
  eq(b.ready, true, 'BOOT.ready');
  assert(/^https:\/\//.test(b.url), 'BOOT.url');
});

await step('auth.login 틀린 비밀번호 → AUTH', () => { denied(api('auth.login', { id: 'admin', password: 'wrong-pw' }), ['AUTH'], '틀린 비밀번호 로그인'); });

await step('auth.login (admin)', () => {
  const d = ok(api('auth.login', { id: 'admin', password: PW }), 'login');
  assert(d.token && d.token.length >= 32, '세션 토큰이 짧습니다');
  eq(d.me.kind, 'hq', 'me.kind'); eq(d.me.role, 'admin', 'me.role');
  S.hq = d.token;
});

await step('토큰 없이 boot → AUTH', () => { denied(api('boot', {}, ''), ['AUTH'], '토큰 없는 boot'); });

await step('settings.save (본사 메일 수신자)', () => {
  const inst = instance();
  const base = JSON.parse(JSON.stringify(inst.DEFAULT_SETTINGS || {}));
  base.mail = Object.assign({}, base.mail, { enabled: true, onRequest: true, onReturn: true, hqEmails: [HQMAIL] });
  const d = ok(api('settings.save', { settings: base }, need(S.hq, '본사 토큰')), 'settings.save');
  assert(d.settings && d.settings.mail && d.settings.mail.hqEmails.includes(HQMAIL), '저장된 settings 에 hqEmails 가 없습니다');
});

await step('sites.save ×2 (토큰 자동 발급)', () => {
  const mk = (id, name, mail) => ({
    id, name, type: '오피스', region: '서울', client: id === SITE1 ? '한빛자산운용' : '세림리테일', address: '서울특별시 강남구 테헤란로 ' + id.slice(-1) + '0',
    tags: ['보안'], shifts: ['주간', '야간'], forms: [], openDate: '2025-03-01', status: '운영', hec: id === SITE1, headcount: 24,
    managerName: id === SITE1 ? '박현장' : '이소장', managerEmail: mail, managerPhone: '010-1234-567' + id.slice(-1), memo: ''
  });
  const a = ok(api('sites.save', { site: mk(SITE1, '강남오피스타워', MAIL1) }, need(S.hq, '본사 토큰')), 'sites.save S001');
  const b = ok(api('sites.save', { site: mk(SITE2, '판교테크센터', MAIL2) }, S.hq), 'sites.save S002');
  assert(a.site && a.site.token && b.site.token, '사업장 토큰이 발급되지 않았습니다');
  assert(a.site.token !== b.site.token, '두 사업장 토큰이 같습니다');
  S.tok1 = a.site.token; S.tok2 = b.site.token;
  return `S001 토큰 ${S.tok1.length}자`;
});

await step('people.bulk (S001 인원 3명, 중복 1명 건너뜀)', () => {
  const rows = [
    { name: '김경비', job: '보안', role: '근무자', phone4: '0123' },
    { name: '이미화', job: '미화', role: '근무자', phone4: '4567' },
    { name: '박현장', job: '보안', role: '소장', phone4: '8901' }
  ];
  const d = ok(api('people.bulk', { site: SITE1, rows }, need(S.hq, '본사 토큰')), 'people.bulk');
  eq(d.added, 3, 'added');
  const d2 = ok(api('people.bulk', { site: SITE1, rows: [rows[0]] }, S.hq), 'people.bulk 중복');
  eq(d2.added, 0, '중복 added');
  const people = mock.table('people').filter((p) => p.site === SITE1);
  eq(people.length, 3, 'people 행 수');
  const p0 = people.find((p) => p.name === '김경비');
  eq(String(p0.phone4), '0123', 'phone4 앞자리 0 유지(문자열 저장)');
});

await step('auth.siteLogin (사업장 링크 토큰 + 작성자 이름)', () => {
  denied(api('auth.siteLogin', { siteToken: 'WRONGTOKEN123456', name: '김현장' }), ['AUTH'], '틀린 사업장 토큰');
  const d = ok(api('auth.siteLogin', { siteToken: need(S.tok1, '사업장 토큰'), name: '김현장' }), 'siteLogin');
  eq(d.me.kind, 'site', 'me.kind'); eq(d.me.site, SITE1, 'me.site'); eq(d.me.name, '김현장', 'me.name');
  S.site1 = d.token;
});

await step('사업장 boot — 자기 사업장만, 다른 사업장 토큰·사용자 해시 노출 없음', () => {
  const d = ok(api('boot', { days: 400 }, need(S.site1, '사업장 세션')), 'boot(site)');
  eq(d.me.site, SITE1, 'me.site');
  const json = JSON.stringify(d);
  assert(!json.includes(need(S.tok2, 'S002 토큰')), '사업장 boot 에 다른 사업장 토큰이 보입니다');
  assert(!/pwHash|"salt"/.test(json), '사업장 boot 에 비밀번호 해시가 보입니다');
  const idx = Array.isArray(d.index) ? d.index : Object.values(d.index || {});
  assert(idx.every((r) => r.site === SITE1), 'index 에 다른 사업장 기록이 있습니다');
});

const F07_DATA = () => ({
  checkTime: '08:30', attend: 12, healthChecked: 12, weather: '맑음', tempAir: 14,
  tbmTime: '07:50', tbmTarget: 12, nightSolo: 0, accidentCount: 0, nearMissCount: 0
});

await step('(사업장) records.save F07 임시저장 — id 발급·작성중', () => {
  const rec = { form: 'F07', site: SITE1, date: TODAY, period: TODAY, shift: '주간', author: '김현장', data: F07_DATA() };
  const d = ok(api('records.save', { record: rec }, need(S.site1, '사업장 세션')), 'records.save');
  const r = d.record;
  assert(r && r.id, 'record.id 없음');
  assert(new RegExp(`^ID-${SITE1}-${YYMMDD}-\\d{2}$`).test(r.id), `ID 규칙(ID-S001-${YYMMDD}-NN)과 다릅니다: ${r.id}`);
  eq(r.status, '작성중', 'status');
  eq(r.site, SITE1, 'site');
  S.rec = r;
  return r.id;
});

await step('(사업장) records.submit — 조치 후보 1건 포함', () => {
  const r = need(S.rec, '임시저장 기록');
  const data = Object.assign(F07_DATA(), { sec_items: { D01: { r: '양호' }, D02: { r: '불량', note: '2층 소화기 압력 저하' } } });
  const facts = { v: { attend: 12, healthChecked: 12, weather: '맑음', accidentCount: 0, nearMissCount: 0 }, t: {}, k: { sec_items: { D01: '양호', D02: '불량' } }, sm: [12, 0, 0] };
  const cand = { key: `${r.id}#sec_items#D02`, srcItem: 'D02', title: '소화기 압력 저하', detail: '2층 소화기 압력 저하', level: '높음', due: addDays(TODAY, 3), owner: '김현장', photo: null };
  const d = ok(api('records.submit', { record: Object.assign({}, r, { data, facts }), acts: [cand] }, S.site1), 'records.submit');
  eq(d.record.status, '제출', 'status');
  eq(Number(d.record.rev), 1, 'rev');
  assert(d.record.submittedAt, 'submittedAt 없음');
  assert(Array.isArray(d.acts) && d.acts.length === 1, `조치 1건이 생겨야 합니다(실제 ${d.acts && d.acts.length})`);
  const a = d.acts[0];
  assert(new RegExp(`^ACT-${SITE1}-\\d{4}-\\d{3}$`).test(a.id), `조치 ID 규칙(ACT-S001-YYMM-NNN)과 다릅니다: ${a.id}`);
  eq(a.status, '등록', '조치 status');
  eq(a.srcId, r.id, '조치 srcId');
  S.rec = d.record; S.act = a; S.cand = cand;
  return `${d.record.id} · ${a.id}`;
});

await step('(본사) boot — 제출 기록·조치가 보임, 사용자 해시 제외', () => {
  const d = ok(api('boot', { days: 400 }, need(S.hq, '본사 토큰')), 'boot(hq)');
  const idx = Array.isArray(d.index) ? d.index : Object.values(d.index || {});
  const row = idx.find((x) => x.id === need(S.rec, '기록').id);
  assert(row, '본사 index 에 제출 기록이 없습니다');
  eq(row.status, '제출', 'index status');
  assert(!('data' in row), 'indexRow 에 data 가 들어 있습니다(계약: data 제외)');
  const acts = Array.isArray(d.acts) ? d.acts : Object.values(d.acts || {});
  assert(acts.some((a) => a.id === S.act.id), '본사 boot 에 조치가 없습니다');
  assert(Array.isArray(d.users) && d.users.length >= 1, 'admin boot 에 users 없음');
  assert(!/pwHash|"salt"/.test(JSON.stringify(d.users)), 'users 에 비밀번호 해시가 들어 있습니다');
  assert(d.urls && /docs\.google\.com\/spreadsheets/.test(d.urls.sheet || ''), 'urls.sheet 없음');
});

await step('(본사) records.review 반려 — 사유·사업장 메일', () => {
  const before = mails.length;
  denied(api('records.review', { id: need(S.rec, '기록').id, decision: '반려', note: '' }, S.hq), ['INVALID'], '사유 없는 반려');
  const d = ok(api('records.review', { id: S.rec.id, decision: '반려', note: '2번 항목 사진을 붙여 다시 제출해 주세요' }, S.hq), 'review 반려');
  eq(d.record.status, '반려', 'status');
  assert(String(d.record.returnNote || '').includes('사진'), 'returnNote 없음');
  const m = mails.slice(before).find((x) => x.to.includes(MAIL1));
  assert(m, `반려 메일이 사업장 담당자(${MAIL1})에게 가지 않았습니다`);
  const body = String(m.htmlBody || m.body || '');
  assert(body.includes('s=') && body.includes('v=rec%2F' + encodeURIComponent(S.rec.id)), '반려 메일 링크가 사업장 링크 + 기록 화면(?s=…&v=rec/ID)이 아닙니다');
  S.rec = d.record;
  return `메일 "${m.subject}"`;
});

await step('(사업장) 고쳐 다시 제출 — rev 2, 조치 중복 없음', () => {
  const r = need(S.rec, '반려 기록');
  const full = ok(api('records.get', { id: r.id }, S.site1), 'records.get');
  const data = Object.assign({}, full.data, { handoverNote: '소화기 교체 요청함', sec_items: { D01: { r: '양호' }, D02: { r: '불량', note: '2층 소화기 압력 저하', photo: 'FILE-TEST' } } });
  const d = ok(api('records.submit', { record: Object.assign({}, full, { data }), acts: [need(S.cand, '조치 후보')] }, S.site1), 'records.submit(재제출)');
  eq(d.record.status, '제출', 'status');
  eq(Number(d.record.rev), 2, 'rev');
  const acts = mock.table('acts').filter((a) => a.key === S.cand.key && String(a.deleted) !== 'true');
  eq(acts.length, 1, '같은 key 조치 수');
  S.rec = d.record;
});

await step('(사업장) 제출된 기록 임시저장 → 거부(수정 제출만)', () => {
  const r = need(S.rec, '기록');
  const res = denied(api('records.save', { record: { id: r.id, data: Object.assign({}, r.data || {}, { workerVoice: '몰래 고침' }) } }, S.site1), ['CONFLICT'], '제출 기록 임시저장');
  assert(/수정 제출/.test(res.error), '안내 문장에 [수정 제출]이 없습니다: ' + res.error);
});

await step('(본사) records.review 확인', () => {
  const d = ok(api('records.review', { id: need(S.rec, '기록').id, decision: '확인', note: '' }, S.hq), 'review 확인');
  eq(d.record.status, '확인', 'status');
  assert(d.record.confirmedAt, 'confirmedAt 없음');
  assert(d.record.confirmedBy, 'confirmedBy 없음');
  S.rec = d.record;
});

await step('(사업장) 확인된 기록 수정 시도 → 거부', () => {
  const r = need(S.rec, '확인 기록');
  const full = ok(api('records.get', { id: r.id }, S.site1), 'records.get');
  const changed = Object.assign({}, full, { data: Object.assign({}, full.data, { attend: 99 }) });
  denied(api('records.save', { record: changed }, S.site1), ['CONFLICT', 'FORBIDDEN', 'INVALID'], '확인 기록 임시저장');
  denied(api('records.submit', { record: changed, acts: [] }, S.site1), ['CONFLICT', 'FORBIDDEN', 'INVALID'], '확인 기록 재제출');
  const after = ok(api('records.get', { id: r.id }, S.hq), 'records.get(본사)');
  eq(Number(after.data.attend), 12, '잠긴 기록의 attend');
});

await step('acts.transition 조치중 → 완료 → (본사) 확인', () => {
  const a = need(S.act, '조치');
  const d1 = ok(api('acts.transition', { id: a.id, to: '조치중', note: '부품 주문' }, S.site1), '조치중');
  eq(d1.act.status, '조치중', 'status');
  const d2 = ok(api('acts.transition', { id: a.id, to: '완료', note: '소화기 교체 완료', noPhotoReason: '카메라 고장' }, S.site1), '완료');
  eq(d2.act.status, '완료', 'status');
  assert(JSON.stringify(d2.act.history).includes('사진 없음 사유: 카메라 고장'), 'noPhotoReason 이 이력 메모에 남지 않았습니다');
  assert(d2.act.doneAt, 'doneAt 없음');
  const d3 = ok(api('acts.transition', { id: a.id, to: '확인', note: '' }, S.hq), '확인');
  eq(d3.act.status, '확인', 'status');
  assert(d3.act.confirmedBy, 'confirmedBy 없음');
  assert(Array.isArray(d3.act.history) && d3.act.history.length >= 3, `history 가 3건 이상이어야 합니다(실제 ${d3.act.history && d3.act.history.length})`);
});

await step('(본사) requests.save — 대상 사업장 담당자 메일', () => {
  const before = mails.length;
  const req = { kind: 'form', title: '11월 위험성평가 제출 요청', message: '정기 위험성평가 결과를 마감일까지 올려 주세요.', forms: ['F01'], sites: [SITE1], due: addDays(TODAY, 7), ackRequired: true };
  const d = ok(api('requests.save', { request: req }, need(S.hq, '본사 토큰')), 'requests.save');
  const r = d.request;
  assert(new RegExp(`^REQ-${YYMMDD}-\\d{2}$`).test(r.id), `요청 ID 규칙(REQ-${YYMMDD}-NN)과 다릅니다: ${r.id}`);
  eq(r.status, '진행', 'status');
  const m = mails.slice(before).find((x) => x.to.includes(MAIL1));
  assert(m, `새 요청 메일이 ${MAIL1} 로 가지 않았습니다`);
  assert(!mails.slice(before).some((x) => x.to.includes(MAIL2)), '대상이 아닌 S002 에도 메일이 갔습니다');
  assert(/s=/.test(m.htmlBody || m.body), '메일 본문에 사업장 링크(?s=)가 없습니다');
  S.req = r;
  return `메일 "${m.subject}"`;
});

await step('(본사) requests.remind — 미제출 사업장 독촉', () => {
  const before = mails.length;
  const d = ok(api('requests.remind', { id: need(S.req, '요청').id }, S.hq), 'requests.remind');
  assert(typeof d.sent === 'number' && typeof d.skipped === 'number', 'sent/skipped 숫자가 아닙니다');
  assert(d.sent >= 1, `독촉 메일이 1건 이상이어야 합니다(sent ${d.sent}, skipped ${d.skipped})`);
  assert(mails.slice(before).some((x) => x.to.includes(MAIL1)), '독촉 메일 포착 안 됨');
  return `sent ${d.sent}, skipped ${d.skipped}`;
});

await step('(사업장) reads.mark — 요청 열람 기록', () => {
  const d = ok(api('reads.mark', { refId: need(S.req, '요청').id }, need(S.site1, '사업장 세션')), 'reads.mark');
  assert(d.read, 'read 없음');
  eq(d.read.refId, S.req.id, 'read.refId');
  eq(d.read.site, SITE1, 'read.site');
  ok(api('reads.mark', { refId: S.req.id }, S.site1), 'reads.mark 두 번째');
  const rows = mock.table('reads').filter((x) => x.refId === S.req.id && x.site === SITE1);
  assert(rows.length >= 1, 'reads 행 없음');
});

await step('(사업장) files.put / files.get 왕복', () => {
  const dataUrl = 'data:image/png;base64,' + PNG_1PX;
  const d = ok(api('files.put', { dataUrl, name: '소화기.png', kind: 'photo', recordId: need(S.rec, '기록').id }, need(S.site1, '사업장 세션')), 'files.put');
  assert(d.file && /^FILE-/.test(d.file.id), `파일 ID 규칙(FILE-…)과 다릅니다: ${d.file && d.file.id}`);
  eq(d.file.site, SITE1, 'file.site');
  const g = ok(api('files.get', { id: d.file.id }, S.site1), 'files.get');
  eq(g.mime, 'image/png', 'mime');
  eq(String(g.dataUrl).split(',')[1], PNG_1PX, 'dataUrl 내용');
  S.file = d.file;
});

await step('다른 사업장 접근 거부(S002 세션 → S001 기록·파일·조치)', () => {
  const d = ok(api('auth.siteLogin', { siteToken: need(S.tok2, 'S002 토큰'), name: '최판교' }), 'siteLogin S002');
  S.site2 = d.token;
  const notes = [];
  const r1 = denied(api('records.get', { id: need(S.rec, '기록').id }, S.site2), ['FORBIDDEN', 'NOTFOUND'], '다른 사업장 기록 읽기');
  notes.push('records.get ' + r1.code);
  denied(api('files.get', { id: need(S.file, '파일').id }, S.site2), ['FORBIDDEN', 'NOTFOUND'], '다른 사업장 파일 읽기');
  denied(api('acts.transition', { id: need(S.act, '조치').id, to: '조치중', note: 'x' }, S.site2), ['FORBIDDEN', 'NOTFOUND', 'CONFLICT'], '다른 사업장 조치 전환');
  denied(api('people.bulk', { site: SITE1, rows: [{ name: '침입자', job: '', role: '', phone4: '' }] }, S.site2), ['FORBIDDEN'], '다른 사업장 인원 등록');
  const w = api('records.save', { record: { form: 'F07', site: SITE1, date: TODAY, period: TODAY, data: {} } }, S.site2);
  if (w.ok) eq(w.data.record.site, SITE2, '다른 사업장 이름으로 저장 시 사업장');
  else denied(w, ['FORBIDDEN', 'INVALID'], '다른 사업장 기록 저장');
  denied(api('sites.save', { site: { id: 'S009', name: 'x' } }, S.site2), ['FORBIDDEN'], '사업장이 사업장 등록');
  return notes.join(', ');
});

await step('열람(viewer) 쓰기 거부, 읽기 허용', () => {
  const u = ok(api('users.save', { user: { id: 'viewer1', name: '열람담당', role: 'viewer', email: 'viewer@hds.test', active: true }, password: 'view1234a' }, need(S.hq, '본사 토큰')), 'users.save');
  assert(!/pwHash|"salt"/.test(JSON.stringify(u)), 'users.save 응답에 해시가 있습니다');
  const d = ok(api('auth.login', { id: 'viewer1', password: 'view1234a' }), 'viewer 로그인');
  S.viewer = d.token;
  ok(api('boot', {}, S.viewer), 'viewer boot');
  denied(api('records.save', { record: { form: 'F07', site: SITE1, date: TODAY, period: TODAY, data: {} } }, S.viewer), ['FORBIDDEN'], 'viewer 기록 저장');
  denied(api('requests.save', { request: { kind: 'notice', title: 'x', sites: ['*'] } }, S.viewer), ['FORBIDDEN'], 'viewer 요청 저장');
  denied(api('records.review', { id: need(S.rec, '기록').id, decision: '확인취소', note: '' }, S.viewer), ['FORBIDDEN'], 'viewer 검토');
  denied(api('sites.save', { site: { id: 'S010', name: 'x' } }, S.viewer), ['FORBIDDEN'], 'viewer 사업장 저장');
});

await step('admin.importBulk — id 유지 이관', () => {
  const rec = {
    id: `ID-${SITE3}-261020-01`, form: 'F07', formVersion: 'v2.0', site: SITE3, date: '2026-10-20', period: '2026-10-20', shift: '주간',
    status: '확인', stageDone: [], author: '정이관', rev: 1, createdBy: 'site', requestId: '', createdAt: '2026-10-20T08:40:00',
    updatedAt: '2026-10-20T09:10:00', submittedAt: '2026-10-20T08:55:00', confirmedAt: '2026-10-20T09:10:00', confirmedBy: 'admin',
    data: Object.assign(F07_DATA(), { sec_items: { D01: { r: '양호' } } }), facts: { v: { attend: 12 }, t: {}, k: {}, sm: [] }
  };
  const act = { id: `ACT-${SITE3}-2610-001`, key: rec.id + '#sec_items#D05', site: SITE3, srcId: rec.id, srcForm: 'F07', srcItem: 'D05', title: '비상구 적치물', detail: '', level: '보통', type: '', due: '2026-10-25', owner: '정이관', status: '조치중', history: [], createdAt: '2026-10-20T08:55:00', updatedAt: '2026-10-21T10:00:00' };
  const d = ok(api('admin.importBulk', {
    sites: [{ id: SITE3, name: '여의도파이낸스센터', type: '오피스', region: '서울', client: '대한증권', status: '운영', managerEmail: 's003@site.test', shifts: ['주간'], forms: [], tags: [] }],
    people: [{ id: 'P-imp00001', site: SITE3, name: '정이관', job: '보안', role: '소장', phone4: '0007', active: true }],
    records: [rec], acts: [act], requests: [], reads: []
  }, need(S.hq, '본사 토큰')), 'admin.importBulk');
  assert(d.counts, 'counts 없음');
  const got = ok(api('records.get', { id: rec.id }, S.hq), 'records.get(이관 기록)');
  eq(got.status, '확인', 'status');
  assert(deepEq(got.data, rec.data), '이관 기록 data 가 다릅니다: ' + firstDiff(got.data, rec.data));
  const boot = ok(api('boot', {}, S.hq), 'boot');
  assert(boot.sites.some((s) => s.id === SITE3), 'boot 에 이관 사업장 없음');
  const s3 = boot.sites.find((s) => s.id === SITE3);
  assert(s3.token, '이관 사업장에 토큰이 발급되지 않았습니다');
  return JSON.stringify(d.counts);
});

await step('admin.log — 최신순, 메일 기록 포함', () => {
  const d = ok(api('admin.log', { limit: 200 }, need(S.hq, '본사 토큰')), 'admin.log');
  assert(Array.isArray(d) && d.length > 5, `기록이 너무 적습니다(${d && d.length})`);
  for (let i = 1; i < d.length; i++) assert(String(d[i - 1].at) >= String(d[i].at), '최신순이 아닙니다');
  const m = ok(api('admin.log', { kind: 'mail', limit: 50 }, S.hq), 'admin.log mail');
  assert(Array.isArray(m) && m.length >= 1 && m.every((x) => x.kind === 'mail'), `kind 'mail' 기록이 없습니다`);
  denied(api('admin.log', {}, need(S.site1, '사업장 세션')), ['FORBIDDEN'], '사업장 admin.log');
  return `${d.length}건, 메일 ${m.length}건`;
});

function bigText(n, seed) {
  const words = ['소화기', '비상구', '적치물', '안전모', '점검', '양호', '주의', '불량', '조치', '완료', 'TBM', '근무자', '순찰', '폭염', '휴식'];
  let s = '';
  let i = seed;
  while (s.length < n) { s += words[i % words.length] + ' ' + (i % 97) + '번 '; i = (i * 7 + 3) % 1009; }
  return s.slice(0, n);
}

await step('50,000자 넘는 data 저장·복원(청크)', () => {
  const data = Object.assign(F07_DATA(), { clientNotice: bigText(48000, 1), handoverNote: bigText(47000, 2), workerVoice: bigText(30000, 3) });
  const len = JSON.stringify(data).length;
  const d = ok(api('records.save', { record: { form: 'F07', site: SITE2, date: TODAY, period: TODAY, shift: '야간', author: '본사대리', data } }, need(S.hq, '본사 토큰')), 'records.save(큰 data)');
  const id = d.record.id;
  assert(/H\d+$/.test(id), `본사 대리 입력 ID 는 H1, H2… 로 끝나야 합니다: ${id}`);
  const got = ok(api('records.get', { id }, S.hq), 'records.get');
  assert(deepEq(got.data, data), '복원한 data 가 다릅니다: ' + firstDiff(got.data, data));
  const row = mock.table('records').find((r) => r.id === id);
  assert(row, '시트에 행이 없습니다');
  assert(String(row.data).length <= 50000 && String(row.data_2 || '').length > 0, 'data 가 data_2 … 로 나뉘어 저장되지 않았습니다');
  return `${len.toLocaleString()}자 → data, data_2${row.data_3 ? ', data_3' : ''}${row.data_4 ? ', data_4…' : ''}`;
});

await step('36만 자 넘는 data → 드라이브 저장(@drive:)·복원', () => {
  const data = Object.assign(F07_DATA(), { clientNotice: bigText(140000, 4), handoverNote: bigText(140000, 5), workerVoice: bigText(120000, 6) });
  const d = ok(api('records.save', { record: { form: 'F07', site: SITE2, date: addDays(TODAY, -1), period: addDays(TODAY, -1), shift: '주간', author: '본사대리', data } }, need(S.hq, '본사 토큰')), 'records.save(아주 큰 data)');
  const got = ok(api('records.get', { id: d.record.id }, S.hq), 'records.get');
  assert(deepEq(got.data, data), '복원한 data 가 다릅니다: ' + firstDiff(got.data, data));
  const row = mock.table('records').find((r) => r.id === d.record.id);
  assert(/^@drive:/.test(String(row.data)), `data 열이 @drive:<fileId> 가 아닙니다: ${String(row.data).slice(0, 30)}`);
});

await step('export.sheet (기록 → 새 구글 시트 링크)', () => {
  const d = ok(api('export.sheet', { kind: 'records' }, need(S.hq, '본사 토큰')), 'export.sheet');
  assert(/^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(d.url), `url 이 구글 시트 링크가 아닙니다: ${d.url}`);
  denied(api('export.sheet', { kind: 'records' }, need(S.site1, '사업장 세션')), ['FORBIDDEN'], '사업장 export');
});

await step('export.xlsx ({name, base64})', () => {
  const d = ok(api('export.xlsx', { kind: 'acts' }, need(S.hq, '본사 토큰')), 'export.xlsx');
  assert(d.name && /\.xlsx$/.test(d.name), 'name 이 .xlsx 가 아닙니다');
  assert(d.base64 && d.base64.length > 100, 'base64 없음');
  const bytes = Buffer.from(d.base64, 'base64');
  assert(bytes[0] === 0x50 && bytes[1] === 0x4b, 'xlsx(zip) 서명 PK 가 아닙니다');
  assert(bytes.includes(Buffer.from('xl/workbook.xml')), 'xlsx 안에 xl/workbook.xml 이 없습니다');
  return `${d.name} · ${bytes.length}바이트`;
});

await step('cronDaily · cronWeekly 실행 오류 없음', () => {
  const before = mails.length;
  exec('cronDaily');
  const w1 = exec('cronWeekly');
  const mid = mails.length;
  const w2 = exec('cronWeekly'); // 같은 날 다시 불러도(google.script.run 으로도 부를 수 있음) 다시 보내지 않음
  eq(mails.length, mid, '같은 날 두 번째 주간 요약 메일 수');
  assert(!w1 || !w1.sent || (w2 && w2.sent === false), '두 번째 주간 요약이 보냄으로 표시됐습니다');
  return `메일 ${mails.length - before}건`;
});

await step('admin.installTriggers / admin.info', () => {
  const d = ok(api('admin.installTriggers', {}, need(S.hq, '본사 토큰')), 'installTriggers');
  const trig = mock.globals.ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction());
  assert(trig.includes('cronDaily') && trig.includes('cronWeekly'), `트리거가 없습니다: ${trig.join(',')}`);
  ok(api('admin.installTriggers', {}, S.hq), 'installTriggers 두 번째');
  eq(mock.globals.ScriptApp.getProjectTriggers().length, trig.length, '두 번 설치해도 트리거 수');
  const info = ok(api('admin.info', {}, S.hq), 'admin.info');
  assert(info.version, 'version 없음');
  return `트리거 ${trig.join(', ')}`;
});

await step('영속 왕복 — 저장 후 새 모의에서 로그인·조회', () => {
  assert(mock.save(), '저장 실패');
  const size = String(memStore.getItem('hds-preview-db') || '').length;
  const old = mock;
  mock = newMock(memStore);
  try {
    const d = ok(api('auth.login', { id: 'admin', password: PW }), '다시 로그인');
    const got = ok(api('records.get', { id: need(S.rec, '기록').id }, d.token), 'records.get');
    eq(got.status, '확인', 'status');
    ok(api('boot', {}, need(S.site1, '사업장 세션')), '기존 사업장 세션으로 boot');
  } finally {
    mock = old;
  }
  return `저장 ${size.toLocaleString()}자`;
});

await step('auth.logout — 세션 무효화', () => {
  ok(api('auth.logout', {}, need(S.viewer, 'viewer 세션')), 'logout');
  denied(api('boot', {}, S.viewer), ['AUTH'], '로그아웃한 세션 boot');
});

/* ---------------- 요약 ---------------- */
const failed = results.filter((r) => !r.ok && !r.optional);
const optFailed = results.filter((r) => !r.ok && r.optional);
const passed = results.filter((r) => r.ok);
console.log(`\n결과: 통과 ${passed.length} · 실패 ${failed.length}${optFailed.length ? ` · 참고 실패 ${optFailed.length}` : ''} / ${results.length}단계  (${((Date.now() - T0) / 1000).toFixed(1)}초, 메일 ${mails.length}건)`);
if (mock.warnings.length) {
  console.log(`모의 GAS 경고 ${mock.warnings.length}종(실제 GAS 에서 문제 될 수 있음):`);
  for (const w of mock.warnings.slice(0, 15)) console.log(`  - ${w.msg}${w.count > 1 ? ` (×${w.count})` : ''}`);
}
if (failed.length) {
  console.log('실패한 단계:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.error.split('\n')[0]}`);
}
process.exit(failed.length ? 1 : 0);
