// 빌드된 HTML 시안을 같은 모양의 PPTX로 옮긴다.
// Chrome이 실제로 그린 결과에서 위치·크기·색·줄바꿈을 읽어 오므로 HTML과 똑같이 나온다.
//  - 글자: 화면에 보이는 줄마다 텍스트 상자 (수정 가능, 줄바꿈 위치 고정)
//  - 상자·칩·원·점·그라데이션 면·그라데이션 테두리·그림자: PowerPoint 도형 (수정 가능)
//  - SVG(아이콘·연결선·메달 등): 요소 하나하나를 자유형 도형/타원으로 (점 편집 가능)
//  - 사진·로고처럼 도형이 아닌 그림만 고해상도 PNG
//  - 겹치는 순서: Chrome의 실제 그리는 순서(elementsFromPoint)로 정렬
// 사용: node skh-pt/tools/to-pptx.cjs hec-pt/landscape.html hec-pt/portrait.html
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const PptxGenJS = require('pptxgenjs');
const sharp = require('sharp');
const svgpath = require('svgpath');

const DSF = 3; // 그림 조각 해상도 배율
const ROOT = path.resolve(__dirname, '..');

// 방향별 판형: px → inch. 가로 16:9(13.333×7.5in), 세로 A4(210×297mm)
const FORMATS = {
  landscape: { pxPerIn: 144, layout: 'HEC_16x9' },
  portrait: { pxPerIn: 150, layout: 'HEC_A4' },
};

const FAMILIES = {
  Paperlogy: { 300: ['Paperlogy 3 Light'], 400: ['Paperlogy 4 Regular'], 500: ['Paperlogy 5 Medium'], 600: ['Paperlogy 6 SemiBold'], 700: ['Paperlogy 7 Bold'], 800: ['Paperlogy 8 ExtraBold'], 900: ['Paperlogy 9 Black'] },
  // Windows에 설치되는 Pretendard 정적 글꼴 이름. Bold는 'Pretendard' 계열의 굵게(b=1)
  Pretendard: { 300: ['Pretendard Light'], 400: ['Pretendard'], 500: ['Pretendard Medium'], 600: ['Pretendard SemiBold'], 700: ['Pretendard', true], 800: ['Pretendard ExtraBold'], 900: ['Pretendard ExtraBold'] },
};
let FACE = FAMILIES.Paperlogy;
const pick = (w) => FACE[Math.min(900, Math.max(300, Math.round(w / 100) * 100))];
const faceFor = (w) => pick(w)[0];
const boldFor = (w) => !!pick(w)[1];

