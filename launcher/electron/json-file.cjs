const fs = require("node:fs");

function parseJsonText(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

function readJsonFile(pathname) {
  return parseJsonText(fs.readFileSync(pathname, "utf8"));
}

module.exports = { parseJsonText, readJsonFile };
