// Render the slide model to a structured, editable .pptx (theme, layouts, sections, notes).
const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");
const sharp = require("sharp");
const { COLORS, THEME, WEIGHTS, NATURAL_LH, iconSvg } = require("./lib");

const IN = (px) => px / 96;
const PT = (px) => px * 0.75;
const LANG = "ko-KR";

async function renderPPTX(slides, layouts, outFile) {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE";
  pres.title = "온석터널 훈련개요 브리핑";
  pres.subject = "2026 재난대응 안전한국훈련";
  pres.author = "예산국토관리사무소 시설안전관리과";
  pres.company = "예산국토관리사무소";
  pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
  const SC = pres.SchemeColor;
  const col = (c) => SC[COLORS[c].scheme];
  const face = (f) => WEIGHTS[f || "r"].face;

  const pngCache = new Map();
  async function png(svg, w, h, scale) {
    const key = svg + "|" + scale;
    if (!pngCache.has(key)) {
      const buf = await sharp(Buffer.from(svg), { density: 72 * scale }).resize(Math.round(w * scale), Math.round(h * scale)).png().toBuffer();
      pngCache.set(key, "image/png;base64," + buf.toString("base64"));
    }
    return pngCache.get(key);
  }

  const textOpts = (e) => ({
    x: IN(e.x), y: IN(e.y), w: IN(e.w), h: IN(e.h),
    margin: 0, isTextBox: true, wrap: true,
    valign: { t: "top", m: "middle", b: "bottom" }[e.v || "t"],
    align: { l: "left", c: "center", r: "right" }[e.a || "l"],
    lineSpacingMultiple: +((e.lh || 1.2) / NATURAL_LH).toFixed(3),
    fontFace: face(e.f), fontSize: e.s || 14, color: col(e.c || "ink"), lang: LANG,
    ...(e.ls ? { charSpacing: e.ls } : {}),
    ...(e.name ? { objectName: e.name } : {}),
  });
  const runsOf = (e) => {
    const out = [];
    for (const r of e.runs) {
      const parts = r.text.split("\n");
      parts.forEach((p, i) => {
        const o = { fontFace: face(r.f || e.f), fontSize: r.s || e.s || 14, color: col(r.c || e.c || "ink"), lang: LANG };
        if (e.ls) o.charSpacing = e.ls;
        if (i < parts.length - 1) o.breakLine = true;
        out.push({ text: p, options: o });
      });
    }
    return out;
  };

  // ---- layouts ----
  for (const [name, L] of Object.entries(layouts)) {
    const objects = [];
    for (const e of L.els || []) {
      if (e.t === "rect") objects.push({ rect: { x: IN(e.x), y: IN(e.y), w: IN(e.w), h: IN(e.h), fill: { color: col(e.fill) } } });
      else objects.push({ text: { text: e.runs.map((r) => r.text).join(""), options: textOpts(e) } });
    }
    const T = L.title;
    objects.push({
      placeholder: {
        options: { name: "title", type: "title", x: IN(T.x), y: IN(T.y), w: IN(T.w), h: IN(T.h), fontFace: face(T.f), fontSize: T.s, color: col(T.c), valign: "top", align: "left", margin: 0, lineSpacingMultiple: +(T.lh / NATURAL_LH).toFixed(3), charSpacing: T.ls || 0 },
        text: "",
      },
    });
    const def = { title: name, background: { color: col(L.bg) }, objects };
    if (L.num) def.slideNumber = { x: IN(L.num.x), y: IN(L.num.y), w: IN(L.num.w), h: IN(L.num.h), fontFace: face(L.num.f), fontSize: L.num.s, color: col(L.num.c), align: "right", valign: "middle", margin: 0 };
    pres.defineSlideMaster(def);
  }

  // ---- slides ----
  let section = null;
  for (const s of slides) {
    if (s.section !== section) {
      pres.addSection({ title: s.section });
      section = s.section;
    }
    const slide = pres.addSlide({ masterName: s.layout, sectionTitle: s.section });
    const T = layouts[s.layout].title;
    slide.addText(s.title.split("\n").map((t, i, a) => ({ text: t, options: { fontFace: face(T.f), lang: LANG, ...(i < a.length - 1 ? { breakLine: true } : {}) } })), { placeholder: "title" });
    for (const e of s.els) await addEl(slide, e);
    if (s.notes) slide.addNotes(s.notes);
  }

  async function addEl(slide, e) {
    switch (e.t) {
      case "rect":
      case "ellipse": {
        const shape = e.t === "ellipse" ? pres.ShapeType.ellipse : e.r ? pres.ShapeType.roundRect : pres.ShapeType.rect;
        const o = { x: IN(e.x), y: IN(e.y), w: IN(e.w), h: IN(e.h) };
        o.fill = e.fill ? { color: col(e.fill), ...(e.alpha != null && e.alpha < 1 ? { transparency: Math.round((1 - e.alpha) * 100) } : {}) } : { type: "none" };
        o.line = e.line ? { color: col(e.line), width: PT(e.lw || 1), dashType: e.dash ? "dash" : "solid" } : { type: "none" };
        if (e.r && e.t === "rect") o.rectRadius = IN(Math.min(e.r, e.w / 2, e.h / 2));
        if (e.name) o.objectName = e.name;
        slide.addShape(shape, o);
        break;
      }
      case "text":
        slide.addText(runsOf(e), textOpts(e));
        break;
      case "line": {
        const segs = e.pts.length - 1;
        for (let i = 0; i < segs; i++) {
          const [x1, y1] = e.pts[i], [x2, y2] = e.pts[i + 1];
          const line = { color: col(e.c), width: PT(e.lw || 1), dashType: e.dash ? "dash" : "solid" };
          if (e.arrow && i === segs - 1) line.endArrowType = "triangle";
          slide.addShape(pres.ShapeType.line, {
            x: IN(Math.min(x1, x2)), y: IN(Math.min(y1, y2)), w: IN(Math.abs(x2 - x1)), h: IN(Math.abs(y2 - y1)),
            flipH: x2 < x1, flipV: y2 < y1, line,
          });
        }
        break;
      }
      case "icon": {
        const data = await png(iconSvg(e.n, e.c, 256), 256, 256, 1);
        slide.addImage({ data, x: IN(e.x), y: IN(e.y), w: IN(e.w), h: IN(e.h), altText: "" });
        break;
      }
      case "img": {
        const data = await png(e.svg, e.w, e.h, 2.5);
        slide.addImage({ data, x: IN(e.x), y: IN(e.y), w: IN(e.w), h: IN(e.h), altText: "", objectName: e.name || "Artwork" });
        break;
      }
      case "table": {
        const rows = e.rows.map((row) => row.cells.map((c) => ({
          text: c.text.split("\n").map((t, i, a) => ({ text: t, options: { fontFace: face(c.f), fontSize: c.s, color: col(c.c), lang: LANG, ...(i < a.length - 1 ? { breakLine: true } : {}) } })),
          options: { fill: { color: col(c.fill || "white") }, align: { l: "left", c: "center", r: "right" }[c.a || "l"], valign: "middle", margin: [1, PT(c.pad ?? 8), 1, PT(c.pad ?? 8)], lineSpacingMultiple: +(1.45 / NATURAL_LH).toFixed(3) },
        })));
        slide.addTable(rows, {
          x: IN(e.x), y: IN(e.y), w: IN(e.cols.reduce((a, b) => a + b, 0)), colW: e.cols.map(IN), rowH: e.rows.map((r) => IN(r.h)),
          border: { type: "solid", pt: 0.75, color: col("line") }, objectName: e.name,
        });
        break;
      }
      default:
        throw new Error(`unknown element ${e.t}`);
    }
  }

  await pres.writeFile({ fileName: outFile });
  await patchPackage(outFile);
  return outFile;
}

