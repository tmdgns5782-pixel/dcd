// Slide content and layout for the 온석터널 briefing. px on a 1280x720 canvas, fonts in pt.
// Sections and speaker notes follow the 현장시나리오 #3-2 훈련개요 브리핑 script (4 min).

const X0 = 72, X1 = 1208, W = X1 - X0;
const lineH = (s, lh) => s * (4 / 3) * lh;

// ---- small builders ----------------------------------------------------------------------
const rect = (x, y, w, h, o = {}) => ({ t: "rect", x, y, w, h, ...o });
const oval = (x, y, w, h, o = {}) => ({ t: "ellipse", x, y, w, h, ...o });
const text = (x, y, w, h, body, o = {}) => (Array.isArray(body) ? { t: "text", x, y, w, h, runs: body, ...o } : { t: "text", x, y, w, h, runs: [{ text: body }], ...o });
const icon = (n, x, y, size, c) => ({ t: "icon", n, x, y, w: size, h: size, c });
const poly = (pts, o = {}) => ({ t: "line", pts, ...o });

// The six parts of the script, used for the agenda, the section tags and the PPTX sections.
const PARTS = ["훈련목적 및 추진체계", "도로터널 훈련배경", "훈련개요 및 중점사항", "온석터널 시설현황 및 특성", "교통통제 및 우회도로 운영", "상황전파 및 기관별 대응체계"];
const partNo = (n) => String(n).padStart(2, "0");

// Section tag above the title; the part name is left out when the slide title already says it.
function tag(n, title) {
  const runs = [{ text: partNo(n), f: "eb", c: "orange" }];
  if (PARTS[n - 1] !== title) runs.push({ text: "   " + PARTS[n - 1], f: "sb", c: "muted" });
  return [text(X0, 44, 640, 22, runs, { s: 12, v: "m" })];
}

const label = (x, y, w, t, sub) =>
  text(x, y, w, 28, sub ? [{ text: t }, { text: "   " + sub, f: "m", s: 14, c: "muted" }] : t, { s: 18, f: "b", c: "ink", v: "m" });

// Dark key-message card: label at the top; icon, headline and body below it or at the bottom.
function keyCard(x, y, w, h, { lab, ico, head, headSize = 30, body, bodySize = 16, anchor = "top" }) {
  const pad = 32, iw = w - pad * 2;
  const els = [rect(x, y, w, h, { fill: "navy", r: 18, name: "Key message card" })];
  els.push(text(x + pad, y + pad, iw, 24, lab, { s: 14, f: "sb", c: "amber", v: "m" }));
  const hh = Math.ceil(lineH(headSize, 1.22) * head.split("\n").length) + 4;
  const bh = body ? Math.ceil(lineH(bodySize, 1.5) * body.split("\n").length) + 4 : 0;
  let cy = anchor === "bottom" ? y + h - pad - hh - (body ? 14 + bh : 0) : y + pad + 48 + (ico ? 72 : 0);
  if (ico) els.push(icon(ico, x + pad, cy - 72, 44, "amber"));
  els.push(text(x + pad, cy, iw, hh, head, { s: headSize, f: "eb", c: "white", lh: 1.22, ls: -0.5 }));
  cy += hh + 14;
  if (body) {
    els.push(text(x + pad, cy, iw, bh, body, { s: bodySize, f: "r", c: "mist", lh: 1.5 }));
    cy += bh;
  }
  return { els, bottom: cy };
}

// Small round icon badge.
const badge = (n, x, y, d, bg, fg, alpha) => [oval(x, y, d, d, { fill: bg, alpha }), icon(n, x + d * 0.25, y + d * 0.25, d * 0.5, fg)];

// Chevron between cards.
const chevron = (cx, cy) => [oval(cx - 16, cy - 16, 32, 32, { fill: "white", line: "line", lw: 1.5 }), icon("LuChevronRight", cx - 10, cy - 10, 20, "muted")];

const content = (n, title, els, notes) => ({ layout: "CONTENT", section: `${partNo(n)} ${PARTS[n - 1]}`, title, els: [...tag(n, title), ...els], notes });

// ---- slides ------------------------------------------------------------------------------
const slides = [];

// Info band at the foot of the cover and closing slides: label over value, columns split by hairlines.
function infoBand(cols) {
  const els = [rect(X0, 512, W, 112, { fill: "white", alpha: 0.06, r: 18, name: "Info band" })];
  let x = 104;
  cols.forEach(([lab, val, w], i) => {
    if (i > 0) els.push(poly([[x - 24, 540], [x - 24, 596]], { c: "blue", lw: 1.5 }));
    els.push(text(x, 534, w, 24, lab, { s: 13, f: "sb", c: "amber", v: "m" }));
    els.push(text(x, 562, w, 34, val, { s: 17, f: "b", c: "white", v: "m" }));
    x += w + 48;
  });
  return els;
}

// 1. Cover
slides.push({
  layout: "COVER", section: "표지",
  title: "온석터널\n훈련개요 브리핑",
  els: [
    text(X0, 148, 600, 30, "2026 재난대응 안전한국훈련", { s: 16, f: "sb", c: "amber", v: "m" }),
    text(X0, 400, 800, 32, "도로 분야 복합재난 대응훈련", { s: 20, f: "m", c: "mist", v: "m" }),
    ...infoBand([["일시", "2026. 10. 22. (목) 14:00 ~ 16:00", 384], ["장소", "국도32호선 온석터널 서산방향", 300], ["발표 · 예산국토관리사무소", "시설안전관리과장 최병목", 296]]),
  ],
  notes: "(사회자 소개 후) 안녕하십니까? 예산국토관리사무소 시설안전관리과장 최병목입니다.",
});

// 2. Agenda
{
  const pages = ["3", "4 – 5", "6 – 8", "9", "10", "11 – 13"];
  const els = [
    text(X0, 266, 300, 22, "CONTENTS", { s: 12, f: "eb", c: "amber", v: "m", ls: 2 }),
    text(X0, 386, 330, 68, "온석터널 훈련개요 브리핑\n6개 항목으로 보고드립니다", { s: 16, f: "r", c: "mist", lh: 1.5 }),
  ];
  const top = 96, rh = 88;
  PARTS.forEach((name, i) => {
    const y = top + i * rh;
    if (i > 0) els.push(poly([[520, y], [X1, y]], { c: "line", lw: 1.5 }));
    els.push(text(520, y + 14, 80, 60, partNo(i + 1), { s: 30, f: "eb", c: "orange", v: "m", ls: -0.5 }));
    els.push(text(604, y + 14, 480, 60, name, { s: 22, f: "b", c: "ink", v: "m" }));
    els.push(text(1088, y + 14, 120, 60, pages[i], { s: 13, f: "sb", c: "muted", v: "m", a: "r" }));
  });
  slides.push({
    layout: "AGENDA", section: "표지", title: "목차", els,
    notes: "(대본에 별도 멘트가 없는 장입니다. 인사 후 바로 다음 장으로 넘깁니다.)",
  });
}

