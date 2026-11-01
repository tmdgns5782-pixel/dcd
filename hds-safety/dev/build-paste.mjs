#!/usr/bin/env node
/**
 * build-paste.mjs — gas/ → paste/ (script.google.com 편집기에 복사·붙여넣기로 설치하는 최소 묶음). SPEC.md §12.
 *
 *   node dev/build-paste.mjs          묶음 만들기 + 검사
 *   node dev/build-paste.mjs --quiet  요약만
 *
 * 만드는 파일(편집기에서 만들 파일 이름 = 확장자 뺀 이름)
 *   paste/Code.gs          gas/*.gs 전부(Config.gs 먼저, 나머지 이름순)를 파일별 머리 주석과 함께 이어 붙인 한 파일
 *   paste/Index.html       gas/Index.html 에서 include 를 FormsData·Styles·App·App2·App3 다섯 개로 바꿔 쓴 것
 *   paste/Styles.html      Css + CssEngine + CssViews
 *   paste/App.html         JsCharts + JsCore + JsEngine + JsDemo + JsHq + JsAnalytics + JsSite (Index.html 의 include 순서대로)
 *   paste/FormsData.html   gas/FormsData.html 그대로 (서버 Db.forms() 가 이 이름으로 읽는다)
 *   paste/appsscript.json  gas/appsscript.json 그대로 (편집기 [프로젝트 설정 > "appsscript.json" 표시] 후 붙여넣기)
 *   paste/붙여넣기-안내.txt  편집기에서 만들 파일 이름과 순서, setup 실행, 배포 설정
 *
 * 묶음이 내용상 원본과 같은지(이어 붙이기 누락·순서) 확인하고, 스크립틀릿 문자열·문법 오류가 있으면 종료 코드 1.
 * 실제 서버 동작 확인은 `node dev/test/server.test.mjs --paste` (paste/Code.gs 를 vm 에 올려 같은 시나리오).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { GAS, ROOT, gsFiles, syntaxCheck } from './build-preview.mjs';

export const PASTE = path.join(ROOT, 'paste');

/** 붙여넣기 묶음 정의: 묶음 이름 → 원본 HTML 이름들(순서는 Index.html include 순서를 따른다) */
export const BUNDLES = {
  Styles: ['Css', 'CssEngine', 'CssViews'],
  App: ['JsCharts', 'JsCore', 'JsEngine'],
  App2: ['JsDemo', 'JsHq'],
  App3: ['JsAnalytics', 'JsSite']
};
/** 그대로 옮기는 HTML (이름 유지) */
export const KEEP = ['FormsData'];

