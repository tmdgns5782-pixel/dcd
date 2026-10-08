// 빌드된 HTML 시안을 같은 모양의 PPTX로 옮긴다.
// Chrome이 실제로 그린 결과에서 위치·크기·색·줄바꿈을 읽어 오므로 HTML과 똑같이 나온다.
//  - 글자: 화면에 보이는 줄마다 텍스트 상자 (수정 가능, 줄바꿈 위치 고정)
//  - 단색 상자·칩·원·점: PowerPoint 도형 (수정 가능)
//  - 그라데이션·곡선 연결선·로고 등 도형으로 똑같이 만들 수 없는 그림: 그 부분만 고해상도 PNG
//  - 겹치는 순서: Chrome의 실제 그리는 순서(elementsFromPoint)로 정렬
// 사용: node hec-pt/tools/to-pptx.cjs hec-pt/landscape.html hec-pt/portrait.html
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const PptxGenJS = require('pptxgenjs');
const sharp = require('sharp');

const DSF = 3; // 그림 조각 해상도 배율
const ROOT = path.resolve(__dirname, '..');

// 방향별 판형: px → inch. 가로 16:9(13.333×7.5in), 세로 A4(210×297mm)
const FORMATS = {
  landscape: { pxPerIn: 144, layout: 'HEC_16x9' },
  portrait: { pxPerIn: 150, layout: 'HEC_A4' },
};

const FACE = { 300: 'Paperlogy 3 Light', 400: 'Paperlogy 4 Regular', 500: 'Paperlogy 5 Medium', 600: 'Paperlogy 6 SemiBold', 700: 'Paperlogy 7 Bold', 800: 'Paperlogy 8 ExtraBold', 900: 'Paperlogy 9 Black' };
const faceFor = (w) => FACE[Math.min(900, Math.max(300, Math.round(w / 100) * 100))];

// ---------------------------------------------------------------- 페이지 안에서 실행
function prepare() {
  // 겹침 순서 측정용: 모든 요소를 맞힐 수 있게, SVG 내부는 루트로 묶는다. 문서 구조는 바꾸지 않는다
  const st = document.createElement('style');
  st.id = '__hit';
  st.textContent = '.slide, .slide * { pointer-events: auto !important; } .slide svg * { pointer-events: none !important; }';
  document.head.appendChild(st);
}