// 3. 훈련목적 및 추진체계
{
  const els = [];
  els.push(rect(X0, 152, 704, 216, { fill: "panel", r: 18, name: "Legal basis card" }));
  els.push(...badge("LuScale", 100, 178, 52, "navy", "white"));
  els.push(text(168, 178, 300, 52, "추진 근거", { s: 19, f: "b", c: "ink", v: "m" }));
  els.push(rect(604, 186, 144, 36, { fill: "white", line: "orange", lw: 1.5, r: 18 }));
  els.push(text(604, 186, 144, 36, "행정안전부 총괄", { s: 13, f: "sb", c: "orange", v: "m", a: "c" }));
  [["법률", "재난 및 안전관리 기본법 제35조"], ["시행령", "같은 법 시행령 제43조의14"]].forEach(([k, v], i) => {
    const y = 248 + i * 60;
    els.push(rect(100, y, 648, 50, { fill: "white", r: 12 }));
    els.push(text(122, y, 80, 50, k, { s: 14, f: "sb", c: "orange", v: "m" }));
    els.push(text(204, y, 530, 50, v, { s: 19, f: "b", c: "ink", v: "m" }));
  });
  els.push(label(X0, 400, 704, "도로 분야 복합재난 대응훈련", "대전국토청 소속 4개 국토관리사무소 매년 순환"));
  els.push(poly([[110, 508], [750, 508]], { c: "line", lw: 3 }));
  [["2023", "충주국토"], ["2024", "보은국토"], ["2025", "논산국토"], ["2026", "예산국토"]].forEach(([yr, office], i) => {
    const cx = 130 + i * 200, now = i === 3;
    if (now) {
      els.push(oval(cx - 22, 486, 44, 44, { fill: "orange", alpha: 0.16 }));
      els.push(oval(cx - 12, 496, 24, 24, { fill: "orange" }));
    } else {
      els.push(oval(cx - 10, 498, 20, 20, { fill: "white", line: "blue", lw: 3 }));
    }
    els.push(text(cx - 80, 442, 160, 40, yr, { s: 24, f: "eb", c: now ? "orange" : "ink", v: "m", a: "c" }));
    els.push(text(cx - 80, 538, 160, 28, office, { s: 17, f: now ? "b" : "m", c: now ? "orange" : "muted", v: "m", a: "c" }));
  });
  els.push(rect(730 - 34, 574, 68, 26, { fill: "orange", r: 13 }));
  els.push(text(730 - 34, 574, 68, 26, "올해", { s: 12, f: "sb", c: "white", v: "m", a: "c" }));
  els.push(...keyCard(808, 152, 400, 488, { lab: "훈련 목적", ico: "LuShieldCheck", head: "현장\n대응능력 강화", headSize: 34, body: "국가 재난관리 조직의\n관계기관 합동훈련으로\n복합재난 합동대응 역량 확보", bodySize: 16, anchor: "bottom" }).els);
  slides.push(content(1, "훈련목적 및 추진체계", els,
    "먼저, 안전한국훈련의 목적과 추진체계에 대해 말씀드리겠습니다. 행정안전부가 총괄하는 재난대응 안전한국훈련은 「재난 및 안전관리 기본법」 제35조 및 같은 법 시행령 제43조의14에 따라 국가 재난관리 조직의 현장 대응능력을 강화하기 위해 실시하는 관계기관 합동훈련입니다. 금일 훈련은 그 일환으로 추진하는 도로 분야 복합재난 대응훈련으로, 대전지방국토관리청 소속 4개 국토관리사무소가 매년 순환하여 실시하며, 올해는 예산국토관리사무소에서 진행합니다."));
}

// 4. 도로터널 훈련배경
{
  const els = [];
  els.push(label(X0, 152, 360, "도로터널 위험 특성"));
  [["LuBrickWall", "폐쇄적 공간 특성"], ["LuEyeOff", "시야확보 · 대피 곤란"], ["LuCarFront", "후속차량 진입 · 정체"]].forEach(([ic, t], i) => {
    const y = 192 + i * 100;
    els.push(rect(X0, y, 360, 88, { fill: "white", line: "line", lw: 1.5, r: 14 }));
    els.push(...badge(ic, 92, y + 18, 52, "orange", "orange", 0.12));
    els.push(text(162, y, 250, 88, t, { s: 19, f: "b", c: "ink", v: "m" }));
  });
  els.push(label(464, 152, 744, "지역 여건", "충청남도 대규모 산업단지 밀집"));
  [["화물차 교통사고 비율", "3", "LuTruck"], ["위험물질 운송차량 사고", "2", "LuTriangleAlert"]].forEach(([k, n, ic], i) => {
    const x = 464 + i * 380;
    els.push(rect(x, 192, 364, 228, { fill: "navy", r: 18 }));
    els.push(icon(ic, x + 364 - 28 - 32, 218, 32, "mist"));
    els.push(text(x + 28, 218, 270, 32, k, { s: 16, f: "sb", c: "mist", v: "m" }));
    els.push(text(x + 28, 262, 320, 130, [{ text: "전국 ", f: "b", s: 24, c: "white" }, { text: n, f: "bk", s: 96, c: "amber" }, { text: "위", f: "eb", s: 32, c: "white" }], { v: "b", lh: 1.0 }));
  });
  els.push(rect(464, 432, 744, 48, { fill: "panel", r: 12 }));
  els.push(icon("LuMapPin", 484, 445, 22, "orange"));
  els.push(text(516, 432, 680, 48, [{ text: "온석터널 위치 서산지역", f: "b" }, { text: "  —  대산산업단지 중심, 화물차 · 위험물질 운송차량 통행 집중" }], { s: 14, f: "m", c: "ink", v: "m" }));
  els.push(text(844, 486, 364, 18, "* 실시계획 통계 재인용", { s: 11, f: "r", c: "muted", v: "m", a: "r" }));
  els.push(rect(X0, 516, W, 124, { fill: "orange", alpha: 0.07, r: 18, name: "Conclusion banner" }));
  els.push(...badge("LuHandshake", 104, 546, 64, "orange", "white"));
  els.push(text(196, 536, 900, 38, "복합재난 합동대응 필요", { s: 24, f: "eb", c: "navy", v: "m", ls: -0.3 }));
  els.push(text(196, 578, 980, 30, "대규모 인명피해 확대 우려 — 도로관리청 단독 대응을 넘어 유관기관 공조 필수", { s: 17, f: "m", c: "ink", v: "m" }));
  slides.push(content(2, "도로터널 훈련배경", els,
    "다음은 훈련배경입니다. 도로터널은 폐쇄적인 공간 특성상 화재나 화학물질 누출 시 시야확보와 대피가 어렵고, 후속 차량의 진입과 정체가 겹치면서 대규모 인명피해로 확대될 우려가 있습니다. 특히, 충청남도는 대규모 산업단지가 밀집하여 화물차와 위험물질 운송차량의 통행이 많은 지역으로, 최근 통계에서도 화물차 교통사고 비율 전국 3위, 위험물질 운송차량 사고 전국 2위 수준으로 나타나고 있습니다. 그중 온석터널이 위치한 서산지역은 대산산업단지 등을 중심으로 화물차와 위험물질 운송차량의 통행이 매우 많은 지역입니다."));
}

