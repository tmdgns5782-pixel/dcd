// out/deck.json + out/bgN.png + assets → ../갈현이룸태권도_상담PPT.pptx
// 글자·도형·표는 PPT 개체(수정 가능), 캐릭터·아이콘은 원본 PNG, 붓 터치 등 장식만 배경 그림.
// 실행: node build/build_pptx.js   (pptxgenjs, sharp 필요 — NODE_PATH로 지정 가능)
const fs = require("fs");
const path = require("path");
const pptxgen = require("pptxgenjs");

const HERE = __dirname;
const ROOT = path.dirname(HERE);
const OUT = path.join(HERE, "out");
const deck = JSON.parse(fs.readFileSync(path.join(OUT, "deck.json"), "utf8"));

const IN = v => v / 160;            // 1600px → 10in
const PT = v => +(v * 0.45).toFixed(2); // px → pt (1px = 1/160in = 0.45pt)

function fontFace(family, weight) {
  if (/Recipekorea/.test(family)) return "Recipekorea";
  if (/Sukyung/.test(family)) return "Ownglyph SeokyoungChae";
  if (/Montserrat/.test(family)) return "Montserrat ExtraBold";
  const w = parseInt(weight, 10) || 400;
  if (w >= 800) return "Pretendard ExtraBold";
  if (w >= 700) return "Pretendard Bold";
  if (w >= 600) return "Pretendard SemiBold";
  return "Pretendard Medium";
}

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.title = "갈현이룸태권도 상담 자료";
pres.author = "갈현이룸태권도";

const shadow = () => ({ type: "outer", blur: 8, offset: 2, angle: 90, color: "2A2040", opacity: 0.12 });
const names = ["표지", "교육 철학", "유치부 프로그램", "초등부 프로그램", "인성교육", "시간표", "원비 안내", "무료 차량 운행", "마무리"];

deck.forEach((sd, i) => {
  const slide = pres.addSlide();
  slide.background = { path: path.join(OUT, `bg${i + 1}.jpg`) };
  const items = sd.items;
  const order = { rrect: 0, tri: 0, table: 1, ellipse: 2, image: 3, text: 4 };
  [...items].sort((a, b) => order[a.kind] - order[b.kind]).forEach((it, k) => {
    const name = `${names[i]} ${it.kind} ${k + 1}`;
    if (it.kind === "rrect") {
      slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
        x: IN(it.x), y: IN(it.y), w: IN(it.w), h: IN(it.h), rectRadius: IN(it.radius),
        fill: { color: it.fill || "FFFFFF" },
        line: it.line ? { color: it.line, width: PT(it.lineW), transparency: Math.round((1 - it.lineA) * 100) } : { type: "none" },
        shadow: it.shadow ? shadow() : undefined, objectName: name,
      });
    } else if (it.kind === "tri") {
      slide.addShape(pres.shapes.ISOSCELES_TRIANGLE, { x: IN(it.x), y: IN(it.y), w: IN(it.w), h: IN(it.h) * 0.93, flipV: true,
        fill: { color: it.fill }, line: { type: "none" }, objectName: name });
    } else if (it.kind === "ellipse") {
      slide.addShape(pres.shapes.OVAL, { x: IN(it.x), y: IN(it.y), w: IN(it.w), h: IN(it.h), fill: { color: it.fill },
        line: { type: "none" }, shadow: it.shadow ? shadow() : undefined, objectName: name });
    } else if (it.kind === "table") {
      // 둥근 흰 판 + 표
      slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: IN(it.x), y: IN(it.y), w: IN(it.w), h: IN(it.h), rectRadius: IN(20),
        fill: { color: "FFFFFF" }, line: { type: "none" }, shadow: shadow(), objectName: "시간표 바탕" });
      const border = { type: "solid", pt: 1, color: "E3E9F2" };
      const rows = it.rows.map((r, ri) => r.map(c => ({
        text: c.text,
        options: {
          fontFace: fontFace("Pretendard", c.weight), fontSize: PT(c.size), color: c.color, bold: false,
          fill: { color: ri === 0 ? "3A7BD7" : "FFFFFF" }, align: "center", valign: "middle", margin: 0,
          border: ri === 0 ? [{ type: "none" }, { type: "solid", pt: 1, color: "7FA8E8" }, { type: "none" }, { type: "none" }] : [border, border, border, border],
        },
      })));
      // 마지막 열 오른쪽 테두리 없애기
      rows.forEach(r => { r[r.length - 1].options.border = r[r.length - 1].options.border.map((b, bi) => bi === 1 ? { type: "none" } : b); });
      slide.addTable(rows, { x: IN(it.x), y: IN(it.y), w: IN(it.w), colW: it.rows[0].map(c => IN(c.w)),
        rowH: it.rows.map(r => IN(r[0].h)), objectName: "시간표" });
    } else if (it.kind === "image") {
      slide.addImage({ path: path.join(OUT, "img", it.key), x: IN(it.x), y: IN(it.y), w: IN(it.w), h: IN(it.h),
        altText: it.key.replace(/\.png$/, ""), objectName: it.key.replace(/\.png$/, "") });
    } else if (it.kind === "text") {
      const runs = [];
      it.runs.forEach((r, ri) => {
        if (r.br) { if (runs.length) runs[runs.length - 1].options.breakLine = true; return; }
        runs.push({ text: r.text, options: { fontFace: fontFace(r.family, r.weight), fontSize: PT(r.size), color: r.color,
          charSpacing: it.ls ? PT(it.ls) : undefined } });
      });
      const nLines = it.runs.filter(r => r.br).length + 1;
      const textH = Math.max(it.h, nLines * it.lineHeight);
      const slack = it.w * 0.12 + 10;
      let x = it.x, w = it.w + slack;
      if (it.align === "center") x = it.x - slack / 2;
      else if (it.align === "right") x = it.x - slack;
      slide.addText(runs, {
        x: IN(x), y: IN(it.y + it.h / 2 - textH / 2), w: IN(w), h: IN(textH), margin: 0, valign: "middle", align: it.align,
        lineSpacing: nLines > 1 ? PT(it.lineHeight) : undefined, rotate: it.rot ? +it.rot.toFixed(1) : undefined,
        wrap: false, isTextBox: true, objectName: `${names[i]} 글자 ${k + 1}`,
      });
    }
  });
});

const file = path.join(ROOT, "갈현이룸태권도_상담PPT.pptx");
pres.writeFile({ fileName: file }).then(() => console.log("wrote", file));