// ---------------------------------------------------------------- 페이지 안에서 실행
function prepare() {
  // 겹침 순서 측정용: 모든 요소를 맞힐 수 있게, SVG 내부는 루트로 묶는다. 문서 구조는 바꾸지 않는다
  const st = document.createElement('style');
  st.id = '__hit';
  st.textContent = '.slide, .slide * { pointer-events: auto !important; } .slide svg * { pointer-events: none !important; }'
    + ' [data-nopseudo]::before, [data-nopseudo]::after { content: none !important; }';
  // ::before/::after 장식(구분선·글머리 막대·괄호 등)은 같은 스타일의 실제 span으로 바꿔 도형으로 읽는다
  const made = [];
  document.querySelectorAll('.slide, .slide *').forEach((el) => {
    if (el.closest('svg')) return;
    for (const p of ['::before', '::after']) {
      const ps = getComputedStyle(el, p);
      if (!ps.content || ps.content === 'none' || ps.content === 'normal' || ps.display === 'none') continue;
      const sp = document.createElement('span');
      sp.dataset.pseudo = p;
      for (let i = 0; i < ps.length; i++) { const prop = ps[i]; if (prop !== 'content') sp.style.setProperty(prop, ps.getPropertyValue(prop)); }
      const m = ps.content.match(/^"([\s\S]*)"$/);
      if (m) sp.textContent = m[1].replace(/\\"/g, '"');
      made.push([el, p, sp]);
    }
  });
  document.head.appendChild(st);
  for (const [el, p, sp] of made) {
    el.setAttribute('data-nopseudo', '');
    if (p === '::before') el.insertBefore(sp, el.firstChild); else el.appendChild(sp);
  }
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
  const sub = (m) => [m.a, m.b, m.c, m.d, m.e - S.left, m.f - S.top];

  // SVG 칠(단색·그라데이션)을 화면 좌표로 읽는다
  const paintOf = (leaf, val, bbox, ctm) => {
    if (!val || val === 'none') return null;
    const u = val.match(/url\("?#([^")]+)"?\)/);
    if (!u) { const c = parseColor(val); return c ? { color: c } : null; }
    const g = document.getElementById(u[1]);
    if (!g) return null;
    const stops = [...g.querySelectorAll('stop')].map((s) => {
      const cs = getComputedStyle(s);
      const c = parseColor(cs.stopColor) || { hex: '000000', a: 1 };
      return { off: s.offset.baseVal, hex: c.hex, a: c.a * parseFloat(cs.stopOpacity || '1') };
    });
    if (g.tagName.toLowerCase() !== 'lineargradient') return { color: stops.length ? { hex: stops[0].hex, a: stops[0].a } : null };
    const num = (attr, def) => {
      const v = g.getAttribute(attr);
      if (v == null) return def;
      return v.trim().endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
    };
    const userSpace = g.getAttribute('gradientUnits') === 'userSpaceOnUse';
    let x1 = num('x1', 0), y1 = num('y1', 0), x2 = num('x2', userSpace ? 0 : 1), y2 = num('y2', 0);
    if (!userSpace) { x1 = bbox.x + x1 * bbox.width; x2 = bbox.x + x2 * bbox.width; y1 = bbox.y + y1 * bbox.height; y2 = bbox.y + y2 * bbox.height; }
    const tp = (x, y) => ({ x: ctm[0] * x + ctm[2] * y + ctm[4], y: ctm[1] * x + ctm[3] * y + ctm[5] });
    return { grad: { p1: tp(x1, y1), p2: tp(x2, y2), stops } };
  };

  // SVG 안의 그림 요소를 하나씩 도형 정보로
  const svgLeaves = (svg) => {
    const out = [];
    svg.querySelectorAll('path, line, circle, ellipse, rect, polygon, polyline').forEach((leaf) => {
      if (leaf.closest('defs, clipPath, mask, symbol, marker, pattern')) return;
      const cs = getComputedStyle(leaf);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const tag = leaf.tagName.toLowerCase();
      const ctm = sub(leaf.getScreenCTM());
      let geom;
      const A = (n) => leaf[n].baseVal.value;
      if (tag === 'path') geom = { type: 'path', d: leaf.getAttribute('d') || '' };
      else if (tag === 'line') geom = { type: 'path', d: `M${A('x1')} ${A('y1')}L${A('x2')} ${A('y2')}` };
      else if (tag === 'circle') geom = { type: 'ellipse', cx: A('cx'), cy: A('cy'), rx: A('r'), ry: A('r') };
      else if (tag === 'ellipse') geom = { type: 'ellipse', cx: A('cx'), cy: A('cy'), rx: A('rx'), ry: A('ry') };
      else if (tag === 'rect') geom = { type: 'rect', x: A('x'), y: A('y'), w: A('width'), h: A('height'), rx: leaf.rx.baseVal.value };
      else {
        const pts = [...leaf.points].map((p) => `${p.x} ${p.y}`);
        geom = { type: 'path', d: 'M' + pts.join('L') + (tag === 'polygon' ? 'Z' : '') };
      }
      let bbox;
      try { bbox = leaf.getBBox(); } catch (e) { bbox = { x: 0, y: 0, width: 0, height: 0 }; }
      // clip-path: 원을 원으로 자른 경우(벤다이어그램 겹친 부분)만 렌즈 모양으로 계산
      let clip = null;
      const cm = cs.clipPath && cs.clipPath.match(/url\("?#([^")]+)"?\)/);
      if (cm) {
        const cp = document.getElementById(cm[1]);
        const c = cp && cp.querySelector('circle');
        if (c) clip = { cx: c.cx.baseVal.value, cy: c.cy.baseVal.value, r: c.r.baseVal.value };
      }
      let op = parseFloat(cs.opacity);
      for (let e = leaf.parentElement; e; e = e.parentElement) { op *= parseFloat(getComputedStyle(e).opacity); if (e === slide) break; }
      out.push({
        geom, ctm, clip, op,
        fill: paintOf(leaf, cs.fill, bbox, ctm), fillOp: parseFloat(cs.fillOpacity),
        stroke: paintOf(leaf, cs.stroke, bbox, ctm), strokeOp: parseFloat(cs.strokeOpacity),
        sw: parseFloat(cs.strokeWidth), cap: cs.strokeLinecap, join: cs.strokeLinejoin,
        dash: cs.strokeDasharray && cs.strokeDasharray !== 'none' ? cs.strokeDasharray.split(/[ ,]+/).map(parseFloat).filter((v) => !isNaN(v)) : null,
        name: (leaf.getAttribute('class') || tag),
      });
    });
    return out;
  };

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
    const borderBox = sides.some((b) => b.w > 0 && b.style !== 'none'); // 투명 테두리(그라데이션 테두리 자리)
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
    const radii = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map((k) => cs[`border${k}Radius`]);
    const uniformRadius = radii.every((r) => r === radii[0]) && !radii[0].includes(' ');
    const gradOk = !hasBgImg || !/url\(/.test(cs.backgroundImage);

    const id = `i${pid++}`;
    el.dataset.pid = id;
    const inline = cs.display === 'inline';
    const rects = (inline ? [...el.getClientRects()] : [el.getBoundingClientRect()]).map(rel).filter((r) => r.w > 0 && r.h > 0);
    if (!rects.length) continue;
    const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).trim();
    const name = (el.dataset.pseudo ? `${el.parentElement.className || el.parentElement.tagName.toLowerCase()}${el.dataset.pseudo}` : cls) || tag;

    if (isSvg) {
      items.push({ id, kind: 'svg', rects, tag, cls: name, leaves: svgLeaves(el) });
      continue;
    }
    const native = !isImg && !pseudo && translateOnly && gradOk;
    if (native) {
      const r = rects[0];
      const radius = radii[0];
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
      // 모서리마다 반경이 다르면(괄호 모양 등) 모서리별 px 값으로
      const cornerPx = uniformRadius ? null : radii.map((v) => {
        const f = parseFloat(v) || 0;
        return Math.min(v.trim().split(/\s+/)[0].endsWith('%') ? (f / 100) * Math.min(r.w, r.h) : f, Math.min(r.w, r.h) / 2);
      });
      items.push({
        id, kind: 'box', rects, tag, cls: name, shape, radius: Math.min(rpx, Math.min(r.w, r.h) / 2), cornerPx, op,
        bg: bg && bg.a > 0 ? bg : null, bgImage: hasBgImg ? cs.backgroundImage : null, bgClip: cs.backgroundClip,
        sides: sides.map((s) => ({ w: s.w, style: s.style, c: s.c })), borderBox,
        shadow: shadow ? cs.boxShadow : null,
      });
      continue;
    }
    // 사진·로고 등: 그림 조각
    const it = { id, kind: 'raster', rects, tag, cls: name };
    const b = el.getBoundingClientRect();
    const pad = 12;
    it.clip = rel({ left: b.left - pad, top: b.top - pad, width: b.width + pad * 2, height: b.height + pad * 2 });
    if (!isImg) {
      it.pin = {
        bc: ['Top', 'Right', 'Bottom', 'Left'].map((sd) => cs[`border${sd}Color`]), bg: cs.backgroundColor, sh: cs.boxShadow,
        before: getComputedStyle(el, '::before').color, after: getComputedStyle(el, '::after').color,
      };
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

// ---------------------------------------------------------------- Node 쪽: CSS 해석
function parseColor(c) {
  if (!c) return null;
  if (c === 'transparent') return { hex: '000000', a: 0 };
  let m = c.match(/rgba?\(([^)]+)\)/);
  let scale = 1;
  if (!m) { m = c.match(/color\(srgb ([^)]+)\)/); scale = 255; }
  if (!m) { const h = c.match(/#([0-9a-f]{6})/i); return h ? { hex: h[1].toUpperCase(), a: 1 } : null; }
  const p = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat);
  const a = p.length > 3 ? p[3] : 1;
  const hex = p.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v * scale))).toString(16).padStart(2, '0')).join('').toUpperCase();
  return { hex, a };
}
// 괄호 밖의 쉼표로 나눈다
function splitTop(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const COLOR_RE = /^(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8}|transparent)\s*(.*)$/i;
function parseStops(args) {
  const stops = args.map((a) => {
    const m = a.match(COLOR_RE);
    if (!m) return null;
    const c = parseColor(m[1]);
    const pos = m[2] && /%$/.test(m[2].trim()) ? parseFloat(m[2]) / 100 : null;
    return { hex: c.hex, a: c.a, pos };
  }).filter(Boolean);
  if (!stops.length) return null;
  if (stops[0].pos == null) stops[0].pos = 0;
  if (stops[stops.length - 1].pos == null) stops[stops.length - 1].pos = 1;
  for (let i = 1; i < stops.length - 1; i++) {
    if (stops[i].pos != null) continue;
    let j = i; while (stops[j].pos == null) j++;
    const a = stops[i - 1].pos, b = stops[j].pos;
    for (let k = i; k < j; k++) stops[k].pos = a + ((b - a) * (k - i + 1)) / (j - i + 1);
  }
  return stops;
}
// CSS 그라데이션 하나 → { lin: DrawingML 각도 } 또는 { radial: 초점 } + 색 정지점
function parseGradient(s) {
  const m = s.match(/^(?:repeating-)?(linear|radial)-gradient\(([\s\S]*)\)$/);
  if (!m) return null;
  const args = splitTop(m[2]);
  if (m[1] === 'linear') {
    let ang = 180;
    if (!COLOR_RE.test(args[0])) {
      const a = args.shift();
      const dm = a.match(/(-?[\d.]+)(deg|turn|rad)/);
      if (dm) ang = dm[2] === 'turn' ? parseFloat(dm[1]) * 360 : dm[2] === 'rad' ? (parseFloat(dm[1]) * 180) / Math.PI : parseFloat(dm[1]);
      else {
        const dirs = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270, 'to top right': 45, 'to right top': 45, 'to bottom right': 135, 'to right bottom': 135, 'to bottom left': 225, 'to left bottom': 225, 'to top left': 315, 'to left top': 315 };
        ang = dirs[a.trim()] ?? 180;
      }
    }
    const stops = parseStops(args);
    return stops ? { lin: ang - 90, stops } : null;
  }
  let fx = 0.5, fy = 0.5;
  if (!COLOR_RE.test(args[0])) {
    const a = args.shift();
    const at = a.match(/at\s+(-?[\d.]+)%\s+(-?[\d.]+)%/);
    if (at) { fx = parseFloat(at[1]) / 100; fy = parseFloat(at[2]) / 100; }
  }
  const stops = parseStops(args);
  return stops ? { radial: { fx, fy }, stops } : null;
}
function parseShadows(s) {
  if (!s || s === 'none') return [];
  return splitTop(s).map((sh) => {
    const inset = /\binset\b/.test(sh);
    const cm = sh.match(/(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8})/i);
    const c = parseColor(cm ? cm[1] : 'rgb(0,0,0)');
    const nums = sh.replace(cm ? cm[1] : '', '').match(/-?[\d.]+px/g) || [];
    const [ox, oy, blur, spread] = nums.map(parseFloat).concat([0, 0, 0, 0]);
    return { inset, c, ox, oy, blur, spread };
  }).filter((x) => !x.inset && x.c && x.c.a > 0);
}
const lerp = (a, b, t) => a + (b - a) * t;
function mixStop(s0, s1, pos) {
  const t = s1.pos === s0.pos ? 0 : (pos - s0.pos) / (s1.pos - s0.pos);
  const ch = (i) => Math.round(lerp(parseInt(s0.hex.slice(i, i + 2), 16), parseInt(s1.hex.slice(i, i + 2), 16), t)).toString(16).padStart(2, '0');
  return { hex: (ch(0) + ch(2) + ch(4)).toUpperCase(), a: lerp(s0.a, s1.a, t), pos };
}
// 0~1 밖으로 나간 정지점은 경계에서 잘라 그 자리의 색을 보간
function clipStops(stops) {
  const s = [...stops].sort((a, b) => a.pos - b.pos);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const cur = s[i], prev = s[i - 1];
    if (prev && prev.pos < 0 && cur.pos > 0) out.push(mixStop(prev, cur, 0));
    if (cur.pos >= 0 && cur.pos <= 1) out.push(cur);
    if (prev && prev.pos < 1 && cur.pos > 1) out.push(mixStop(prev, cur, 1));
  }
  if (!out.length) { const last = s[s.length - 1].pos < 0 ? s[s.length - 1] : s[0]; out.push({ ...last, pos: 0 }); }
  return out;
}
// SVG 그라데이션(화면 좌표 두 점) → 도형 상자 기준 DrawingML 선형 그라데이션
function linFromPoints(p1, p2, stops, bb) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  const proj = [[bb.x, bb.y], [bb.x + bb.w, bb.y], [bb.x, bb.y + bb.h], [bb.x + bb.w, bb.y + bb.h]].map(([x, y]) => x * ux + y * uy);
  const tmin = Math.min(...proj), span = Math.max(...proj) - tmin || 1;
  const base = p1.x * ux + p1.y * uy;
  return { lin: (Math.atan2(uy, ux) * 180) / Math.PI, stops: clipStops(stops.map((s) => ({ hex: s.hex, a: s.a, pos: (base + s.off * L - tmin) / span }))) };
}
const withAlpha = (fill, k) => {
  if (!fill || k >= 0.999) return fill;
  if (fill.solid) return { solid: { hex: fill.solid.hex, a: fill.solid.a * k } };
  return { ...fill, stops: fill.stops.map((s) => ({ ...s, a: s.a * k })) };
};

