const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const source = fs.readFileSync(path.join(launcherRoot, "src/runtime-copy.ts"), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText;
const loaded = { exports: {} };
Function("module", "exports", "require", output)(loaded, loaded.exports, name => {
  assert.match(name, /^\.\/runtime-errors-[a-z]+\.json$/);
  return require(path.join(launcherRoot, "src", name));
});
const { localizeMessage, localizeEvent, localizeDetailKey, statusLabel } = loaded.exports;
const languages = ["en", "fr", "zh-CN", "zh-TW", "ja", "ko"];
const translatedLanguages = languages.slice(1);

function parse(text, file = "fixture.ts") {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}
function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, child => visit(child, callback));
}
const tables = new Map();
for (const file of ["runtime-errors-browser.json", "runtime-errors-control.json", "runtime-errors-supervisor.json"]) {
  tables.set(file, require(path.join(launcherRoot, "src", file)));
}
visit(parse(source), node => {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer
    || !ts.isArrayLiteralExpression(node.initializer)) return;
  const rows = node.initializer.elements;
  if (rows.every(row => ts.isArrayLiteralExpression(row) && row.elements.every(ts.isStringLiteral))) {
    tables.set(node.name.text, rows.map(row => row.elements.map(cell => cell.text)));
  }
});

test("runtime catalogs have every language and preserve template parameters exactly", () => {
  for (const [name, rows] of tables) {
    const keys = new Set();
    for (const row of rows) {
      assert.equal(row.length, languages.length, `${name}: ${row[0]}`);
      assert.ok(!keys.has(row[0]), `duplicate ${name} key: ${row[0]}`);
      keys.add(row[0]);
      const placeholders = text => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
      for (const [index, value] of row.entries()) {
        assert.ok(value.trim(), `${name}: empty ${languages[index]} value for ${row[0]}`);
        assert.deepEqual(placeholders(value), placeholders(row[0]), `${name}: ${languages[index]} ${row[0]}`);
      }
    }
  }
  const messageKeys = ["messages", "diagnostics", "errors", "limitsMessages", "templates",
    "runtime-errors-browser.json", "runtime-errors-control.json", "runtime-errors-supervisor.json"]
    .flatMap(name => tables.get(name).map(row => row[0]));
  assert.equal(new Set(messageKeys).size, messageKeys.length, "message catalogs must not override one another");
});

for (const language of languages) {
  test(`${language}: exact producer messages and parameterized diagnostics`, () => {
    const samples = [
      "No active task",
      "Checking runtime",
      "Codex integration installed",
      "Tunnel runtime is not ready",
      "Finish or cancel active ChatGPT turns before changing browser interaction mode",
      "Limits is unavailable in Zero Risk mode. Switch to Automatic to check your plan.",
    ];
    for (const sample of samples) {
      const result = localizeMessage(sample, language);
      if (language === "en") assert.equal(result, sample);
      else assert.notEqual(result, sample);
    }
    // Values deliberately look like replacement strings and other placeholders.
    const filePath = "C:\\Users\\$&\\{1}\\résumé\\state.json";
    const config = localizeMessage(`Configuration is valid (${filePath})`, language);
    assert.ok(config.includes(filePath));
    const connector = '"Codex $& $` $\' {0} Native2"';
    assert.ok(localizeMessage(`ChatGPT connector ${connector} is available`, language).includes(connector));
    assert.ok(localizeMessage("Responses proxy is healthy on 127.0.0.1:17841", language).includes("127.0.0.1:17841"));
    const version = localizeMessage("Daemon version is 5.0.8; config requires 6.0.0", language);
    assert.ok(version.includes("5.0.8") && version.includes("6.0.0"));
    assert.ok(localizeMessage("A Tunnels Read + Use runtime key is required", language).includes("Tunnels Read + Use"));
    assert.ok(localizeMessage("Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters", language).includes("tunnel_"));
  });

  test(`${language}: Electron invoke failures only unwrap recognized messages`, () => {
    const known = "Error invoking remote method 'launcher:doctor': Error: Tunnel runtime is not ready";
    assert.equal(localizeMessage(known, language), language === "en" ? known : localizeMessage("Tunnel runtime is not ready", language));
    for (const type of ["TypeError", "RangeError", "LimitsStoreError"]) {
      const wrapped = `Error invoking remote method 'launcher:doctor': ${type}: Tunnel runtime is not ready`;
      assert.equal(localizeMessage(wrapped, language), language === "en" ? wrapped : localizeMessage("Tunnel runtime is not ready", language));
    }
    const unknown = "Error invoking remote method 'launcher:doctor': Error: private $& $` ${token} {0} diagnostic";
    assert.equal(localizeMessage(unknown, language), unknown);
    const stack = known + "\n    at privateFunction (C:\\private\\source.cjs:12:4)";
    assert.equal(localizeMessage(stack, language), stack);
    const otherChannel = "Error invoking remote method 'user:doctor': Error: Tunnel runtime is not ready";
    assert.equal(localizeMessage(otherChannel, language), otherChannel);
  });

  test(`${language}: composed Limits warnings keep causes and recorded-history guarantees`, () => {
    const warning = "Local history may be incomplete. Check your plan again.";
    const cause = "Could not read the limits store.";
    const wrapped = `Limits tracking is unavailable. ${cause} ${warning}`;
    const result = localizeMessage(wrapped, language);
    assert.ok(result.includes(localizeMessage(cause, language)));
    assert.ok(result.includes(localizeMessage(warning, language)));
    if (language !== "en") assert.notEqual(result, wrapped);
    const serverDetail = "EACCES: C:\\$&\\{0}\\private.json";
    assert.ok(localizeMessage(`Could not record launcher usage. ${serverDetail} ${warning}`, language).includes(serverDetail));
    const accountWarning = `The ChatGPT account does not match the checked account. This message was not counted. ${warning}`;
    if (language !== "en") assert.notEqual(localizeMessage(accountWarning, language), accountWarning);
  });
}