function extract(slideIndex) {
  const slide = document.querySelectorAll('.slide')[slideIndex];
  const S = slide.getBoundingClientRect();
  const rel = (r) => ({ x: r.left - S.left, y: r.top - S.top, w: r.width, h: r.height });

  // rgb()/rgba()와 color-mix()의 계산값 color(srgb r g b / a)를 모두 읽는다
  const parseColor = (c) => {
    if (!c) return null;
    let m = c.match(/rgba?\(([^)]+)\)/);
    let scale = 1;
    if (!m) { m = c.match(/color\(srgb ([^)]+)\)/); scale = 255; }
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat);
    const a = p.length > 3 ? p[3] : 1;
    const hex = p.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v * scale))).toString(16).padStart(2, '0')).join('').toUpperCase();
    return { hex, a };
  };
  const effOpacity = (el) => {
    let o = 1;
    for (let e = el; e && e !== slide.parentElement; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
    return o;
  };
  const pseudoPaints = (el) => ['::before', '::after'].some((p) => {
    const ps = getComputedStyle(el, p);
    return ps.content && ps.content !== 'none' && ps.content !== 'normal' && ps.display !== 'none';
  });

  // ---- 그림을 그리는 요소 분류
  let pid = 0;
  const items = [];
  const all = [slide, ...slide.querySelectorAll('*')];
  for (const el of all) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const tag = el.tagName.toLowerCase();
    const bg = parseColor(cs.backgroundColor);
    const hasBgImg = cs.backgroundImage && cs.backgroundImage !== 'none';
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map((s) => ({
      w: parseFloat(cs[`border${s}Width`]), style: cs[`border${s}Style`], c: parseColor(cs[`border${s}Color`]),
    }));
    const borderVisible = sides.some((b) => b.w > 0 && b.style !== 'none' && b.c && b.c.a > 0);
    const shadow = cs.boxShadow && cs.boxShadow !== 'none';
    const pseudo = pseudoPaints(el);
    const isSvg = tag === 'svg';
    const isImg = tag === 'img';
    const paints = isSvg || isImg || hasBgImg || shadow || pseudo || borderVisible || (bg && bg.a > 0);
    if (!paints) continue;
    if (el === slide) continue; // 슬라이드 바탕(흰색)은 배경으로 처리

    const op = effOpacity(el);
    const t = cs.transform;
    const translateOnly = t === 'none' || /^matrix\(1, 0, 0, 1,/.test(t);
    const uniformBorder = sides.every((b) => b.w === sides[0].w && b.style === sides[0].style && (b.c && sides[0].c ? b.c.hex === sides[0].c.hex && b.c.a === sides[0].c.a : b.c === sides[0].c));
    const radii = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map((k) => cs[`border${k}Radius`]);
    const uniformRadius = radii.every((r) => r === radii[0]);
    const borderOk = !borderVisible || (uniformBorder && sides[0].style === 'solid');
    const native = !isSvg && !isImg && !hasBgImg && !shadow && !pseudo && translateOnly && borderOk && uniformRadius && op > 0.999 && !radii[0].includes(' ');

    const id = `i${pid++}`;
    el.dataset.pid = id;
    const inline = cs.display === 'inline';
    const rects = (inline ? [...el.getClientRects()] : [el.getBoundingClientRect()]).map(rel).filter((r) => r.w > 0 && r.h > 0);
    if (!rects.length) continue;
    const it = { id, kind: native ? 'shape' : 'raster', rects, tag, cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) };
    if (native) {
      const r = rects[0];
      let radius = radii[0];
      let shape = 'rect';
      let rpx = 0;
      if (radius.endsWith('%')) {
        if (parseFloat(radius) >= 50) shape = 'ellipse';
        else { rpx = (parseFloat(radius) / 100) * Math.min(r.w, r.h); shape = rpx > 0 ? 'roundRect' : 'rect'; }
      } else {
        rpx = parseFloat(radius) || 0;
        if (rpx >= Math.min(r.w, r.h) / 2 - 0.5) shape = Math.abs(r.w - r.h) < 1 ? 'ellipse' : 'roundRect';
        else if (rpx > 0) shape = 'roundRect';
      }
      it.shape = shape;
      it.radius = Math.min(rpx, Math.min(r.w, r.h) / 2);
      it.fill = bg && bg.a > 0 ? bg : null;
      it.border = borderVisible ? { w: sides[0].w, c: sides[0].c } : null;
    } else {
      // 그림 조각 범위: 요소 + (SVG는 넘쳐 그린 부분) + 그림자 여유
      let b = el.getBoundingClientRect();
      let x0 = b.left, y0 = b.top, x1 = b.right, y1 = b.bottom;
      if (isSvg) {
        el.querySelectorAll('*').forEach((c) => {
          const r = c.getBoundingClientRect();
          if (r.width || r.height) { x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); }
        });
      }
      const pad = 12;
      it.clip = rel({ left: x0 - pad, top: y0 - pad, width: x1 - x0 + pad * 2, height: y1 - y0 + pad * 2 });
      if (!isSvg && !isImg) {
        it.pin = {
          bc: ['Top', 'Right', 'Bottom', 'Left'].map((sd) => cs[`border${sd}Color`]), bg: cs.backgroundColor, sh: cs.boxShadow,
          before: getComputedStyle(el, '::before').color, after: getComputedStyle(el, '::after').color,
        };
      }
    }
    items.push(it);
  }

  // ---- 겹침 순서: 격자 점마다 Chrome이 그린 위→아래 순서를 읽는다
  const idSet = new Set(items.map((i) => i.id));
  const edges = new Set();
  const step = 4;
  for (let y = S.top + 1; y < S.bottom; y += step) {
    for (let x = S.left + 1; x < S.right; x += step) {
      const list = document.elementsFromPoint(x, y)
        .map((e) => (e.closest('svg') ? e.closest('svg') : e))
        .map((e) => e.dataset && e.dataset.pid)
        .filter((p) => p && idSet.has(p));
      for (let k = 0; k + 1 < list.length; k++) if (list[k] !== list[k + 1]) edges.add(`${list[k + 1]}<${list[k]}`); // 아래<위
    }
  }

  // ---- 글자: 글자 하나하나의 위치로 화면의 줄을 그대로 재구성
  const blockOf = (el) => {
    for (let e = el.parentElement; e; e = e.parentElement) {
      const d = getComputedStyle(e).display;
      if (d !== 'inline' && d !== 'contents') return e;
    }
    return slide;
  };
  const blocks = new Map();
  const range = document.createRange();
  const tw = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
  while (tw.nextNode()) {
    const node = tw.currentNode;
    const sp = node.parentElement;
    if (sp.closest('svg, style, script')) continue;
    const cs = getComputedStyle(sp);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const col = parseColor(cs.color);
    if (!col || col.a === 0) continue;
    const op = effOpacity(sp);
    const block = cs.display !== 'inline' && cs.display !== 'contents' ? sp : blockOf(sp);
    const bcs = getComputedStyle(block);
    const style = {
      size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10), color: col.hex, alpha: col.a * op,
      ls: cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing),
    };
    const key = JSON.stringify(style);
    const upper = cs.textTransform === 'uppercase';
    if (!blocks.has(block)) blocks.set(block, { align: bcs.textAlign, glyphs: [] });
    const g = blocks.get(block).glyphs;
    for (let i = 0; i < node.data.length; i++) {
      range.setStart(node, i); range.setEnd(node, i + 1);
      const rs = range.getClientRects();
      if (!rs.length) continue;
      const r = rs[0];
      if (r.width === 0) continue;
      let ch = node.data[i];
      if (/\s/.test(ch)) ch = ' ';
      else if (upper) ch = ch.toUpperCase();
      g.push({ ch, l: r.left - S.left, r: r.right - S.left, t: r.top - S.top, b: r.bottom - S.top, key, style });
    }
  }
  const lines = [];
  for (const [, blk] of blocks) {
    let cur = null;
    for (const gl of blk.glyphs) {
      const mid = (gl.t + gl.b) / 2;
      const newLine = !cur || Math.abs(mid - cur.mid) > (gl.b - gl.t) * 0.5 || gl.l < cur.lastR - 2;
      if (newLine) { cur = { glyphs: [], mid, lastR: -1e9 }; lines.push({ align: blk.align, cur }); }
      cur.glyphs.push(gl);
      cur.lastR = gl.r;
    }
  }
  // 한 줄 안에 그림(인라인 SVG 아이콘 등)이 끼어 글자 사이가 벌어지면 그 자리에서 상자를 나눈다
  const segments = [];
  for (const { align, cur } of lines) {
    let seg = [];
    const parts = [seg];
    cur.glyphs.forEach((gl, i) => {
      const prev = cur.glyphs[i - 1];
      if (prev && gl.l - prev.r > Math.max(3, gl.style.size * 0.2)) { seg = []; parts.push(seg); }
      seg.push(gl);
    });
    parts.forEach((gs) => segments.push({ align: parts.length > 1 ? 'left' : align, cur: { glyphs: gs } }));
  }
  const textLines = segments.map(({ align, cur }) => {
    let gs = cur.glyphs;
    while (gs.length && gs[0].ch === ' ') gs = gs.slice(1);
    while (gs.length && gs[gs.length - 1].ch === ' ') gs = gs.slice(0, -1);
    if (!gs.length) return null;
    const runs = [];
    for (const gl of gs) {
      const last = runs[runs.length - 1];
      if (last && last.key === gl.key) last.text += gl.ch;
      else runs.push({ key: gl.key, text: gl.ch, style: gl.style });
    }
    const maxSize = Math.max(...gs.map((g) => g.style.size));
    const big = gs.filter((g) => g.style.size === maxSize);
    const top = Math.min(...big.map((g) => g.t));
    const bottom = Math.max(...big.map((g) => g.b));
    return { align, left: gs[0].l, right: gs[gs.length - 1].r, top, bottom, runs: runs.map(({ text, style }) => ({ text, style })) };
  }).filter(Boolean);

  return { size: { w: S.width, h: S.height }, items, edges: [...edges], text: textLines };
}

