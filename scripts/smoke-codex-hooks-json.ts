import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  codexJsonInterruptHookStateKey,
  installCodexInterruptHookTrust,
  restoreCodexInterruptHookTrust,
  verifyCodexInterruptHookTrust,
} from "../src/codex-interrupt-hook";

// Run with: bun run scripts/smoke-codex-hooks-json.ts [absolute-path-to-codex]
// Discovery only: no thread, model request, bridge setup, or hook execution.
const codex = resolve(process.argv[2] ?? "/Applications/ChatGPT.app/Contents/Resources/codex");
assert(existsSync(codex), `Codex executable is missing: ${codex}`);
const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-hooks-json-")));
const codexHome = join(root, "codex");
const cwd = join(root, "workspace");
const configPath = join(codexHome, "config.toml");
const hooksPath = join(codexHome, "hooks.json");
// Do not inherit credentials, config overrides, or an enclosing Codex session.
const env = { PATH: process.env.PATH, CODEX_HOME: codexHome };
const config = "[features]\nhooks = true\n\n[analytics]\nenabled = false\n";
const command = "echo codex-hooks-json-discovery";
const json = JSON.stringify({ hooks: { Interrupt: [{ hooks: [{ type: "command", command, timeout: 3 }] }] } }, null, 2);
const toml = `\n[[hooks.Interrupt]]\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\ntimeout = 3\n`;
const mixedWarning = /loading hooks from both .*hooks\.json.*config\.toml/;

type Request = (method: string, params: unknown) => Promise<unknown>;

