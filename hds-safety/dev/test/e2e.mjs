#!/usr/bin/env node
/**
 * e2e.mjs — Playwright 로 dist/preview.html 을 열어 화면·흐름을 시험한다. SPEC.md §10.
 *
 *   node dev/test/e2e.mjs                 빌드 → 시험 (폭 1440·768·390)
 *   E2E_WIDTHS=1440,390 node dev/test/e2e.mjs
 *   E2E_NO_BUILD=1 node dev/test/e2e.mjs  이미 있는 dist/preview.html 로
 *   E2E_SCREENS=home,collect ...          일부 화면만
 *
 * 하는 일
 *  1) dist/ 를 작은 http 서버(임의 포트)로 띄우고 ?demo=1 로 열어 예시 데이터 적재를 기다린다(최대 120초).
 *  2) 본사 화면 전부를 폭마다 열어 콘솔 error·pageerror 0, 빈 화면·없는 경로, 가로 넘침(scrollWidth > innerWidth)을 검사하고
 *     dev/shots/<폭>-<화면>.png 로 찍는다.
 *  3) 사업장 흐름: 사업장 토큰을 모의 DB 에서 읽어 새 컨텍스트(같은 DB 복사)로 ?s=<token> → 이름 입력 로그인 → 홈 →
 *     일일점검(F07) 새로 작성 → '전부 양호' → 제출 → DB 를 본사 컨텍스트로 옮겨 검토함에서 확인 처리.
 *  실패를 모아 요약하고 하나라도 있으면 종료 코드 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DIST = path.join(ROOT, 'dist');
const SHOTS = path.join(ROOT, 'dev', 'shots');
const FONT = path.resolve(ROOT, '..', 'fonts', 'PretendardVariable.woff2');
const KEY = 'hds-preview-db';
const T0 = Date.now();

const WIDTHS = (process.env.E2E_WIDTHS || '1440,768,390').split(',').map((s) => Number(s.trim())).filter(Boolean);
const HEIGHT = { 1440: 900, 768: 1024, 390: 844 };
const ONLY = process.env.E2E_SCREENS ? process.env.E2E_SCREENS.split(',').map((s) => s.trim()) : null;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch (e) {
  try { playwright = await import('playwright'); } catch (e2) {
    console.error('playwright 를 찾지 못했습니다(require("playwright")). 설치 후 다시 실행하세요.');
    process.exit(1);
  }
}
const { chromium } = playwright;

/* ---------------- 결과 모음 ---------------- */
const failures = [];   // {area, what, detail}
const warnings = [];
const passes = [];
function fail(area, what, detail = '') { failures.push({ area, what, detail: String(detail).slice(0, 400) }); console.log(`  [실패] ${area} — ${what}${detail ? ': ' + String(detail).split('\n')[0].slice(0, 200) : ''}`); }
function pass(area, what) { passes.push({ area, what }); console.log(`  [통과] ${area} — ${what}`); }
function warn(area, what) { warnings.push({ area, what }); }

/* ---------------- 빌드 ---------------- */
if (!process.env.E2E_NO_BUILD) {
  try {
    const { buildPreview } = await import('../build-preview.mjs');
    const r = buildPreview({ quiet: true });
    console.log(`빌드: dist/preview.html ${(r.bytes / 1024 / 1024).toFixed(2)}MB${r.problems.length ? `, 문제 ${r.problems.length}건` : ''}`);
    for (const p of r.problems) fail('빌드', p);
  } catch (e) {
    fail('빌드', '빌드 실패', e && e.message);
  }
}
if (!fs.existsSync(path.join(DIST, 'preview.html'))) {
  console.error('dist/preview.html 이 없습니다 — node dev/build-preview.mjs 를 먼저 실행하세요');
  process.exit(1);
}