// 5. 최근 실제 사고 사례
{
  const els = [];
  els.push(rect(X0, 158, 104, 32, { fill: "orange", r: 16 }));
  els.push(text(X0, 158, 104, 32, "실제 사고", { s: 14, f: "sb", c: "white", v: "m", a: "c" }));
  els.push(text(192, 154, 568, 40, "2026. 7. 27.  충남 서천IC 인근", { s: 24, f: "b", c: "ink", v: "m" }));
  [["LuFlaskConical", "황산 누출", [{ text: "약 ", f: "b", s: 24 }, { text: "1.63", f: "eb", s: 56 }, { text: "톤", f: "b", s: 26 }]],
   ["LuUsers", "인근 주민 대피", [{ text: "77", f: "eb", s: 56 }, { text: "명", f: "b", s: 26 }]]].forEach(([ic, k, runs], i) => {
    const x = X0 + i * 352;
    els.push(rect(x, 216, 336, 200, { fill: "panel", r: 18 }));
    els.push(icon(ic, x + 28, 244, 28, "orange"));
    els.push(text(x + 66, 242, 240, 32, k, { s: 16, f: "sb", c: "muted", v: "m" }));
    els.push(text(x + 28, 300, 290, 92, runs.map((r) => ({ c: "navy", ...r })), { v: "m", lh: 1.0 }));
  });
  [["사고개요", "운행 중 탱크로리 황산 누출 (약 1.63톤)"], ["조치사항", "도로통제 및 합동방제, 인근 주민 77명 대피"]].forEach(([k, v], i) => {
    const y = 440 + i * 58;
    els.push(poly([[X0, y], [760, y]], { c: "line", lw: 1.5 }));
    els.push(text(X0, y, 110, 58, k, { s: 15, f: "sb", c: "muted", v: "m" }));
    els.push(text(190, y, 570, 58, v, { s: 18, f: "m", c: "ink", v: "m" }));
  });
  els.push(poly([[X0, 556], [760, 556]], { c: "line", lw: 1.5 }));
  els.push(icon("LuNewspaper", X0, 580, 18, "muted"));
  els.push(text(X0 + 28, 574, 400, 30, "출처 : 아주경제, 대전MBC", { s: 13, f: "r", c: "muted", v: "m" }));
  els.push(...keyCard(792, 152, 416, 488, { lab: "훈련 시사점", head: "도로상 화학사고\n합동대응 중요성 증대", headSize: 28, body: "가상의 벤젠 유출 상황을 설정하여\n실제 사고의 교훈을 훈련에 반영", bodySize: 16 }).els);
  [["실제 사고", "황산 누출 · 약 1.63톤"], ["훈련 상황", "벤젠 약 20L 누출 · 착화"]].forEach(([k, v], i) => {
    const y = 504 + i * 60;
    els.push(rect(824, y, 352, 50, { fill: "white", alpha: 0.08, r: 12 }));
    els.push(text(844, y, 100, 50, k, { s: 13, f: "sb", c: i ? "amber" : "mist", v: "m" }));
    els.push(text(940, y, 228, 50, v, { s: 14, f: "m", c: "white", v: "m" }));
  });
  slides.push(content(2, "최근 실제 사고 사례", els,
    "또한, 2026년 7월에는 충남 서천IC 인근에서 운행 중이던 탱크로리에서 황산이 누출되어 도로가 통제되고 인근 주민이 대피하는 사고가 실제 발생하는 등, 도로상 화학사고에 대비한 관계기관 합동대응이 중요해지고 있습니다."));
}

