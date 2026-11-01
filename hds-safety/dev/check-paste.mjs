#!/usr/bin/env node
/**
 * check-paste.mjs — script.google.com "복붙" 배포 규칙 검사 (SPEC §2·§12). 위반이 있으면 종료 코드 1.
 *
 *   node dev/check-paste.mjs           gas/ 와 paste/ 검사
 *   node dev/check-paste.mjs --gas     gas/ 만
 *   node dev/check-paste.mjs --dir=X   gas/ 대신 폴더 X 검사(검사기 시험용)
 *
 * 검사
 *  1) 스크립틀릿 문자열: gas/*.gs·*.html 안의 '<?' 또는 '?>' (Index.html 의 허용 스크립틀릿 두 형태 제외).
 *     HtmlService 템플릿(Index.html)이 스크립틀릿으로 오해하므로 다른 파일에도 두지 않는다.
 *  2) 모듈·Node 문법: import/export 문, import(), require(), module.exports — .gs 와 HTML <script> 안(주석·문자열 제외).
 *  3) .gs 안의 Node·브라우저 전용 전역(window, document, Buffer, process, TextEncoder, btoa, setTimeout …).
 *  4) 최상위 실행 순서: .gs 파일마다 다른 서버 파일 없이 GAS 모의 전역만 있는 새 컨텍스트에 혼자 올려 본다.
 *     최상위(로드 시점)에서 다른 파일의 객체를 부르면 ReferenceError/TypeError → 위반.
 *     로드 시점에 GAS 서비스를 부르면 경고(매 실행마다 비용·권한 문제).
 *  5) 전역 이름 충돌: 같은 최상위 이름(function/var/let/const/class)이 두 .gs 파일에 있거나 GAS 서비스 이름을 덮어씀.
 *  6) paste/: 묶음이 gas/ 최신 내용과 같은지(아니면 `node dev/build-paste.mjs`), Index include 3개, Code.gs 단독 로드.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { GAS, ROOT, MOCK_PATH, gsFiles, mockGlobalNames } from './build-preview.mjs';
import { buildPaste, PASTE } from './build-paste.mjs';

const DIR_ARG = (process.argv.find((a) => a.startsWith('--dir=')) || '').slice(6);
const SRC = DIR_ARG ? path.resolve(DIR_ARG) : GAS;     // --dir=<폴더> : gas/ 대신 다른 폴더 검사(검사기 자체 시험용, paste 검사 생략)
const ONLY_GAS = process.argv.includes('--gas') || !!DIR_ARG;
const violations = [];
const warnings = [];
const bad = (file, msg) => violations.push({ file, msg });
const warn = (file, msg) => warnings.push({ file, msg });
const rel = (p) => path.relative(ROOT, p);

/* ------------------------------------------------------------------ */
/* JS 소스에서 주석·문자열·정규식 내용을 지운 "코드만" 문자열(줄·위치 유지)  */
/* ------------------------------------------------------------------ */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
export function codeOnly(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let lastSig = '';      // 마지막 의미 있는 문자
  let lastWord = '';     // 마지막 단어(키워드 판별)
  const tplStack = [];   // 템플릿 리터럴 ${ 깊이
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; blank(i, end); i = end; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j); i = j + 1; lastSig = c; lastWord = ''; continue;
    }
    if (c === '`' || (c === '}' && tplStack.length && tplStack[tplStack.length - 1] === 0)) {
      if (c === '}') tplStack.pop();
      let j = i + 1;
      while (j < n && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      if (src[j] === '$') { tplStack.push(0); i = j + 2; lastSig = '{'; lastWord = ''; continue; }
      i = j + 1; lastSig = '`'; lastWord = ''; continue;
    }
    if (c === '{' && tplStack.length) tplStack[tplStack.length - 1]++;
    if (c === '}' && tplStack.length) tplStack[tplStack.length - 1]--;
    if (c === '/') {
      const isRegex = !lastSig || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig) || REGEX_AFTER_WORD.has(lastWord);
      if (isRegex) {
        let j = i + 1, cls = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break;
          j++;
        }
        blank(i + 1, j); i = j + 1;
        while (i < n && /[a-z]/i.test(src[i])) i++;
        lastSig = '/'; lastWord = ''; continue;
      }
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      lastWord = src.slice(i, j); lastSig = 'a'; i = j; continue;
    }
    if (!/\s/.test(c)) { lastSig = c; lastWord = ''; }
    i++;
  }
  return out.join('');
}

function lineOf(src, idx) { return src.slice(0, idx).split('\n').length; }

function scriptBlocks(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1] || '';
    if (type && !/^(text\/javascript|application\/javascript|module)$/i.test(type)) continue;
    out.push({ code: m[2], line: lineOf(html, m.index + m[0].indexOf('>') + 1) });
  }
  return out;
}