test("unknown messages, IDs, diagnostic JSON and multiline stdout remain verbatim", () => {
  const raw = [
    "private account message $& {0}",
    '{"event":"runtime.startup_failed","message":"Tunnel runtime is not ready"}',
    "[chatgpt-web] ready\nhttp://127.0.0.1:17841",
    "Tunnel runtime is not ready (unrecognized extension)",
    "prefix Checking runtime suffix",
  ];
  for (const language of languages) {
    for (const value of raw) assert.equal(localizeMessage(value, language), value);
    assert.equal(localizeEvent("plugin.private_event", language), "plugin.private_event");
    assert.equal(localizeDetailKey("private_$key", language), "private_$key");
    assert.equal(statusLabel("private-status", language), "private-status");
  }
});

test("literal parameters cannot trigger a second substitution", () => {
  for (const language of translatedLanguages) {
    for (const row of ["templates", "runtime-errors-browser.json", "runtime-errors-control.json", "runtime-errors-supervisor.json"]
      .flatMap(name => tables.get(name)).filter(row => /\{\d+\}/.test(row[0]))) {
      const input = row[0].replace(/\{(\d+)\}/g, (_, number) => `PARAM${number}:$&:{9}:\\path`);
      const actual = localizeMessage(input, language);
      for (const match of row[0].matchAll(/\{(\d+)\}/g)) assert.ok(actual.includes(`PARAM${match[1]}:$&:{9}:\\path`), row[0]);
      if (row[0] !== "HTTP {0}") assert.notEqual(actual, input, `${language}: ${row[0]}`);
    }
    const known = "Bigger Context enabled; restart Codex";
    assert.notEqual(localizeMessage(known, language), known);
    const unknown = "private runtime note; restart Codex";
    assert.equal(localizeMessage(unknown, language), unknown);
  }
});

test("all literal Electron error constructors are translated in every supported locale", () => {
  const errors = new Map();
  for (const file of fs.readdirSync(path.join(launcherRoot, "electron")).filter(file => file.endsWith(".cjs"))) {
    visit(parse(fs.readFileSync(path.join(launcherRoot, "electron", file), "utf8"), file), node => {
      if (!ts.isNewExpression(node) || !/^(?:Error|TypeError|RangeError|LimitsStoreError)$/.test(node.expression.getText())) return;
      const argument = node.arguments?.[node.expression.getText() === "LimitsStoreError" ? 1 : 0];
      for (const message of staticStrings(argument)) errors.set(message, file);
    });
  }
  assert.ok(errors.size > 200, "must scan the actual Electron producers");
  const missing = [...errors].filter(([message]) => translatedLanguages.some(language => localizeMessage(message, language) === message));
  assert.deepEqual(missing, []);
});

test("known error prefixes do not translate multiline stacks or external prose", () => {
  for (const language of languages) {
    const stack = "Browser helper abc timed out\n    at external (C:\\private\\helper.js:12:3)";
    assert.equal(localizeMessage(stack, language), stack);
    const raw = "Unrecognized external diagnostic; private account details remain raw";
    assert.equal(localizeMessage(raw, language), raw);
  }
});

// Evaluate only syntax that constructs producer-owned text. Calls, identifiers,
// and property reads become opaque values; application code is never executed.
function producerSamples(node, parameters = new Map()) {
  if (!node) return ["VALUE"];
  if (ts.isIdentifier(node) && parameters.has(node.text)) return parameters.get(node.text);
  if (ts.isParenthesizedExpression(node)) return producerSamples(node.expression, parameters);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isNumericLiteral(node)) return [node.text];
  if (ts.isConditionalExpression(node)) return [...producerSamples(node.whenTrue, parameters), ...producerSamples(node.whenFalse, parameters)];
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
    return [...producerSamples(node.left, parameters), ...producerSamples(node.right, parameters)];
  }
  if (ts.isTemplateExpression(node)) {
    let samples = [node.head.text];
    for (const span of node.templateSpans) samples = samples.flatMap(prefix => producerSamples(span.expression, parameters).map(value => prefix + value + span.literal.text));
    return samples;
  }
  return ["VALUE"];
}