const INCLUDE_RE = /<\?!=\s*include\(\s*['"]([\w.-]+)['"]\s*\)\s*;?\s*\?>/g;
const BOOT_RE = /<\?!=\s*BOOT\s*;?\s*\?>/g;

function readGas(name) {
  return fs.readFileSync(path.join(GAS, name), 'utf8').replace(/\r\n/g, '\n');
}

function versionOf(configSrc) {
  return (/version\s*:\s*['"]([^'"]+)['"]/.exec(configSrc) || [])[1] || '1.0.0';
}

/** 스크립틀릿 열고 닫는 문자열 위치 [{line, text}] — '<?xml …?>' 도 예외 없이 잡는다(GAS 템플릿은 가리지 않음). */
export function scriptletHits(src) {
  const out = [];
  const lines = src.split('\n');
  lines.forEach((l, i) => {
    let m;
    const re = /<\?|\?>/g;
    while ((m = re.exec(l))) out.push({ line: i + 1, text: l.slice(Math.max(0, m.index - 30), m.index + 32).trim() });
  });
  return out;
}

function banner(title, lines) {
  return ['/**', ` * ${title}`, ...lines.map((l) => (l ? ` * ${l}` : ' *')), ' */'].join('\n');
}

export function buildPaste({ quiet = false, outDir = PASTE } = {}) {
  const problems = [];
  const notes = [];
  const out = {};

  /* ---------- Code.gs ---------- */
  const files = gsFiles();
  for (const e of syntaxCheck(files)) problems.push(`gas/${e.file} 문법 오류: ${e.message}`);
  const version = versionOf(files.find((f) => f.name === 'Config.gs')?.src || '');
  const parts = [];
  parts.push(banner(`HDS 안전장부 — 서버 코드 (Code.gs) · 버전 ${version}`, [
    '이 파일은 dev/build-paste.mjs 가 gas/*.gs 를 이어 붙여 만든 것입니다. 고칠 때는 gas/ 원본을 고치고 다시 만드세요.',
    `원본 순서: ${files.map((f) => f.name).join(', ')}`,
    '편집기에서 처음 한 번 함수 목록의 setup 을 골라 [실행] 하세요(실행 로그에 관리자 임시 비밀번호가 나옵니다).'
  ]));
  for (const f of files) {
    const src = f.src.replace(/\r\n/g, '\n').replace(/\s+$/, '');
    parts.push('', '', `/* ======================================================================`, ` * ${f.name}`, ` * ==================================================================== */`, '', src);
  }
  out['Code.gs'] = parts.join('\n') + '\n';
  try {
    new vm.Script(out['Code.gs'], { filename: 'Code.gs' });
  } catch (e) {
    problems.push('paste/Code.gs 문법 오류(이어 붙였을 때): ' + e.message);
  }
  // 원본이 빠짐없이 들어갔는지
  for (const f of files) {
    if (!out['Code.gs'].includes(f.src.replace(/\r\n/g, '\n').replace(/\s+$/, ''))) problems.push(`paste/Code.gs 에 ${f.name} 내용이 그대로 들어가지 않았습니다`);
  }

  /* ---------- Index.html ---------- */
  const index = readGas('Index.html');
  const order = [...index.matchAll(INCLUDE_RE)].map((m) => m[1]);
  const known = new Set([...KEEP, ...Object.values(BUNDLES).flat()]);
  for (const n of order) if (!known.has(n)) problems.push(`Index.html 의 include('${n}') 가 붙여넣기 묶음 정의(BUNDLES/KEEP)에 없습니다 — dev/build-paste.mjs 를 고치세요`);
  const htmlOnDisk = fs.readdirSync(GAS).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, '')).filter((n) => n !== 'Index');
  for (const n of htmlOnDisk) if (!order.includes(n)) notes.push(`gas/${n}.html 은 Index.html 에서 include 하지 않아 묶음에서 빠집니다`);
  const bundleOf = {};
  for (const [b, names] of Object.entries(BUNDLES)) for (const n of names) bundleOf[n] = b;
  const emitted = new Set();
  let pIndex = index.replace(INCLUDE_RE, (all, name) => {
    const target = bundleOf[name] || name;
    if (emitted.has(target)) return '\u0000DROP\u0000';
    emitted.add(target);
    return `<?!= include('${target}'); ?>`;
  });
  pIndex = pIndex.replace(/^[ \t]*\u0000DROP\u0000[ \t]*\n/gm, '').replace(/\u0000DROP\u0000/g, '');
  out['Index.html'] = pIndex;
  const pOrder = [...pIndex.matchAll(INCLUDE_RE)].map((m) => m[1]);
  const want = [...KEEP, ...Object.keys(BUNDLES)];
  if (pOrder.length !== want.length || want.some((w) => !pOrder.includes(w))) problems.push(`paste/Index.html include 가 ${want.join('·')} 가 아닙니다: ${pOrder.join(', ')}`);
  const rest = pIndex.replace(INCLUDE_RE, '').replace(BOOT_RE, '');
  for (const h of scriptletHits(rest)) problems.push(`paste/Index.html:${h.line} 허용되지 않은 스크립틀릿 문자열: ${h.text}`);
  if (!BOOT_RE.test(pIndex)) problems.push('paste/Index.html 에 <?!= BOOT ?> 가 없습니다');

  /* ---------- Styles.html · App.html · FormsData.html ---------- */
  for (const [b, names] of Object.entries(BUNDLES)) {
    const inOrder = order.filter((n) => names.includes(n));
    for (const n of names) if (!inOrder.includes(n)) notes.push(`${b}.html: ${n} 은 Index.html 에 include 가 없어 넣지 않았습니다`);
    const chunks = inOrder.map((n) => {
      const src = readGas(n + '.html').replace(/\s+$/, '');
      return `<!-- ===== ${n}.html ===== -->\n${src}`;
    });
    out[b + '.html'] = `<!-- HDS 안전장부 ${b}.html (버전 ${version}) — dev/build-paste.mjs 가 ${inOrder.join(' + ')} 를 이어 붙여 만든 파일입니다. -->\n` + chunks.join('\n\n') + '\n';
  }
  for (const n of KEEP) out[n + '.html'] = readGas(n + '.html');

  for (const name of ['Styles.html', 'App.html', 'FormsData.html']) {
    for (const h of scriptletHits(out[name]).slice(0, 10)) problems.push(`paste/${name}:${h.line} '<?' 또는 '?>' 문자열: ${h.text}`);
  }

  /* ---------- appsscript.json ---------- */
  const manifest = readGas('appsscript.json');
  try {
    const j = JSON.parse(manifest);
    if (j.runtimeVersion !== 'V8') problems.push('appsscript.json: runtimeVersion 이 V8 이 아닙니다');
    if (j.timeZone !== 'Asia/Seoul') problems.push('appsscript.json: timeZone 이 Asia/Seoul 이 아닙니다');
  } catch (e) {
    problems.push('gas/appsscript.json 이 JSON 이 아닙니다: ' + e.message);
  }
  out['appsscript.json'] = manifest.endsWith('\n') ? manifest : manifest + '\n';

  /* ---------- 붙여넣기-안내.txt ---------- */
  const kb = (s) => `${Math.ceil(Buffer.byteLength(s) / 1024).toLocaleString()}KB`;
  out['붙여넣기-안내.txt'] = '\ufeff' + [   // BOM: 윈도 메모장에서도 한글이 깨지지 않게
    `HDS 안전장부 붙여넣기 설치 안내 (버전 ${version})`,
    '',
    '준비: 회사 구글 계정으로 https://script.google.com 에 들어가 [새 프로젝트]를 만들고 이름을 "HDS 안전장부"로 바꿉니다.',
    '',
    '1) 매니페스트',
    '   왼쪽 [프로젝트 설정](톱니) > "편집기에서 \'appsscript.json\' 매니페스트 파일 표시" 를 켭니다.',
    '   편집기로 돌아와 appsscript.json 을 열고 내용을 모두 지운 뒤 paste/appsscript.json 내용을 붙여넣습니다.',
    '',
    '2) 서버 코드',
    `   처음부터 있는 Code.gs 를 열고 내용을 모두 지운 뒤 paste/Code.gs (${kb(out['Code.gs'])}) 내용을 붙여넣습니다.`,
    '',
    `3) HTML 파일 ${2 + Object.keys(BUNDLES).length}개 — 파일 옆 [+] > HTML 로 아래 이름 그대로 만듭니다(.html 은 편집기가 붙입니다. 대소문자 그대로).`,
    '   새 파일에 들어 있는 기본 내용은 모두 지우고 붙여넣습니다.',
    `   - Index      ← paste/Index.html (${kb(out['Index.html'])})`,
    `   - Styles     ← paste/Styles.html (${kb(out['Styles.html'])})`,
    ...Object.keys(BUNDLES).filter((b) => b !== 'Styles').map((b) => `   - ${b.padEnd(10)} ← paste/${b}.html (${kb(out[b + '.html'])})`),
    `   - FormsData  ← paste/FormsData.html (${kb(out['FormsData.html'])})`,
    '   큰 파일은 텍스트 편집기에서 전체 선택(Ctrl+A)·복사 후 붙여넣고, 끝부분이 잘리지 않았는지 마지막 줄을 확인합니다.',
    '   [저장](Ctrl+S) 을 누릅니다. 파일 목록 순서는 상관없습니다.',
    '',
    '4) 설치 실행 — 배포보다 먼저',
    '   위쪽 함수 목록에서 setup 을 고르고 [실행]. 처음에는 권한 승인 창이 뜹니다(고급 > 안전하지 않은 페이지로 이동 > 허용).',
    '   [실행 로그]에 나오는 관리자 아이디(admin)와 임시 비밀번호를 적어 둡니다. 다시 보여 주지 않습니다.',
    '   여러 번 실행해도 안전합니다(이미 있으면 그대로 씁니다).',
    '',
    '5) 웹앱 배포',
    '   [배포] > [새 배포] > 유형 "웹 앱" > 설명 입력 > 실행 계정: 나 > 액세스 권한: 모든 사용자 > [배포].',
    '   나온 웹앱 URL(…/exec)로 들어가 admin 과 임시 비밀번호로 로그인하고 [설정 > 비밀번호 변경]부터 합니다.',
    '',
    '6) 사업장 등록 후 [사업장 > 링크 복사]로 사업장 링크(…/exec?s=…)를 담당자에게 전달합니다.',
    '',
    '고친 코드를 반영할 때: 파일을 다시 붙여넣고 저장한 뒤 [배포] > [배포 관리] > 연필 > 버전 "새 버전" > [배포].',
    '(새 배포를 만들면 URL 이 바뀌어 사업장 링크를 다시 보내야 합니다.)',
    ''
  ].join('\r\n');

  /* ---------- 쓰기 ---------- */
  fs.mkdirSync(outDir, { recursive: true });
  const wanted = new Set(Object.keys(out));
  for (const f of fs.readdirSync(outDir)) {
    if (!wanted.has(f) && fs.statSync(path.join(outDir, f)).isFile()) notes.push(`paste/${f} 는 묶음에 없는 파일입니다(그대로 둠)`);
  }
  for (const [name, content] of Object.entries(out)) fs.writeFileSync(path.join(outDir, name), content);

  if (!quiet) {
    console.log(`paste/ 묶음 ${Object.keys(out).length}개 (버전 ${version})`);
    for (const [name, content] of Object.entries(out)) console.log(`  ${name.padEnd(18)} ${(Buffer.byteLength(content) / 1024).toFixed(1).padStart(8)}KB`);
    console.log(`  Code.gs ← ${files.map((f) => f.name).join(', ')}`);
    for (const [b, names] of Object.entries(BUNDLES)) console.log(`  ${b}.html ← ${order.filter((n) => names.includes(n)).join(', ')}`);
    console.log(`  Index.html include: ${pOrder.join(', ')}`);
    for (const n of notes) console.log('  - ' + n);
  }
  if (problems.length) {
    console.error(`\n문제 ${problems.length}건:`);
    for (const p of problems) console.error('  ✗ ' + p);
  }
  return { files: Object.keys(out), problems, notes, version };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    const r = buildPaste({ quiet: process.argv.includes('--quiet') });
    if (process.argv.includes('--quiet')) console.log(`paste/ ${r.files.length}개 파일, 문제 ${r.problems.length}건`);
    process.exit(r.problems.length ? 1 : 0);
  } catch (e) {
    console.error('붙여넣기 묶음 만들기 실패: ' + (e && e.stack || e));
    process.exit(1);
  }
}
