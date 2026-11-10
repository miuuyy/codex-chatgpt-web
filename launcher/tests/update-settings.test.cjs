const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const compile = file => ts.transpileModule(fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.React, jsxFactory: "element" }, fileName: file,
}).outputText;
const translations = { exports: {} };
vm.runInNewContext(compile("i18n.ts"), translations);

test("update settings show failures and reset time in every language and allow a read-only recheck", async () => {
  const hooks = { useState: value => [value, () => {}], useEffect() {} };
  const context = { exports: {}, require: name => { assert.equal(name, "react"); return hooks; },
    element: (type, props, ...children) => ({ type, props, children }) };
  vm.runInNewContext(compile("UpdateSettings.tsx"), context);
  const visit = tree => Array.isArray(tree) ? tree.flatMap(visit) : tree && typeof tree === "object"
    ? [tree, ...visit(tree.children)] : [];
  for (const language of Object.keys(require("../electron/languages.json"))) {
    const copy = translations.exports.copyFor(language);
    let checks = 0;
    const render = update => visit(context.exports.UpdateSettings({ copy, language, update, version: "6.1.12",
      onCheck: async () => { checks++; return { status: "up-to-date" }; }, setError: assert.fail,
    }));
    let nodes = render({ status: "error", message: "GitHub temporarily limited update checks.", retryAt: Date.now() + 60_000 });
    assert.equal(nodes.find(node => node.props?.role === "status").children[0], "GitHub temporarily limited update checks.");
    assert.ok(nodes.some(node => node.type === "p" && typeof node.children[0] === "string"
      && node.children[0].startsWith(copy.updateRetryAfter.split("{time}")[0])));
    assert.equal(nodes.find(node => node.type === "button").props.disabled, true);
    nodes = render({ status: "error", message: "Connection failed", retryAt: Date.now() - 1000 });
    const button = nodes.find(node => node.type === "button");
    assert.equal(button.props.disabled, false);
    button.props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(checks, 1);
    assert.equal(render({ status: "up-to-date" }).find(node => node.props?.role === "status").children[0], copy.upToDate);
    for (const status of ["checking", "downloading", "installing"]) {
      assert.equal(render({ status, version: "6.1.17" }).find(node => node.type === "button").props.disabled, true);
    }
  }
});