function literalCallParameters(source, node) {
  let owner = node.parent;
  while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
  const parameters = new Map();
  if (!owner?.name) return parameters;
  // Helper labels are known prose at their real call sites, not arbitrary input.
  owner.parameters.forEach((parameter, index) => {
    if (parameter.name.getText() !== "label") return;
    const labels = new Set();
    visit(source, call => {
      if (ts.isCallExpression(call) && call.expression.getText() === owner.name.text) {
        staticStrings(call.arguments[index]).forEach(label => labels.add(label));
      }
    });
    if (labels.size) parameters.set("label", [...labels]);
  });
  return parameters;
}

function messageVariants(node) {
  if (!node) return [];
  if (ts.isParenthesizedExpression(node)) return messageVariants(node.expression);
  if (ts.isConditionalExpression(node)) return [...messageVariants(node.whenTrue), ...messageVariants(node.whenFalse)];
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
    return [...messageVariants(node.left), ...messageVariants(node.right)];
  }
  return [node];
}

test("parameterized Electron errors cover producer wording and conditional branches", () => {
  const missing = [];
  let checked = 0;
  for (const file of fs.readdirSync(path.join(launcherRoot, "electron")).filter(file => file.endsWith(".cjs"))) {
    const source = parse(fs.readFileSync(path.join(launcherRoot, "electron", file), "utf8"), file);
    visit(source, node => {
      if (!ts.isNewExpression(node) || !/^(?:Error|TypeError|RangeError|LimitsStoreError)$/.test(node.expression.getText())) return;
      const message = node.arguments?.[node.expression.getText() === "LimitsStoreError" ? 1 : 0];
      for (const argument of messageVariants(message).filter(ts.isTemplateExpression)) {
        const literalParts = argument.head.text + argument.templateSpans.map(span => span.literal.text).join("");
        // Pure transport concatenation has no authored prose to translate.
        if (!/[a-zA-Z]{2}/.test(literalParts)) continue;
        for (const sample of new Set(producerSamples(argument, literalCallParameters(source, node)))) {
          checked++;
          if (!/^HTTP \S+$/.test(sample) && translatedLanguages.some(language => localizeMessage(sample, language) === sample)) missing.push({file, sample});
        }
      }
    });
  }
  assert.ok(checked > 100);
  assert.deepEqual(missing, []);
});

function staticStrings(node) {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isConditionalExpression(node)) return [...staticStrings(node.whenTrue), ...staticStrings(node.whenFalse)];
  return [];
}

test("all current browser and runtime static status messages and doctor summaries have translations", () => {
  const files = ["launcher/electron/browser-host.cjs", "launcher/electron/runtime.cjs", "src/doctor.ts"];
  const samples = new Set();
  for (const file of files) {
    visit(parse(fs.readFileSync(path.join(repositoryRoot, file), "utf8"), file), node => {
      if (ts.isPropertyAssignment(node) && ["message", "successMessage"].includes(node.name.getText())) {
        staticStrings(node.initializer).forEach(value => samples.add(value));
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left) && node.left.name.text === "message") {
        staticStrings(node.right).forEach(value => samples.add(value));
      }
    });
  }
  assert.ok(samples.size > 80, "must inspect real producer messages, not an empty inventory");
  const missing = [...samples].filter(message => translatedLanguages.some(language => localizeMessage(message, language) === message));
  assert.deepEqual(missing, []);
});

test("every literal launcher activity event has a localized label", () => {
  const samples = new Set();
  for (const file of fs.readdirSync(path.join(launcherRoot, "electron")).filter(file => file.endsWith(".cjs"))) {
    const text = fs.readFileSync(path.join(launcherRoot, "electron", file), "utf8");
    for (const match of text.matchAll(/(?:logger|this\.logger)\.(?:info|warn|debug|error)\(\s*"([^"]+)"/g)) samples.add(match[1]);
  }
  assert.ok(samples.size > 100);
  for (const event of samples) {
    for (const language of translatedLanguages) assert.notEqual(localizeEvent(event, language), event, `${language}: ${event}`);
  }
  for (const language of translatedLanguages) {
    assert.notEqual(localizeEvent("runtime.daemon_stdout", language), "runtime.daemon_stdout");
    assert.notEqual(localizeDetailKey("message", language), "message");
    assert.notEqual(statusLabel("awaiting-user", language), "awaiting-user");
  }
});

test("every statically declared Activity detail key has a display label", () => {
  const keys = new Set();
  for (const file of fs.readdirSync(path.join(launcherRoot, "electron")).filter(file => file.endsWith(".cjs"))) {
    visit(parse(fs.readFileSync(path.join(launcherRoot, "electron", file), "utf8"), file), node => {
      if (!ts.isCallExpression(node) || !/(?:this\.)?logger\.(?:info|warn|error|debug)$/.test(node.expression.getText())) return;
      const detail = node.arguments[1];
      if (!detail || !ts.isObjectLiteralExpression(detail)) return;
      for (const property of detail.properties) {
        if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) keys.add(property.name.text);
      }
    });
  }
  const known = new Set(tables.get("detailKeys").map(row => row[0]));
  assert.ok(keys.size >= 60);
  assert.deepEqual([...keys].filter(key => !known.has(key)), []);
});
