const path = require("path");
const { slides, layouts } = require("./slides");
const { renderPPTX } = require("./render_pptx");

const [out] = process.argv.slice(2);
renderPPTX(slides, layouts, path.resolve(out)).then(
  (f) => console.log("wrote", f),
  (e) => { console.error(e); process.exit(1); }
);