// pptxgenjs writes Office's stock palette, leaves the theme's East Asian fonts empty (Hangul
// falls back to 맑은 고딕), tags every ea typeface with the GB2312 charset and names icons
// "preencoded.png" for screen readers. Write the deck's palette and Paperlogy into the theme,
// mark ea runs as Hangul, and blank the alt text of the decorative images.
const SLOTS = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
async function patchPackage(file) {
  const JSZip = require(require.resolve("jszip", { paths: [require.resolve("pptxgenjs")] }));
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const tp = "ppt/theme/theme1.xml";
  let th = await zip.file(tp).async("string");
  const scheme = `<a:clrScheme name="${THEME.name}">` + SLOTS.map((k) => `<a:${k}><a:srgbClr val="${THEME.colors[k]}"/></a:${k}>`).join("") + "</a:clrScheme>";
  th = th.replace(/<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/, () => scheme).replace(/(<a:(?:theme|fontScheme)\b[^>]*?\bname=")[^"]*"/g, (_, head) => `${head}${THEME.name}"`);
  if (!th.includes(scheme)) throw new Error("theme colour scheme not replaced");
  th = th.replace(/(<a:majorFont>[\s\S]*?<\/a:majorFont>)/, (m) => m.replace(/<a:ea typeface="[^"]*"\/>/, `<a:ea typeface="${THEME.headFontFace}"/>`).replace(/<a:font script="Hang" typeface="[^"]*"\/>/, `<a:font script="Hang" typeface="${THEME.headFontFace}"/>`));
  th = th.replace(/(<a:minorFont>[\s\S]*?<\/a:minorFont>)/, (m) => m.replace(/<a:ea typeface="[^"]*"\/>/, `<a:ea typeface="${THEME.bodyFontFace}"/>`).replace(/<a:font script="Hang" typeface="[^"]*"\/>/, `<a:font script="Hang" typeface="${THEME.bodyFontFace}"/>`));
  zip.file(tp, th);
  for (const name of Object.keys(zip.files)) {
    if (!/^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/.test(name)) continue;
    const x = await zip.file(name).async("string");
    zip.file(name, x.replace(/(<a:ea typeface="[^"]*" pitchFamily="34" charset=)"-122"/g, '$1"-127"').replace(/ descr="preencoded\.png"/g, ' descr=""'));
  }
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

module.exports = { renderPPTX };