// ---------------------------------------------------------------- Node 쪽: 도형 XML
let EMU = 6350; // px → EMU (판형마다 다시 계산)
const E = (v) => Math.round(v * EMU);
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clr = (hex, a) => `<a:srgbClr val="${hex}">${a < 0.999 ? `<a:alpha val="${Math.max(0, Math.round(a * 100000))}"/>` : ''}</a:srgbClr>`;
function fillXml(f) {
  if (!f) return '<a:noFill/>';
  if (f.solid) return `<a:solidFill>${clr(f.solid.hex, f.solid.a)}</a:solidFill>`;
  const gs = f.stops.map((s) => `<a:gs pos="${Math.round(Math.min(1, Math.max(0, s.pos)) * 100000)}">${clr(s.hex, s.a)}</a:gs>`).join('');
  if (f.radial) {
    const l = Math.round(f.radial.fx * 100000), t = Math.round(f.radial.fy * 100000);
    return `<a:gradFill rotWithShape="1"><a:gsLst>${gs}</a:gsLst><a:path path="circle"><a:fillToRect l="${l}" t="${t}" r="${100000 - l}" b="${100000 - t}"/></a:path></a:gradFill>`;
  }
  const ang = (((f.lin % 360) + 360) % 360);
  return `<a:gradFill rotWithShape="1"><a:gsLst>${gs}</a:gsLst><a:lin ang="${Math.round(ang * 60000)}" scaled="0"/></a:gradFill>`;
}
function lnXml(l) {
  if (!l) return '<a:ln><a:noFill/></a:ln>';
  const cap = l.cap === 'round' ? ' cap="rnd"' : l.cap === 'square' ? ' cap="sq"' : '';
  let dash = '';
  if (l.dash && l.dash.length >= 2) {
    // SVG 점선(둥근 끝 + 아주 짧은 선)은 '둥근 점선'으로: 점 크기 = 선 굵기, 간격 = 나머지
    const w = l.w || 1;
    const period = l.dash[0] + l.dash[1];
    const d = l.cap === 'round' && l.dash[0] < w ? 1 : l.dash[0] / w;
    const sp = Math.max(0.1, period / w - d);
    dash = `<a:custDash><a:ds d="${Math.round(d * 100000)}" sp="${Math.round(sp * 100000)}"/></a:custDash>`;
  } else if (l.prstDash) dash = `<a:prstDash val="${l.prstDash}"/>`;
  const join = l.join === 'round' ? '<a:round/>' : l.join === 'bevel' ? '<a:bevel/>' : '<a:miter lim="800000"/>';
  return `<a:ln w="${Math.max(1, E(l.w))}"${cap}>${fillXml(l.fill)}${dash}${join}</a:ln>`;
}
function effectXml(sh) {
  if (!sh) return '';
  const dir = ((((Math.atan2(sh.oy, sh.ox) * 180) / Math.PI) % 360) + 360) % 360;
  return `<a:effectLst><a:outerShdw blurRad="${E(sh.blur)}" dist="${E(Math.hypot(sh.ox, sh.oy))}" dir="${Math.round(dir * 60000)}" algn="ctr" rotWithShape="0">${clr(sh.c.hex, sh.c.a)}</a:outerShdw></a:effectLst>`;
}
// 경로 명령(화면 px) → 자유형 도형
function custGeomXml(cmds, bb, fillNone, strokeNone) {
  const W = Math.max(1, E(bb.w)), H = Math.max(1, E(bb.h));
  const P = (x, y) => `<a:pt x="${E(x - bb.x)}" y="${E(y - bb.y)}"/>`;
  const body = cmds.map((c) => {
    if (c.t === 'M') return `<a:moveTo>${P(c.x, c.y)}</a:moveTo>`;
    if (c.t === 'L') return `<a:lnTo>${P(c.x, c.y)}</a:lnTo>`;
    if (c.t === 'C') return `<a:cubicBezTo>${P(c.x1, c.y1)}${P(c.x2, c.y2)}${P(c.x, c.y)}</a:cubicBezTo>`;
    if (c.t === 'Q') return `<a:quadBezTo>${P(c.x1, c.y1)}${P(c.x, c.y)}</a:quadBezTo>`;
    return '<a:close/>';
  }).join('');
  return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${W}" h="${H}"${fillNone ? ' fill="none"' : ''}${strokeNone ? ' stroke="0"' : ''}>${body}</a:path></a:pathLst></a:custGeom>`;
}
function spXml(id, s) {
  const bb = s.bb;
  let geom;
  if (s.cmds) geom = custGeomXml(s.cmds, bb, !s.fill, !s.line);
  else if (s.prst === 'roundRect') geom = `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.round(Math.min(50000, (s.radius / Math.max(0.01, Math.min(bb.w, bb.h))) * 100000))}"/></a:avLst></a:prstGeom>`;
  else geom = `<a:prstGeom prst="${s.prst || 'rect'}"><a:avLst/></a:prstGeom>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEsc(s.name || 'shape').slice(0, 80)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${E(bb.x)}" y="${E(bb.y)}"/><a:ext cx="${Math.max(1, E(bb.w))}" cy="${Math.max(1, E(bb.h))}"/></a:xfrm>${geom}${fillXml(s.fill)}${lnXml(s.line)}${effectXml(s.shadow)}</p:spPr>`
    + '<p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:endParaRPr lang="ko-KR" dirty="0"/></a:p></p:txBody></p:sp>';
}

