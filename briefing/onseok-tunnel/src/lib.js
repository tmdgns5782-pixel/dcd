// Shared design tokens, icons and art for the HTML draft and the PPTX build.
// Coordinates are px on a 1280x720 canvas (96 px = 1 in); font sizes are pt.
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const lu = require("react-icons/lu");

const COLORS = {
  ink: { hex: "141C2E", scheme: "text1" }, // dk1
  white: { hex: "FFFFFF", scheme: "background1" }, // lt1
  navy: { hex: "0D1F3C", scheme: "text2" }, // dk2
  panel: { hex: "EEF2F7", scheme: "background2" }, // lt2
  blue: { hex: "1E4B8F", scheme: "accent1" },
  orange: { hex: "D9480F", scheme: "accent2" },
  amber: { hex: "FFB02E", scheme: "accent3" },
  mist: { hex: "AFC2E3", scheme: "accent4" },
  muted: { hex: "5A6478", scheme: "accent5" },
  line: { hex: "D5DDE8", scheme: "accent6" },
};

const THEME = {
  name: "Onseok Tunnel Briefing",
  headFontFace: "Paperlogy 8 ExtraBold",
  bodyFontFace: "Paperlogy 4 Regular",
  colors: {
    dk1: COLORS.ink.hex, lt1: COLORS.white.hex, dk2: COLORS.navy.hex, lt2: COLORS.panel.hex,
    accent1: COLORS.blue.hex, accent2: COLORS.orange.hex, accent3: COLORS.amber.hex,
    accent4: COLORS.mist.hex, accent5: COLORS.muted.hex, accent6: COLORS.line.hex,
    hlink: COLORS.blue.hex, folHlink: COLORS.muted.hex,
  },
};

// Paperlogy ships each weight as its own family ("Paperlogy 7 Bold", style Regular).
const WEIGHTS = {
  r: { face: "Paperlogy 4 Regular", css: 400, file: "Paperlogy-4Regular" },
  m: { face: "Paperlogy 5 Medium", css: 500, file: "Paperlogy-5Medium" },
  sb: { face: "Paperlogy 6 SemiBold", css: 600, file: "Paperlogy-6SemiBold" },
  b: { face: "Paperlogy 7 Bold", css: 700, file: "Paperlogy-7Bold" },
  eb: { face: "Paperlogy 8 ExtraBold", css: 800, file: "Paperlogy-8ExtraBold" },
  bk: { face: "Paperlogy 9 Black", css: 900, file: "Paperlogy-9Black" },
};

// Natural line height of Paperlogy (winAscent + winDescent) / unitsPerEm.
const NATURAL_LH = 1060 / 900;

const hex = (c) => (COLORS[c] ? COLORS[c].hex : c);

// ---- icons -------------------------------------------------------------------------------
function iconSvg(name, color, size = 24) {
  const c = hex(color);
  const Comp = lu[name];
  if (!Comp) throw new Error(`unknown icon ${name}`);
  let svg = renderToStaticMarkup(React.createElement(Comp, { size, color: `#${c}` }));
  if (!svg.includes("xmlns=")) svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  return svg;
}

module.exports = { COLORS, THEME, WEIGHTS, NATURAL_LH, hex, iconSvg };