// 6. 훈련개요
{
  const els = [];
  [["LuCalendarClock", "일시", "2026. 10. 22. (목) 14:00 ~ 16:00"], ["LuMapPin", "장소", "국도32호선 온석터널 서산방향 일원"]].forEach(([ic, k, v], i) => {
    const x = X0 + i * 576;
    els.push(rect(x, 152, 560, 96, { fill: "panel", r: 18 }));
    els.push(...badge(ic, x + 24, 174, 52, "navy", "white"));
    els.push(text(x + 92, 168, 440, 24, k, { s: 14, f: "sb", c: "muted", v: "m" }));
    els.push(text(x + 92, 192, 456, 38, v, { s: 21, f: "b", c: "ink", v: "m" }));
  });
  els.push(label(X0, 276, 600, "훈련 진행", "1부 현장훈련 · 2부 토론훈련"));
  const px = W / 120, x15 = X0 + 60 * px, x1510 = X0 + 70 * px;
  els.push(rect(X0, 316, 60 * px - 8, 112, { fill: "navy", r: 16, name: "Part 1 bar" }));
  els.push(text(X0 + 28, 330, 400, 24, "1부  ·  14:00 ~ 15:00", { s: 15, f: "b", c: "amber", v: "m" }));
  els.push(text(X0 + 28, 354, 500, 40, "현장훈련", { s: 24, f: "eb", c: "white", v: "m" }));
  els.push(text(X0 + 28, 394, 500, 24, "사고발생부터 수습 · 복구까지 현장 합동대응", { s: 14, f: "m", c: "mist", v: "m" }));
  els.push(rect(x15 + 4, 316, x1510 - x15 - 12, 112, { line: "line", lw: 1.5, dash: true, r: 16 }));
  els.push(text(x15 + 4, 316, x1510 - x15 - 12, 112, "10분", { s: 12, f: "m", c: "muted", v: "m", a: "c" }));
  els.push(rect(x1510, 316, X1 - x1510, 112, { fill: "blue", r: 16, name: "Part 2 bar" }));
  els.push(text(x1510 + 28, 330, 400, 24, "2부  ·  15:10 ~ 16:00", { s: 15, f: "b", c: "amber", v: "m" }));
  els.push(text(x1510 + 28, 354, 420, 40, "토론훈련", { s: 24, f: "eb", c: "white", v: "m" }));
  els.push(text(x1510 + 28, 394, 420, 24, "현장훈련 강평 · 관계기관 협업체계 개선방안 논의", { s: 14, f: "m", c: "mist", v: "m" }));
  els.push(text(X0, 432, 80, 20, "14:00", { s: 11, f: "m", c: "muted", v: "m" }));
  els.push(text(x15 - 84, 432, 80, 20, "15:00", { s: 11, f: "m", c: "muted", v: "m", a: "r" }));
  els.push(text(x1510, 432, 80, 20, "15:10", { s: 11, f: "m", c: "muted", v: "m" }));
  els.push(text(X1 - 80, 432, 80, 20, "16:00", { s: 11, f: "m", c: "muted", v: "m", a: "r" }));
  els.push(label(X0, 474, 600, "토론의제", "2부 토론훈련"));
  [["LuSiren", "비상대응체계 가동"], ["LuShieldCheck", "유출 확대 시 주민보호"], ["LuRefreshCw", "재발방지 및 협업 개선"]].forEach(([ic, t], i) => {
    const x = X0 + i * 384;
    els.push(rect(x, 514, 368, 126, { fill: "white", line: "line", lw: 1.5, r: 16 }));
    els.push(text(x + 24, 532, 60, 26, "0" + (i + 1), { s: 16, f: "eb", c: "orange", v: "m" }));
    els.push(icon(ic, x + 368 - 24 - 30, 532, 30, "blue"));
    els.push(text(x + 24, 568, 320, 52, t, { s: 20, f: "b", c: "ink", v: "m" }));
  });
  slides.push(content(3, "훈련개요", els,
    "다음은 훈련개요 및 중점사항입니다. 금일 훈련은 10월 22일 오후 2시부터 4시까지, 국도32호선 온석터널 서산방향 일원에서 진행하며, 1부 현장훈련과 2부 토론훈련으로 구성하였습니다. 1부 현장훈련에서는 사고발생부터 수습·복구까지 현장 합동대응을 실시하고, 2부에서는 현장훈련 강평과 관계기관 협업체계에 대한 개선방안을 논의할 예정입니다."));
}

// 7. 훈련상황
{
  const els = [];
  els.push(label(X0, 152, 900, "시나리오 전개", "터널 내 화물차 추돌 → 화학물질 누출 · 화재 → 차량 고립"));
  const steps = [["LuTruck", "졸음운전 화물차\n터널 벽면 충돌"], ["LuTriangleAlert", "탱크로리 추돌\n하부 밸브 손상"], ["LuFlame", "벤젠 약 20L 누출\n증기 착화 · 화재"], ["LuSchool", "초등학생 승합차량\n급정지 · 고립"]];
  const cw = (W - 3 * 24) / 4;
  steps.forEach(([ic, t], i) => {
    const x = X0 + i * (cw + 24), hot = i === 2;
    els.push(rect(x, 192, cw, 164, hot ? { fill: "orange", alpha: 0.06, line: "orange", lw: 2.5, r: 16 } : { fill: "white", line: "line", lw: 1.5, r: 16 }));
    els.push(oval(x + 22, 214, 36, 36, { fill: hot ? "orange" : "navy" }));
    els.push(text(x + 22, 214, 36, 36, String(i + 1), { s: 15, f: "eb", c: "white", v: "m", a: "c" }));
    els.push(icon(ic, x + cw - 22 - 30, 217, 30, hot ? "orange" : "blue"));
    els.push(text(x + 22, 270, cw - 40, 70, t, { s: 19, f: "b", c: "ink", lh: 1.35 }));
    if (i < 3) els.push(...chevron(x + cw + 12, 274));
  });
  els.push(label(X0, 384, 600, "가상 인명피해", "시나리오 기준"));
  [["중상", "2", "화물차 운전자", "orange"], ["경상 (연기흡입)", "3", "승합차량 인솔자", "blue"], ["긴급 대피", "23", "교사 · 학생", "blue"]].forEach(([k, n, who, c], i) => {
    const x = X0 + i * 235;
    els.push(rect(x, 424, 219, 216, { fill: "panel", r: 18 }));
    els.push(text(x + 24, 446, 180, 26, k, { s: 15, f: "b", c, v: "m" }));
    els.push(text(x + 24, 484, 180, 92, [{ text: n, f: "eb", s: 60 }, { text: "명", f: "b", s: 24 }], { c: "navy", v: "m", lh: 1.0 }));
    els.push(text(x + 24, 590, 180, 28, who, { s: 16, f: "m", c: "muted", v: "m" }));
  });
  els.push(...keyCard(792, 384, 416, 256, { lab: "주요 피해 특성", head: "연쇄적 생명 위협\n및 고립 발생", headSize: 26, body: "화학물질 누출과 화재가 동반된 복합 피해", bodySize: 15 }).els);
  slides.push(content(3, "훈련상황 (복합재난 시나리오)", els,
    "훈련상황은 터널 내 화물차 추돌에 따른 화학물질 누출과 화재, 초등학생 탑승 차량의 고립을 가정하였습니다. 졸음운전 화물차가 터널 벽면에 충돌하고, 뒤따르던 탱크로리가 추돌하면서 하부 밸브가 손상되고 벤젠 약 20L가 누출됩니다. 누출된 벤젠증기에 불이 붙으면서 화재가 발생하고, 후방의 초등학생 탑승 승합차량이 급정지하여 고립됩니다. 이 과정에서 화물차 운전자 2명이 중상, 초등학생 승합차량 인솔자 3명이 연기를 흡입하고, 교사·학생 23명이 긴급히 대피해야 하는 상황입니다."));
}

