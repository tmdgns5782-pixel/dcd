// Slide content and layout for the 온석터널 briefing. px on a 1280x720 canvas, fonts in pt.
const { tunnelArtSvg, archWatermarkSvg, portalBleedSvg } = require("./lib");

const X0 = 72, X1 = 1208, W = X1 - X0;
const lineH = (s, lh) => s * (4 / 3) * lh;

// ---- small builders ----------------------------------------------------------------------
const rect = (x, y, w, h, o = {}) => ({ t: "rect", x, y, w, h, ...o });
const oval = (x, y, w, h, o = {}) => ({ t: "ellipse", x, y, w, h, ...o });
const text = (x, y, w, h, body, o = {}) => (Array.isArray(body) ? { t: "text", x, y, w, h, runs: body, ...o } : { t: "text", x, y, w, h, runs: [{ text: body }], ...o });
const icon = (n, x, y, size, c) => ({ t: "icon", n, x, y, w: size, h: size, c });
const img = (svg, x, y, w, h, name) => ({ t: "img", svg, x, y, w, h, name });
const poly = (pts, o = {}) => ({ t: "line", pts, ...o });

// Section tag above the title: portal mark + number + section name.
function tag(num, name) {
  return [
    icon("arch", X0, 47, 16, "orange"),
    text(X0 + 24, 44, 520, 22, [{ text: num, f: "eb", c: "orange" }, { text: "   " + name, f: "sb", c: "muted" }], { s: 12, v: "m" }),
  ];
}

const label = (x, y, w, t, sub) =>
  text(x, y, w, 28, sub ? [{ text: t }, { text: "   " + sub, f: "m", s: 14, c: "muted" }] : t, { s: 18, f: "b", c: "ink", v: "m" });

// Dark key-message card: label, icon, headline, body, portal watermark.
function keyCard(x, y, w, h, { lab, ico, head, headSize = 30, body, bodySize = 16, watermark = true }) {
  const pad = 32, iw = w - pad * 2;
  const els = [rect(x, y, w, h, { fill: "navy", r: 18, name: "Key message card" })];
  if (watermark) els.push(img(archWatermarkSvg(240, 200), x + w - 240, y + h - 200, 240, 200, "Portal watermark"));
  els.push(icon("arch", x + pad, y + pad + 3, 18, "amber"));
  els.push(text(x + pad + 26, y + pad, iw - 26, 24, lab, { s: 14, f: "sb", c: "amber", v: "m" }));
  let cy = y + pad + 48;
  if (ico) {
    els.push(icon(ico, x + pad, cy, 44, "amber"));
    cy += 72;
  }
  const hl = head.split("\n").length, hh = Math.ceil(lineH(headSize, 1.22) * hl) + 4;
  els.push(text(x + pad, cy, iw, hh, head, { s: headSize, f: "eb", c: "white", lh: 1.22, ls: -0.5 }));
  cy += hh + 14;
  if (body) {
    const bl = body.split("\n").length, bh = Math.ceil(lineH(bodySize, 1.5) * bl) + 4;
    els.push(text(x + pad, cy, iw, bh, body, { s: bodySize, f: "r", c: "mist", lh: 1.5 }));
    cy += bh;
  }
  return { els, bottom: cy };
}

// Small round icon badge.
const badge = (n, x, y, d, bg, fg, alpha) => [oval(x, y, d, d, { fill: bg, alpha }), icon(n, x + d * 0.25, y + d * 0.25, d * 0.5, fg)];

// Chevron between cards.
const chevron = (cx, cy) => [oval(cx - 16, cy - 16, 32, 32, { fill: "white", line: "line", lw: 1.5 }), icon("LuChevronRight", cx - 10, cy - 10, 20, "muted")];

// ---- slides ------------------------------------------------------------------------------
const slides = [];

// 1. Cover
slides.push({
  layout: "COVER", section: "표지",
  title: "온석터널\n훈련개요 브리핑",
  els: [
    img(tunnelArtSvg(720, 720), 560, 0, 720, 720, "Tunnel artwork"),
    icon("arch", X0, 199, 20, "amber"),
    text(X0 + 30, 194, 520, 30, "2026 재난대응 안전한국훈련", { s: 16, f: "sb", c: "amber", v: "m" }),
    text(X0, 428, 560, 30, "국도32호선 온석터널 복합재난 합동대응훈련", { s: 17, f: "m", c: "mist", v: "m" }),
    text(X0, 546, 480, 34, "2026. 10. 22. (목)", { s: 20, f: "b", c: "amber", v: "m" }),
    text(X0, 586, 600, 28, "예산국토관리사무소  시설안전관리과장  최병목", { s: 16, f: "m", c: "white", v: "m" }),
  ],
  notes: "2026 재난대응 안전한국훈련 온석터널 훈련개요를 보고드리겠습니다. 오늘 훈련은 국도32호선 온석터널에서 위험물 누출과 화재가 함께 발생하는 복합재난을 가정한 유관기관 합동대응훈련입니다.",
});