/* ---------------- http 서버 ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = decodeURIComponent(u.pathname);
  if (p === '/' || p === '') p = '/preview.html';
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = path.join(DIST, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('없음'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`미리보기 서버 ${BASE}/preview.html`);

fs.mkdirSync(SHOTS, { recursive: true });
const fontBytes = fs.existsSync(FONT) ? fs.readFileSync(FONT) : null;
const external = new Map();

/** 외부(CDN) 요청은 네트워크 없이 처리: 글꼴은 로컬 Pretendard 로, 나머지는 빈 응답 — 콘솔 오류가 네트워크 탓이 되지 않게 */
async function routeExternal(context) {
  await context.addInitScript(API_TRAP);
  await context.route((url) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url.href) && /^https?:/.test(url.href), async (route) => {
    const url = route.request().url();
    const host = new URL(url).host;
    external.set(host, (external.get(host) || 0) + 1);
    if (/\.(woff2?|ttf|otf)(\?|$)/i.test(url) && fontBytes) return route.fulfill({ status: 200, contentType: 'font/woff2', body: fontBytes });
    if (/\.css(\?|$)/i.test(url)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    if (/\.js(\?|$)/i.test(url)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    if (/\.(png|jpe?g|gif|svg|webp)(\?|$)/i.test(url)) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
    return route.fulfill({ status: 204, body: '' });
  });
}

/** 서버 api 응답 중 ok:false 를 모은다(window.__server 가 생길 때 api 를 감싼다) */
const API_TRAP = `(() => {
  window.__e2eApi = [];
  let srv;
  Object.defineProperty(window, '__server', {
    configurable: true,
    get() { return srv; },
    set(v) {
      srv = v;
      if (v && typeof v.api === 'function' && !v.api.__e2e) {
        const orig = v.api;
        const wrapped = function (m, p, t) {
          const r = orig.apply(this, arguments);
          try { const o = JSON.parse(r); if (o && o.ok === false && o.code !== 'AUTH') window.__e2eApi.push({ m, code: o.code, error: o.error, hash: location.hash }); } catch (e) {}
          return r;
        };
        wrapped.__e2e = true;
        v.api = wrapped;
      }
    }
  });
})();`;

async function apiErrors(page) {
  return page.evaluate(() => { const a = window.__e2eApi || []; window.__e2eApi = []; return a; }).catch(() => []);
}

/** 페이지의 콘솔 error·pageerror 를 지금 화면 이름으로 모은다 */
function watchConsole(page, label) {
  const st = { screen: '(시작)', errors: [], warns: 0 };
  page.on('console', (msg) => {
    if (msg.type() === 'error') st.errors.push({ screen: st.screen, text: msg.text() });
    else if (msg.type() === 'warning') st.warns++;
  });
  page.on('pageerror', (err) => st.errors.push({ screen: st.screen, text: 'pageerror: ' + (err && (err.stack || err.message) || err) }));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('crash', () => st.errors.push({ screen: st.screen, text: '페이지가 멈췄습니다(crash)' }));
  st.label = label;
  return st;
}

async function settle(page, ms = 8000) {
  await page.waitForFunction(() => {
    const p = document.getElementById('page') || document.getElementById('app');
    if (!p) return false;
    return !p.querySelector('.skel') && !document.querySelector('.login-loading, [data-loading="1"]');
  }, null, { timeout: ms, polling: 100 }).catch(() => {});
  await page.waitForTimeout(250);
}

async function go(page, hash) {
  await page.evaluate((h) => {
    if (location.hash === h) {
      if (window.App && typeof App.route === 'function') App.route();
      else window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else {
      location.hash = h;
    }
  }, hash);
  await settle(page);
}

async function shot(page, name) {
  const file = path.join(SHOTS, name + '.png');
  // 알림(토스트)이 내용을 가리지 않게 찍는 동안만 숨긴다
  await page.evaluate(() => { const t = document.getElementById('toasts'); if (t) t.style.visibility = 'hidden'; }).catch(() => {});
  try { return await shotRaw(page, file); } finally {
    await page.evaluate(() => { const t = document.getElementById('toasts'); if (t) t.style.visibility = ''; }).catch(() => {});
  }
}
async function shotRaw(page, file) {
  try { await page.screenshot({ path: file, fullPage: true, timeout: 20000 }); } catch (e) {
    try { await page.screenshot({ path: file, timeout: 20000 }); } catch (e2) { warn('스크린샷', `${path.basename(file)}: ${e2.message}`); }
  }
  return path.relative(ROOT, file);
}

/** 화면 한 개 검사: 비어 있음·홈으로 튕김·가로 넘침·h1 */
async function inspectScreen(page, st, width, name, hash) {
  st.screen = `${width}-${name}`;
  const before = st.errors.length;
  try {
    await go(page, hash);
  } catch (e) {
    fail(`화면 ${width}`, `${name} 열기 실패`, e.message);
    return;
  }
  const info = await page.evaluate(() => {
    const p = document.getElementById('page');
    const h1 = p ? p.querySelectorAll('h1').length : 0;
    return {
      hash: location.hash,
      text: p ? p.innerText.trim().length : 0,
      h1,
      err: p ? Array.from(p.querySelectorAll('.err')).map((e) => e.innerText.trim().slice(0, 120)) : [],
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
      wide: (() => {
        if (document.documentElement.scrollWidth <= window.innerWidth) return [];
        const out = [];
        const all = document.querySelectorAll('#app *');
        for (let i = 0; i < all.length && out.length < 3; i++) {
          const r = all[i].getBoundingClientRect();
          if (r.right > window.innerWidth + 1 && r.width > 0) {
            const el = all[i];
            out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '') + ` (오른쪽 ${Math.round(r.right)}px)`);
          }
        }
        return out;
      })(),
      shell: !!document.querySelector('.shell')
    };
  });
  const file = await shot(page, `${width}-${name}`);
  const problems = [];
  const apiErrs = await apiErrors(page);
  for (const e of apiErrs) {
    if (e.code === 'SERVER') problems.push(`서버 오류 ${e.m}: ${e.error}`);
    else warn(`화면 ${width}`, `${name}: api ${e.m} → ${e.code} ${e.error}`);
  }
  if (!info.shell) problems.push('셸(.shell)이 없습니다');
  if (info.text < 10) problems.push('화면이 비어 있습니다');
  const wantHome = /^#\/home/.test(hash);
  if (!wantHome && /^#\/home/.test(info.hash) && hash !== '#/home') problems.push(`경로가 없어 홈으로 이동했습니다(${hash})`);
  if (info.sw > info.iw) problems.push(`가로 넘침 scrollWidth ${info.sw} > ${info.iw} ${info.wide.join(', ')}`);
  if (info.err.length) problems.push('오류 블록: ' + info.err.join(' / '));
  const errs = st.errors.slice(before);
  if (errs.length) problems.push(`콘솔 오류 ${errs.length}건: ${errs.slice(0, 2).map((e) => e.text.split('\n')[0].slice(0, 160)).join(' | ')}`);
  if (info.h1 !== 1) warn(`화면 ${width}`, `${name}: h1 ${info.h1}개(규칙: 화면마다 1개)`);
  if (problems.length) fail(`화면 ${width}`, name, problems.join(' · '));
  else pass(`화면 ${width}`, `${name} (${file})`);
}

/* ---------------- 시험 ---------------- */
const browser = await chromium.launch();
let hqCtx, hqPage, hqSt;
let demoOk = false;
try {
  /* 1) 본사 + 예시 데이터 */
  console.log('\n[본사] ?demo=1 로 열고 예시 데이터 적재를 기다립니다');
  hqCtx = await browser.newContext({ viewport: { width: WIDTHS[0] || 1440, height: HEIGHT[WIDTHS[0]] || 900 }, deviceScaleFactor: 1, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  await routeExternal(hqCtx);
  hqPage = await hqCtx.newPage();
  hqSt = watchConsole(hqPage, 'hq');
  hqSt.screen = '데모 적재';
  const tLoad = Date.now();
  await hqPage.goto(`${BASE}/preview.html?demo=1`, { waitUntil: 'load', timeout: 60000 });
  const hasRuntime = await hqPage.evaluate(() => !!(window.__mock && window.__server && window.google && google.script && google.script.run));
  if (!hasRuntime) fail('런타임', '미리보기 런타임(__mock·__server·google.script.run)이 없습니다');
  else pass('런타임', '__mock·__server·google.script.run 준비');
  try {
    // 성공(셸 + 기록) 또는 끝난 실패(로그인·설치 화면이 15초 넘게 그대로)까지 기다린다. 최대 120초.
    let loginSince = 0;
    for (;;) {
      const st = await hqPage.evaluate(() => {
        const m = window.__mock;
        return {
          ok: !!(m && document.querySelector('.shell') && m.table('records').length > 0 && m.table('sites').length > 0),
          login: !!document.querySelector('.login-form') && !document.querySelector('.shell')
        };
      }).catch(() => ({ ok: false, login: false }));
      if (st.ok) break;
      if (st.login) { loginSince = loginSince || Date.now(); if (Date.now() - loginSince > 15000) throw new Error('로그인·설치 화면에서 멈췄습니다'); }
      else loginSince = 0;
      if (Date.now() - tLoad > 120000) throw new Error('시간 초과');
      await hqPage.waitForTimeout(500);
    }
    await settle(hqPage, 20000);
    const n = await hqPage.evaluate(() => ({ sites: __mock.table('sites').length, records: __mock.table('records').length, acts: __mock.table('acts').length, requests: __mock.table('requests').length, size: __mock.storageSize() }));
    demoOk = true;
    pass('예시 데이터', `${((Date.now() - tLoad) / 1000).toFixed(1)}초 — 사업장 ${n.sites} · 기록 ${n.records} · 조치 ${n.acts} · 요청 ${n.requests} (저장 ${(n.size / 1024).toFixed(0)}KB)`);
  } catch (e) {
    const why = await hqPage.evaluate(() => ({
      shell: !!document.querySelector('.shell'), login: !!document.querySelector('.login'),
      records: window.__mock ? __mock.table('records').length : -1, text: (document.body.innerText || '').slice(0, 200)
    })).catch(() => ({}));
    fail('예시 데이터', '적재되지 않았습니다(' + e.message + ')', JSON.stringify(why));
    await shot(hqPage, 'fail-demo');
  }
  const loadErrs = hqSt.errors.filter((x) => x.screen === '데모 적재');
  if (loadErrs.length) fail('예시 데이터', `적재 중 콘솔 오류 ${loadErrs.length}건`, loadErrs.slice(0, 3).map((x) => x.text.split('\n')[0]).join(' | '));

  /* 2) 본사 화면 전부 */
  const ids = await hqPage.evaluate(() => {
    if (!window.__mock) return {};
    const t = (n) => __mock.table(n);
    const recs = t('records').filter((r) => String(r.deleted) !== 'true');
    const pick = (arr, f) => (arr.find(f) || arr[0] || {}).id || '';
    return {
      site: pick(t('sites'), (s) => s.status !== '종료'),
      rec: pick(recs, (r) => r.status === '제출'),
      act: pick(t('acts'), (a) => a.status === '조치중'),
      req: pick(t('requests'), (r) => r.status === '진행')
    };
  });
  const screens = [
    ['home', '#/home'], ['collect', '#/collect'], ['review', '#/review'],
    ['requests', '#/requests'], ['requests-new', '#/requests/new'], ids.req && ['requests-detail', '#/requests/' + ids.req],
    ['forms', '#/forms'], ['records', '#/records'], ids.rec && ['rec-detail', '#/rec/' + ids.rec],
    ['acts', '#/acts'], ids.act && ['acts-detail', '#/acts/' + ids.act],
    ['analytics', '#/analytics'], ['analytics-incidents', '#/analytics/incidents'], ['analytics-risk', '#/analytics/risk'],
    ['analytics-daily', '#/analytics/daily'], ['analytics-edu', '#/analytics/edu'], ['analytics-acts', '#/analytics/acts'],
    ['analytics-hec', '#/analytics/hec'], ['analytics-sites', '#/analytics/sites'], ['analytics-form-F07', '#/analytics/form/F07'],
    ['sites', '#/sites'], ids.site && ['sites-detail', '#/sites/' + ids.site], ['users', '#/users'], ['settings', '#/settings'],
    ['search', '#/search?q=' + encodeURIComponent('소화기')]
  ].filter(Boolean).filter(([n]) => !ONLY || ONLY.includes(n));

  if (await hqPage.evaluate(() => !!document.querySelector('.shell'))) {
    for (const w of WIDTHS) {
      console.log(`\n[본사 화면] 폭 ${w}`);
      await hqPage.setViewportSize({ width: w, height: HEIGHT[w] || 900 });
      await hqPage.waitForTimeout(150);
      for (const [name, hash] of screens) await inspectScreen(hqPage, hqSt, w, name, hash);
    }
  } else {
    fail('본사 화면', '로그인 후 셸이 없어 화면 검사를 건너뜁니다');
    await shot(hqPage, 'fail-hq-shell');
  }

  /* 3) 사업장 흐름 */
  console.log('\n[사업장 흐름]');
  await siteFlow();
} catch (e) {
  fail('시험 진행', '예외', e && (e.stack || e.message));
} finally {
  await browser.close().catch(() => {});
  server.close();
}

async function siteFlow() {
  if (!hqPage || !(await hqPage.evaluate(() => !!window.__mock))) { fail('사업장', '본사 페이지가 없어 건너뜁니다'); return; }
  const site = await hqPage.evaluate(() => {
    const s = __mock.table('sites').filter((x) => x.status !== '종료' && x.token);
    const withShift = s.find((x) => /주간|야간/.test(String(x.shifts))) || s[0];
    return withShift ? { id: withShift.id, token: withShift.token, name: withShift.name } : null;
  });
  if (!site) { fail('사업장', '토큰이 있는 사업장이 모의 DB 에 없습니다'); return; }
  const db = await hqPage.evaluate((k) => { __mock.save(); return localStorage.getItem(k); }, KEY);
  if (!db) { fail('사업장', '본사 페이지의 모의 DB 를 저장소에서 읽지 못했습니다(용량 초과?)'); return; }

  const w = 390;
  const ctx = await browser.newContext({
    viewport: { width: w, height: HEIGHT[w] }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, locale: 'ko-KR', timezoneId: 'Asia/Seoul',
    storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: KEY, value: db }] }] }
  });
  await routeExternal(ctx);
  const page = await ctx.newPage();
  const st = watchConsole(page, 'site');
  st.screen = '사업장 로그인';
  try {
    await page.goto(`${BASE}/preview.html?s=${encodeURIComponent(site.token)}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('form.login-form, .login-form', { timeout: 20000 });
    const nameInput = page.locator('#site-name, .login-form input[name="name"]').first();
    await nameInput.fill('김현장');
    await shot(page, `${w}-site-login`);
    await page.locator('.login-form button[type="submit"]').first().click();
    await page.waitForSelector('.shell', { timeout: 20000 });
    const kind = await page.evaluate(() => (document.querySelector('.shell') || {}).getAttribute && document.querySelector('.shell').getAttribute('data-kind'));
    if (kind !== 'site') fail('사업장', '로그인 뒤 셸이 사업장(data-kind="site")이 아닙니다', kind);
    else pass('사업장', `${site.id} ${site.name} 링크로 로그인`);
    await settle(page);
  } catch (e) {
    fail('사업장', '링크 로그인 실패', e.message);
    await shot(page, `${w}-site-fail-login`);
    await ctx.close();
    return;
  }
  const loginErrs = st.errors.slice();
  if (loginErrs.length) fail('사업장', `로그인 중 콘솔 오류 ${loginErrs.length}건`, loginErrs.slice(0, 2).map((x) => x.text.split('\n')[0]).join(' | '));

  // 사업장 화면들
  const siteScreens = [['site-home', '#/home'], ['site-inbox', '#/inbox'], ['site-records', '#/records'], ['site-acts', '#/acts'], ['site-site', '#/site']]
    .filter(([n]) => !ONLY || ONLY.includes(n) || ONLY.includes('site'));
  for (const sw of [390, 1440].filter((x) => WIDTHS.includes(x) || x === 390)) {
    await page.setViewportSize({ width: sw, height: HEIGHT[sw] || 900 });
    for (const [name, hash] of siteScreens) await inspectScreen(page, st, sw, name, hash);
  }
  await page.setViewportSize({ width: w, height: HEIGHT[w] });

  // 일일점검 새로 작성
  st.screen = '일일점검 작성';
  const startKst = new Date(Date.now() + 9 * 3600e3 - 5000).toISOString().slice(0, 19);
  let recId = null;
  try {
    await go(page, '#/home');
    const cta = page.locator('#page a, #page button').filter({ hasText: /오늘 일일점검 쓰기|일일점검 이어서 쓰기|일일점검 쓰기/ }).first();
    if (await cta.count()) {
      await cta.click();
    } else {
      warn('사업장', '홈에서 "오늘 일일점검 쓰기" 버튼을 찾지 못해 #/new/F07/<사업장> 으로 이동합니다');
      await go(page, `#/new/F07/${site.id}`);
    }
    await page.waitForFunction(() => /^#\/(new|edit)\//.test(location.hash), null, { timeout: 10000 });
    await settle(page);
    const inEditor = await page.evaluate(() => (document.getElementById('page') || {}).innerText || '');
    if (!/점검/.test(inEditor)) throw new Error('편집기 화면이 그려지지 않았습니다: ' + location.hash);
    await shot(page, `${w}-site-f07-new`);

    // 필수 입력 채우기(선택 뒤 새로 나타나는 칸이 있어 두 번)
    let filled = await fillVisible(page);
    filled += await pickChoices(page);
    filled += await fillVisible(page);
    // 전부 양호
    const allGood = page.locator('#page button, #page [role="button"]').filter({ hasText: /전부 양호|모두 양호/ });
    const nAll = await allGood.count();
    if (nAll) {
      for (let i = 0; i < nAll; i++) await allGood.nth(i).click().catch(() => {});
    } else {
      const goods = page.locator('#page button').filter({ hasText: /^\s*양호\s*$/ });
      const n = await goods.count();
      for (let i = 0; i < n; i++) await goods.nth(i).click().catch(() => {});
      warn('사업장', `'전부 양호' 버튼이 없어 양호 ${n}개를 하나씩 눌렀습니다`);
    }
    await page.waitForTimeout(300);
    await shot(page, `${w}-site-f07-filled`);
    pass('사업장', `일일점검 작성(입력 ${filled}칸, 전부 양호 ${nAll}회)`);

    // 제출
    st.screen = '일일점검 제출';
    const submitOnce = async () => {
      const submit = page.locator('button.btn.primary:visible, button.primary:visible').filter({ hasText: /제출/ });
      if (!(await submit.count())) throw new Error('보이는 제출 버튼(.btn.primary, "제출")을 찾지 못했습니다');
      await submit.last().click();
      const dlg = page.locator('dialog[open] button:visible, .dlg[open] button:visible').filter({ hasText: /제출|확인|보내기/ });
      await dlg.first().waitFor({ timeout: 2500 }).then(() => dlg.last().click()).catch(() => {});
      await page.waitForTimeout(600);
      const afterClick = await page.evaluate(() => {
        const t = (sel) => Array.from(document.querySelectorAll(sel)).map((e) => e.innerText.trim().replace(/\s+/g, ' ')).filter(Boolean);
        return [...t('#toasts .toast').map((x) => '토스트: ' + x.slice(0, 120)), ...t('dialog[open]').map((x) => '대화상자: ' + x.slice(0, 120))].join(' / ');
      }).catch(() => '');
      const id = await page.waitForFunction(({ siteId, since }) => {
        const r = __mock.table('records').filter((x) => x.site === siteId && x.form === 'F07' && x.status === '제출' && String(x.submittedAt) >= since);
        return r.length ? r[r.length - 1].id : null;
      }, { siteId: site.id, since: startKst }, { timeout: 15000, polling: 250 }).then((h) => h.jsonValue()).catch(() => null);
      return { id, afterClick };
    };
    // 사람처럼: 입력 뒤 자동 임시저장(3초)으로 기록 번호(#/edit/<id>)를 받은 다음 제출
    const autosaved = await page.waitForFunction(() => /^#\/edit\//.test(location.hash), null, { timeout: 8000, polling: 200 }).then(() => true).catch(() => false);
    if (!autosaved) warn('사업장', '입력 뒤 8초 안에 자동 임시저장(#/edit/<id>)이 일어나지 않았습니다');
    let attempt = await submitOnce();
    let afterClick = attempt.afterClick;
    recId = attempt.id;
    if (!recId && /기록 번호를 받지 못했습니다/.test(afterClick)) {
      // 저장(자동 3초) 전에 바로 제출하면 생기는 편집기 문제 — 사용자가 하듯 잠시 뒤 다시 누른다
      fail('사업장', '임시저장 전에 제출하면 "기록 번호를 받지 못했습니다"(다시 눌러도 같음)', 'JsEngine submit(): ed.busy=true 뒤 doSave(ed,false) → autosaveOk 가 busy 때문에 false → 저장 건너뜀, 자동저장 타이머도 지워져 다시 눌러도 실패. 칸 하나를 고쳐 자동저장을 일으킨 뒤 이어 갑니다');
      const ta = page.locator('#page textarea:visible').first();
      if (await ta.count()) await ta.fill('인계사항 없음');
      await page.waitForFunction(() => /^#\/edit\//.test(location.hash), null, { timeout: 8000, polling: 200 }).catch(() => {});
      attempt = await submitOnce();
      afterClick = attempt.afterClick;
      recId = attempt.id;
    }
    await settle(page);
    await shot(page, `${w}-site-f07-submitted`);
    if (!recId) {
      const why = await page.evaluate(() => {
        const t = (sel) => Array.from(document.querySelectorAll(sel)).map((e) => e.innerText.trim().replace(/\s+/g, ' ')).filter(Boolean);
        const own = __mock.table('records').filter((r) => r.form === 'F07').slice(-1)[0] || {};
        return [
          ...t('.field-err').slice(0, 5),
          ...t('dialog[open]').map((x) => '대화상자: ' + x.slice(0, 160)),
          ...t('#toasts .toast').map((x) => '토스트: ' + x.slice(0, 160)),
          ...(window.__e2eApi || []).map((x) => `api ${x.m} → ${x.code} ${x.error}`),
          '주소 ' + location.hash,
          '마지막 F07: ' + [own.id, own.status, own.submittedAt].join(' ')
        ].join(' / ');
      });
      throw new Error('제출된 F07 기록이 모의 DB 에 없습니다' + (afterClick ? ' — 제출 직후: ' + afterClick : '') + (why ? ' — 화면: ' + why : ''));
    }
    pass('사업장', `일일점검 제출 ${recId}`);
  } catch (e) {
    fail('사업장', '일일점검 작성·제출', e.message);
    await shot(page, `${w}-site-fail-f07`);
  }
  const flowErrs = st.errors.filter((x) => /일일점검/.test(x.screen));
  if (flowErrs.length) fail('사업장', `작성·제출 중 콘솔 오류 ${flowErrs.length}건`, flowErrs.slice(0, 3).map((x) => x.text.split('\n')[0]).join(' | '));

  // 본사 검토함에서 확인
  if (recId) {
    try {
      const db2 = await page.evaluate((k) => { __mock.save(); return localStorage.getItem(k); }, KEY);
      await hqPage.setViewportSize({ width: 1440, height: 900 });
      await hqPage.evaluate(({ k, v }) => { localStorage.setItem(k, v); }, { k: KEY, v: db2 });
      hqSt.screen = '검토 확인';
      await hqPage.reload({ waitUntil: 'load' });
      await hqPage.waitForSelector('.shell', { timeout: 30000 });
      await go(hqPage, '#/review');
      const item = hqPage.locator(`[data-id="${recId}"]`).first();
      await item.waitFor({ timeout: 10000 }).catch(() => {});
      if (!(await item.count())) throw new Error(`검토함에 ${recId} 가 보이지 않습니다`);
      await item.click();
      await hqPage.waitForTimeout(400);
      let okBtn = hqPage.locator(`button[data-act="hq.rvOk"][data-id="${recId}"]`).first();
      if (!(await okBtn.count())) okBtn = hqPage.locator('#page button.btn.primary').filter({ hasText: /^\s*확인\s*$/ }).first();
      await okBtn.click();
      const dlg = hqPage.locator('dialog[open] button').filter({ hasText: /확인/ });
      await dlg.first().waitFor({ timeout: 1500 }).then(() => dlg.last().click()).catch(() => {});
      await hqPage.waitForFunction((id) => __mock.table('records').some((r) => r.id === id && r.status === '확인'), recId, { timeout: 10000, polling: 250 });
      await settle(hqPage);
      await shot(hqPage, '1440-review-confirmed');
      pass('본사', `검토함에서 ${recId} 확인`);
    } catch (e) {
      fail('본사', '검토함 확인', e.message);
      await shot(hqPage, '1440-fail-review');
    }
    const rvErrs = hqSt.errors.filter((x) => x.screen === '검토 확인');
    if (rvErrs.length) fail('본사', `검토 중 콘솔 오류 ${rvErrs.length}건`, rvErrs.slice(0, 3).map((x) => x.text.split('\n')[0]).join(' | '));
  }
  await ctx.close();
}

/** 필수 표시가 있는 선택 단추 묶음(role=radiogroup)에서 아직 고르지 않은 것은 첫 단추를 누른다. → 누른 수 */
async function pickChoices(page) {
  const idx = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#page [role="radiogroup"]').forEach((g, i) => {
      g.setAttribute('data-e2e-rg', String(i));
      const field = g.closest('.field');
      const req = !!(field && field.querySelector('.req'));
      const chosen = g.querySelector('[aria-checked="true"], .on, [aria-pressed="true"]');
      const visible = !!(g.offsetWidth || g.offsetHeight);
      if (req && !chosen && visible) out.push(String(i));
    });
    return out;
  });
  let n = 0;
  for (const i of idx) {
    const b = page.locator(`[data-e2e-rg="${i}"] [role="radio"], [data-e2e-rg="${i}"] button`).first();
    if (await b.count()) { await b.click().catch(() => {}); n++; }
  }
  return n;
}