// 8. 참여규모 및 중점사항
{
  const els = [];
  [[[{ text: "11", f: "eb", s: 40 }, { text: "개", f: "b", s: 20 }], "관계기관 · 단체"],
   [[{ text: "약 ", f: "b", s: 20 }, { text: "90", f: "eb", s: 40 }, { text: "명", f: "b", s: 20 }], "참여 인원"],
   [[{ text: "16", f: "eb", s: 40 }, { text: "대", f: "b", s: 20 }], "투입 장비"]].forEach(([runs, k], i) => {
    const x = X0 + i * 235;
    els.push(rect(x, 152, 219, 108, { fill: "panel", r: 16 }));
    els.push(text(x + 24, 164, 180, 58, runs, { c: "navy", v: "m", lh: 1.0 }));
    els.push(text(x + 24, 222, 180, 24, k, { s: 14, f: "m", c: "muted", v: "m" }));
  });
  const H = (t) => ({ text: t, f: "b", s: 15, c: "white", fill: "navy", a: "c" });
  const K = (t) => ({ text: t, f: "b", s: 16, c: "navy", fill: "panel", a: "c" });
  const V = (t) => ({ text: t, f: "m", s: 16, c: "ink", fill: "white", a: "l", pad: 16 });
  const N = (t) => ({ text: t, f: "eb", s: 18, c: "orange", fill: "white", a: "c" });
  els.push({
    t: "table", x: X0, y: 284, cols: [150, 458, 80], name: "Participants table",
    rows: [
      { h: 44, cells: [H("구분"), H("참여 기관·단체"), H("수")] },
      { h: 68, cells: [K("국토부"), V("대전국토청, 예산국토, 온석터널센터"), N("3")] },
      { h: 68, cells: [K("소방·경찰"), V("서산소방서, 서산경찰서"), N("2")] },
      { h: 68, cells: [K("지자체·의료"), V("서산시청, 서산시보건소"), N("2")] },
      { h: 108, cells: [K("특수·기타"), V("서산화학재난합동방재센터, 성연초등학교,\n제20전비 화생방지원대, 주민평가단"), N("4")] },
    ],
  });
  els.push(...keyCard(792, 152, 416, 488, { lab: "훈련 중점", ico: "LuHandshake", head: "기관별 대응체계\n유기적 연계 점검", headSize: 26 }).els);
  [["LuUsers", "재난취약계층 대피 · 구조\n응급의료 협업체계 확인"], ["LuSchool", "학생 실제 대피 참여\n어린이 재난대응 역량 · 안전의식 제고"]].forEach(([ic, t], i) => {
    const y = 468 + i * 80;
    els.push(rect(824, y, 352, 68, { fill: "white", alpha: 0.08, r: 12 }));
    els.push(icon(ic, 842, y + 22, 24, "amber"));
    els.push(text(880, y, 290, 68, t, { s: 14, f: "m", c: "white", lh: 1.35, v: "m" }));
  });
  slides.push(content(3, "참여규모 및 중점사항", els,
    "훈련에는 대전지방국토관리청과 예산국토관리사무소를 비롯하여 서산화학재난합동방재센터, 서산시, 서산소방서 등 11개 관계기관·단체의 인원 약 90여명과 장비 16대가 참여합니다. 이번 훈련의 중점사항은 도로재난과 화학사고가 복합적으로 발생한 현장에서 기관별 대응체계가 유기적으로 연계되는지를 점검하는 것입니다. 특히, 어린이 등 재난취약계층의 대피·구조와 응급의료 협업체계를 확인하고, 학생들이 실제 대피 과정에 참여함으로써 어린이 재난대응 역량과 지역사회 안전의식을 높이는 계기가 되고자 합니다."));
}

