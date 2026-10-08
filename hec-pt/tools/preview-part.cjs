// 한 장만 미리보기: 다른 작업자와 출력 파일이 겹치지 않도록 임시 파일로 빌드한다.
// 사용: node hec-pt/tools/preview-part.cjs landscape 2   → hec-pt/preview/parts/landscape-2.png
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

(async () => {
  const [orient, nStr] = process.argv.slice(2);
  const n = parseInt(nStr, 10);
  const ROOT = path.resolve(__dirname, '..');
  const tmp = path.join(os.tmpdir(), `hecpt-${orient}-${n}-${process.pid}.html`);
  execFileSync('node', [path.join(__dirname, 'build.cjs'), path.join(ROOT, 'src', `${orient}.html`)], { env: { ...process.env, OUT: tmp } });
  const outDir = path.join(ROOT, 'preview', 'parts');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 2400, height: 2000 } });
  await page.goto('file://' + tmp);
  await page.evaluate(() => { document.documentElement.classList.add('static'); document.documentElement.style.setProperty('--s', 1); });
  await page.evaluate(() => document.fonts.ready);
  const slide = (await page.$$('.slide'))[n - 1];
  const out = path.join(outDir, `${orient}-${n}.png`);
  await slide.screenshot({ path: out });
  const issues = await page.evaluate((idx) => {
    const res = [];
    const s = document.querySelectorAll('.slide')[idx];
    const sr = s.getBoundingClientRect();
    const body = s.querySelector('.body').getBoundingClientRect();
    const ft = s.querySelector('.ft').getBoundingClientRect();
    s.querySelectorAll('.body *').forEach((el) => {
      if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const name = `<${el.tagName.toLowerCase()} class="${typeof el.className === 'string' ? el.className : (el.className.baseVal || '')}">`;
      if (r.right > sr.right - 40 || r.left < sr.left + 40) res.push(`${name} too close to / past the side edge`);
      if (r.bottom > ft.top - 8) res.push(`${name} runs into the footer (bottom ${Math.round(r.bottom - sr.top)}px, footer top ${Math.round(ft.top - sr.top)}px)`);
      if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible') res.push(`${name} content wider than its box`);
      if (el.scrollHeight > el.clientHeight + 2 && getComputedStyle(el).overflow !== 'visible') res.push(`${name} content taller than its box`);
    });
    return { res, body: { top: Math.round(body.top - sr.top), bottom: Math.round(body.bottom - sr.top), height: Math.round(body.height), width: Math.round(body.width) } };
  }, n - 1);
  console.log('png', path.relative(process.cwd(), out));
  console.log('body box (px, relative to slide):', JSON.stringify(issues.body));
  console.log(issues.res.length ? 'issues:\n  ' + [...new Set(issues.res)].join('\n  ') : 'issues: none');
  await browser.close();
  fs.unlinkSync(tmp);
})();