// svgpath 결과를 M/L/C/Q/Z 절대 좌표 명령으로
function toCmds(d, m) {
  const cmds = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  svgpath(d).matrix(m).abs().unarc().unshort().iterate((seg) => {
    const [t, ...a] = seg;
    if (t === 'M') { cmds.push({ t: 'M', x: a[0], y: a[1] }); cx = sx = a[0]; cy = sy = a[1]; }
    else if (t === 'L') { cmds.push({ t: 'L', x: a[0], y: a[1] }); cx = a[0]; cy = a[1]; }
    else if (t === 'H') { cmds.push({ t: 'L', x: a[0], y: cy }); cx = a[0]; }
    else if (t === 'V') { cmds.push({ t: 'L', x: cx, y: a[0] }); cy = a[0]; }
    else if (t === 'C') { cmds.push({ t: 'C', x1: a[0], y1: a[1], x2: a[2], y2: a[3], x: a[4], y: a[5] }); cx = a[4]; cy = a[5]; }
    else if (t === 'Q') { cmds.push({ t: 'Q', x1: a[0], y1: a[1], x: a[2], y: a[3] }); cx = a[2]; cy = a[3]; }
    else if (t === 'Z' || t === 'z') { cmds.push({ t: 'Z' }); cx = sx; cy = sy; }
  });
  return cmds;
}
function cmdsBox(cmds) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const c of cmds) { if (c.t === 'Z') continue; add(c.x, c.y); if (c.x1 != null) add(c.x1, c.y1); if (c.x2 != null) add(c.x2, c.y2); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// 두 원의 겹친 부분(렌즈)을 원호 두 개로
function lensPath(a, b) {
  const d = Math.hypot(b.cx - a.cx, b.cy - a.cy);
  if (d >= a.r + b.r || d === 0) return null;
  const l = (a.r * a.r - b.r * b.r + d * d) / (2 * d), h = Math.sqrt(Math.max(0, a.r * a.r - l * l));
  const mx = a.cx + (l * (b.cx - a.cx)) / d, my = a.cy + (l * (b.cy - a.cy)) / d;
  const P = { x: mx + (h * (b.cy - a.cy)) / d, y: my - (h * (b.cx - a.cx)) / d };
  const Q = { x: mx - (h * (b.cy - a.cy)) / d, y: my + (h * (b.cx - a.cx)) / d };
  const arc = (c, other, from, to) => {
    const a0 = Math.atan2(from.y - c.cy, from.x - c.cx), a1 = Math.atan2(to.y - c.cy, to.x - c.cx);
    const delta = (((a1 - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const mid = a0 + delta / 2;
    const inside = Math.hypot(c.cx + c.r * Math.cos(mid) - other.cx, c.cy + c.r * Math.sin(mid) - other.cy) <= other.r;
    const sweep = inside ? 1 : 0, large = inside ? (delta > Math.PI ? 1 : 0) : (2 * Math.PI - delta > Math.PI ? 1 : 0);
    return `A${c.r} ${c.r} 0 ${large} ${sweep} ${to.x} ${to.y}`;
  };
  return `M${P.x} ${P.y}${arc(b, a, P, Q)}${arc(a, b, Q, P)}Z`;
}

// SVG 요소 하나 → 도형 사양
function svgLeafSpec(lf, name) {
  const m = lf.ctm;
  const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
  const k = Math.sqrt(det) || 1;
  const axis = Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6;
  const g = lf.geom;
  let spec = { name: `${name} ${lf.name}`.trim() };
  if (lf.clip && g.type === 'ellipse' && g.rx === g.ry) {
    const tp = (x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
    const A = tp(lf.clip.cx, lf.clip.cy), B = tp(g.cx, g.cy);
    const d = lensPath({ cx: A.x, cy: A.y, r: lf.clip.r * k }, { cx: B.x, cy: B.y, r: g.rx * k });
    if (!d) return null;
    spec.cmds = toCmds(d, [1, 0, 0, 1, 0, 0]);
    spec.bb = cmdsBox(spec.cmds);
  } else if (g.type === 'ellipse' && axis) {
    const cx = m[0] * g.cx + m[4], cy = m[3] * g.cy + m[5], rx = Math.abs(m[0]) * g.rx, ry = Math.abs(m[3]) * g.ry;
    spec.prst = 'ellipse';
    spec.bb = { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 };
  } else if (g.type === 'rect' && axis) {
    const x = m[0] * g.x + m[4], y = m[3] * g.y + m[5];
    spec.bb = { x: Math.min(x, x + m[0] * g.w), y: Math.min(y, y + m[3] * g.h), w: Math.abs(m[0] * g.w), h: Math.abs(m[3] * g.h) };
    spec.prst = g.rx > 0 ? 'roundRect' : 'rect';
    spec.radius = g.rx * k;
  } else {
    let d = g.d;
    if (g.type === 'ellipse') d = `M${g.cx - g.rx} ${g.cy}A${g.rx} ${g.ry} 0 1 0 ${g.cx + g.rx} ${g.cy}A${g.rx} ${g.ry} 0 1 0 ${g.cx - g.rx} ${g.cy}Z`;
    if (g.type === 'rect') d = `M${g.x} ${g.y}h${g.w}v${g.h}h${-g.w}Z`;
    spec.cmds = toCmds(d, m);
    if (!spec.cmds.length) return null;
    spec.bb = cmdsBox(spec.cmds);
  }
  const paint = (p, op) => {
    if (!p) return null;
    if (p.color) return p.color.a * op > 0 ? { solid: { hex: p.color.hex, a: p.color.a * op } } : null;
    if (p.grad) return withAlpha(linFromPoints(p.grad.p1, p.grad.p2, p.grad.stops, spec.bb), op);
    return null;
  };
  spec.fill = paint(lf.fill, lf.op * (isNaN(lf.fillOp) ? 1 : lf.fillOp));
  const stroke = lf.sw > 0 ? paint(lf.stroke, lf.op * (isNaN(lf.strokeOp) ? 1 : lf.strokeOp)) : null;
  spec.line = stroke ? { w: lf.sw * k, fill: stroke, cap: lf.cap, join: lf.join, dash: lf.dash ? lf.dash.map((v) => v * k) : null } : null;
  if (!spec.fill && !spec.line) return null;
  return spec;
}

// 모서리마다 반경이 다른 둥근 사각형 / 일부 변만 있는 테두리를 경로로 (원호는 3차 곡선 근사)
const KAPPA = 0.5523;
function cornerArc(cx, cy, r, a0, a1) {
  const p = (a) => ({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  const s = p(a0), e = p(a1);
  const k = KAPPA * r * Math.sign(a1 - a0);
  return { s, c: { t: 'C', x1: s.x - k * Math.sin(a0), y1: s.y + k * Math.cos(a0), x2: e.x + k * Math.sin(a1), y2: e.y - k * Math.cos(a1), x: e.x, y: e.y } };
}
// 둘레 조각 8개: 위변, 오른쪽 위 모서리, 오른변, 오른쪽 아래, 아랫변, 왼쪽 아래, 왼변, 왼쪽 위
function perimeter(b, rad) {
  const [tl, tr, br, bl] = rad;
  const { x, y, w, h } = b;
  const H = Math.PI / 2;
  return [
    { kind: 'line', side: 0 }, { kind: 'corner', a: 0, b: 1, arc: cornerArc(x + w - tr, y + tr, tr, -H, 0), p: { x: x + w, y } },
    { kind: 'line', side: 1 }, { kind: 'corner', a: 1, b: 2, arc: cornerArc(x + w - br, y + h - br, br, 0, H), p: { x: x + w, y: y + h } },
    { kind: 'line', side: 2 }, { kind: 'corner', a: 2, b: 3, arc: cornerArc(x + bl, y + h - bl, bl, H, 2 * H), p: { x, y: y + h } },
    { kind: 'line', side: 3 }, { kind: 'corner', a: 3, b: 0, arc: cornerArc(x + tl, y + tl, tl, 2 * H, 3 * H), p: { x, y } },
  ];
}
function roundedCmds(b, rad) {
  const per = perimeter(b, rad);
  const cmds = [];
  per.filter((q) => q.kind === 'corner').forEach((q, i) => {
    if (i === 0) cmds.push({ t: 'M', x: b.x + rad[0], y: b.y });
    cmds.push({ t: 'L', x: q.arc.s.x, y: q.arc.s.y });
    cmds.push(q.arc.c);
  });
  cmds.push({ t: 'Z' });
  return cmds;
}
function partialBorderCmds(b, rad, visible) {
  const per = perimeter(b, rad);
  const on = per.map((q) => (q.kind === 'line' ? visible[q.side] : visible[q.a] && visible[q.b]));
  const corners = per.filter((q) => q.kind === 'corner');
  // 변 i의 시작점·끝점: 앞뒤 모서리를 그리면 원호 끝, 아니면 사각형 꼭짓점
  const before = [3, 0, 1, 2], after = [0, 1, 2, 3];
  const ends = (side) => {
    const cb = corners[before[side]], ca = corners[after[side]];
    const cbOn = visible[cb.a] && visible[cb.b], caOn = visible[ca.a] && visible[ca.b];
    return { s: cbOn ? cb.arc.c : cb.p, e: caOn ? ca.arc.s : ca.p };
  };
  const startIdx = on.findIndex((v, i) => v && !on[(i + 7) % 8]);
  if (startIdx < 0) return on.every(Boolean) ? roundedCmds(b, rad) : [];
  const cmds = [];
  let pen = false;
  for (let n = 0; n < 8; n++) {
    const i = (startIdx + n) % 8, q = per[i];
    if (!on[i]) { pen = false; continue; }
    if (q.kind === 'line') {
      const { s, e } = ends(q.side);
      if (!pen) cmds.push({ t: 'M', x: s.x, y: s.y });
      cmds.push({ t: 'L', x: e.x, y: e.y });
    } else {
      if (!pen) cmds.push({ t: 'M', x: q.arc.s.x, y: q.arc.s.y });
      cmds.push(q.arc.c);
    }
    pen = true;
  }
  return cmds;
}

// HTML 상자 → 도형 사양들(바깥 번짐 그림자 고리, 본체, 한쪽 테두리 선)
function boxSpecs(it, r) {
  const out = [];
  const op = it.op;
  const visible = it.sides.map((s) => s.w > 0 && s.style !== 'none' && s.c && s.c.a > 0);
  const uniform = it.sides.every((s) => s.w === it.sides[0].w && s.style === it.sides[0].style && (s.c && it.sides[0].c ? s.c.hex === it.sides[0].c.hex && s.c.a === it.sides[0].c.a : s.c === it.sides[0].c));
  const name = it.cls;

  // 배경: 단색 + 그라데이션 층(위가 먼저). 투명 테두리 + 'padding-box 단색 / border-box 그라데이션' = 그라데이션 테두리
  let fill = it.bg ? { solid: it.bg } : null;
  let ringLine = null;
  if (it.bgImage) {
    const layers = splitTop(it.bgImage).map(parseGradient);
    const clips = splitTop(it.bgClip || '');
    const solidOf = (g) => g && g.stops.every((s) => s.hex === g.stops[0].hex && s.a === g.stops[0].a) ? { hex: g.stops[0].hex, a: g.stops[0].a } : null;
    const bw = it.sides[0].w;
    if (layers.length === 2 && layers.every(Boolean) && /padding/.test(clips[0] || '') && /border/.test(clips[1] || '') && bw > 0 && solidOf(layers[0])) {
      fill = { solid: solidOf(layers[0]) };
      ringLine = { w: bw, fill: layers[1].radial ? { solid: layers[1].stops[0] } : { lin: layers[1].lin, stops: layers[1].stops } };
    } else if (layers[0]) {
      const g = layers[layers.length - 1 >= 0 ? 0 : 0];
      const solid = solidOf(g);
      fill = solid ? { solid } : g.radial ? { radial: g.radial, stops: g.stops } : { lin: g.lin, stops: g.stops };
    }
  }
  fill = withAlpha(fill, op);

  const shadows = parseShadows(it.shadow);
  // 번짐 없는 굵은 그림자(바깥 고리) → 뒤에 같은 모양 도형
  for (const sh of shadows.filter((x) => x.blur === 0 && x.spread > 0)) {
    const sp = sh.spread;
    out.push({
      name: `${name} 고리`, prst: it.shape, radius: it.radius + sp,
      bb: { x: r.x + sh.ox - sp, y: r.y + sh.oy - sp, w: r.w + sp * 2, h: r.h + sp * 2 }, fill: withAlpha({ solid: sh.c }, op), line: null,
    });
  }
  const soft = shadows.filter((x) => x.blur > 0);
  let shadow = null;
  if (soft.length) {
    const main = soft.reduce((a, b) => (b.blur > a.blur ? b : a));
    const alpha = Math.min(0.35, soft.reduce((s, x) => s + x.c.a, 0));
    shadow = { ...main, c: { hex: main.c.hex, a: alpha * op } };
  }

  let line = null;
  let inset = 0;
  if (ringLine) { line = { ...ringLine, fill: withAlpha(ringLine.fill, op) }; inset = ringLine.w; }
  else if (visible.some(Boolean) && uniform) {
    const s = it.sides[0];
    line = { w: s.w, fill: { solid: { hex: s.c.hex, a: s.c.a * op } }, prstDash: s.style === 'dashed' ? 'dash' : s.style === 'dotted' ? 'sysDot' : null };
    inset = s.w;
  }
  if (fill || line || shadow) {
    const bb = { x: r.x + inset / 2, y: r.y + inset / 2, w: r.w - inset, h: r.h - inset };
    if (it.cornerPx) {
      const cmds = roundedCmds(bb, it.cornerPx.map((v) => Math.max(0, v - inset / 2)));
      out.push({ name, cmds, bb: cmdsBox(cmds), fill, line, shadow });
    } else out.push({ name, prst: it.shape, radius: Math.max(0, it.radius - inset / 2), bb, fill, line, shadow });
  }
  // 일부 변에만 있는 같은 색·굵기 테두리 → 모서리 곡선까지 이어진 열린 선 하나
  const vis = it.sides.filter((s, i) => visible[i]);
  const sameLook = vis.length && vis.every((s) => s.w === vis[0].w && s.style === vis[0].style && s.c.hex === vis[0].c.hex && s.c.a === vis[0].c.a);
  if (!ringLine && visible.some(Boolean) && !uniform && sameLook) {
    const s0 = vis[0];
    const bb = { x: r.x + s0.w / 2, y: r.y + s0.w / 2, w: r.w - s0.w, h: r.h - s0.w };
    const rad = (it.cornerPx || [it.radius, it.radius, it.radius, it.radius]).map((v) => Math.max(0, v - s0.w / 2));
    const cmds = partialBorderCmds(bb, rad, visible);
    if (cmds.length) {
      out.push({
        name: `${name} 선`, cmds, bb: cmdsBox(cmds), fill: null,
        line: { w: s0.w, fill: { solid: { hex: s0.c.hex, a: s0.c.a * op } }, cap: 'flat', join: 'round', prstDash: s0.style === 'dashed' ? 'dash' : s0.style === 'dotted' ? 'sysDot' : null },
      });
    }
  } else if (!ringLine && visible.some(Boolean) && !uniform) {
    const segs = [
      [0, r.x, r.y, r.x + r.w, r.y, 'h'], [1, r.x + r.w, r.y, r.x + r.w, r.y + r.h, 'v'],
      [2, r.x, r.y + r.h, r.x + r.w, r.y + r.h, 'h'], [3, r.x, r.y, r.x, r.y + r.h, 'v'],
    ];
    for (const [i, x0, y0, x1, y1, o] of segs) {
      if (!visible[i]) continue;
      const s = it.sides[i];
      const off = (i === 0 || i === 3 ? 1 : -1) * (s.w / 2);
      const cmds = o === 'h' ? [{ t: 'M', x: x0, y: y0 + off }, { t: 'L', x: x1, y: y1 + off }] : [{ t: 'M', x: x0 + off, y: y0 }, { t: 'L', x: x1 + off, y: y1 }];
      out.push({
        name: `${name} 선`, cmds, bb: cmdsBox(cmds), fill: null,
        line: { w: s.w, fill: { solid: { hex: s.c.hex, a: s.c.a * op } }, cap: 'flat', prstDash: s.style === 'dashed' ? 'dash' : s.style === 'dotted' ? 'sysDot' : null },
      });
    }
  }
  return out;
}

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
  EMU = 914400 / fmt.pxPerIn;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 2400, height: 2200 }, deviceScaleFactor: DSF });
  await page.goto('file://' + path.resolve(file));
  await page.evaluate(() => { document.documentElement.classList.add('static'); document.documentElement.style.setProperty('--s', 1); });
  await page.evaluate(() => document.fonts.ready);
  // 장식(::before/::after)을 실제 요소로 바꾸기 전후로 모든 요소의 위치를 비교해, 1px이라도 바뀌면 멈춘다
  // (그리지 않는 <br>은 제외하고, 글자 노드는 글자 범위의 위치로 비교)
  const snap = () => page.evaluate(() => {
    const out = [...document.querySelectorAll('.slide *:not(br):not([data-pseudo])')].map((e) => e.getBoundingClientRect());
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
    const texts = await page.evaluate((idx) => idx.map((i) => { const els = document.querySelectorAll('.slide *:not(br):not([data-pseudo])'); const n = els.length; return i >= n ? JSON.stringify(window.__textNodes[i - n].data) : els[i].outerHTML.slice(0, 80); }), diffs.map((d) => parseInt(d, 10)));
    throw new Error(`${name}: 장식 변환 후 ${moved}개 요소의 레이아웃이 바뀜\n${diffs.map((d, i) => d + '  ' + texts[i]).join('\n')}`);
  }

  const nSlides = await page.evaluate(() => document.querySelectorAll('.slide').length);
  const pres = new PptxGenJS();
  const first = await page.evaluate(() => { const r = document.querySelector('.slide').getBoundingClientRect(); return { w: r.width, h: r.height }; });
  const k = 1 / fmt.pxPerIn; // px → inch
  const ptPerPx = 72 / fmt.pxPerIn;
  pres.defineLayout({ name: fmt.layout, width: first.w * k, height: first.h * k });
  pres.layout = fmt.layout;
  const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily.split(',')[0].replace(/["']/g, '').trim());
  FACE = FAMILIES[family] || FAMILIES.Paperlogy;
  pres.theme = { headFontFace: FACE[800][0], bodyFontFace: FACE[500][0] };
  pres.title = await page.title();

  // 도형은 자리표시 도형으로 넣어 두고, 저장 뒤 XML에서 직접 쓴 도형으로 바꾼다(그라데이션·자유형·점선·그림자)
  const specs = new Map();
  const addSpec = (slide, spec) => {
    if (!spec || !spec.bb || !(spec.bb.w >= 0) || !(spec.bb.h >= 0)) return;
    const token = `__N${specs.size}__`;
    specs.set(token, spec);
    slide.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: 0.1, h: 0.1, objectName: token });
  };

  const stats = { shapes: 0, images: 0, lines: 0 };
  for (let si = 0; si < nSlides; si++) {
    // 지금 장만 남겨 화면 맨 위에 둔다(캡처 범위가 화면 안에 들어오도록)
    await page.evaluate((i) => document.querySelectorAll('.slide').forEach((s, j) => { s.style.display = j === i ? '' : 'none'; }), si);
    const data = await page.evaluate(extract, si);
    const slide = pres.addSlide();
    const notes = await page.evaluate((i) => document.querySelectorAll('.slide')[i].getAttribute('data-notes'), si);
    if (notes) slide.addNotes(notes);
    slide.background = { color: 'FFFFFF' };
    const S = await page.evaluate((i) => { const r = document.querySelectorAll('.slide')[i].getBoundingClientRect(); return { x: r.left, y: r.top }; }, si);

    for (const it of order(data.items, data.edges)) {
      if (it.kind === 'box') {
        for (const r of it.rects) for (const sp of boxSpecs(it, r)) { addSpec(slide, sp); stats.shapes++; }
      } else if (it.kind === 'svg') {
        for (const lf of it.leaves) { const sp = svgLeafSpec(lf, it.cls); if (sp) { addSpec(slide, sp); stats.shapes++; } }
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
          fontFace: faceFor(r.style.weight), bold: boldFor(r.style.weight) || undefined, fontSize: +(r.style.size * ptPerPx).toFixed(2), color: r.style.color,
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
  await postProcess(out, specs);
  console.log(`${path.relative(process.cwd(), out)}: ${nSlides} slides, ${stats.shapes} shapes, ${stats.images} images, ${stats.lines} text lines`);
}

async function postProcess(file, specs) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const names = Object.keys(zip.files).filter((n) => /^ppt\/(slides\/slide\d+|theme\/theme\d+|slideMasters\/slideMaster\d+|slideLayouts\/slideLayout\d+)\.xml$/.test(n));
  for (const n of names) {
    let xml = await zip.file(n).async('string');
    // 자리표시 도형 → 직접 쓴 도형
    xml = xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (seg) => {
      const m = seg.match(/name="(__N\d+__)"/);
      if (!m || !specs.has(m[1])) return seg;
      const id = seg.match(/<p:cNvPr id="(\d+)"/)[1];
      return spXml(id, specs.get(m[1]));
    });
    // 한글 글꼴이 테마 기본(맑은 고딕 등)으로 바뀌지 않도록 동아시아 글꼴(ea)도 같은 이름으로 지정
    xml = xml.replace(/<a:latin typeface="([^"]+)"([^>]*)\/>(?!<a:ea)/g, (m, face, rest) => `<a:latin typeface="${face}"${rest}/><a:ea typeface="${face}"${rest}/>`);
    // pptxgenjs는 ea 글꼴에 중국어 문자셋(-122)을 붙인다 → 한국어(-127)로
    xml = xml.replace(/(<a:ea typeface="[^"]+" pitchFamily="\d+") charset="-122"/g, '$1 charset="-127"');
    // 테마의 동아시아 기본 글꼴도 본문 글꼴로
    xml = xml.replace(/<a:ea typeface=""\/>/g, `<a:ea typeface="${FACE[500][0]}"/>`);
    zip.file(n, xml);
  }
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

(async () => {
  const files = process.argv.slice(2);
  for (const f of files) await convert(f);
})();