function isolate({ id, pin }) {
  const st = document.getElementById('__iso') || document.head.appendChild(Object.assign(document.createElement('style'), { id: '__iso' }));
  const T = `[data-pid="${id}"]`;
  let css = `
    html, body, .deck { background: transparent !important; }
    .slide { box-shadow: none !important; }
    .slide, .slide * { visibility: hidden !important; }
    ${T} { visibility: visible !important; }
    ${T} * { visibility: hidden !important; }
    svg${T} * { visibility: visible !important; }
  `;
  if (pin) {
    css += `${T} { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important;
      border-top-color: ${pin.bc[0]} !important; border-right-color: ${pin.bc[1]} !important; border-bottom-color: ${pin.bc[2]} !important; border-left-color: ${pin.bc[3]} !important;
      background-color: ${pin.bg} !important; box-shadow: ${pin.sh} !important; }
      ${T}::before { color: ${pin.before} !important; -webkit-text-fill-color: ${pin.before} !important; }
      ${T}::after { color: ${pin.after} !important; -webkit-text-fill-color: ${pin.after} !important; }`;
  }
  st.textContent = css;
}
function unisolate() { const st = document.getElementById('__iso'); if (st) st.textContent = ''; }

// ---------------------------------------------------------------- Node 쪽
function order(items, edges) {
  const idx = new Map(items.map((it, i) => [it.id, i]));
  const out = new Map(items.map((it) => [it.id, []]));
  const indeg = new Map(items.map((it) => [it.id, 0]));
  for (const e of edges) {
    const [lo, hi] = e.split('<');
    if (!idx.has(lo) || !idx.has(hi)) continue;
    out.get(lo).push(hi);
    indeg.set(hi, indeg.get(hi) + 1);
  }
  const ready = items.filter((it) => indeg.get(it.id) === 0).map((it) => it.id);
  const res = [];
  const seen = new Set();
  while (res.length < items.length) {
    if (!ready.length) { // 순환이 있으면 문서 순서로 끊는다
      const rest = items.find((it) => !seen.has(it.id));
      ready.push(rest.id);
      indeg.set(rest.id, 0);
    }
    ready.sort((a, b) => idx.get(a) - idx.get(b));
    const id = ready.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    res.push(id);
    for (const n of out.get(id)) { indeg.set(n, indeg.get(n) - 1); if (indeg.get(n) === 0 && !seen.has(n)) ready.push(n); }
  }
  return res.map((id) => items[idx.get(id)]);
}