// 2. Agenda
{
  const rows = [
    ["01", "훈련 배경", "훈련목적 및 추진체계 · 훈련배경 · 최근 실제 사고 사례", "3 – 5"],
    ["02", "훈련 계획", "훈련개요 · 훈련상황(복합재난 시나리오) · 참여규모 및 중점", "6 – 8"],
    ["03", "현장 여건", "온석터널 현황 · 교통통제 및 우회도로", "9 – 10"],
    ["04", "대응 및 복구", "상황전파 체계 · 기관별 대응 현황 · 수습복구 및 마무리", "11 – 13"],
  ];
  const els = [
    img(portalBleedSvg(380, 300), X0 - 10, 420, 380, 300, "Portal artwork"),
    icon("arch", X0, 123, 16, "orange"),
    text(X0 + 24, 120, 300, 22, "CONTENTS", { s: 12, f: "eb", c: "orange", v: "m", ls: 2 }),
    text(X0, 236, 380, 64, "훈련 배경부터 대응·복구까지\n4개 파트로 보고드립니다", { s: 16, f: "r", c: "muted", lh: 1.5 }),
  ];
  const top = 120, rh = 120;
  rows.forEach(([n, name, topics, pages], i) => {
    const y = top + i * rh;
    if (i > 0) els.push(poly([[520, y], [X1, y]], { c: "line", lw: 1.5 }));
    els.push(text(520, y + 18, 100, 60, n, { s: 36, f: "eb", c: "orange", v: "m", ls: -0.5 }));
    els.push(text(624, y + 22, 440, 38, name, { s: 22, f: "b", c: "ink", v: "m" }));
    els.push(text(624, y + 62, 584, 26, topics, { s: 14, f: "r", c: "muted", v: "m" }));
    els.push(text(1088, y + 24, 120, 34, pages, { s: 13, f: "sb", c: "muted", v: "m", a: "r" }));
  });
  slides.push({
    layout: "AGENDA", section: "표지", title: "목차", els,
    notes: "보고 순서입니다. 훈련 배경, 훈련 계획, 현장 여건, 그리고 대응 및 복구 순으로 말씀드리겠습니다.",
  });
}

// 3. 훈련목적 및 추진체계
{
  const els = [...tag("01", "훈련 배경")];
  // legal basis card
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
  // timeline
  els.push(label(X0, 400, 400, "연도별 추진 현황"));
  els.push(poly([[110, 508], [750, 508]], { c: "line", lw: 3 }));
  [["2023", "충주"], ["2024", "보은"], ["2025", "논산"], ["2026", "예산"]].forEach(([yr, city], i) => {
    const cx = 130 + i * 200, now = i === 3;
    if (now) {
      els.push(oval(cx - 22, 486, 44, 44, { fill: "orange", alpha: 0.16 }));
      els.push(oval(cx - 12, 496, 24, 24, { fill: "orange" }));
    } else {
      els.push(oval(cx - 10, 498, 20, 20, { fill: "white", line: "blue", lw: 3 }));
    }
    els.push(text(cx - 80, 442, 160, 40, yr, { s: 24, f: "eb", c: now ? "orange" : "ink", v: "m", a: "c" }));
    els.push(text(cx - 80, 538, 160, 28, city, { s: 17, f: now ? "b" : "m", c: now ? "orange" : "muted", v: "m", a: "c" }));
  });
  els.push(rect(130 + 600 - 34, 574, 68, 26, { fill: "orange", r: 13 }));
  els.push(text(130 + 600 - 34, 574, 68, 26, "올해", { s: 12, f: "sb", c: "white", v: "m", a: "c" }));
  els.push(...keyCard(808, 152, 400, 488, { lab: "훈련 목적", ico: "LuShieldCheck", head: "현장\n대응능력 강화", headSize: 34, body: "복합재난 상황에서의\n실전적 합동대응 역량 확보", bodySize: 17 }).els);
  slides.push({
    layout: "CONTENT", section: "01 훈련 배경", title: "훈련목적 및 추진체계", els,
    notes: "이번 훈련은 행정안전부 총괄 아래 재난 및 안전관리 기본법 제35조와 같은 법 시행령 제43조의14에 근거해 추진합니다. 2023년 충주, 2024년 보은, 2025년 논산에 이어 올해는 예산에서 추진하며, 복합재난 상황에서의 실전적 합동대응 역량 확보, 즉 현장 대응능력 강화가 목적입니다.",
  });
}

