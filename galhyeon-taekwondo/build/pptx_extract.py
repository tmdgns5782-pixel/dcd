"""index.html(1600×900) → PPT 재료.
- 각 장의 글자·도형·표·이미지 위치와 스타일을 재서 out/deck.json 으로
- PPT가 직접 못 그리는 장식(붓 터치, 그라데이션 원, 구름·도로 등)만 남긴 배경을 out/bgN.png 로
실행: python3 build/pptx_extract.py   (playwright, Chromium 필요)
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "out")
CHROME = os.environ.get("CHROME", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")

JS = r"""
() => {
  const px = v => parseFloat(v) || 0;
  const rgb = s => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null;
    const p = m[1].split(',').map(x => parseFloat(x)); return {r:p[0], g:p[1], b:p[2], a: p.length > 3 ? p[3] : 1}; };
  const hex = c => c ? [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase() : null;
  const gradColors = s => (s.match(/rgba?\([^)]+\)/g) || []).map(rgb);
  const avg = cs => { cs = cs.filter(c => c && c.a > 0.3); if (!cs.length) return null;
    const n = cs.length; return {r: cs.reduce((a,c)=>a+c.r,0)/n, g: cs.reduce((a,c)=>a+c.g,0)/n, b: cs.reduce((a,c)=>a+c.b,0)/n, a:1}; };
  const fill = el => { const cs = getComputedStyle(el); const g = gradColors(cs.backgroundImage);
    if (g.length) { if (cs.backgroundImage.startsWith('radial')) return hex(g[1] || g[0]); return hex(avg(g.slice(0, 2))); }
    const c = rgb(cs.backgroundColor); return c && c.a > 0 ? hex(c) : null; };

  const slides = [];
  document.querySelectorAll('.slide').forEach((slide, si) => {
    const S = slide.getBoundingClientRect();
    const box = el => { const r = el.getBoundingClientRect(); return {x: r.left - S.left, y: r.top - S.top, w: r.width, h: r.height}; };
    const items = [];
    const native = new Set();

    // 도형
    slide.querySelectorAll('.card, .price, .info, .bubble').forEach(el => {
      const cs = getComputedStyle(el);
      items.push({kind: 'rrect', ...box(el), radius: px(cs.borderTopLeftRadius), fill: fill(el),
        line: px(cs.borderTopWidth) ? hex(rgb(cs.borderTopColor)) : null, lineW: px(cs.borderTopWidth),
        lineA: px(cs.borderTopWidth) ? (rgb(cs.borderTopColor).a) : 1, shadow: cs.boxShadow !== 'none'});
      native.add(el);
    });
    slide.querySelectorAll('.bubble-tail').forEach(el => { items.push({kind: 'tri', ...box(el), fill: 'FBD9DF'}); native.add(el); });
    slide.querySelectorAll('.badge, .card .no').forEach(el => {
      items.push({kind: 'ellipse', ...box(el), fill: fill(el), shadow: el.classList.contains('badge')}); });

    // 표
    slide.querySelectorAll('table.tt').forEach(t => {
      const rows = [...t.rows].map(tr => [...tr.cells].map(td => { const cs = getComputedStyle(td);
        return {text: td.innerText, size: px(cs.fontSize), weight: cs.fontWeight, color: hex(rgb(cs.color)),
                fill: fill(td), w: td.getBoundingClientRect().width, h: td.getBoundingClientRect().height}; }));
      items.push({kind: 'table', ...box(t), rows}); native.add(t);
    });

    // 이미지 (object-fit: contain 으로 실제 그려진 영역 계산)
    slide.querySelectorAll('img').forEach(img => {
      const b = box(img), cs = getComputedStyle(img);
      const nw = img.naturalWidth, nh = img.naturalHeight, s = Math.min(b.w / nw, b.h / nh);
      const dw = nw * s, dh = nh * s;
      const [px_, py_] = cs.objectPosition.split(' ');
      const fx = px_.endsWith('%') ? parseFloat(px_) / 100 : 0, fy = py_.endsWith('%') ? parseFloat(py_) / 100 : 0;
      items.push({kind: 'image', src: (img.getAttribute('data-src') || ''), key: img.dataset.key,
        x: b.x + (b.w - dw) * fx, y: b.y + (b.h - dh) * fy, w: dw, h: dh});
      native.add(img);
    });

    // 글자
    const textEls = new Set();
    slide.querySelectorAll('.title, .lead, .badge, .card .no, h3, .card p, .phil p, .virtue p, .price .k, .price .v, .chk-row, .info .row, .pageno, .bubble')
      .forEach(el => textEls.add(el));
    slide.querySelectorAll('div.abs').forEach(el => { if ([...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) textEls.add(el); });
    textEls.forEach(el => {
      const cs = getComputedStyle(el);
      const runs = [];
      const walk = (node, st) => node.childNodes.forEach(n => {
        if (n.nodeType === 3) { const t = n.textContent.replace(/\s+/g, ' '); if (t.trim() || t === ' ') runs.push({text: t, ...st}); }
        else if (n.nodeName === 'BR') runs.push({br: true});
        else if (n.nodeType === 1 && n.nodeName !== 'IMG' && n.nodeName !== 'svg') {
          const c = getComputedStyle(n); walk(n, {size: px(c.fontSize), color: hex(rgb(c.color)), weight: c.fontWeight, family: c.fontFamily}); }
      });
      walk(el, {size: px(cs.fontSize), color: hex(rgb(cs.color)), weight: cs.fontWeight, family: cs.fontFamily});
      while (runs.length && !runs[0].br && !runs[0].text.trim()) runs.shift();
      if (runs.length && runs[0].text) runs[0].text = runs[0].text.replace(/^\s+/, '');
      if (!runs.some(r => r.text && r.text.trim())) return;
      // 글자만 감싼 범위
      const rg = document.createRange(); let first = null, last = null;
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n;
      while ((n = tw.nextNode())) if (n.textContent.trim()) { if (!first) first = n; last = n; }
      rg.setStart(first, 0); rg.setEnd(last, last.textContent.length);
      // 회전된 요소는 회전 전 좌표로
      let rot = 0, r;
      const m = cs.transform !== 'none' ? new DOMMatrix(cs.transform) : null;
      if (m && Math.abs(m.b) > 1e-4) {
        rot = Math.atan2(m.b, m.a) * 180 / Math.PI;
        const saved = el.style.transform; el.style.transform = 'none';
        r = rg.getBoundingClientRect(); const eb = el.getBoundingClientRect();
        el.style.transform = saved;
        // CSS 회전 기준점(왼쪽 위) → PPT는 중심 기준: 중심점을 회전시켜 이동
        const ox = eb.left, oy = eb.top, cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const a = rot * Math.PI / 180, dx = cx - ox, dy = cy - oy;
        const ncx = ox + dx * Math.cos(a) - dy * Math.sin(a), ncy = oy + dx * Math.sin(a) + dy * Math.cos(a);
        r = {left: ncx - r.width / 2, top: ncy - r.height / 2, width: r.width, height: r.height};
      } else r = rg.getBoundingClientRect();
      const lh = cs.lineHeight === 'normal' ? px(cs.fontSize) * 1.25 : px(cs.lineHeight);
      const display = cs.display;
      const align = (display === 'grid' && cs.placeItems.includes('center')) || cs.textAlign === 'center' ? 'center' : (cs.textAlign === 'right' ? 'right' : 'left');
      items.push({kind: 'text', x: r.left - S.left, y: r.top - S.top, w: r.width, h: r.height, rot, align,
        lineHeight: lh, ls: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing), runs,
        stroke: px(cs.webkitTextStrokeWidth)});
    });

    // 배경 캡처용: PPT로 직접 만드는 것 숨기기
    const hide = [...native, ...textEls, ...slide.querySelectorAll('.badge, .card .no, .chk-row, .info .row, .virtue .disc > *, .virtue p, .phil, .pageno')];
    hide.forEach(el => el.setAttribute('data-hide', '1'));
    slides.push({items});
  });
  return slides;
}
"""


def main():
    os.makedirs(OUT, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME)
        pg = b.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=2)
        pg.goto("file://" + os.path.join(ROOT, "index.html"))
        pg.wait_for_timeout(1500)
        pg.evaluate("""() => { document.querySelectorAll('.slide').forEach(s => s.style.transform = 'none');
          document.querySelectorAll('.frame').forEach(f => { f.style.maxWidth = 'none'; f.style.width = '1600px'; f.style.height = '900px'; });
          // 이미지 원본 이름 기록 (data URI 앞에 키가 없으니 순서 대신 alt 없는 것도 식별)
          document.querySelectorAll('img').forEach(i => { const m = i.getAttribute('src').slice(0, 40); }); }""")
        # src 토큰 이름을 다시 붙이기 위해 원본 템플릿의 이미지 순서를 사용
        src = open(os.path.join(HERE, "deck.src.html"), encoding="utf-8").read()
        import re
        names = re.findall(r"\{\{IMG:([^}]+)\}\}", src)
        pg.evaluate("names => document.querySelectorAll('img').forEach((im, i) => im.dataset.key = names[i])", names)
        slides = pg.evaluate(JS)
        pg.add_style_tag(content="[data-hide]{visibility:hidden!important} .slide{box-shadow:none!important}")
        pg.wait_for_timeout(300)
        for i, s in enumerate(pg.query_selector_all(".slide")):
            s.screenshot(path=os.path.join(OUT, f"bg{i + 1}.png"))
        b.close()
    json.dump(slides, open(os.path.join(OUT, "deck.json"), "w"), ensure_ascii=False, indent=1)
    # 배경은 JPEG로, 이미지는 투명 여백을 잘라낸 원본 PNG로
    from PIL import Image
    for i in range(len(slides)):
        bg = os.path.join(OUT, f"bg{i + 1}.png")
        Image.open(bg).convert("RGB").save(bg[:-4] + ".jpg", quality=90)
        os.remove(bg)
    os.makedirs(os.path.join(OUT, "img"), exist_ok=True)
    for key in set(names):
        src_path = os.path.join(ROOT, "assets", key)
        if not os.path.exists(src_path):
            src_path = os.path.join(ROOT, "reference", key)
        im = Image.open(src_path).convert("RGBA")
        bb = im.getchannel("A").point(lambda a: 255 if a > 60 else 0).getbbox()
        im = im.crop(bb) if bb else im
        im.thumbnail((1400, 1400), Image.LANCZOS)
        im.save(os.path.join(OUT, "img", key), optimize=True)
    print("slides", len(slides), "items", sum(len(s["items"]) for s in slides))


if __name__ == "__main__":
    main()