// 9. 온석터널 시설현황 및 특성
{
  const els = [];
  const U = (n, u) => [{ text: n, f: "eb", s: 28 }, { text: u, f: "b", s: 16 }];
  const specs = [
    ["LuCalendarCheck", "준공", U("2016", "년"), "국도대체우회도로 건설공사"],
    ["LuRuler", "연장", [...U("340", "m"), { text: "  ·  ", f: "b", s: 20 }, ...U("350", "m")], "서산방향 · 당진방향"],
    ["LuFireExtinguisher", "소화기", U("28", "개"), "방향별 14개"],
    ["LuCctv", "CCTV", U("6", "대"), "방향별 3대"],
  ];
  specs.forEach(([ic, k, runs, sub], i) => {
    const x = X0 + i * 288;
    els.push(rect(x, 152, 272, 168, { fill: "white", line: "line", lw: 1.5, r: 16 }));
    els.push(...badge(ic, x + 20, 172, 48, "navy", "white"));
    els.push(text(x + 80, 172, 90, 48, k, { s: 15, f: "sb", c: "muted", v: "m" }));
    if (i === 1) {
      els.push(rect(x + 272 - 20 - 104, 183, 104, 26, { line: "orange", lw: 1.5, r: 13 }));
      els.push(text(x + 272 - 20 - 104, 183, 104, 26, "4등급 단터널", { s: 12, f: "sb", c: "orange", v: "m", a: "c" }));
    }
    els.push(text(x + 20, 230, 240, 46, runs, { c: "ink", v: "m", lh: 1.0 }));
    els.push(text(x + 20, 280, 240, 24, sub, { s: 14, f: "r", c: "muted", v: "m" }));
  });
  els.push(label(X0, 348, 800, "방재시설 운영", "소화기 · CCTV · 조명제어설비 등 기본 방재시설"));
  // lighting
  els.push(rect(X0, 388, 560, 140, { fill: "panel", r: 18 }));
  els.push(icon("LuLightbulb", 96, 410, 26, "orange"));
  els.push(text(132, 406, 420, 34, "사고 시 터널조명 100% 전환", { s: 18, f: "b", c: "ink", v: "m" }));
  [["평상시", 0.6, "약 60%", "mist", "muted"], ["사고 시", 1, "100%", "orange", "orange"]].forEach(([k, r, v, bar, tc], i) => {
    const y = 456 + i * 34;
    els.push(text(96, y, 64, 24, k, { s: 13, f: "sb", c: "muted", v: "m" }));
    els.push(rect(164, y + 5, 340, 14, { fill: "white", r: 7 }));
    els.push(rect(164, y + 5, 340 * r, 14, { fill: bar, r: 7 }));
    els.push(text(516, y, 100, 24, v, { s: 15, f: "eb", c: tc, v: "m" }));
  });
  // cctv
  els.push(rect(648, 388, 560, 140, { fill: "panel", r: 18 }));
  els.push(icon("LuCctv", 672, 410, 26, "orange"));
  els.push(text(708, 406, 480, 34, "터널통합관리센터 CCTV 상시 모니터링", { s: 18, f: "b", c: "ink", v: "m" }));
  els.push(text(672, 448, 520, 64, [{ text: "현장출동조 약 ", f: "b", s: 22 }, { text: "2", f: "eb", s: 44, c: "orange" }, { text: "분 이내 현장 대응", f: "b", s: 22 }], { c: "ink", v: "m", lh: 1.0 }));
  // bottom strip
  els.push(rect(X0, 556, W, 84, { fill: "navy", r: 18, name: "Key message strip" }));
  els.push(text(104, 556, 560, 84, "단터널 특성 반영 · 현장 대응력 점검", { s: 22, f: "eb", c: "white", v: "m" }));
  ["초기인지", "현장통제", "신속출동", "기관공조"].forEach((t, i) => {
    const x = 676 + i * 130;
    els.push(rect(x, 578, 118, 40, { line: "amber", lw: 1.5, r: 20 }));
    els.push(text(x, 578, 118, 40, t, { s: 15, f: "sb", c: "white", v: "m", a: "c" }));
  });
  slides.push(content(4, "온석터널 시설현황 및 특성", els,
    "다음은 훈련장소인 온석터널 시설현황에 대해 간략히 설명드리겠습니다. 온석터널은 국도32호선에 위치한 연장 340m의 연장등급 4등급 단터널로, 2016년에 서산시 국도대체우회도로 건설공사를 통해 준공되었습니다. 온석터널에는 관련 설치기준에 따라 소화기, CCTV, 조명제어설비 등 기본적인 방재시설을 갖추고 있습니다. 평상시 약 60% 수준으로 운영되는 터널조명은 사고 발생 시 100%로 전환하여 현장 시야를 확보하며, 터널통합관리센터에서 CCTV로 상시 모니터링하고, 사고발생 시 현장출동조는 약 2분 이내에 현장 대응이 가능합니다. 이번 훈련은 오히려 이러한 단터널의 특성을 적극적으로 반영하였습니다. 화물차 통행이 많은 국도 구간에서 대형 화재와 화학물질 사고가 발생할 경우, 장대터널과 같이 다양한 방재설비에 의존하기보다는 초기 상황인지와 현장통제, 신속한 관계기관 출동 및 기관 간 공조가 얼마나 효과적으로 이루어지는지를 점검하는 데 중점을 두었습니다."));
}

// 10. 교통통제 및 우회도로 운영
{
  const els = [];
  const row = (y, h, ic, col, n, t) => {
    els.push(rect(X0, y, W, h, { fill: "white", line: "line", lw: 1.5, r: 18 }));
    els.push(...badge(ic, 96, y + (h - 56) / 2, 56, col, "white"));
    els.push(text(168, y, 60, h, n, { s: 15, f: "eb", c: col === "navy" ? "blue" : col, v: "m" }));
    els.push(text(206, y, 170, h, t, { s: 20, f: "b", c: "ink", v: "m" }));
    els.push(poly([[384, y + 22], [384, y + h - 22]], { c: "line", lw: 1.5 }));
  };
  row(152, 104, "LuBan", "orange", "01", "통제 구간");
  els.push(text(412, 152, 780, 104, [{ text: "온석터널 서산방향 훈련구간 " }, { text: "통제", c: "orange" }, { text: "\n온석교차로 진입램프 차단", f: "m", s: 15, c: "muted" }], { s: 22, f: "b", c: "ink", v: "m", lh: 1.4 }));
  row(272, 128, "LuRoute", "blue", "02", "우회 노선");
  const pills = [["온석교차로", 412, 140], ["온석1길 경유", 604, 140], ["일람교차로", 796, 140], ["국도29호선 합류", 988, 172]];
  pills.forEach(([t, x, w], i) => {
    const last = i === pills.length - 1;
    els.push(rect(x, 312, w, 48, last ? { fill: "blue", alpha: 0.1, r: 24 } : { fill: "panel", r: 24 }));
    els.push(text(x, 312, w, 48, t, { s: 16, f: "b", c: last ? "blue" : "ink", v: "m", a: "c" }));
    if (!last) els.push(poly([[x + w + 10, 336], [pills[i + 1][1] - 10, 336]], { c: "blue", lw: 2.5, arrow: "end" }));
  });
  row(416, 104, "LuArrowLeftRight", "navy", "03", "교차 통행");
  els.push(text(412, 416, 340, 104, "부산교차로 진입 본선차량", { s: 22, f: "b", c: "ink", v: "m" }));
  els.push(poly([[748, 468], [792, 468]], { c: "blue", lw: 2.5, arrow: "end" }));
  els.push(rect(804, 446, 180, 44, { fill: "blue", alpha: 0.1, r: 22 }));
  els.push(text(804, 446, 180, 44, "비상회차로 활용", { s: 16, f: "b", c: "blue", v: "m", a: "c" }));
  els.push(rect(1000, 446, 160, 44, { line: "line", lw: 1.5, r: 22 }));
  els.push(text(1000, 446, 160, 44, "경찰 합의 운영", { s: 14, f: "sb", c: "muted", v: "m", a: "c" }));
  els.push(rect(X0, 544, W, 96, { fill: "navy", r: 18, name: "Key message strip" }));
  els.push(text(104, 556, 600, 36, "우회와 교차통행 병행", { s: 22, f: "eb", c: "white", v: "m" }));
  els.push(text(104, 594, 760, 28, "ITS센터 협조 — VMS 표출 · 내비게이션사 정보제공으로 통제 · 우회정보 안내", { s: 15, f: "r", c: "mist", v: "m" }));
  [["LuMonitor", "VMS 표출"], ["LuNavigation", "내비게이션"]].forEach(([ic, t], i) => {
    const x = 888 + i * 152;
    els.push(rect(x, 568, 140, 48, { fill: "white", alpha: 0.08, r: 12 }));
    els.push(icon(ic, x + 16, 580, 24, "amber"));
    els.push(text(x + 48, 568, 88, 48, t, { s: 14, f: "sb", c: "white", v: "m" }));
  });
  slides.push(content(5, "교통통제 및 우회도로 운영", els,
    "다음은 교통통제 및 우회도로 운영계획입니다. 금일 훈련으로 온석터널 서산방향 훈련구간을 통제하고, 화면과 같이 우회도로를 운영하고 있습니다. 우회차량은 온석교차로에서 온석1길을 경유한 후, 일람교차로에서 국도29호선으로 합류하게 됩니다. 다만, 본선 전면차단에 따른 지역주민과 도로 이용자의 불편을 최소화하기 위해, 경찰과 합의하에 부산교차로에서 진입한 본선 차량은 비상회차로를 활용하여 교차통행하도록 운영하고 있습니다. 또한 이러한 교통정보는 ITS센터의 협조를 받아 VMS 표출, 내비게이션사 정보제공을 통해 국민에게 교통통제 및 우회정보를 안내하고 있습니다."));
}