async function convert(file) {
  const name = path.basename(file, '.html');
  const fmt = FORMATS[name] || FORMATS.landscape;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 2400, height: 2200 }, deviceScaleFactor: DSF });
  await page.goto('file://' + path.resolve(file));
  await page.evaluate(() => { document.documentElement.classList.add('static'); document.documentElement.style.setProperty('--s', 1); });
  await page.evaluate(() => document.fonts.ready);
  // 글자를 감싸기 전후로 모든 요소의 위치를 비교해, 1px이라도 바뀌면 멈춘다
  // (그리지 않는 <br>은 제외하고, 글자 노드는 글자 범위의 위치로 비교)
  const snap = () => page.evaluate(() => {
    const out = [...document.querySelectorAll('.slide *:not(br)')].map((e) => e.getBoundingClientRect());
    window.__textNodes = window.__textNodes || (() => { const a = []; document.querySelectorAll('.slide').forEach((sl) => { const w = document.createTreeWalker(sl, NodeFilter.SHOW_TEXT); while (w.nextNode()) if (w.currentNode.data.trim()) a.push(w.currentNode); }); return a; })();
    const rg = document.createRange();
    window.__textNodes.forEach((n) => { rg.selectNodeContents(n); out.push(rg.getBoundingClientRect()); });
    return out.map((r) => [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2) / 2).join(','));
  });
  const before = await snap();
  await page.evaluate(prepare);
  const after = await snap();
  const moved = before.filter((v, i) => v !== after[i]).length;
  if (moved || before.length !== after.length) {
    const diffs = before.map((v, i) => (v !== after[i] ? `${i}: ${v} -> ${after[i]}` : null)).filter(Boolean);
    const texts = await page.evaluate((idx) => idx.map((i) => { const n = document.querySelectorAll('.slide *:not(br)').length; return i >= n ? JSON.stringify(window.__textNodes[i - n].data) : document.querySelectorAll('.slide *:not(br)')[i].outerHTML.slice(0, 80); }), diffs.map((d) => parseInt(d, 10)));
    throw new Error(`${name}: 글자 감싸기 후 ${moved}개 요소의 레이아웃이 바뀜\n${diffs.map((d, i) => d + '  ' + texts[i]).join('\n')}`);
  }

  const nSlides = await page.evaluate(() => document.querySelectorAll('.slide').length);
  const pres = new PptxGenJS();
  const first = await page.evaluate(() => { const r = document.querySelector('.slide').getBoundingClientRect(); return { w: r.width, h: r.height }; });
  const k = 1 / fmt.pxPerIn; // px → inch
  const ptPerPx = 72 / fmt.pxPerIn;
  pres.defineLayout({ name: fmt.layout, width: first.w * k, height: first.h * k });
  pres.layout = fmt.layout;
  pres.theme = { headFontFace: FACE[800], bodyFontFace: FACE[500] };
  pres.title = name === 'portrait' ? '현대엔지니어링 PT · 세로형' : '현대엔지니어링 PT · 가로형';

  const stats = { shapes: 0, images: 0, lines: 0 };
  for (let si = 0; si < nSlides; si++) {
    // 지금 장만 남겨 화면 맨 위에 둔다(캡처 범위가 화면 안에 들어오도록)
    await page.evaluate((i) => document.querySelectorAll('.slide').forEach((s, j) => { s.style.display = j === i ? '' : 'none'; }), si);
    const data = await page.evaluate(extract, si);
    const slide = pres.addSlide();
    slide.background = { color: 'FFFFFF' };
    const S = await page.evaluate((i) => { const r = document.querySelectorAll('.slide')[i].getBoundingClientRect(); return { x: r.left, y: r.top }; }, si);

    for (const it of order(data.items, data.edges)) {
      if (it.kind === 'shape') {
        for (const r of it.rects) {
          const bw = it.border ? it.border.w : 0;
          const x = (r.x + bw / 2) * k, y = (r.y + bw / 2) * k, w = (r.w - bw) * k, h = (r.h - bw) * k;
          const opt = { x, y, w, h, objectName: `${it.cls || it.tag}`.trim().slice(0, 60) || 'shape' };
          opt.fill = it.fill ? { color: it.fill.hex, transparency: Math.round((1 - it.fill.a) * 100) } : { type: 'none' };
          opt.line = it.border ? { color: it.border.c.hex, width: bw * ptPerPx, transparency: Math.round((1 - it.border.c.a) * 100) } : { type: 'none' };
          let type = pres.ShapeType.rect;
          if (it.shape === 'ellipse') type = pres.ShapeType.ellipse;
          else if (it.shape === 'roundRect') { type = pres.ShapeType.roundRect; opt.rectRadius = Math.max(0, it.radius - bw / 2) * k; }
          slide.addShape(type, opt);
          stats.shapes++;
        }
      } else {
        await page.evaluate(isolate, { id: it.id, pin: it.pin || null });
        const c = it.clip;
        const shot = await page.screenshot({ clip: { x: S.x + c.x, y: S.y + c.y, width: c.w, height: c.h }, omitBackground: true });
        await page.evaluate(unisolate);
        const img = sharp(shot);
        const { data: raw, info } = await img.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        // 투명 여백을 잘라 실제 그림 범위만 남긴다
        let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
        for (let yy = 0; yy < info.height; yy++) for (let xx = 0; xx < info.width; xx++) {
          if (raw[(yy * info.width + xx) * 4 + 3] > 0) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
        }
        if (x1 < 0) continue;
        const png = await sharp(shot).extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }).png({ compressionLevel: 9 }).toBuffer();
        slide.addImage({
          data: 'image/png;base64,' + png.toString('base64'),
          x: (c.x + x0 / DSF) * k, y: (c.y + y0 / DSF) * k, w: ((x1 - x0 + 1) / DSF) * k, h: ((y1 - y0 + 1) / DSF) * k,
          altText: it.cls || it.tag, objectName: `${it.cls || it.tag}`.trim().slice(0, 60) || 'graphic',
        });
        stats.images++;
      }
    }

    for (const ln of data.text) {
      const runs = ln.runs.map((r) => ({
        text: r.text,
        options: {
          fontFace: faceFor(r.style.weight), fontSize: +(r.style.size * ptPerPx).toFixed(2), color: r.style.color,
          transparency: r.style.alpha < 0.999 ? Math.round((1 - r.style.alpha) * 100) : undefined,
          charSpacing: r.style.ls ? +(r.style.ls * ptPerPx).toFixed(2) : undefined, lang: 'ko-KR',
        },
      }));
      const width = ln.right - ln.left;
      const slack = Math.max(8, width * 0.06);
      const align = /center/.test(ln.align) ? 'center' : /right|end/.test(ln.align) ? 'right' : 'left';
      let x = ln.left;
      if (align === 'center') x -= slack / 2; else if (align === 'right') x -= slack;
      slide.addText(runs, {
        x: x * k, y: ln.top * k, w: (width + slack) * k, h: (ln.bottom - ln.top) * k,
        margin: 0, valign: 'middle', align, wrap: false, isTextBox: true, fit: 'none',
        objectName: runs.map((r) => r.text).join('').slice(0, 40),
      });
      stats.lines++;
    }
  }
  await browser.close();
  const outDir = path.join(ROOT, 'pptx');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${name}.pptx`);
  await pres.writeFile({ fileName: out });
  // 한글 글꼴이 테마 기본(맑은 고딕 등)으로 바뀌지 않도록 동아시아 글꼴(ea)도 같은 이름으로 지정
  await fixEastAsianFonts(out);
  console.log(`${path.relative(process.cwd(), out)}: ${nSlides} slides, ${stats.shapes} shapes, ${stats.images} images, ${stats.lines} text lines`);
}

async function fixEastAsianFonts(file) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const names = Object.keys(zip.files).filter((n) => /^ppt\/(slides\/slide\d+|theme\/theme\d+|slideMasters\/slideMaster\d+|slideLayouts\/slideLayout\d+)\.xml$/.test(n));
  for (const n of names) {
    let xml = await zip.file(n).async('string');
    // <a:latin typeface="X" .../> 뒤에 ea가 없으면 같은 글꼴로 ea를 넣는다
    xml = xml.replace(/<a:latin typeface="([^"]+)"([^>]*)\/>(?!<a:ea)/g, (m, face, rest) => `<a:latin typeface="${face}"${rest}/><a:ea typeface="${face}"${rest}/>`);
    // pptxgenjs는 ea 글꼴에 중국어 문자셋(-122)을 붙인다 → 한국어(-127)로
    xml = xml.replace(/(<a:ea typeface="[^"]+" pitchFamily="\d+") charset="-122"/g, '$1 charset="-127"');
    // 테마의 동아시아 기본 글꼴도 페이퍼로지로
    xml = xml.replace(/<a:ea typeface=""\/>/g, `<a:ea typeface="${FACE[500]}"/>`);
    zip.file(n, xml);
  }
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

(async () => {
  const files = process.argv.slice(2);
  for (const f of files) await convert(f);
})();
