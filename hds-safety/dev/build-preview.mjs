#!/usr/bin/env node
/**
 * build-preview.mjs — gas/ → dist/preview.html (모의 GAS 서버를 품은 단일 HTML). SPEC.md §3·§10.
 *
 *   node dev/build-preview.mjs            빌드
 *   node dev/build-preview.mjs --quiet    요약만
 *
 * 하는 일
 *  1) gas/Index.html 의 <?!= include('X'); ?> 를 gas/X.html 내용으로, <?!= BOOT ?> 를 기본 BOOT JSON 으로 바꾼다.
 *  2) Pretendard CDN <link> 를 빼고 ../fonts/PretendardVariable.woff2 를 base64 @font-face 로 넣는다(있으면).
 *     vendor/Paperlogy-*.woff2 가 있으면 'Paperlogy' 로 넣는다.
 *  3) 첫 앱 스크립트(JsCharts) 앞에 미리보기 런타임을 넣는다:
 *     dev/gas-mock.js + 서버 번들(window.__server) + 가짜 google.script.run + 시작 처리(setup·BOOT·?s=·?demo=1).
 *  4) gas/*.gs 와 HTML 안 <script> 의 문법을 검사한다. 문제가 있으면 결과는 쓰되 종료 코드 1.
 *
 * 다른 도구(dev/test/*.mjs)가 쓰도록 서버 번들 함수들을 export 한다(직접 실행할 때만 빌드).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEV = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(DEV, '..');
export const GAS = path.join(ROOT, 'gas');
export const DIST = path.join(ROOT, 'dist');
export const OUT = path.join(DIST, 'preview.html');
export const MOCK_PATH = path.join(DEV, 'gas-mock.js');
export const FONT_PRETENDARD = path.resolve(ROOT, '..', 'fonts', 'PretendardVariable.woff2');
export const VENDOR = path.join(ROOT, 'vendor');
export const STORAGE_KEY = 'hds-preview-db';
export const PREVIEW_ADMIN_PASSWORD = 'hds1234';

/** 서버 .gs 파일 순서: Config.gs 먼저, 나머지 이름순 (paste/Code.gs 와 같은 규칙) */
export function gsFiles(dir = GAS) {
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const i = names.indexOf('Config.gs');
  if (i > 0) { names.splice(i, 1); names.unshift('Config.gs'); }
  return names.map((name) => ({ name, path: path.join(dir, name), src: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

export function htmlFileNames(dir = GAS) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, '')).sort();
}

/** 줄 맨 앞의 function NAME( 선언 / var·let·const NAME — 서버 전역 이름 */
export function topLevelNames(files) {
  const fns = new Set(), vars = new Set();
  for (const f of files) {
    const src = stripComments(f.src);
    for (const m of src.matchAll(/^function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm)) fns.add(m[1]);
    for (const m of src.matchAll(/^(?:var|let|const)\s+([A-Za-z_$][\w$]*)/gm)) vars.add(m[1]);
    for (const m of src.matchAll(/^(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=[^;]*?,\s*\n?\s*([A-Za-z_$][\w$]*)\s*=/gm)) vars.add(m[1]);
  }
  for (const n of ['api', 'setup', 'cronDaily', 'cronWeekly', 'doGet', 'include']) if (!vars.has(n)) fns.add(n);
  for (const n of fns) vars.delete(n);
  return { functions: [...fns].sort(), vars: [...vars].sort() };
}

function stripComments(src) {
  // 줄 머리 판별용: 블록 주석 안의 'function x(' 를 이름으로 잡지 않게 지운다(문자열 속 주석 기호는 드묾).
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** 모의 전역 이름 목록 (dev/gas-mock.js 를 실제로 읽어 globals 키를 얻는다) */
export function mockGlobalNames(mockSrc = fs.readFileSync(MOCK_PATH, 'utf8')) {
  const ctx = vm.createContext({ console: { log() {}, info() {}, warn() {}, error() {} } });
  vm.runInContext(mockSrc, ctx, { filename: 'gas-mock.js' });
  return Object.keys(ctx.createGasMock({ autoSave: false }).globals);
}

/**
 * 서버 팩토리 소스: function (__g) { var SpreadsheetApp = __g.SpreadsheetApp, …; <gs 전부>; return { 이름: … }; }
 * GAS 처럼 "호출마다 새 실행"을 흉내 내려고 팩토리로 둔다(전역 변수 캐시가 호출 사이에 남지 않음).
 * 반환 객체에는 함수뿐 아니라 최상위 var(Db, Auth, APP …)도 담는다(시험·디버깅용).
 */
export function serverFactorySource(files, globalNames, names = topLevelNames(files)) {
  const lines = [];
  const map = [];
  lines.push('function (__g) {');
  lines.push('var ' + globalNames.map((n) => `${n} = __g.${n}`).join(', ') + ';');
  for (const f of files) {
    lines.push(`/* ===== ${f.name} ===== */`);
    map.push({ file: f.name, start: lines.length + 1, lines: f.src.split('\n').length });
    lines.push(f.src.replace(/\r\n/g, '\n'));
  }
  lines.push('/* ===== (미리보기 내보내기) ===== */');
  const all = [...names.functions, ...names.vars];
  lines.push('return {');
  lines.push(all.map((n) => `  ${JSON.stringify(n)}: typeof ${n} !== 'undefined' ? ${n} : null`).join(',\n'));
  lines.push('};');
  lines.push('}');
  // map 의 start 는 이 소스 안의 1-based 줄 번호(파일 첫 줄)
  const src = lines.join('\n');
  return { src, map: fixLineMap(src, files) };
}

function fixLineMap(src, files) {
  const out = [];
  const L = src.split('\n');
  for (const f of files) {
    const marker = `/* ===== ${f.name} ===== */`;
    const idx = L.indexOf(marker);
    if (idx >= 0) out.push({ file: f.name, start: idx + 2, lines: f.src.split('\n').length });
  }
  return out;
}

/** 'bundle.js:123' 같은 줄 번호를 'Db.gs:45' 로 바꾼다 */
export function mapBundleLine(map, line, offset = 0) {
  const ln = line - offset;
  for (const m of map) if (ln >= m.start && ln < m.start + m.lines) return `${m.file}:${ln - m.start + 1}`;
  return null;
}

/** 문법 검사: [{file, message}] */
export function syntaxCheck(files) {
  const errs = [];
  for (const f of files) {
    try {
      new vm.Script(f.src, { filename: f.name });
    } catch (e) {
      const m = /:(\d+)/.exec(String(e.stack || '').split('\n')[0] || '');
      errs.push({ file: f.name + (m ? ':' + m[1] : ''), message: e.message });
    }
  }
  return errs;
}

function scriptBlocks(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1] || '';
    if (type && !/^(text\/javascript|application\/javascript|module)$/i.test(type)) continue;
    out.push({ code: m[2], line: html.slice(0, m.index).split('\n').length });
  }
  return out;
}

function readVersion() {
  try {
    const src = fs.readFileSync(path.join(GAS, 'Config.gs'), 'utf8');
    return (/version\s*:\s*['"]([^'"]+)['"]/.exec(src) || [])[1] || '1.0.0';
  } catch (e) {
    return '1.0.0';
  }
}

function jsonForScript(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** 인라인 <script> 안에 넣어도 HTML 파서가 끊지 않게 */
function scriptSafe(code) {
  return code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

function fontFaces(notes) {
  let css = '';
  if (fs.existsSync(FONT_PRETENDARD)) {
    const b64 = fs.readFileSync(FONT_PRETENDARD).toString('base64');
    css += `@font-face{font-family:'Pretendard Variable';font-weight:45 920;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}\n`;
    notes.push(`글꼴 Pretendard Variable 인라인 (${(b64.length / 1024 / 1024).toFixed(2)}MB base64)`);
  } else {
    notes.push('글꼴 ../fonts/PretendardVariable.woff2 없음 — 시스템 글꼴로 대체');
  }
  let paper = [];
  try { paper = fs.readdirSync(VENDOR).filter((f) => /^Paperlogy-.*\.woff2$/i.test(f)).sort(); } catch (e) { paper = []; }
  for (const f of paper) {
    const w = /^Paperlogy-(\d)/i.exec(f);
    const weight = w ? Number(w[1]) * 100 : 700;
    const b64 = fs.readFileSync(path.join(VENDOR, f)).toString('base64');
    css += `@font-face{font-family:'Paperlogy';font-weight:${weight};font-style:normal;font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}\n`;
    notes.push(`글꼴 Paperlogy ${weight} 인라인 (${f})`);
  }
  if (!paper.length) notes.push('Paperlogy 로컬 파일 없음 — Css.html 의 CDN @font-face 를 그대로 둠(실패 시 대체 글꼴)');
  return css.length ? css : '';
}

/** 브라우저에서 돌아가는 미리보기 런타임(문자열). __SERVER_FACTORY__ 등은 빌드 때 채운다. */
function runtimeSource({ factorySrc, functionNames, htmlNames, version }) {
  return `
/* ===== HDS 안전장부 미리보기 런타임 (dev/build-preview.mjs 가 만듦 — 직접 고치지 말 것) ===== */
(function () {
  'use strict';
  var KEY = ${JSON.stringify(STORAGE_KEY)};
  var ADMIN_PW = ${JSON.stringify(PREVIEW_ADMIN_PASSWORD)};
  var FUNCTIONS = ${JSON.stringify(functionNames)};
  var HTML_FILES = ${JSON.stringify(htmlNames)};

  function memoryStore() {
    var m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; }
    };
  }
  var store = (function () {
    try {
      var ls = window.localStorage;
      ls.setItem('__hds_probe', '1');
      ls.removeItem('__hds_probe');
      return ls;
    } catch (e) {
      console.warn('[미리보기] 브라우저 저장소를 쓸 수 없어 이 탭 메모리에만 저장합니다');
      return memoryStore();
    }
  })();

  function formsHtml() {
    var el = document.getElementById('forms-data');
    return el ? '<script id="forms-data" type="application/json">' + el.textContent + '</scr' + 'ipt>' : '';
  }

  var mock = window.createGasMock({
    storage: store,
    storageKey: KEY,
    formsHtml: formsHtml,
    htmlFiles: HTML_FILES,
    log: console,
    serviceUrl: location.origin + location.pathname
  });
  window.__mock = mock;

  var factory = (${factorySrc});

  /** GAS 처럼 호출마다 새 실행(전역 다시 평가) */
  function execution() { return factory(mock.globals); }
  function exec(name, args) {
    var inst = execution();
    var fn = inst[name];
    if (typeof fn !== 'function') {
      var e = new Error('Script function not found: ' + name);
      e.name = 'ScriptError';
      throw e;
    }
    return fn.apply(null, args || []);
  }

  var server = {};
  FUNCTIONS.forEach(function (n) {
    server[n] = function () { return exec(n, Array.prototype.slice.call(arguments)); };
  });
  Object.defineProperty(server, '__exec', { value: exec });
  Object.defineProperty(server, '__instance', { value: execution });
  Object.defineProperty(server, '__has', { value: function (n) { var f = execution()[n]; return typeof f === 'function'; } });
  window.__server = server;

  /* ---------- 처음 실행: setup ---------- */
  function hasFn(n) { try { return server.__has(n); } catch (e) { return false; } }
  try {
    var props = mock.globals.PropertiesService.getScriptProperties();
    if (!props.getProperty('DB_ID')) {
      if (hasFn('setup')) {
        console.info('[미리보기] 처음 실행 — setup() 으로 모의 DB 를 만듭니다. 관리자 admin / ' + ADMIN_PW);
        server.setup({ adminPassword: ADMIN_PW });
        mock.save();
      } else {
        console.warn('[미리보기] setup() 이 아직 없습니다(gas/Setup.gs)');
      }
    }
  } catch (e) {
    console.error('[미리보기] setup 실패: ' + (e && e.message), e);
  }

  /* ---------- BOOT: doGet 을 모의로 실행해 실제와 같은 BOOT 를 얻는다 ---------- */
  var q = new URLSearchParams(location.search);
  var s = q.get('s') || '';
  var v = q.get('v') || '';
  var boot = window.BOOT || {};
  try {
    if (hasFn('doGet')) {
      mock.lastTemplate = null;
      var params = {};
      var arrs = {};
      q.forEach(function (val, key) { if (!(key in params)) params[key] = val; (arrs[key] = arrs[key] || []).push(val); });
      server.doGet({ parameter: params, parameters: arrs, queryString: location.search.replace(/^\\?/, ''), contextPath: '', contentLength: -1 });
      var t = mock.lastTemplate;
      if (t && t.vars && typeof t.vars.BOOT === 'string') boot = Object.assign({}, boot, JSON.parse(t.vars.BOOT));
    } else if (hasFn('api')) {
      var st = JSON.parse(server.api('auth.status', JSON.stringify(s ? { siteToken: s } : {}), ''));
      if (st && st.ok && st.data) {
        boot.ready = !!st.data.ready;
        if (st.data.appName) boot.appName = st.data.appName;
        if (st.data.company) boot.company = st.data.company;
        if (s) boot.site = st.data.site || null;
      }
    }
  } catch (e) {
    console.warn('[미리보기] doGet 모의 실패 — 기본 BOOT 를 씁니다: ' + (e && e.message));
  }
  boot.preview = true;
  boot.url = location.origin + location.pathname;
  if (s) boot.s = s;
  if (v && !boot.view) boot.view = v;
  boot.demo = q.get('demo') === '1' || q.get('demo') === 'true' || /^#demo\\b/.test(location.hash) || /[#&?]demo(=1)?(&|$)/.test(location.hash);
  if (!boot.version) boot.version = ${JSON.stringify(version)};
  window.BOOT = boot;

  /* ---------- 가짜 google.script.run ---------- */
  function illegal(v, p, seen) {
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === 'function') return p || '0';
    if (t !== 'object') return null;
    if (Object.prototype.toString.call(v) === '[object Date]') return p || '0';
    if (seen.indexOf(v) >= 0) return p || '0';
    seen.push(v);
    for (var k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      var r = illegal(v[k], p ? p + '.' + k : k, seen);
      if (r) return r;
    }
    seen.pop();
    return null;
  }
  function hasDate(v, depth) {
    if (!v || typeof v !== 'object' || depth > 50) return false;
    if (Object.prototype.toString.call(v) === '[object Date]') return true;
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k) && hasDate(v[k], depth + 1)) return true;
    return false;
  }
  function invoke(fnName, args, onOk, onFail, userObj) {
    var bad = illegal(args, '', []);
    if (bad) throw new Error('Failed due to illegal value in property: ' + bad);
    var payload = JSON.stringify(args);
    var delay = 20 + Math.floor(Math.random() * 101);
    setTimeout(function () {
      var res, err = null;
      try {
        if (FUNCTIONS.indexOf(fnName) < 0 || /_$/.test(fnName) || typeof window.__server[fnName] !== 'function') throw new Error('Script function not found: ' + fnName);
        res = window.__server[fnName].apply(null, JSON.parse(payload));
        if (res !== undefined) {
          if (hasDate(res, 0)) {
            console.warn('[미리보기] 서버 함수 ' + fnName + ' 이 Date 를 돌려줘 GAS 처럼 null 로 바꿉니다');
            res = null;
          } else {
            res = JSON.parse(JSON.stringify(res));
          }
        }
      } catch (e) {
        err = e instanceof Error ? e : new Error(String(e));
      }
      setTimeout(function () {
        if (err) {
          if (typeof onFail === 'function') onFail(err, userObj);
          else console.error('google.script.run.' + fnName + ' 실패(실패 처리기 없음): ' + err.message);
        } else if (typeof onOk === 'function') {
          onOk(res, userObj);
        }
      }, 0);
    }, delay);
  }
  function runner(onOk, onFail, userObj) {
    var base = {
      withSuccessHandler: function (fn) { return runner(fn, onFail, userObj); },
      withFailureHandler: function (fn) { return runner(onOk, fn, userObj); },
      withUserObject: function (o) { return runner(onOk, onFail, o); }
    };
    if (typeof Proxy === 'function') {
      return new Proxy(base, {
        get: function (t, prop) {
          if (prop in t) return t[prop];
          if (typeof prop !== 'string' || prop === 'then') return undefined;
          return function () { invoke(prop, Array.prototype.slice.call(arguments), onOk, onFail, userObj); };
        }
      });
    }
    FUNCTIONS.forEach(function (n) {
      base[n] = function () { invoke(n, Array.prototype.slice.call(arguments), onOk, onFail, userObj); };
    });
    return base;
  }
  var g = window.google = window.google || {};
  g.script = g.script || {};
  g.script.run = runner(null, null, undefined);
  g.script.host = g.script.host || {
    origin: location.origin,
    close: function () {},
    setHeight: function () {},
    setWidth: function () {},
    editor: { focus: function () {} }
  };
  g.script.url = g.script.url || {
    getLocation: function (cb) {
      var p = {}, ps = {};
      new URLSearchParams(location.search).forEach(function (val, key) { if (!(key in p)) p[key] = val; (ps[key] = ps[key] || []).push(val); });
      setTimeout(function () { cb({ hash: location.hash.replace(/^#/, ''), parameter: p, parameters: ps }); }, 0);
    }
  };
  g.script.history = g.script.history || (function () {
    var handler = null;
    window.addEventListener('popstate', function (e) {
      if (handler) handler({ state: e.state, location: { hash: location.hash.replace(/^#/, ''), parameter: Object.fromEntries(new URLSearchParams(location.search)) } });
    });
    function url(params, hash) {
      var u = location.pathname + (params ? '?' + new URLSearchParams(params).toString() : location.search);
      return u + (hash != null ? '#' + hash : location.hash);
    }
    return {
      push: function (st, params, hash) { history.pushState(st || null, '', url(params, hash)); },
      replace: function (st, params, hash) { history.replaceState(st || null, '', url(params, hash)); },
      setChangeHandler: function (fn) { handler = fn; }
    };
  })();

  /* ---------- 저장·탭 동기화 ---------- */
  window.addEventListener('pagehide', function () { if (mock.isDirty()) mock.save(); });
  window.addEventListener('beforeunload', function () { if (mock.isDirty()) mock.save(); });
  window.addEventListener('storage', function (e) {
    if (e.key === KEY && e.newValue && !mock.isDirty()) mock.reload();
  });

  /* ---------- 콘솔 도우미 ---------- */
  window.__preview = {
    mock: mock,
    server: server,
    version: ${JSON.stringify(version)},
    api: function (method, payload, token) {
      var tk = token;
      if (tk === undefined) { try { tk = localStorage.getItem('hds.token') || ''; } catch (e) { tk = ''; } }
      return JSON.parse(server.api(method, JSON.stringify(payload || {}), tk || ''));
    },
    table: function (name) { return mock.table(name); },
    mails: function () { return mock.sent.slice(); },
    siteLink: function (siteId) {
      var row = mock.table('sites').filter(function (r) { return !siteId || r.id === siteId; })[0];
      return row ? location.origin + location.pathname + '?s=' + row.token : null;
    },
    reset: function () {
      mock.reset();
      try { ['hds.token', 'hds.siteToken', 'hds.name'].forEach(function (k) { localStorage.removeItem(k); }); } catch (e) { /* 무시 */ }
      location.href = location.pathname;
    }
  };
})();
`;
}

/** 빌드 본체. → { html, notes, problems, files, bytes } */
export function buildPreview({ quiet = false } = {}) {
  const notes = [];
  const problems = [];
  const indexPath = path.join(GAS, 'Index.html');
  if (!fs.existsSync(indexPath)) throw new Error('gas/Index.html 이 없습니다');
  const index = fs.readFileSync(indexPath, 'utf8');
  const mockSrc = fs.readFileSync(MOCK_PATH, 'utf8');
  const version = readVersion();

  // Index.html 스크립틀릿 검사: 허용 형태 두 가지만
  const INCLUDE_RE = /<\?!=\s*include\(\s*['"]([\w.-]+)['"]\s*\)\s*;?\s*\?>/g;
  const BOOT_RE = /<\?!=\s*BOOT\s*;?\s*\?>/g;
  const rest = index.replace(INCLUDE_RE, '').replace(BOOT_RE, '');
  for (const m of rest.matchAll(/<\?[\s\S]*?(\?>|$)/g)) {
    problems.push(`Index.html: 허용되지 않은 스크립틀릿 ${JSON.stringify(m[0].slice(0, 60))} (SPEC §3)`);
  }
  if (!BOOT_RE.test(index)) problems.push('Index.html: <?!= BOOT ?> 가 없습니다');

  // 서버 번들
  const files = gsFiles();
  const gsErrs = syntaxCheck(files);
  for (const e of gsErrs) problems.push(`${e.file} 문법 오류: ${e.message}`);
  const globalNames = mockGlobalNames(mockSrc);
  const names = topLevelNames(files);
  const { src: factorySrc } = serverFactorySource(files, globalNames, names);
  try {
    new vm.Script('(' + factorySrc + ')', { filename: 'server-bundle.js' });
  } catch (e) {
    if (!gsErrs.length) problems.push('서버 번들 문법 오류(파일을 이어 붙였을 때): ' + e.message);
  }

  // include 치환
  const included = [];
  const htmlNames = htmlFileNames();
  let runtimeInserted = false;
  const runtime = `<script id="hds-preview-runtime">\n/* ===== dev/gas-mock.js ===== */\n${scriptSafe(mockSrc)}\n${scriptSafe(runtimeSource({ factorySrc, functionNames: names.functions, htmlNames, version }))}\n</script>\n`;
  const firstAppScript = (() => {
    const order = [...index.matchAll(INCLUDE_RE)].map((m) => m[1]);
    if (order.includes('JsCharts')) return 'JsCharts';
    return order.find((n) => /^Js/.test(n)) || null;
  })();

  let html = index.replace(INCLUDE_RE, (all, name) => {
    const p = path.join(GAS, name + '.html');
    if (!fs.existsSync(p)) {
      problems.push(`include('${name}') — gas/${name}.html 이 없습니다`);
      return `<!-- include('${name}') 없음 -->`;
    }
    const content = fs.readFileSync(p, 'utf8');
    included.push({ name: name + '.html', bytes: Buffer.byteLength(content) });
    if (name !== 'FormsData' && /<\?|\?>/.test(content.replace(/<\?xml[^>]*\?>/g, ''))) {
      notes.push(`주의: ${name}.html 안에 '<?' 또는 '?>' 문자열이 있습니다(SPEC §12 — 붙여넣기 배포에서 스크립틀릿으로 오해될 수 있음)`);
    }
    for (const b of scriptBlocks(content)) {
      try {
        new vm.Script(b.code, { filename: `${name}.html` });
      } catch (e) {
        const lm = /:(\d+)/.exec(String(e.stack || '').split('\n')[0] || '');
        const line = lm ? b.line + Number(lm[1]) - 1 : b.line;
        problems.push(`${name}.html:${line} <script> 문법 오류: ${e.message}`);
      }
    }
    if (name === firstAppScript && !runtimeInserted) {
      runtimeInserted = true;
      return runtime + content;
    }
    return content;
  });
  if (!runtimeInserted) {
    html = html.replace(/<script>\s*window\.BOOT/, (m) => runtime + m);
    if (!html.includes('id="hds-preview-runtime"')) html = html.replace(/<\/body>/i, runtime + '</body>');
    notes.push('JsCharts include 를 찾지 못해 런타임을 다른 위치에 넣었습니다');
  }

  // BOOT
  const boot = {
    url: '', s: '', view: '', appName: 'HDS 안전장부', company: 'HDS(주) 안전경영지원실',
    ready: true, preview: true, version
  };
  html = html.replace(BOOT_RE, () => jsonForScript(boot));

  // 글꼴
  const before = html.length;
  html = html.replace(/[ \t]*<link\b[^>]*href=["'][^"']*pretendard[^"']*["'][^>]*>\s*\n?/gi, '');
  if (html.length === before) notes.push('Pretendard CDN <link> 를 찾지 못했습니다(이미 없음)');
  const faces = fontFaces(notes);
  if (faces) {
    const tag = `<style id="hds-preview-fonts">\n${faces}</style>\n`;
    if (/<title>/i.test(html)) html = html.replace(/<title>/i, (m) => tag + m);
    else html = html.replace(/<\/head>/i, (m) => tag + m);
  }

  // 미리보기 표식
  html = html.replace(/<html\b([^>]*)>/i, (m, a) => (/data-preview/.test(a) ? m : `<html${a} data-preview="1">`));

  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(OUT, html);
  const bytes = Buffer.byteLength(html);

  if (!quiet) {
    console.log(`dist/preview.html  ${(bytes / 1024 / 1024).toFixed(2)}MB  (${bytes.toLocaleString()} bytes)`);
    console.log(`  서버 .gs ${files.length}개: ${files.map((f) => `${f.name}(${f.src.length.toLocaleString()}자)`).join(', ')}`);
    console.log(`  서버 함수 ${names.functions.length}개: ${names.functions.join(', ')}`);
    console.log(`  HTML include ${included.length}개: ${included.map((f) => `${f.name}(${(f.bytes / 1024).toFixed(1)}KB)`).join(', ')}`);
    console.log(`  모의 전역: ${globalNames.join(', ')}`);
    for (const n of notes) console.log('  - ' + n);
  }
  if (problems.length) {
    console.error(`\n문제 ${problems.length}건:`);
    for (const p of problems) console.error('  ✗ ' + p);
  }
  return { html, notes, problems, files: files.map((f) => f.name), included, bytes };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    const r = buildPreview({ quiet: process.argv.includes('--quiet') });
    if (process.argv.includes('--quiet')) console.log(`dist/preview.html ${(r.bytes / 1024 / 1024).toFixed(2)}MB, 문제 ${r.problems.length}건`);
    process.exit(r.problems.length ? 1 : 0);
  } catch (e) {
    console.error('빌드 실패: ' + (e && e.stack || e));
    process.exit(1);
  }
}