// 11. 상황전파 체계
{
  const els = [];
  els.push(text(392, 160, 300, 22, "보고 체계", { s: 14, f: "sb", c: "blue", v: "m" }));
  els.push(rect(392, 190, 208, 116, { fill: "white", line: "blue", lw: 2, r: 16 }));
  els.push(text(392, 204, 208, 32, "예산국토", { s: 20, f: "b", c: "ink", v: "m", a: "c" }));
  els.push(text(392, 240, 208, 52, "대전국토청 보고\n관계기관 협조요청", { s: 13, f: "r", c: "muted", lh: 1.35, a: "c", v: "m" }));
  els.push(poly([[604, 248], [644, 248]], { c: "blue", lw: 2.5, arrow: "end" }));
  els.push(rect(648, 190, 216, 116, { fill: "navy", r: 16 }));
  els.push(text(648, 204, 216, 32, "대전국토청", { s: 20, f: "b", c: "white", v: "m", a: "c" }));
  els.push(text(648, 240, 216, 52, "상황판단회의\n지역사고수습본부 설치·운영", { s: 13, f: "r", c: "mist", lh: 1.35, a: "c", v: "m" }));
  els.push(rect(X0, 330, 284, 160, { fill: "orange", alpha: 0.07, line: "orange", lw: 2.5, r: 18, name: "Origin node" }));
  els.push(icon("LuRadioTower", 96, 350, 30, "orange"));
  els.push(text(96, 388, 252, 34, "터널통합관리센터", { s: 20, f: "b", c: "ink", v: "m" }));
  els.push(text(96, 424, 252, 52, "CCTV 사고인지\n방재시설 가동 · 현장출동조 투입", { s: 14, f: "r", c: "muted", lh: 1.35 }));
  els.push(poly([[360, 380], [376, 380], [376, 248], [388, 248]], { c: "blue", lw: 2.5, arrow: "end" }));
  els.push(poly([[360, 446], [376, 446], [376, 476], [770, 476]], { c: "orange", lw: 2.5 }));
  els.push(text(392, 446, 200, 26, "동시 전파", { s: 14, f: "sb", c: "orange", v: "m" }));
  [["LuShield", "경찰"], ["LuFlame", "소방"], ["LuMonitor", "ITS센터"]].forEach(([ic, t], i) => {
    const x = 392 + i * 154, cx = x + 70;
    els.push(poly([[cx, 476], [cx, 506]], { c: "orange", lw: 2.5, arrow: "end" }));
    els.push(rect(x, 510, 140, 92, { fill: "white", line: "orange", lw: 2, r: 16 }));
    els.push(icon(ic, cx - 13, 524, 26, "orange"));
    els.push(text(x, 556, 140, 32, t, { s: 19, f: "b", c: "ink", v: "m", a: "c" }));
  });
  els.push(...keyCard(896, 152, 312, 488, { lab: "초동 조치 핵심", ico: "LuTimer", head: "동시다발적\n상황 전파", headSize: 30, body: "초동 조치의 핵심인\n골든타임 확보", bodySize: 17, anchor: "bottom" }).els);
  slides.push(content(6, "상황전파 체계", els,
    "마지막으로, 상황전파와 기관별 대응체계입니다. 터널통합관리센터는 CCTV로 사고를 인지한 즉시 방재시설을 가동하고 현장출동조를 투입하며, 경찰·소방·ITS센터에 상황을 전파하고 예산국토관리사무소에 보고합니다. 예산국토는 대전지방국토관리청에 보고하고 관계기관에 협조를 요청하며, 대전국토청은 상황판단회의를 거쳐 지역사고수습본부를 설치·운영합니다."));
}