const INCLUDE_RE = /<\?!=\s*include\(\s*['"]([\w.-]+)['"]\s*\)\s*;?\s*\?>/g;
const BOOT_RE = /<\?!=\s*BOOT\s*;?\s*\?>/g;

/* 1) 스크립틀릿 문자열 */
function checkScriptlets(file, src, isIndex) {
  let text = src;
  if (isIndex) text = src.replace(INCLUDE_RE, (m) => ' '.repeat(m.length)).replace(BOOT_RE, (m) => ' '.repeat(m.length));
  const re = /<\?|\?>/g;
  let m, count = 0;
  while ((m = re.exec(text))) {
    if (++count > 8) { bad(file, `'<?'/'?>' 문자열이 더 있습니다(처음 8개만 표시)`); break; }
    const ln = lineOf(text, m.index);
    const line = text.split('\n')[ln - 1];
    bad(`${file}:${ln}`, `'${m[0]}' 문자열 — HtmlService 템플릿이 스크립틀릿으로 오해합니다. '<' + '?' 처럼 나눠 쓰세요: ${line.trim().slice(0, 90)}`);
  }
}

/* 2) 모듈·Node 문법 */
function checkModuleSyntax(file, code, lineBase = 1) {
  const rules = [
    [/^[ \t]*import\s*(?:[\w$*{]|['"])/gm, 'import 문(ES 모듈) — GAS 에서 쓸 수 없습니다'],
    [/^[ \t]*export\s+(?:default|var|let|const|function|class|async|\{|\*)/gm, 'export 문(ES 모듈) — GAS 에서 쓸 수 없습니다'],
    [/(?<![\w$.])import\s*\(/g, '동적 import() — GAS 에서 쓸 수 없습니다'],
    [/(?<![\w$.])require\s*\(/g, 'require() — GAS 에 없습니다'],
    [/(?<![\w$.])module\.exports\b|(?<![\w$.])exports\.[\w$]+\s*=/g, 'CommonJS module.exports — GAS 에 없습니다']
  ];
  for (const [re, msg] of rules) {
    let m;
    while ((m = re.exec(code))) bad(`${file}:${lineBase + lineOf(code, m.index) - 1}`, msg);
  }
}

/* 3) .gs 안 Node·브라우저 전용 전역 */
const NON_GAS = ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'Buffer', 'process', '__dirname', '__filename',
  'TextEncoder', 'TextDecoder', 'btoa', 'atob', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'fetch', 'XMLHttpRequest', 'crypto', 'structuredClone', 'globalThis', 'self', 'Worker', 'Blob', 'FileReader', 'URL', 'URLSearchParams', 'AbortController'];
function checkNonGasGlobals(file, code) {
  const re = new RegExp(`(?<![\\w$.])(${NON_GAS.join('|')})(?![\\w$])(?!\\s*:)`, 'g');
  let m;
  while ((m = re.exec(code))) {
    const before = code.slice(Math.max(0, m.index - 20), m.index);
    if (/typeof\s+$/.test(before)) continue; // typeof window !== 'undefined' 같은 방어는 허용
    bad(`${file}:${lineOf(code, m.index)}`, `${m[1]} — GAS 서버에 없는 Node·브라우저 전역입니다(SPEC §2)`);
  }
}

/* 4)·5) 단독 로드 + 전역 이름 */
const mockSrc = fs.readFileSync(MOCK_PATH, 'utf8');
const GAS_GLOBALS = mockGlobalNames(mockSrc);
const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

function isolatedLoad(label, src) {
  const ctx = vm.createContext({ console: quiet });
  vm.runInContext(mockSrc, ctx, { filename: 'gas-mock.js' });
  const mock = ctx.createGasMock({ autoSave: false, log: quiet, formsHtml: '<script type="application/json">{"forms":[]}</script>' });
  const touched = new Set();
  for (const [k, v] of Object.entries(mock.globals)) {
    ctx[k] = (v && typeof v === 'object') ? new Proxy(v, { get(t, p, r) { if (typeof p === 'string') touched.add(k + '.' + p); return Reflect.get(t, p, r); } }) : v;
  }
  delete ctx.createGasMock;
  const before = new Set(Object.getOwnPropertyNames(ctx));
  try {
    vm.runInContext(src, ctx, { filename: label });
  } catch (e) {
    const where = (/\n\s+at .*?(?:\(|\s)([^():\s]+:\d+)/.exec(String(e.stack || '')) || [])[1] || label;
    bad(where, `파일을 혼자 올리면(다른 .gs 없이) 로드 시점 오류: ${e.name}: ${e.message} — 최상위에서 다른 파일 객체를 바로 부르지 말고 함수 안에서 참조하세요(SPEC §12)`);
  }
  const names = Object.getOwnPropertyNames(ctx).filter((k) => !before.has(k));
  // 줄 맨 앞 선언도 소스에서 읽는다(let/const/class 는 컨텍스트 속성이 아니고, 로드가 중간에 멈췄을 수도 있음)
  const code = codeOnly(src);
  for (const m of code.matchAll(/^(?:var|let|const|class|function\s*\*?)\s*([A-Za-z_$][\w$]*)/gm)) names.push(m[1]);
  return { names: [...new Set(names)], touched: [...touched] };
}

function checkGsSet(files, dirLabel) {
  const owners = {};
  for (const f of files) {
    const file = `${dirLabel}/${f.name}`;
    checkScriptlets(file, f.src, false);
    const code = codeOnly(f.src);
    checkModuleSyntax(file, code);
    checkNonGasGlobals(file, code);
    const r = isolatedLoad(file, f.src);
    if (r.touched.length) warn(file, `로드 시점에 GAS 서비스를 부릅니다(${r.touched.slice(0, 5).join(', ')}) — 함수 안으로 옮기는 것이 좋습니다`);
    for (const n of r.names) {
      (owners[n] = owners[n] || []).push(f.name);
      if (GAS_GLOBALS.includes(n)) bad(file, `전역 이름 ${n} 이 GAS 내장 서비스 이름을 덮어씁니다`);
    }
  }
  for (const [n, fs_] of Object.entries(owners)) if (fs_.length > 1) bad(`${dirLabel}/${fs_.join(', ')}`, `전역 이름 충돌: ${n} 이 여러 파일에 있습니다(한 전역 범위를 같이 씀)`);
  return owners;
}

function checkHtmlSet(dir, dirLabel) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html')).sort()) {
    const file = `${dirLabel}/${f}`;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    checkScriptlets(file, src, f === 'Index.html');
    for (const b of scriptBlocks(src)) {
      checkModuleSyntax(file, codeOnly(b.code), b.line);
    }
    if (/<script\b[^>]*type\s*=\s*["']?module/i.test(src)) bad(file, '<script type="module"> — ES 모듈은 쓰지 않습니다(SPEC §12)');
    if (f === 'Index.html') {
      const rest = src.replace(INCLUDE_RE, '').replace(BOOT_RE, '');
      if (/<\?/.test(rest)) bad(file, '허용되지 않은 스크립틀릿(SPEC §3: include·BOOT 두 형태만)');
      for (const m of src.matchAll(INCLUDE_RE)) if (!fs.existsSync(path.join(dir, m[1] + '.html'))) bad(file, `include('${m[1]}') 의 ${m[1]}.html 이 없습니다`);
    }
  }
}

/* ---------------- gas/ ---------------- */
const SRC_LABEL = DIR_ARG ? (rel(SRC).startsWith('..') ? SRC : rel(SRC)) : 'gas';
const gas = gsFiles(SRC);
checkGsSet(gas, SRC_LABEL);
checkHtmlSet(SRC, SRC_LABEL);
if (fs.existsSync(path.join(SRC, 'appsscript.json'))) {
  try { JSON.parse(fs.readFileSync(path.join(SRC, 'appsscript.json'), 'utf8')); } catch (e) { bad(SRC_LABEL + '/appsscript.json', 'JSON 오류: ' + e.message); }
}

/* ---------------- paste/ ---------------- */
if (!ONLY_GAS) {
  if (!fs.existsSync(path.join(PASTE, 'Code.gs'))) {
    bad('paste/', '붙여넣기 묶음이 없습니다 — `node dev/build-paste.mjs` 를 실행하세요');
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hds-paste-'));
    try {
      const r = buildPaste({ quiet: true, outDir: tmp });
      for (const p of r.problems) bad('build-paste', p);
      for (const name of r.files) {
        const a = path.join(PASTE, name), b = path.join(tmp, name);
        if (!fs.existsSync(a)) bad(`paste/${name}`, '없습니다 — `node dev/build-paste.mjs` 로 다시 만드세요');
        else if (!fs.readFileSync(a).equals(fs.readFileSync(b))) bad(`paste/${name}`, 'gas/ 최신 내용과 다릅니다 — `node dev/build-paste.mjs` 로 다시 만드세요');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    checkGsSet(gsFiles(PASTE), 'paste');
    checkHtmlSet(PASTE, 'paste');
    const idx = fs.readFileSync(path.join(PASTE, 'Index.html'), 'utf8');
    const inc = [...idx.matchAll(INCLUDE_RE)].map((m) => m[1]);
    const wantInc = 'FormsData,Styles,App,App2,App3';
    if (inc.join(',') !== wantInc) bad('paste/Index.html', `include 가 ${wantInc} 순서가 아닙니다: ${inc.join(', ')}`);
    const big = fs.readdirSync(PASTE).map((f) => ({ f, size: fs.statSync(path.join(PASTE, f)).size })).filter((x) => x.size > 1024 * 1024);
    for (const x of big) warn(`paste/${x.f}`, `${(x.size / 1024 / 1024).toFixed(2)}MB — 편집기 붙여넣기가 느릴 수 있습니다(끝까지 붙었는지 마지막 줄 확인)`);
  }
}

/* ---------------- 보고 ---------------- */
console.log(`복붙 배포 검사 — ${SRC_LABEL}/ .gs ${gas.length}개·HTML ${fs.readdirSync(SRC).filter((x) => x.endsWith('.html')).length}개${ONLY_GAS ? '' : ' + paste/'}`);
for (const w of warnings) console.log(`  [경고] ${w.file} — ${w.msg}`);
for (const v of violations) console.log(`  [위반] ${v.file} — ${v.msg}`);
console.log(violations.length ? `\n위반 ${violations.length}건, 경고 ${warnings.length}건` : `\n위반 없음 (경고 ${warnings.length}건)`);
process.exit(violations.length ? 1 : 0);
