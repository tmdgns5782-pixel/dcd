// Render the slide model to one self-contained HTML file (Paperlogy embedded as woff2).
const fs = require("fs");
const path = require("path");
const { COLORS, WEIGHTS, hex, iconSvg } = require("./lib");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function rgba(c, a = 1) {
  const h = hex(c);
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return a >= 1 ? `#${h}` : `rgba(${r},${g},${b},${a})`;
}
const box = (e) => `left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;`;

function renderEl(e) {
  switch (e.t) {
    case "rect":
    case "ellipse": {
      let st = box(e);
      if (e.fill) st += `background:${rgba(e.fill, e.alpha ?? 1)};`;
      if (e.line) st += `border:${e.lw || 1}px ${e.dash ? "dashed" : "solid"} ${rgba(e.line)};`;
      st += e.t === "ellipse" ? "border-radius:50%;" : e.r ? `border-radius:${e.r}px;` : "";
      return `<div class="el" style="${st}"></div>`;
    }
    case "text": {
      const s = e.s || 14, lh = e.lh || 1.2;
      const jc = { t: "flex-start", m: "center", b: "flex-end" }[e.v || "t"];
      const ta = { l: "left", c: "center", r: "right" }[e.a || "l"];
      let st = box(e) + `justify-content:${jc};text-align:${ta};font-size:${s}pt;font-weight:${WEIGHTS[e.f || "r"].css};color:${rgba(e.c || "ink")};line-height:${lh};`;
      if (e.ls) st += `letter-spacing:${e.ls}pt;`;
      const runs = e.runs.map((r) => {
        let rs = "";
        if (r.s) rs += `font-size:${r.s}pt;`;
        if (r.f) rs += `font-weight:${WEIGHTS[r.f].css};`;
        if (r.c) rs += `color:${rgba(r.c)};`;
        return `<span${rs ? ` style="${rs}"` : ""}>${esc(r.text).replace(/\n/g, "<br>")}</span>`;
      }).join("");
      const lines = e.runs.map((r) => r.text).join("").split("\n").length;
      const maxS = Math.max(s, ...e.runs.map((r) => r.s || 0));
      return `<div class="el tx" data-lines="${lines}" data-s="${maxS}" data-lh="${lh}" style="${st}"><div class="in">${runs}</div></div>`;
    }
    case "line": {
      const id = `arr-${hex(e.c)}`;
      const pts = e.pts.map((p) => p.join(",")).join(" ");
      const dash = e.dash ? ` stroke-dasharray="${(e.lw || 1) * 3} ${(e.lw || 1) * 2}"` : "";
      const m = e.arrow ? ` marker-end="url(#${id})"` : "";
      return `<svg class="el ln" viewBox="0 0 1280 720" width="1280" height="720"><polyline points="${pts}" fill="none" stroke="${rgba(e.c)}" stroke-width="${e.lw || 1}"${dash}${m}/></svg>`;
    }
    case "icon":
      return `<div class="el" style="${box(e)}">${iconSvg(e.n, e.c, e.w)}</div>`;
    case "img":
      return `<div class="el" style="${box(e)}">${e.svg.replace(/width="\d+" height="\d+"/, 'width="100%" height="100%"')}</div>`;
    case "table": {
      const w = e.cols.reduce((a, b) => a + b, 0);
      let h = `<table class="el tb" style="left:${e.x}px;top:${e.y}px;width:${w}px"><colgroup>${e.cols.map((c) => `<col style="width:${c}px">`).join("")}</colgroup>`;
      for (const row of e.rows) {
        h += `<tr style="height:${row.h}px">`;
        for (const c of row.cells) {
          const ta = { l: "left", c: "center", r: "right" }[c.a || "l"];
          h += `<td style="background:${rgba(c.fill || "white")};color:${rgba(c.c || "ink")};font-size:${c.s}pt;font-weight:${WEIGHTS[c.f].css};text-align:${ta};padding:0 ${c.pad ?? 8}px">${esc(c.text).replace(/\n/g, "<br>")}</td>`;
        }
        h += `</tr>`;
      }
      return h + `</table>`;
    }
    default:
      throw new Error(`unknown element ${e.t}`);
  }
}

function markers(slides) {
  const cols = new Set();
  for (const s of slides) for (const e of s.els) if (e.t === "line" && e.arrow) cols.add(hex(e.c));
  return `<svg width="0" height="0" style="position:absolute"><defs>${[...cols].map((c) => `<marker id="arr-${c}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="3.6" markerHeight="3.6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#${c}"/></marker>`).join("")}</defs></svg>`;
}