/** 편집기의 보이는 빈 입력을 무난한 값으로 채운다(숫자 0, 시각 08:30, 날짜 오늘, 필수 글·선택). → 채운 칸 수 */
async function fillVisible(page) {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const handles = await page.$$('#page input:visible, #page select:visible, #page textarea:visible');
  let n = 0;
  for (const h of handles) {
    try {
      const d = await h.evaluate((el) => ({
        tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || '').toLowerCase(), value: el.value, disabled: el.disabled || el.readOnly,
        req: el.required || !!(el.closest('.field') && el.closest('.field').querySelector('.req')),
        opts: el.tagName === 'SELECT' ? Array.from(el.options).map((o) => o.value).filter((v) => v !== '') : []
      }));
      if (d.disabled || d.value) continue;
      if (d.tag === 'select') { if (d.req && d.opts.length) { await h.selectOption(d.opts[0]); n++; } continue; }
      if (['checkbox', 'radio', 'file', 'hidden', 'button', 'submit', 'search', 'password', 'color', 'range'].includes(d.type)) continue;
      let v = null;
      if (d.type === 'number') v = '0';
      else if (d.type === 'time') v = '08:30';
      else if (d.type === 'date') v = today;
      else if (d.type === 'datetime-local') v = today + 'T08:30';
      else if (d.type === 'month') v = today.slice(0, 7);
      else if (d.req) v = d.tag === 'textarea' ? '특이사항 없음' : '이상 없음';
      if (v === null) continue;
      await h.fill(v);
      n++;
    } catch (e) { /* 사라진 칸 등은 넘어감 */ }
  }
  return n;
}