// 12. 기관별 대응 현황
{
  const els = [];
  const hub = { x: 640, y: 352 };
  const cards = [
    ["LuShield", "경찰", "교통통제 · 긴급차량 진입로 확보"],
    ["LuFlame", "소방", "화재진압 · 인명구조 · 초기제독"],
    ["LuFlaskConical", "서산화학재난합동방재센터", "오염도 측정·분석 · 영향범위 판단"],
    ["LuLandmark", "서산시", "현장통합지원본부 운영"],
    ["LuStethoscope", "보건소", "현장응급의료소 운영"],
    ["LuPlane", "공군 제20전투비행단", "제독차량 투입"],
  ];
  const cw = 400, ch = 112;
  const pos = cards.map((_, i) => ({ x: i < 3 ? X0 : X1 - cw, y: 172 + (i % 3) * 128 }));
  // spokes first so cards and hub sit on top
  pos.forEach((p, i) => {
    const ax = i < 3 ? p.x + cw : p.x, ay = p.y + ch / 2;
    const ang = Math.atan2(ay - hub.y, ax - hub.x);
    const bx = hub.x + 124 * Math.cos(ang), by = hub.y + 124 * Math.sin(ang);
    els.push(poly([[ax, ay], [bx, by]], { c: "mist", lw: 2 }));
    els.push(oval(bx - 5, by - 5, 10, 10, { fill: "blue" }));
  });
  els.push(oval(hub.x - 124, hub.y - 124, 248, 248, { line: "mist", lw: 1.5, dash: true }));
  els.push(oval(hub.x - 104, hub.y - 104, 208, 208, { fill: "navy", name: "Hub" }));
  els.push(icon("LuMapPin", hub.x - 13, hub.y - 68, 26, "amber"));
  els.push(text(hub.x - 100, hub.y - 30, 200, 70, "온석터널\n사고 현장", { s: 20, f: "eb", c: "white", lh: 1.25, a: "c", v: "m" }));
  els.push(text(hub.x - 100, hub.y + 44, 200, 22, "Concurrent", { s: 12, f: "sb", c: "amber", a: "c", v: "m", ls: 1 }));
  cards.forEach(([ic, name, role], i) => {
    const { x, y } = pos[i];
    els.push(rect(x, y, cw, ch, { fill: "white", line: "line", lw: 1.5, r: 16 }));
    els.push(...badge(ic, x + 20, y + 28, 56, "blue", "blue", 0.1));
    els.push(text(x + 92, y + 22, 296, 30, name, { s: 18, f: "b", c: "ink", v: "m" }));
    els.push(text(x + 92, y + 54, 296, 30, role, { s: 15, f: "r", c: "muted", v: "m" }));
  });
  els.push(text(X0, 568, W, 34, "상황에 따른 연계 및 병행(Concurrent) 대응", { s: 20, f: "eb", c: "navy", a: "c", v: "m" }));
  els.push(text(X0, 604, W, 28, "단선적 조치가 아닌, 각 기관의 전문성이 현장에서 동시 다발적으로 맞물려 작동", { s: 15, f: "r", c: "muted", a: "c", v: "m" }));
  slides.push(content(6, "기관별 대응 현황", els,
    "현장에서는 경찰이 교통통제와 긴급차량 진입로를 확보하고, 소방이 화재진압·인명구조 및 초기제독을 실시합니다. 화학재난합동방재센터는 오염도 측정·분석과 화학물질 영향범위 판단을 지원하고, 서산시는 현장통합지원본부를, 보건소는 현장응급의료소를 운영하며, 군부대는 제독차량을 투입합니다."));
}

// 13. 수습복구 및 마무리
{
  const els = [];
  els.push(label(X0, 152, 600, "수습복구 절차", "예산국토 주관 · 관계기관 협의"));
  const steps = [["LuTruck", "사고차량 견인 및\n파손시설 복구"], ["LuClipboardCheck", "터널 안전점검 및\n안전 확인"], ["LuCircleCheckBig", "경찰 등 관계기관\n협의 후 통행재개"]];
  steps.forEach(([ic, t], i) => {
    const x = X0 + i * 392, last = i === 2;
    els.push(rect(x, 192, 352, 252, last ? { fill: "orange", alpha: 0.06, line: "orange", lw: 2.5, r: 18 } : { fill: "white", line: "line", lw: 1.5, r: 18 }));
    els.push(text(x + 28, 212, 120, 64, "0" + (i + 1), { s: 40, f: "eb", c: last ? "orange" : "blue", v: "m", ls: -0.5 }));
    els.push(...badge(ic, x + 352 - 28 - 60, 214, 60, last ? "orange" : "blue", last ? "orange" : "blue", 0.1));
    els.push(text(x + 28, 334, 300, 84, t, { s: 22, f: "b", c: "ink", lh: 1.35, v: "b" }));
    if (i < 2) els.push(...chevron(x + 352 + 20, 318));
  });
  els.push(rect(X0, 476, W, 136, { fill: "panel", r: 18 }));
  els.push(...badge("LuBookOpenCheck", 104, 514, 60, "navy", "white"));
  els.push(text(188, 504, 600, 26, "협조체계 현장 작동 확인", { s: 14, f: "sb", c: "orange", v: "m" }));
  els.push(text(188, 532, 980, 44, "훈련에서 도출된 개선사항은 매뉴얼과 후속 조치에 반영", { s: 20, f: "b", c: "ink", v: "m" }));
  slides.push(content(6, "수습복구 및 마무리", els,
    "이후 예산국토에서 사고차량 견인과 파손시설 복구, 터널 안전점검을 실시하고, 안전을 확인한 후 경찰 등 관계기관과 협의하여 통행을 재개합니다. 이와 같은 대응과정을 통해 기관 간 협조체계가 실제 현장에서 작동하는지를 확인하고, 훈련에서 도출된 개선사항은 매뉴얼과 후속 조치에 반영하겠습니다."));
}

// 14. Closing
slides.push({
  layout: "CLOSING", section: "마무리", title: "감사합니다",
  els: [
    text(X0, 196, 600, 30, "현장에서 작동하는 협조체계", { s: 16, f: "sb", c: "amber", v: "m" }),
    text(X0, 358, 900, 40, "훈련에 참여해주신 유관기관 및 관계자 여러분께 감사드립니다.", { s: 20, f: "m", c: "mist", v: "m" }),
    ...infoBand([["훈련", "2026 재난대응 안전한국훈련 · 온석터널", 456], ["주관", "예산국토관리사무소 시설안전관리과", 456]]),
  ],
  notes: "이상으로 훈련개요 브리핑을 마치겠습니다. 감사합니다.",
});

// ---- layouts -----------------------------------------------------------------------------
const FOOTER = "2026 재난대응 안전한국훈련  |  온석터널 훈련개요 브리핑";
const NUM = { x: X1 - 100, y: 676, w: 100, h: 20, s: 10, f: "sb", c: "muted" };
const layouts = {
  COVER: { bg: "navy", title: { x: X0, y: 188, w: W, h: 196, s: 64, f: "bk", c: "white", lh: 1.15, ls: -1 } },
  CLOSING: { bg: "navy", title: { x: X0, y: 236, w: W, h: 110, s: 72, f: "bk", c: "white", lh: 1.15, ls: -1 } },
  AGENDA: {
    bg: "white", title: { x: X0, y: 300, w: 340, h: 70, s: 44, f: "eb", c: "white", lh: 1.15, ls: -0.5 },
    els: [rect(0, 0, 448, 720, { fill: "navy" }), text(520, 676, 600, 20, FOOTER, { s: 10, f: "r", c: "muted", v: "m" })],
    num: NUM,
  },
  CONTENT: {
    bg: "white", title: { x: X0, y: 70, w: W, h: 52, s: 30, f: "eb", c: "navy", lh: 1.2, ls: -0.5 },
    els: [text(X0, 676, 700, 20, FOOTER, { s: 10, f: "r", c: "muted", v: "m" })],
    num: NUM,
  },
};

module.exports = { slides, layouts };
