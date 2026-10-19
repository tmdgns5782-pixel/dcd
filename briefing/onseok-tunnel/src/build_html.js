const path = require("path");
const { slides, layouts } = require("./slides");
const { renderHTML } = require("./render_html");

const [fontDir, out] = process.argv.slice(2);
renderHTML(slides, layouts, fontDir, path.resolve(out));
console.log("wrote", out);