// 4. 훈련배경
{
  const els = [...tag("01", "훈련 배경")];
  els.push(label(X0, 152, 360, "터널 구조적 특성"));
  [["arch", "폐쇄공간"], ["LuEyeOff", "시야와 대피 제약"], ["LuCarFront", "후속차량 정체 심화"]].forEach(([ic, t], i) => {
    const y = 192 + i * 96;
    els.push(rect(X0, y, 360, 84, { fill: "white", line: "line", lw: 1.5, r: 14 }));
    els.push(...badge(ic, 92, y + 16, 52, "orange", "orange", 0.12));
    els.push(text(162, y, 250, 84, t, { s: 19, f: "b", c: "ink", v: "m" }));
  });
  els.push(label(464, 152, 744, "지역 여건", "충남 산업단지와 서산 대산산단"));
  [["화물차 사고 비율", "3", "LuTruck"], ["위험물질 운송차량 사고", "2", "LuTriangleAlert"]].forEach(([k, n, ic], i) => {
    const x = 464 + i * 380;
    els.push(rect(x, 192, 364, 276, { fill: "navy", r: 18 }));
    els.push(icon(ic, x + 364 - 28 - 32, 220, 32, "mist"));
    els.push(text(x + 28, 220, 260, 32, k, { s: 16, f: "sb", c: "mist", v: "m" }));
    els.push(text(x + 28, 300, 320, 130, [{ text: "전국 ", f: "b", s: 24, c: "white" }, { text: n, f: "bk", s: 96, c: "amber" }, { text: "위", f: "eb", s: 32, c: "white" }], { v: "b", lh: 1.0 }));
  });
  els.push(text(844, 474, 364, 20, "* 실시계획 통계 재인용", { s: 11, f: "r", c: "muted", v: "m", a: "r" }));
  els.push(rect(X0, 512, W, 128, { fill: "orange", alpha: 0.07, r: 18, name: "Conclusion banner" }));
  els.push(...badge("LuHandshake", 104, 544, 64, "orange", "white"));
  els.push(text(196, 534, 900, 38, "복합재난 합동대응 필요", { s: 24, f: "eb", c: "navy", v: "m", ls: -0.3 }));
  els.push(text(196, 576, 960, 30, "도로관리청 단독 대응의 한계를 극복하기 위한 유관기관 공조 필수", { s: 17, f: "m", c: "ink", v: "m" }));
  slides.push({
    layout: "CONTENT", section: "01 훈련 배경", title: "훈련배경", els,
    notes: "터널은 폐쇄공간이라 시야와 대피가 제약되고, 사고 시 후속차량 정체가 빠르게 심화됩니다. 여기에 충남 산업단지와 서산 대산산단 여건상 화물차 사고 비율은 전국 3위, 위험물질 운송차량 사고는 전국 2위입니다. 도로관리청 단독 대응으로는 한계가 있어 유관기관 공조가 필수입니다.",
  });
}

// 5. 최근 실제 사고 사례
{
  const els = [...tag("01", "훈련 배경")];
  els.push(rect(X0, 158, 104, 32, { fill: "orange", r: 16 }));
  els.push(text(X0, 158, 104, 32, "실제 사고", { s: 14, f: "sb", c: "white", v: "m", a: "c" }));
  els.push(text(192, 154, 560, 40, "2026. 7. 27.  서천IC 인근", { s: 24, f: "b", c: "ink", v: "m" }));
  [["LuFlaskConical", "황산 누출", [{ text: "약 ", f: "b", s: 24 }, { text: "1.63", f: "eb", s: 56 }, { text: "톤", f: "b", s: 26 }]],
   ["LuUsers", "인근 주민 대피", [{ text: "77", f: "eb", s: 56 }, { text: "명", f: "b", s: 26 }]]].forEach(([ic, k, runs], i) => {
    const x = X0 + i * 352;
    els.push(rect(x, 216, 336, 200, { fill: "panel", r: 18 }));
    els.push(icon(ic, x + 28, 244, 28, "orange"));
    els.push(text(x + 66, 242, 240, 32, k, { s: 16, f: "sb", c: "muted", v: "m" }));
    els.push(text(x + 28, 300, 290, 92, runs.map((r) => ({ c: "navy", ...r })), { v: "m", lh: 1.0 }));
  });
  [["사고개요", "황산 누출 (약 1.63톤)"], ["조치사항", "도로통제 및 합동방제, 인근 주민 77명 대피"]].forEach(([k, v], i) => {
    const y = 440 + i * 58;
    els.push(poly([[X0, y], [760, y]], { c: "line", lw: 1.5 }));
    els.push(text(X0, y, 110, 58, k, { s: 15, f: "sb", c: "muted", v: "m" }));
    els.push(text(190, y, 570, 58, v, { s: 18, f: "m", c: "ink", v: "m" }));
  });
  els.push(poly([[X0, 556], [760, 556]], { c: "line", lw: 1.5 }));
  els.push(icon("LuNewspaper", X0, 580, 18, "muted"));
  els.push(text(X0 + 28, 574, 400, 30, "출처 : 아주경제, 대전MBC", { s: 13, f: "r", c: "muted", v: "m" }));
  const kc = keyCard(792, 152, 416, 488, { lab: "훈련 시사점", head: "실제 사고의\n교훈을 반영", headSize: 32, body: "본 훈련은 가상의 벤젠 유출 상황을\n설정하여 실제 사고의 교훈을 반영", bodySize: 16, watermark: false });
  els.push(...kc.els);
  [["실제 사고", "황산 누출 · 약 1.63톤"], ["훈련 상황", "벤젠 20L 누출 · 착화"]].forEach(([k, v], i) => {
    const y = 504 + i * 60;
    els.push(rect(824, y, 352, 50, { fill: "white", alpha: 0.08, r: 12 }));
    els.push(text(844, y, 100, 50, k, { s: 13, f: "sb", c: i ? "amber" : "mist", v: "m" }));
    els.push(text(944, y, 220, 50, v, { s: 15, f: "m", c: "white", v: "m" }));
  });
  slides.push({
    layout: "CONTENT", section: "01 훈련 배경", title: "최근 실제 사고 사례", els,
    notes: "올해 7월 27일 서천IC 인근에서 약 1.63톤의 황산이 누출되는 사고가 있었습니다. 도로통제와 합동방제가 이뤄졌고 인근 주민 77명이 대피했습니다. 본 훈련은 가상의 벤젠 유출 상황을 설정해 이 실제 사고의 교훈을 반영했습니다.",
  });
}

