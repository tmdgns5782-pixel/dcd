// Export every slide of the HTML draft as a 1920x1080 PNG (Chromium, Paperlogy embedded).
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

(async () => {
  const [file, outDir, prefix = "onseok-briefing"] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  await page.goto("file://" + path.resolve(file) + "#raw");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const slides = await page.$$(".slide");
  for (let i = 0; i < slides.length; i++) {
    const out = path.join(outDir, `${prefix}-${String(i + 1).padStart(2, "0")}.png`);
    await slides[i].screenshot({ path: out });
    console.log(out);
  }
  await browser.close();
})();
