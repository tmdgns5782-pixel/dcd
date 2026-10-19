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

// ---- art ---------------------------------------------------------------------------------
// Perspective tunnel: portals receding toward a lit exit, lamp dots, dashed centre line.
function tunnelArtSvg(W = 720, H = 720) {
  const vp = { x: 360, y: 395 };
  const portal = (s) => {
    const R = 430 * s, ground = vp.y + 360 * s, shoulder = vp.y - 30 * s;
    const l = vp.x - R, r = vp.x + R;
    return { d: `M${l.toFixed(1)} ${ground.toFixed(1)} L${l.toFixed(1)} ${shoulder.toFixed(1)} A${R.toFixed(1)} ${R.toFixed(1)} 0 0 1 ${r.toFixed(1)} ${shoulder.toFixed(1)} L${r.toFixed(1)} ${ground.toFixed(1)}`, R, ground, shoulder };
  };
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
  out += `<defs><radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#FFB02E" stop-opacity="0.55"/><stop offset="0.45" stop-color="#FFB02E" stop-opacity="0.16"/><stop offset="1" stop-color="#FFB02E" stop-opacity="0"/></radialGradient>`;
  out += `<linearGradient id="road" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.07"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>`;
  out += `<linearGradient id="fadeL" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="0.22" stop-color="#FFFFFF" stop-opacity="1"/></linearGradient><mask id="fade" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="url(#fadeL)"/></mask></defs><g mask="url(#fade)">`;
  // road surface
  const far = portal(0.06);
  out += `<path d="M${vp.x - 430} ${vp.y + 360} L${vp.x - far.R} ${far.ground} L${vp.x + far.R} ${far.ground} L${vp.x + 430} ${vp.y + 360} Z" fill="url(#road)"/>`;
  // glow at the exit
  out += `<ellipse cx="${vp.x}" cy="${vp.y + 5}" rx="190" ry="170" fill="url(#glow)"/>`;
  const N = 9;
  for (let k = 0; k < N; k++) {
    const s = Math.pow(0.7, k);
    const p = portal(s);
    const t = k / (N - 1);
    const op = (0.16 + 0.5 * t).toFixed(2);
    const sw = Math.max(1.4, 16 * s).toFixed(1);
    const col = k >= N - 2 ? "#FFB02E" : "#AFC2E3";
    out += `<path d="${p.d}" fill="none" stroke="${col}" stroke-opacity="${op}" stroke-width="${sw}" stroke-linecap="round"/>`;
    // lamps on both upper shoulders
    for (const th of [205, 335]) {
      const rad = (th * Math.PI) / 180;
      const rr = p.R - (+sw) / 2 - 10 * s;
      const lx = vp.x + rr * Math.cos(rad), ly = p.shoulder + rr * Math.sin(rad);
      out += `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="${Math.max(1.2, 7 * s).toFixed(1)}" fill="#FFB02E" fill-opacity="${(0.55 + 0.4 * t).toFixed(2)}"/>`;
    }
  }
  // exit opening
  const ex = portal(Math.pow(0.7, N));
  out += `<path d="${ex.d} Z" fill="#FFD27A" fill-opacity="0.9"/>`;
  // dashed centre line with perspective spacing
  for (let n = 0; n < 9; n++) {
    const s0 = Math.pow(0.78, 2 * n), s1 = Math.pow(0.78, 2 * n + 1);
    const y0 = vp.y + 360 * s0, y1 = vp.y + 360 * s1;
    out += `<line x1="${vp.x}" y1="${y0.toFixed(1)}" x2="${vp.x}" y2="${y1.toFixed(1)}" stroke="#FFB02E" stroke-opacity="0.85" stroke-width="${Math.max(1.2, 9 * s0).toFixed(1)}" stroke-linecap="butt"/>`;
  }
  out += `</g></svg>`;
  return out;
}

module.exports = { COLORS, THEME, WEIGHTS, NATURAL_LH, hex, iconSvg, tunnelArtSvg };