// 6. 훈련개요
{
  const els = [...tag("02", "훈련 계획")];
  [["LuCalendarClock", "일시", "2026. 10. 22. (목) 14:00 ~ 16:00"], ["LuMapPin", "장소", "국도32호선 온석터널 (서산방향)"]].forEach(([ic, k, v], i) => {
    const x = X0 + i * 576;
    els.push(rect(x, 152, 560, 96, { fill: "panel", r: 18 }));
    els.push(...badge(ic, x + 24, 174, 52, "navy", "white"));
    els.push(text(x + 92, 168, 440, 24, k, { s: 14, f: "sb", c: "muted", v: "m" }));
    els.push(text(x + 92, 192, 456, 38, v, { s: 21, f: "b", c: "ink", v: "m" }));
  });
  els.push(label(X0, 276, 600, "훈련 진행", "총 2시간"));
  const px = W / 120, x15 = X0 + 60 * px, x1510 = X0 + 70 * px;
  els.push(rect(X0, 316, 60 * px - 8, 112, { fill: "navy", r: 16, name: "Part 1 bar" }));
  els.push(text(X0 + 28, 330, 400, 24, "1부", { s: 15, f: "b", c: "amber", v: "m" }));
  els.push(text(X0 + 28, 354, 520, 40, "현장 합동대응", { s: 24, f: "eb", c: "white", v: "m" }));
  els.push(text(X0 + 28, 394, 400, 24, "14:00 ~ 15:00  ·  60분", { s: 14, f: "m", c: "mist", v: "m" }));
  els.push(rect(x15 + 4, 316, x1510 - x15 - 12, 112, { line: "line", lw: 1.5, dash: true, r: 16 }));
  els.push(text(x15 + 4, 316, x1510 - x15 - 12, 112, "10분", { s: 12, f: "m", c: "muted", v: "m", a: "c" }));
  els.push(rect(x1510, 316, X1 - x1510, 112, { fill: "blue", r: 16, name: "Part 2 bar" }));
  els.push(text(x1510 + 28, 330, 400, 24, "2부  ·  토론훈련", { s: 15, f: "b", c: "amber", v: "m" }));
  els.push(text(x1510 + 28, 354, 430, 40, "강평 및 기관 협업 개선 논의", { s: 24, f: "eb", c: "white", v: "m" }));
  els.push(text(x1510 + 28, 394, 400, 24, "15:10 ~ 16:00  ·  50분", { s: 14, f: "m", c: "mist", v: "m" }));
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
  slides.push({
    layout: "CONTENT", section: "02 훈련 계획", title: "훈련개요", els,
    notes: "훈련은 10월 22일 목요일 14시부터 16시까지 국도32호선 온석터널 서산방향에서 진행합니다. 1부 14시부터 15시까지는 현장 합동대응, 2부 15시 10분부터 16시까지는 강평과 기관 협업 개선을 논의하는 토론훈련입니다. 토론의제는 비상대응체계 가동, 유출 확대 시 주민보호, 재발방지 및 협업 개선 세 가지입니다.",
  });
}

// 7. 훈련상황
{
  const els = [...tag("02", "훈련 계획")];
  els.push(label(X0, 152, 600, "시나리오 전개"));
  const steps = [["LuTruck", "졸음운전 화물차\n벽면 충돌"], ["LuTriangleAlert", "탱크로리 추돌 및\n밸브 손상"], ["LuFlame", "벤젠 20L\n누출 및 착화"], ["LuSchool", "후방 초등학생\n차량 고립"]];
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
  [["중상", "2", "운전자", "orange"], ["경상 (연기흡입)", "3", "인솔자", "blue"], ["대피", "23", "교사 · 학생", "blue"]].forEach(([k, n, who, c], i) => {
    const x = X0 + i * 235;
    els.push(rect(x, 424, 219, 216, { fill: "panel", r: 18 }));
    els.push(text(x + 24, 446, 180, 26, k, { s: 15, f: "b", c, v: "m" }));
    els.push(text(x + 24, 484, 180, 92, [{ text: n, f: "eb", s: 60 }, { text: "명", f: "b", s: 24 }], { c: "navy", v: "m", lh: 1.0 }));
    els.push(text(x + 24, 590, 180, 28, who, { s: 16, f: "m", c: "muted", v: "m" }));
  });
  els.push(...keyCard(792, 384, 416, 256, { lab: "주요 피해 특성", head: "연쇄적 생명 위협\n및 고립 발생", headSize: 26, body: "화학물질 누출과 화재가 동반된 복합 피해", bodySize: 15, watermark: false }).els);
  slides.push({
    layout: "CONTENT", section: "02 훈련 계획", title: "훈련상황 (복합재난 시나리오)", els,
    notes: "시나리오는 졸음운전 화물차의 벽면 충돌로 시작해 탱크로리 추돌과 밸브 손상, 벤젠 20리터 누출 및 착화, 그리고 후방 초등학생 차량 고립으로 이어집니다. 가상 인명피해는 중상 운전자 2명, 연기흡입 경상 인솔자 3명, 대피 교사와 학생 23명입니다. 화학물질 누출과 화재가 동반된 연쇄적 생명 위협과 고립 상황이 핵심입니다.",
  });
}

