const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const {
  createLogger,
  exportSanitizedLogs,
  installProcessDiagnosticGuards,
  registerLoggedIpc,
  sanitize,
  sanitizedLogText,
} = require("../electron/logging.cjs");

test("launcher logs redact tunnel ids, runtime keys, and bearer credentials", () => {
  assert.deepEqual(sanitize({
    line: "tunnel_0123456789abcdef0123456789abcdef sk-exampleRuntimeSecret123",
    authorization: "Bearer this-must-never-be-recorded",
    nested: { controlToken: "also-secret" },
  }), {
    line: "[tunnel-id] [runtime-key]",
    authorization: "[redacted]",
    nested: { controlToken: "[redacted]" },
  });
});

test("failed launcher IPC calls are written to runtime activity", async () => {
  let registered;
  const errors = [];
  const ipcMain = {
    handle(channel, handler) {
      registered = { channel, handler };
    },
  };
  registerLoggedIpc(
    ipcMain,
    { error: (event, detail) => errors.push({ event, detail }) },
    "launcher:test",
    async () => {
      throw new Error("visible failure");
    },
  );

  await assert.rejects(registered.handler({}, 1), /visible failure/);
  assert.deepEqual(errors, [{
    event: "launcher.ipc_failed",
    detail: { channel: "launcher:test", message: "visible failure" },
  }]);
});

test("launcher activity restores valid records from the previous process", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-logging-"));
  const filePath = path.join(root, "launcher.jsonl");
  try {
    fs.writeFileSync(filePath, [
      JSON.stringify({ at: "2026-07-28T00:00:00.000Z", level: "info", event: "previous", detail: {} }),
      "not-json",
      "",
    ].join("\n"));
    const logger = createLogger({ filePath });
    assert.deepEqual(logger.recent().map((record) => record.event), ["previous"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("clearing launcher activity removes memory and current and rotated logs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-clear-logs-"));
  const filePath = path.join(root, "launcher.jsonl");
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(`${filePath}.1`, "rotated\n");
    const logger = createLogger({ filePath });
    logger.info("current", {});

    logger.clear();

    assert.deepEqual(logger.recent(), []);
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(fs.existsSync(`${filePath}.1`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exported launcher logs remove local usernames, private ChatGPT titles, and URL paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-export-"));
  const filePath = path.join(root, "launcher.jsonl");
  const destinationPath = path.join(root, "shared", "diagnostics.jsonl");
  try {
    fs.writeFileSync(`${filePath}.1`, `${JSON.stringify({
      at: "2026-08-23T00:00:00.000Z",
      level: "error",
      event: "runtime.daemon_stdout",
      detail: {
        line: "prompt_attachment failed at C:\\Users\\private.user\\.codex and encoded C:\\\\Users\\\\private.user\\\\.codex; connector missing; visible rows: Private roadmap, Health notes",
      },
    })}\n`);
    fs.writeFileSync(filePath, `${JSON.stringify({
      at: "2026-08-23T00:01:00.000Z",
      level: "info",
      event: "runtime.stdout",
      detail: {
        line: "config loaded from /Users/local-person/.codex/config.toml",
        prompt: "private prompt",
        connector: "Codex Native2",
        url: "https://chatgpt.com/c/private-conversation?state=oauth-secret&email=private@example.com",
        message: "failed while loading 'https://accounts.google.com/o/oauth2/v2/auth?state=oauth-secret&login_hint=private@example.com'",
      },
    })}\n`);

    const clipboardExport = sanitizedLogText({ filePath });
    assert.equal(clipboardExport.recordCount, 2);
    assert.equal(exportSanitizedLogs({ filePath, destinationPath }), 2);
    const exported = fs.readFileSync(destinationPath, "utf8");
    assert.equal(clipboardExport.text, exported);
    assert.doesNotMatch(exported, /private\.user|local-person|Private roadmap|Health notes|private prompt|private-conversation|oauth-secret|private@example\.com/);
    assert.match(exported, /\[user-home\]/);
    assert.match(exported, /visible rows: \[redacted\]/);
    assert.match(exported, /Codex Native2/);
    assert.match(exported, /"prompt":"\[redacted\]"/);
    assert.match(exported, /https:\/\/chatgpt\.com/);
    assert.match(exported, /https:\/\/accounts\.google\.com/);
    assert.throws(
      () => exportSanitizedLogs({ filePath, destinationPath: filePath }),
      /Refusing to overwrite a launcher source log/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a closed Windows diagnostic pipe is recorded without becoming an uncaught process error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-process-pipe-"));
  const filePath = path.join(root, "process-stream-errors.log");
  const stream = new PassThrough();
  try {
    installProcessDiagnosticGuards({ filePath, streams: [stream] });
    stream.emit("error", Object.assign(new Error("write EOF"), { code: "EOF" }));
    assert.match(fs.readFileSync(filePath, "utf8"), /write EOF/);
  } finally {
    stream.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
