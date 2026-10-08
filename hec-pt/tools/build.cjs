// src/*.html → hec-pt/*.html (폰트·CSS·JS를 모두 파일 안에 넣은 단일 파일)
// 사용: node hec-pt/tools/build.cjs [src/landscape.html ...]
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const targets = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => path.resolve(p))
  : fs.readdirSync(SRC).filter((f) => f.endsWith('.html')).map((f) => path.join(SRC, f));

function inlineFonts(css, baseDir) {
  return css.replace(/url\("([^"]+\.woff2)"\)/g, (_, rel) => {
    const file = path.resolve(baseDir, rel);
    const b64 = fs.readFileSync(file).toString('base64');
    return `url("data:font/woff2;base64,${b64}")`;
  });
}

for (const file of targets) {
  let html = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  html = html.replace(/<!-- @include ([^ ]+) -->/g, (_, rel) => fs.readFileSync(path.resolve(dir, rel), 'utf8').trim());
  html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) => {
    const cssPath = path.resolve(dir, href);
    const css = inlineFonts(fs.readFileSync(cssPath, 'utf8'), path.dirname(cssPath));
    return `<style>\n${css}\n</style>`;
  });
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
    const js = fs.readFileSync(path.resolve(dir, src), 'utf8');
    return `<script>\n${js}\n</script>`;
  });
  // 공식 로고(hec-pt/logo.svg 또는 logo.png)가 있으면 파일 안에 넣는다. 없으면 점선 자리표시가 보인다.
  const logo = ['logo.svg', 'logo.png'].map((f) => path.join(ROOT, f)).find((f) => fs.existsSync(f));
  if (logo) {
    const mime = logo.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    const uri = `data:${mime};base64,${fs.readFileSync(logo).toString('base64')}`;
    html = html.split('src="logo.png"').join(`src="${uri}"`);
  }
  const outArg = process.env.OUT;
  const out = outArg ? path.resolve(outArg) : path.join(ROOT, path.basename(file));
  fs.writeFileSync(out, html);
  console.log(`built ${path.relative(process.cwd(), out)} (${(html.length / 1024).toFixed(0)} KB)`);
}
