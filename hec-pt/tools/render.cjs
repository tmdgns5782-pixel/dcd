// 빌드된 HTML을 슬라이드별 PNG(미리보기)와 PDF(제출 형식)로 렌더링한다.
// 사용: node hec-pt/tools/render.cjs hec-pt/landscape.html [--png-only] [--scale=1]
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

(async () => {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  const pngOnly = args.includes('--png-only');
  const scaleArg = args.find((a) => a.startsWith('--scale='));
  const scale = scaleArg ? parseFloat(scaleArg.split('=')[1]) : 1;
  const ROOT = path.resolve(__dirname, '..');
  const prevDir = path.join(ROOT, 'preview');
  const pdfDir = path.join(ROOT, 'pdf');
  fs.mkdirSync(prevDir, { recursive: true });
  fs.mkdirSync(pdfDir, { recursive: true });

  const browser = await chromium.launch();
  for (const f of files) {
    const abs = path.resolve(f);
    const name = path.basename(abs, '.html');
    const page = await browser.newPage({ viewport: { width: 2400, height: 2000 }, deviceScaleFactor: scale });
    await page.goto('file://' + abs);
    await page.evaluate(() => { document.documentElement.classList.add('static'); document.documentElement.style.setProperty('--s', 1); });
    await page.evaluate(() => document.fonts.ready);
    const fontsOk = await page.evaluate(() => document.fonts.check('700 20px Paperlogy'));
    const slides = await page.$$('.slide');
    for (let i = 0; i < slides.length; i++) {
      const out = path.join(prevDir, `${name}-${i + 1}.png`);
      await slides[i].screenshot({ path: out });
      console.log('png', path.relative(process.cwd(), out));
    }
    // 넘침 검사: 슬라이드 밖으로 나간 요소와 스크롤 넘침을 보고한다
    const issues = await page.evaluate(() => {
      const res = [];
      document.querySelectorAll('.slide').forEach((s, si) => {
        const sr = s.getBoundingClientRect();
        s.querySelectorAll('*').forEach((el) => {
          if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') return;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;
          if (r.right > sr.right + 1 || r.bottom > sr.bottom + 1 || r.left < sr.left - 1 || r.top < sr.top - 1) {
            res.push(`slide ${si + 1}: <${el.tagName.toLowerCase()} class="${el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className}"> outside slide`);
          }
          if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible' && el !== s) {
            res.push(`slide ${si + 1}: <${el.tagName.toLowerCase()} class="${el.className}"> content wider than box`);
          }
        });
      });
      return res;
    });
    console.log(fontsOk ? 'fonts: Paperlogy loaded' : 'fonts: WARNING Paperlogy NOT loaded');
    console.log(issues.length ? 'overflow:\n  ' + issues.join('\n  ') : 'overflow: none');
    if (!pngOnly) {
      await page.emulateMedia({ media: 'print' });
      const out = path.join(pdfDir, `${name}.pdf`);
      await page.pdf({ path: out, preferCSSPageSize: true, printBackground: true });
      console.log('pdf', path.relative(process.cwd(), out));
    }
    await page.close();
  }
  await browser.close();
})();