/* ---------------- 요약 ---------------- */
const allErrors = [...(hqSt ? hqSt.errors : [])];
console.log(`\n결과: 통과 ${passes.length} · 실패 ${failures.length} · 경고 ${warnings.length}  (${((Date.now() - T0) / 1000).toFixed(0)}초, 스크린샷 dev/shots/)`);
if (external.size) console.log(`외부 요청(네트워크 없이 대체): ${[...external.entries()].map(([h, c]) => `${h}×${c}`).join(', ')}`);
if (warnings.length) {
  console.log('경고:');
  for (const w of warnings.slice(0, 30)) console.log(`  - ${w.area}: ${w.what}`);
  if (warnings.length > 30) console.log(`  … ${warnings.length - 30}건 더`);
}
if (failures.length) {
  console.log('실패 요약:');
  for (const f of failures) console.log(`  - ${f.area} / ${f.what}${f.detail ? ' — ' + f.detail.split('\n')[0].slice(0, 300) : ''}`);
}
if (allErrors.length) {
  const uniq = new Map();
  for (const e of allErrors) { const k = e.text.split('\n')[0].slice(0, 200); if (!uniq.has(k)) uniq.set(k, e.screen); }
  console.log(`콘솔 오류(본사, 서로 다른 것 ${uniq.size}종):`);
  for (const [t, s] of [...uniq.entries()].slice(0, 15)) console.log(`  - [${s}] ${t}`);
}
process.exit(failures.length ? 1 : 0);