async function withClient<T>(operation: (request: Request) => Promise<T>, allowMixed = false): Promise<T> {
  const child = spawn(codex, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  let stopping = false;
  let failure: Error | undefined;
  let stderr = "";
  const fail = (error: Error): void => {
    if (!failure) {
      failure = error;
    }
    for (const waiting of pending.values()) {
      waiting.reject(error);
    }
    pending.clear();
  };
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-8_000); });
  child.on("error", fail);
  child.stdin.on("error", fail);
  const closed = new Promise<void>(done => child.once("close", (code, signal) => {
    if (!stopping || (code !== 0 && signal !== "SIGTERM")) {
      fail(new Error(`Codex app-server closed unexpectedly: code=${code}, signal=${signal}`));
    }
    done();
  }));
  lines.on("line", line => {
    try {
      const message: unknown = JSON.parse(line);
      assert(message && typeof message === "object", "Invalid RPC envelope");
      const response = message as { id?: unknown; result?: unknown; error?: unknown };
      if (typeof response.id !== "number") {
        return;
      }
      const waiting = pending.get(response.id);
      assert(waiting, `Unexpected RPC response id: ${response.id}`);
      pending.delete(response.id);
      if (response.error) {
        waiting.reject(new Error(`Codex RPC error: ${JSON.stringify(response.error)}`));
      } else {
        waiting.resolve(response.result);
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const request: Request = (method, params) => new Promise((resolveRequest, reject) => {
    if (failure) {
      reject(failure);
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve: resolveRequest, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const timeout = setTimeout(() => {
    fail(new Error("Codex discovery timed out after 15 seconds"));
    child.kill("SIGKILL");
  }, 15_000);
  try {
    await request("initialize", {
      clientInfo: { name: "codex-hooks-json-smoke", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    return await operation(request);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nCodex stderr:\n${stderr}`);
  } finally {
    stopping = true;
    child.kill();
    await closed;
    clearTimeout(timeout);
    lines.close();
    if (failure) {
      throw new Error(`${failure.message}\nCodex stderr:\n${stderr}`);
    }
    if (!allowMixed) {
      assert.doesNotMatch(stderr, mixedWarning, "Unexpected mixed-source warning on stderr");
    }
  }
}

// Narrow projection of the experimental API, checked against generated 0.153.4 bindings.
type Hook = { key: string; currentHash: string; trustStatus: string; command: string; sourcePath: string };

async function listHooks(request: Request): Promise<{ hooks: Hook[]; warnings: string[]; errors: unknown[] }> {
  const result = await request("hooks/list", { cwds: [cwd] }) as { data?: unknown } | null;
  assert(result && Array.isArray(result.data) && result.data.length === 1, "Expected one hooks/list result");
  const entry = result.data[0] as { cwd?: unknown; hooks?: unknown; warnings?: unknown; errors?: unknown };
  assert.equal(entry.cwd, cwd);
  assert(Array.isArray(entry.hooks), "Missing hooks array");
  assert(Array.isArray(entry.warnings) && entry.warnings.every(warning => typeof warning === "string"), "Invalid warnings");
  assert(Array.isArray(entry.errors), "Missing errors array");
  const hooks = entry.hooks.map((value: unknown) => {
    assert(value && typeof value === "object", "Invalid hook metadata");
    const hook = value as Record<string, unknown>;
    assert.equal(hook.eventName, "interrupt");
    assert.equal(hook.handlerType, "command");
    assert.equal(hook.source, "user");
    assert.equal(hook.timeoutSec, 3);
    assert.equal(hook.enabled, true);
    assert.equal(hook.isManaged, false);
    assert.equal(typeof hook.key, "string");
    assert.equal(typeof hook.currentHash, "string");
    assert.equal(typeof hook.trustStatus, "string");
    assert.equal(typeof hook.command, "string");
    assert.equal(typeof hook.sourcePath, "string");
    return hook as Hook;
  });
  return { hooks, warnings: entry.warnings, errors: entry.errors };
}

async function expectHooks(count: number, mixed = false): Promise<Hook[]> {
  const result = await withClient(listHooks, mixed);
  assert.equal(result.hooks.length, count);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.some(warning => mixedWarning.test(warning)), mixed, JSON.stringify(result.warnings));
  if (!mixed) {
    assert.deepEqual(result.warnings, []);
  }
  return result.hooks;
}

try {
  mkdirSync(codexHome);
  mkdirSync(cwd);
  const version = spawnSync(codex, ["--version"], { cwd, env, encoding: "utf8", timeout: 5_000 });
  assert.equal(version.status, 0, version.error?.message ?? version.stderr);
  console.log(`Codex: ${version.stdout.trim()} (${codex})`);
  writeFileSync(configPath, config);
  await expectHooks(0);
  console.log("PASS isolated baseline: no hooks");

  writeFileSync(hooksPath, json);
  const [untrusted] = await expectHooks(1);
  assert.equal(untrusted.command, command);
  assert.equal(untrusted.sourcePath, hooksPath);
  assert.equal(untrusted.key, `${hooksPath}:interrupt:0:0`);
  assert.equal(untrusted.trustStatus, "untrusted");
  assert.match(untrusted.currentHash, /^sha256:[a-f0-9]{64}$/);
  console.log("PASS JSON-only: discovered, untrusted, no mixed-source warning");

  // Use Codex's writer and reported identity, rather than assuming JSON trust storage.
  await withClient(request => request("config/value/write", {
    keyPath: "hooks.state",
    value: { [untrusted.key]: { trusted_hash: untrusted.currentHash } },
    mergeStrategy: "replace",
    filePath: configPath,
  }));
  const trustedConfig = readFileSync(configPath, "utf8");
  const parsed = Bun.TOML.parse(trustedConfig) as { hooks: Record<string, unknown> };
  assert.deepEqual(Object.keys(parsed.hooks), ["state"]);
  assert.deepEqual(parsed.hooks.state, { [untrusted.key]: { trusted_hash: untrusted.currentHash } });
  assert.equal(readFileSync(hooksPath, "utf8"), json);
  const [trusted] = await expectHooks(1);
  assert.equal(trusted.trustStatus, "trusted");
  assert.equal(trusted.currentHash, untrusted.currentHash);
  console.log("PASS JSON + TOML trust state: trusted after restart, no mixed-source warning");

  const sharedHooksPath = join(root, "shared-hooks.json");
  rmSync(hooksPath);
  writeFileSync(sharedHooksPath, json);
  symlinkSync(sharedHooksPath, hooksPath);
  writeFileSync(configPath, config);
  const [symlinked] = await expectHooks(1);
  assert.equal(symlinked.sourcePath, hooksPath);
  assert.equal(symlinked.key, codexJsonInterruptHookStateKey(hooksPath, 0, 0));
  await withClient(request => request("config/value/write", {
    keyPath: "hooks.state",
    value: { [symlinked.key]: { trusted_hash: symlinked.currentHash } },
    mergeStrategy: "replace",
    filePath: configPath,
  }));
  const [symlinkedTrusted] = await expectHooks(1);
  assert.equal(symlinkedTrusted.trustStatus, "trusted");
  console.log("PASS symlinked JSON: Codex trusts the hooks.json source path");

  writeFileSync(configPath, config);
  const trust = installCodexInterruptHookTrust(
    config,
    codexJsonInterruptHookStateKey(hooksPath, 0, 0),
    symlinked.currentHash,
  );
  writeFileSync(configPath, trust.text);
  await withClient(request => request("config/value/write", {
    keyPath: "mcp_servers.astra_review.command",
    value: "review",
    mergeStrategy: "replace",
    filePath: configPath,
  }));
  const nativeEditedTrust = readFileSync(configPath, "utf8");
  verifyCodexInterruptHookTrust(nativeEditedTrust, trust.installed);
  const restoredTrust = restoreCodexInterruptHookTrust(nativeEditedTrust, trust.installed);
  assert.match(restoredTrust, /\[mcp_servers\.astra_review\]/);
  assert.doesNotMatch(restoredTrust, /JSON interrupt hook trust/);
  console.log("PASS native TOML writer: trust cleanup preserves an unrelated MCP table");

  rmSync(hooksPath);
  writeFileSync(hooksPath, json);
  writeFileSync(hooksPath, json.replace(command, `${command}-changed`));
  const [modified] = await expectHooks(1);
  assert.equal(modified.key, untrusted.key);
  assert.equal(modified.trustStatus, "modified");
  assert.notEqual(modified.currentHash, untrusted.currentHash);
  console.log("PASS changed JSON command: trust invalidated");

  writeFileSync(hooksPath, json);
  writeFileSync(configPath, trustedConfig + toml);
  const mixed = await expectHooks(2, true);
  const inline = mixed.find(hook => hook.sourcePath === configPath);
  assert(inline, "TOML hook was not discovered");
  assert.equal(inline.currentHash, untrusted.currentHash);
  assert.equal(inline.trustStatus, "untrusted");
  assert.equal(mixed.find(hook => hook.sourcePath === hooksPath)?.trustStatus, "trusted");
  console.log("PASS JSON + TOML definitions: both discovered, warning emitted, trust stays source-specific");

  writeFileSync(hooksPath, '{"hooks":{}}');
  await expectHooks(1);
  console.log("PASS empty JSON + TOML definition: no mixed-source warning");

  writeFileSync(configPath, trustedConfig);
  writeFileSync(hooksPath, '{"hooks":');
  const malformed = await withClient(listHooks);
  assert.equal(malformed.hooks.length, 0);
  assert(malformed.warnings.some(warning => warning.includes(hooksPath) && /failed to parse hooks config/.test(warning))
    || malformed.errors.some(value => {
      const error = value as { path?: unknown; message?: unknown } | null;
      return error?.path === hooksPath && typeof error.message === "string" && error.message.length > 0;
    }), "Malformed JSON produced no diagnostic for hooks.json");
  console.log("PASS malformed JSON: diagnostic returned, no hook discovered");

  rmSync(hooksPath);
  await expectHooks(0);
  console.log("PASS removed JSON: stale trust state creates no hook or mixed-source warning");
  console.log("NATIVE_CODEX_HOOKS_JSON_DISCOVERY_SMOKE_OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