// 8. 참여규모 및 중점
{
  const els = [...tag("02", "훈련 계획")];
  [[[{ text: "11", f: "eb", s: 40 }, { text: "개", f: "b", s: 20 }], "참여 기관·단체"],
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
  els.push(...keyCard(792, 152, 416, 488, { lab: "훈련 중점", ico: "LuHandshake", head: "기관 간 유기적 연계\n재난취약계층 보호", headSize: 26, body: "대피구조·응급의료 협업 및\n학생 참여에 따른 대응역량 강화", bodySize: 16 }).els);
  slides.push({
    layout: "CONTENT", section: "02 훈련 계획", title: "참여규모 및 중점", els,
    notes: "이번 훈련에는 11개 기관·단체, 약 90명, 장비 16대가 참여합니다. 국토부 3개 기관, 소방·경찰, 지자체·의료, 그리고 서산화학재난합동방재센터와 제20전비 화생방지원대, 성연초등학교, 주민평가단이 함께합니다. 기관 간 유기적 연계와 재난취약계층 보호에 중점을 두고, 대피구조·응급의료 협업과 학생 참여를 통해 대응역량을 강화하겠습니다.",
  });
}

// 9. 온석터널 현황
{
  const els = [...tag("03", "현장 여건")];
  const U = (n, u) => [{ text: n, f: "eb", s: 28 }, { text: u, f: "b", s: 16 }];
  const specs = [
    ["LuCalendarCheck", "준공", U("2016", "년"), "국도32호선"],
    ["LuRuler", "연장", [...U("340", "m"), { text: "  ·  ", f: "b", s: 20 }, ...U("350", "m")], "서산방향 · 당진방향"],
    ["LuFireExtinguisher", "소화기", U("28", "개"), "방향별 14개"],
    ["LuCctv", "CCTV", U("6", "대"), "방향별 3대"],
  ];
  specs.forEach(([ic, k, runs, sub], i) => {
    const x = X0 + i * 288;
    els.push(rect(x, 152, 272, 168, { fill: "white", line: "line", lw: 1.5, r: 16 }));
    els.push(...badge(ic, x + 20, 172, 48, "navy", "white"));
    els.push(text(x + 80, 172, 120, 48, k, { s: 15, f: "sb", c: "muted", v: "m" }));
    if (i === 1) {
      els.push(rect(x + 272 - 20 - 64, 183, 64, 26, { line: "orange", lw: 1.5, r: 13 }));
      els.push(text(x + 272 - 20 - 64, 183, 64, 26, "단터널", { s: 12, f: "sb", c: "orange", v: "m", a: "c" }));
    }
    els.push(text(x + 20, 230, 240, 46, runs, { c: "ink", v: "m", lh: 1.0 }));
    els.push(text(x + 20, 280, 240, 24, sub, { s: 14, f: "r", c: "muted", v: "m" }));
  });
  els.push(label(X0, 348, 600, "안전시설 개선"));
  // lighting
  els.push(rect(X0, 388, 560, 140, { fill: "panel", r: 18 }));
  els.push(icon("LuLightbulb", 96, 410, 26, "orange"));
  els.push(text(132, 406, 300, 34, "터널 조명 상향", { s: 18, f: "b", c: "ink", v: "m" }));
  [["기존", 0.6, "60%", "mist", "muted"], ["개선", 1, "100%", "orange", "orange"]].forEach(([k, r, v, bar, tc], i) => {
    const y = 456 + i * 34;
    els.push(text(96, y, 56, 24, k, { s: 13, f: "sb", c: "muted", v: "m" }));
    els.push(rect(152, y + 5, 360, 14, { fill: "white", r: 7 }));
    els.push(rect(152, y + 5, 360 * r, 14, { fill: bar, r: 7 }));
    els.push(text(524, y, 92, 24, v, { s: 15, f: "eb", c: tc, v: "m" }));
  });
  // cctv
  els.push(rect(648, 388, 560, 140, { fill: "panel", r: 18 }));
  els.push(icon("LuCctv", 672, 410, 26, "orange"));
  els.push(text(708, 406, 300, 34, "CCTV 상시감시", { s: 18, f: "b", c: "ink", v: "m" }));
  els.push(text(672, 448, 520, 64, [{ text: "약 ", f: "b", s: 22 }, { text: "2", f: "eb", s: 44, c: "orange" }, { text: "분 내", f: "b", s: 22 }, { text: "  초기 대응", f: "b", s: 22 }], { c: "ink", v: "m", lh: 1.0 }));
  // bottom strip
  els.push(rect(X0, 556, W, 84, { fill: "navy", r: 18, name: "Key message strip" }));
  els.push(icon("arch", 104, 588, 20, "amber"));
  els.push(text(136, 556, 440, 84, "단터널의 현장 대응력 강화", { s: 22, f: "eb", c: "white", v: "m" }));
  ["초기인지", "현장통제", "신속출동", "기관공조"].forEach((t, i) => {
    const x = 676 + i * 130;
    els.push(rect(x, 578, 118, 40, { line: "amber", lw: 1.5, r: 20 }));
    els.push(text(x, 578, 118, 40, t, { s: 15, f: "sb", c: "white", v: "m", a: "c" }));
  });
  slides.push({
    layout: "CONTENT", section: "03 현장 여건", title: "온석터널 현황", els,
    notes: "온석터널은 2016년 준공된 단터널로, 서산방향 340미터, 당진방향 350미터입니다. 소화기는 방향별 14개씩 총 28개, CCTV는 방향별 3대씩 총 6대가 설치되어 있습니다. 조명을 60%에서 100%로 상향하고, CCTV 상시감시로 약 2분 내 초기 대응이 가능하도록 했습니다. 초기인지, 현장통제, 신속출동, 기관공조로 단터널의 현장 대응력을 강화하겠습니다.",
  });
}

// 10. 교통통제 및 우회도로
{
  const els = [...tag("03", "현장 여건")];
  const row = (y, h, ic, col, n, t) => {
    els.push(rect(X0, y, W, h, { fill: "white", line: "line", lw: 1.5, r: 18 }));
    els.push(...badge(ic, 96, y + (h - 56) / 2, 56, col, "white"));
    els.push(text(168, y, 60, h, n, { s: 15, f: "eb", c: col === "navy" ? "blue" : col, v: "m" }));
    els.push(text(206, y, 170, h, t, { s: 20, f: "b", c: "ink", v: "m" }));
    els.push(poly([[384, y + 22], [384, y + h - 22]], { c: "line", lw: 1.5 }));
  };
  row(152, 104, "LuBan", "orange", "01", "차단 지점");
  els.push(text(412, 152, 560, 104, [{ text: "온석교차로 진입램프 " }, { text: "차단", c: "orange" }], { s: 22, f: "b", c: "ink", v: "m" }));
  row(272, 128, "LuRoute", "blue", "02", "우회 노선");
  const pills = [["온석교차로", 412, 170], ["회전교차로 (서령로)", 640, 240], ["일람교차로", 938, 170]];
  pills.forEach(([t, x, w], i) => {
    els.push(rect(x, 312, w, 48, { fill: "panel", r: 24 }));
    els.push(text(x, 312, w, 48, t, { s: 17, f: "b", c: "ink", v: "m", a: "c" }));
    if (i < 2) {
      const x1 = x + w + 10, x2 = pills[i + 1][1] - 10;
      els.push(poly([[x1, 336], [x2, 336]], { c: "blue", lw: 2.5, arrow: "end" }));
    }
  });
  row(416, 104, "LuArrowLeftRight", "navy", "03", "교차 통행");
  els.push(text(412, 416, 340, 104, "부산교차로 진입 본선차량", { s: 22, f: "b", c: "ink", v: "m" }));
  els.push(poly([[748, 468], [792, 468]], { c: "blue", lw: 2.5, arrow: "end" }));
  els.push(rect(804, 446, 180, 44, { fill: "blue", alpha: 0.1, r: 22 }));
  els.push(text(804, 446, 180, 44, "비상회차로 활용", { s: 16, f: "b", c: "blue", v: "m", a: "c" }));
  els.push(rect(X0, 544, W, 96, { fill: "navy", r: 18, name: "Key message strip" }));
  els.push(text(104, 556, 600, 36, "우회와 교차통행 병행", { s: 22, f: "eb", c: "white", v: "m" }));
  els.push(text(104, 594, 760, 28, "VMS 및 내비게이션사를 통한 실시간 정보 제공으로 시민 불편 최소화", { s: 15, f: "r", c: "mist", v: "m" }));
  [["LuMonitor", "VMS 안내"], ["LuNavigation", "내비게이션"]].forEach(([ic, t], i) => {
    const x = 888 + i * 152;
    els.push(rect(x, 568, 140, 48, { fill: "white", alpha: 0.08, r: 12 }));
    els.push(icon(ic, x + 16, 580, 24, "amber"));
    els.push(text(x + 48, 568, 88, 48, t, { s: 14, f: "sb", c: "white", v: "m" }));
  });
  slides.push({
    layout: "CONTENT", section: "03 현장 여건", title: "교통통제 및 우회도로", els,
    notes: "교통통제는 온석교차로 진입램프를 차단하고, 우회 노선은 온석교차로에서 회전교차로(서령로)를 거쳐 일람교차로로 안내합니다. 부산교차로로 진입한 본선차량은 비상회차로를 활용해 교차 통행시킵니다. 우회와 교차통행을 병행하고, VMS와 내비게이션사를 통한 실시간 정보 제공으로 시민 불편을 최소화하겠습니다.",
  });
}

// 11. 상황전파 체계
{
  const els = [...tag("04", "대응 및 복구")];
  const dy = 24;
  els.push(text(392, 154 + dy, 300, 22, "보고 · 협조 요청", { s: 14, f: "sb", c: "blue", v: "m" }));
  // top chain
  els.push(rect(392, 184 + dy, 200, 108, { fill: "white", line: "blue", lw: 2, r: 16 }));
  els.push(text(392, 200 + dy, 200, 32, "예산국토", { s: 20, f: "b", c: "ink", v: "m", a: "c" }));
  els.push(text(392, 238 + dy, 200, 28, "관계기관 협조요청", { s: 14, f: "r", c: "muted", v: "m", a: "c" }));
  els.push(rect(648, 184 + dy, 200, 108, { fill: "navy", r: 16 }));
  els.push(text(648, 196 + dy, 200, 32, "대전국토청", { s: 20, f: "b", c: "white", v: "m", a: "c" }));
  els.push(text(648, 230 + dy, 200, 50, "상황판단\n지역사고수습본부", { s: 14, f: "r", c: "mist", lh: 1.35, a: "c", v: "m" }));
  els.push(poly([[596, 238 + dy], [644, 238 + dy]], { c: "blue", lw: 2.5, arrow: "end" }));
  // origin
  els.push(rect(X0, 316 + dy, 252, 152, { fill: "orange", alpha: 0.07, line: "orange", lw: 2.5, r: 18, name: "Origin node" }));
  els.push(icon("LuRadioTower", 96, 336 + dy, 30, "orange"));
  els.push(text(96, 376 + dy, 220, 32, "터널통합관리센터", { s: 20, f: "b", c: "ink", v: "m" }));
  els.push(text(96, 412 + dy, 220, 32, "사고인지 · 방재가동 · 출동", { s: 14, f: "r", c: "muted", v: "m" }));
  els.push(poly([[326, 360 + dy], [358, 360 + dy], [358, 238 + dy], [388, 238 + dy]], { c: "blue", lw: 2.5, arrow: "end" }));
  // simultaneous branch
  els.push(poly([[326, 424 + dy], [358, 424 + dy], [358, 456 + dy], [770, 456 + dy]], { c: "orange", lw: 2.5 }));
  els.push(text(392, 422 + dy, 200, 26, "동시 전파", { s: 14, f: "sb", c: "orange", v: "m" }));
  [["LuShield", "경찰"], ["LuFlame", "소방"], ["LuMonitor", "ITS센터"]].forEach(([ic, t], i) => {
    const x = 392 + i * 154, cx = x + 70;
    els.push(poly([[cx, 456 + dy], [cx, 486 + dy]], { c: "orange", lw: 2.5, arrow: "end" }));
    els.push(rect(x, 490 + dy, 140, 92, { fill: "white", line: "orange", lw: 2, r: 16 }));
    els.push(icon(ic, cx - 13, 504 + dy, 26, "orange"));
    els.push(text(x, 536 + dy, 140, 32, t, { s: 19, f: "b", c: "ink", v: "m", a: "c" }));
  });
  els.push(...keyCard(880, 152, 328, 488, { lab: "초동 조치 핵심", ico: "LuTimer", head: "동시다발적\n상황 전파", headSize: 30, body: "초동 조치의 핵심인\n골든타임 확보", bodySize: 17 }).els);
  slides.push({
    layout: "CONTENT", section: "04 대응 및 복구", title: "상황전파 체계", els,
    notes: "사고는 터널통합관리센터가 인지하고 즉시 방재설비 가동과 출동을 지시합니다. 동시에 경찰, 소방, ITS센터로 상황을 전파하고, 예산국토는 관계기관 협조를 요청하며 대전국토청은 상황판단과 지역사고수습본부 운영을 맡습니다. 초동 조치의 핵심은 동시다발적 상황 전파를 통한 골든타임 확보입니다.",
  });
}

// 12. 기관별 대응 현황
{
  const els = [...tag("04", "대응 및 복구")];
  const hub = { x: 640, y: 352 };
  const cards = [
    ["LuShield", "경찰", "교통통제 및 진입로 확보"],
    ["LuFlame", "소방", "화재진압 · 인명구조 및 초기제독"],
    ["LuFlaskConical", "서산화학방재센터", "물질 측정 · 분석 및 영향범위 판단"],
    ["LuLandmark", "서산시", "현장통합지원본부 운영"],
    ["LuStethoscope", "보건소", "현장응급의료소 운영"],
    ["LuPlane", "공군 제20전투비행단", "제독차량 지원"],
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
  els.push(icon("arch", hub.x - 14, hub.y - 66, 28, "amber"));
  els.push(text(hub.x - 100, hub.y - 30, 200, 70, "온석터널\n사고 현장", { s: 20, f: "eb", c: "white", lh: 1.25, a: "c", v: "m" }));
  els.push(text(hub.x - 100, hub.y + 44, 200, 22, "Concurrent", { s: 12, f: "sb", c: "amber", a: "c", v: "m", ls: 1 }));
  cards.forEach(([ic, name, role], i) => {
    const { x, y } = pos[i];
    els.push(rect(x, y, cw, ch, { fill: "white", line: "line", lw: 1.5, r: 16 }));
    els.push(...badge(ic, x + 20, y + 28, 56, "blue", "blue", 0.1));
    els.push(text(x + 92, y + 22, 290, 30, name, { s: 18, f: "b", c: "ink", v: "m" }));
    els.push(text(x + 92, y + 54, 296, 30, role, { s: 15, f: "r", c: "muted", v: "m" }));
  });
  els.push(text(X0, 568, W, 34, "상황에 따른 연계 및 병행(Concurrent) 대응", { s: 20, f: "eb", c: "navy", a: "c", v: "m" }));
  els.push(text(X0, 604, W, 28, "단선적 조치가 아닌, 각 기관의 전문성이 현장에서 동시 다발적으로 맞물려 작동", { s: 15, f: "r", c: "muted", a: "c", v: "m" }));
  slides.push({
    layout: "CONTENT", section: "04 대응 및 복구", title: "기관별 대응 현황", els,
    notes: "현장에서는 경찰이 교통통제와 진입로를 확보하고, 소방은 화재진압·인명구조와 초기제독을 맡습니다. 서산화학방재센터는 물질 측정·분석과 영향범위를 판단하고, 서산시는 현장통합지원본부, 보건소는 현장응급의료소를 운영하며, 공군 제20전투비행단은 제독차량을 지원합니다. 단선적 조치가 아니라 각 기관의 전문성이 현장에서 동시에 맞물려 작동하는 병행 대응입니다.",
  });
}

// 13. 수습복구 및 마무리
{
  const els = [...tag("04", "대응 및 복구")];
  els.push(label(X0, 152, 600, "수습복구 절차"));
  const steps = [["LuTruck", "파손차량 견인 및\n시설복구"], ["LuClipboardCheck", "터널 구조 · 시설물\n안전점검"], ["LuCircleCheckBig", "관계기관 협의 후\n통행재개"]];
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
  els.push(text(188, 504, 400, 26, "개선사항 환류", { s: 14, f: "sb", c: "orange", v: "m" }));
  els.push(text(188, 532, 980, 44, "훈련 중 도출된 개선사항은 행동 매뉴얼 및 향후 후속조치에 즉각 반영", { s: 20, f: "b", c: "ink", v: "m" }));
  slides.push({
    layout: "CONTENT", section: "04 대응 및 복구", title: "수습복구 및 마무리", els,
    notes: "상황이 종료되면 파손차량을 견인하고 시설을 복구한 뒤, 터널 구조와 시설물 안전점검을 거쳐 관계기관 협의 후 통행을 재개합니다. 훈련 중 도출된 개선사항은 행동 매뉴얼과 향후 후속조치에 즉각 반영하겠습니다.",
  });
}

// 14. Closing
slides.push({
  layout: "CLOSING", section: "마무리", title: "감사합니다",
  els: [
    img(tunnelArtSvg(720, 720), 560, 0, 720, 720, "Tunnel artwork"),
    icon("arch", X0, 233, 20, "amber"),
    text(X0 + 30, 228, 520, 30, "현장에서 작동하는 협조체계", { s: 16, f: "sb", c: "amber", v: "m" }),
    text(X0, 384, 520, 76, "훈련에 참여해주신 유관기관 및\n관계자 여러분께 감사드립니다.", { s: 19, f: "m", c: "mist", lh: 1.5 }),
    text(X0, 548, 480, 30, "2026 재난대응 안전한국훈련", { s: 16, f: "b", c: "amber", v: "m" }),
    text(X0, 586, 600, 28, "예산국토관리사무소  시설안전관리과", { s: 16, f: "m", c: "white", v: "m" }),
  ],
  notes: "이상으로 온석터널 훈련개요 보고를 마칩니다. 훈련에 참여해주신 유관기관과 관계자 여러분께 감사드립니다.",
});

// ---- layouts -----------------------------------------------------------------------------
const FOOTER = "2026 재난대응 안전한국훈련  |  온석터널 훈련개요 브리핑";
const layouts = {
  COVER: { bg: "navy", title: { x: X0, y: 236, w: 560, h: 180, s: 54, f: "bk", c: "white", lh: 1.15, ls: -1 } },
  CLOSING: { bg: "navy", title: { x: X0, y: 270, w: 520, h: 96, s: 60, f: "bk", c: "white", lh: 1.15, ls: -1 } },
  AGENDA: {
    bg: "white", title: { x: X0, y: 152, w: 380, h: 70, s: 44, f: "eb", c: "navy", lh: 1.15, ls: -0.5 },
    els: [text(X0, 676, 700, 20, FOOTER, { s: 10, f: "r", c: "muted", v: "m" })],
    num: { x: X1 - 100, y: 676, w: 100, h: 20, s: 10, f: "sb", c: "muted" },
  },
  CONTENT: {
    bg: "white", title: { x: X0, y: 70, w: W, h: 52, s: 30, f: "eb", c: "navy", lh: 1.2, ls: -0.5 },
    els: [text(X0, 676, 700, 20, FOOTER, { s: 10, f: "r", c: "muted", v: "m" })],
    num: { x: X1 - 100, y: 676, w: 100, h: 20, s: 10, f: "sb", c: "muted" },
  },
};

module.exports = { slides, layouts };