function renderHTML(slides, layouts, fontDir, outFile) {
  const used = ["r", "m", "sb", "b", "eb", "bk"];
  const faces = used.map((k) => {
    const w = WEIGHTS[k];
    const b64 = fs.readFileSync(path.join(fontDir, `${w.file}.woff2`)).toString("base64");
    return `@font-face{font-family:"Paperlogy";font-weight:${w.css};font-style:normal;font-display:block;src:local("${w.face}"),url(data:font/woff2;base64,${b64}) format("woff2")}`;
  }).join("\n");

  const total = slides.length;
  const frames = slides.map((s, i) => {
    const L = layouts[s.layout];
    let inner = "";
    for (const e of L.els || []) inner += renderEl(e);
    if (L.num) inner += renderEl({ t: "text", ...L.num, a: "r", v: "m", runs: [{ text: String(i + 1) }] });
    inner += renderEl({ t: "text", ...L.title, runs: [{ text: s.title }] });
    for (const e of s.els) inner += renderEl(e);
    const n = String(i + 1).padStart(2, "0");
    return `<section class="frame" id="s${i + 1}">
<div class="meta"><span class="no">${n}</span><span class="sec">${esc(s.section)}</span><span class="ttl">${esc(s.title.replace(/\n/g, " "))}</span></div>
<div class="viewport"><div class="slide" style="background:${rgba(L.bg)}">${inner}</div></div>
<aside class="notes"><b>발표자 노트</b><p>${esc(s.notes || "")}</p></aside>
</section>`;
  }).join("\n");

  const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>온석터널 훈련개요 브리핑</title>
<style>
${faces}
:root{--page:#E6EAF0;--ink:#${COLORS.ink.hex};--muted:#${COLORS.muted.hex};--navy:#${COLORS.navy.hex};--card:#FFFFFF;--line:#${COLORS.line.hex}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--page:#0B1220;--ink:#E7ECF4;--muted:#9AA6BA;--card:#151E2E;--line:#26324A}}
:root[data-theme="dark"]{--page:#0B1220;--ink:#E7ECF4;--muted:#9AA6BA;--card:#151E2E;--line:#26324A}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--page);color:var(--ink);font-family:"Paperlogy","Apple SD Gothic Neo","Malgun Gothic",sans-serif;-webkit-font-smoothing:antialiased}
.bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:16px;padding:14px 16px;background:var(--page);border-bottom:1px solid var(--line)}
.bar h1{font-size:17px;font-weight:800;letter-spacing:-.2px}
.bar .cnt{font-size:13px;color:var(--muted);font-weight:500}
.bar button{margin-left:auto;font:600 13px "Paperlogy",sans-serif;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:8px 14px;cursor:pointer}
main{max-width:1312px;margin:0 auto;padding:24px 16px 64px;display:flex;flex-direction:column;gap:36px}
.meta{display:flex;align-items:baseline;gap:10px;margin:0 2px 10px;font-size:13px;color:var(--muted)}
.meta .no{font-weight:800;color:var(--ink)}
.meta .ttl{font-weight:600;color:var(--ink)}
.viewport{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;border-radius:10px;box-shadow:0 1px 2px rgba(0,0,0,.08),0 8px 28px rgba(13,31,60,.12)}
.slide{position:absolute;left:0;top:0;width:1280px;height:720px;transform-origin:0 0;transform:scale(var(--k,1));overflow:hidden;font-family:"Paperlogy",sans-serif;word-break:keep-all}
.el{position:absolute}
.tx{display:flex;flex-direction:column}
.tx .in{white-space:pre-wrap}
.ln{left:0;top:0;overflow:visible;pointer-events:none}
.tb{border-collapse:collapse;table-layout:fixed}
.tb td{border:1px solid #${COLORS.line.hex};line-height:1.45;vertical-align:middle}
.notes{display:none;margin-top:12px;padding:14px 16px;background:var(--card);border:1px solid var(--line);border-radius:10px;font-size:14px;line-height:1.7}
.notes b{display:block;font-size:12px;color:var(--muted);margin-bottom:4px;font-weight:700}
body.show-notes .notes{display:block}
body.raw main{padding:0;gap:0;max-width:none}
body.raw .bar,body.raw .meta{display:none}
body.raw .viewport{width:1280px;height:720px;border-radius:0;box-shadow:none}
@page{size:13.333in 7.5in;margin:0}
@media print{
  body{background:#fff}
  .bar,.meta,.notes{display:none!important}
  main{padding:0;gap:0;max-width:none}
  .viewport{width:13.333in;height:7.5in;border-radius:0;box-shadow:none;break-after:page}
  .slide{transform:scale(1.0)}
}
</style>
</head>
<body>
${markers(slides)}
<header class="bar"><h1>온석터널 훈련개요 브리핑</h1><span class="cnt">HTML 초안 · ${total}장 · 16:9</span><button type="button" id="notesBtn" aria-pressed="false">발표자 노트 보기</button></header>
<main>
${frames}
</main>
<script>
(function(){
  if (location.hash === "#raw") document.body.classList.add("raw");
  var vps = document.querySelectorAll(".viewport");
  function fit(){ vps.forEach(function(v){ v.firstElementChild.style.setProperty("--k", v.clientWidth / 1280); }); }
  if (window.ResizeObserver) { var ro = new ResizeObserver(fit); vps.forEach(function(v){ ro.observe(v); }); }
  window.addEventListener("resize", fit); fit();
  var btn = document.getElementById("notesBtn");
  try { if (localStorage.getItem("onseok-notes") === "1") document.body.classList.add("show-notes"); } catch (e) {}
  function sync(){ var on = document.body.classList.contains("show-notes"); btn.textContent = on ? "발표자 노트 숨기기" : "발표자 노트 보기"; btn.setAttribute("aria-pressed", on); }
  btn.addEventListener("click", function(){ document.body.classList.toggle("show-notes"); sync(); try { localStorage.setItem("onseok-notes", document.body.classList.contains("show-notes") ? "1" : "0"); } catch (e) {} });
  sync();
})();
</script>
</body>
</html>
`;
  fs.writeFileSync(outFile, html);
  return outFile;
}

module.exports = { renderHTML };
