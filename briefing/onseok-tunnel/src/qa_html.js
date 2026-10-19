// Screenshot every slide of the HTML draft and flag text that wraps or overflows its box.
const path = require("path");
const { chromium } = require("playwright");

(async () => {
  const [file, outDir, only] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.goto("file://" + path.resolve(file) + "#raw");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const issues = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".slide").forEach((slide, si) => {
      slide.querySelectorAll(".tx").forEach((el) => {
        const inn = el.querySelector(".in");
        const lines = +el.dataset.lines, s = +el.dataset.s, lh = +el.dataset.lh;
        const expected = lines * s * (4 / 3) * lh;
        const h = inn.getBoundingClientRect().height;
        const boxH = el.clientHeight;
        // natural (unwrapped) width of the widest explicit line
        const probe = inn.cloneNode(true);
        probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;width:auto;display:inline-block";
        el.appendChild(probe);
        const natW = probe.getBoundingClientRect().width;
        probe.remove();
        const boxW = el.clientWidth;
        const txt = inn.textContent.slice(0, 40);
        const slack = (boxW - natW) / boxW;
        if (h > expected * 1.12 + 1) out.push(`s${si + 1} WRAP   "${txt}" h=${h.toFixed(0)} exp=${expected.toFixed(0)}`);
        if (h > boxH + 1) out.push(`s${si + 1} VOVER  "${txt}" h=${h.toFixed(0)} box=${boxH}`);
        if (slack < 0.04) out.push(`s${si + 1} TIGHT  "${txt}" nat=${natW.toFixed(0)} box=${boxW} slack=${(slack * 100).toFixed(1)}%`);
      });
    });
    return out;
  });
  console.log(issues.length ? issues.join("\n") : "no text issues");
  if (outDir) {
    const slides = await page.$$(".slide");
    for (let i = 0; i < slides.length; i++) {
      if (only && !only.split(",").includes(String(i + 1))) continue;
      await slides[i].screenshot({ path: path.join(outDir, `html-${String(i + 1).padStart(2, "0")}.png`) });
    }
  }
  await browser.close();
})();
