import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MANAGED_INTERRUPT_HOOK_END,
  MANAGED_INTERRUPT_HOOK_TRUST_START,
  MANAGED_INTERRUPT_HOOK_TRUST_END,
  codexInterruptHookCommand,
  codexInterruptHookHash,
  installCodexInterruptHook,
  installCodexInterruptHookTrust,
  restoreCodexInterruptHookTrust,
  restoreCodexInterruptHook,
  verifyCodexInterruptHook,
  verifyCodexInterruptHookTrust,
  verifyCodexInterruptHookRestored,
} from "../src/codex-interrupt-hook";

test("installs one narrowly trusted Interrupt hook and restores the exact Codex config", () => {
  const original = [
    'model = "gpt-5.6-sol"',
    "",
    "[[hooks.Interrupt]]",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    'command = "existing-hook"',
    "",
  ].join("\n");
  const config = { runtimeCommand: ["/opt/Codex Web/runtime/bun", "/opt/Codex Web/app/cli.js"] };
  const installed = installCodexInterruptHook(original, "/Users/test/.codex/config.toml", config);

  expect(installed.installed.groupIndex).toBe(1);
  expect(installed.installed.stateKey).toBe(`${resolve("/Users/test/.codex/config.toml")}:interrupt:1:0`);
  expect(installed.text).toContain('[[hooks.Interrupt]]');
  expect(installed.text).toContain(`[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`);
  expect(installed.text).toContain(`trusted_hash = ${JSON.stringify(installed.installed.trustedHash)}`);
  verifyCodexInterruptHook(installed.text, installed.installed);
  expect(restoreCodexInterruptHook(installed.text, installed.installed)).toBe(original);
  verifyCodexInterruptHookRestored(original);
});

test("trusts the canonical Codex config path before a new config file exists", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-interrupt-hook-"));
  try {
    const configPath = join(directory, "config.toml");
    const installed = installCodexInterruptHook("", configPath, { runtimeCommand: ["/opt/runtime"] });
    expect(installed.installed.stateKey).toBe(
      `${join(realpathSync.native(directory), "config.toml")}:interrupt:0:0`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves native tables moved inside JSON hook trust markers", () => {
  const installed = installCodexInterruptHookTrust(
    'model = "gpt-5.6-sol"\n',
    "/Users/test/.codex/hooks.json:interrupt:0:0",
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  const updated = installed.text.replace(
    MANAGED_INTERRUPT_HOOK_TRUST_END,
    '[mcp_servers.astra_review]\ncommand = "review"\n\n' + MANAGED_INTERRUPT_HOOK_TRUST_END,
  );
  verifyCodexInterruptHookTrust(updated, installed.installed);
  const restored = restoreCodexInterruptHookTrust(updated, installed.installed);
  expect(restored).toContain('[mcp_servers.astra_review]');
  expect(restored).not.toContain("hooks.state");
  expect(restored).not.toContain("JSON interrupt hook trust");
});

test("preserves explicitly declared empty trust parent tables", () => {
  const original = '[hooks]\n[hooks.state]\n';
  const installed = installCodexInterruptHookTrust(
    original,
    "/Users/test/.codex/hooks.json:interrupt:0:0",
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  const restored = restoreCodexInterruptHookTrust(installed.text, installed.installed);
  expect(Bun.TOML.parse(restored)).toEqual(Bun.TOML.parse(original));
  expect(restored).toContain("[hooks]\n[hooks.state]");
});

test("restores empty trust parent tables from equivalent TOML spellings", () => {
  for (const original of [
    "[ hooks ]\n[ hooks.state ]\n",
    '["hooks"]\n["hooks"."state"]\n',
    'description = """\n[hooks]\n"""\n',
  ]) {
    const installed = installCodexInterruptHookTrust(
      original,
      "/Users/test/.codex/hooks.json:interrupt:0:0",
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    expect(Bun.TOML.parse(restoreCodexInterruptHookTrust(installed.text, installed.installed)))
      .toEqual(Bun.TOML.parse(original));
  }
});

test("preserves a native table with a commented header inside trust markers", () => {
  const installed = installCodexInterruptHookTrust(
    'model = "gpt-5.6-sol"\n',
    "/Users/test/.codex/hooks.json:interrupt:0:0",
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  const updated = installed.text.replace(
    MANAGED_INTERRUPT_HOOK_TRUST_END,
    '[mcp_servers.astra_review] # native setting\ncommand = "review"\n\n' + MANAGED_INTERRUPT_HOOK_TRUST_END,
  );
  const restored = restoreCodexInterruptHookTrust(updated, installed.installed);
  expect(restored).toContain('[mcp_servers.astra_review] # native setting\ncommand = "review"');
});

test("removes a moved JSON trust end marker without duplicating native tables", () => {
  const installed = installCodexInterruptHookTrust(
    'model = "gpt-5.6-sol"\n',
    "/Users/test/.codex/hooks.json:interrupt:0:0",
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  const moved = installed.text
    .replace(MANAGED_INTERRUPT_HOOK_TRUST_END, "")
    .replace(
      MANAGED_INTERRUPT_HOOK_TRUST_START,
      `${MANAGED_INTERRUPT_HOOK_TRUST_START}\n${MANAGED_INTERRUPT_HOOK_TRUST_END}`,
    )
    .replace(
      'trusted_hash = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"',
      'trusted_hash = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"\n[mcp_servers.astra_review]\ncommand = "review"',
    );
  verifyCodexInterruptHookTrust(moved, installed.installed);
  const restored = restoreCodexInterruptHookTrust(moved, installed.installed);
  expect(restored).toContain('[mcp_servers.astra_review]');
  expect(restored.match(/\[mcp_servers\.astra_review\]/g)).toHaveLength(1);
  expect(restored).not.toContain("hooks.state");
  expect(restored).not.toContain("JSON interrupt hook trust");
});

test("does not join adjacent user assignments when the JSON trust start marker moves", () => {
  const installed = installCodexInterruptHookTrust(
    'model = "gpt-5.6-sol"\n',
    "/Users/test/.codex/hooks.json:interrupt:0:0",
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  const moved = installed.text
    .replace(MANAGED_INTERRUPT_HOOK_TRUST_START, "")
    .replace(
      'model = "gpt-5.6-sol"\n',
      'model = "gpt-5.6-sol"\n[mcp_servers.astra_review]\ncommand = "review"\n'
        + `${MANAGED_INTERRUPT_HOOK_TRUST_START}\nargs = []\n`,
    );
  verifyCodexInterruptHookTrust(moved, installed.installed);
  const restored = restoreCodexInterruptHookTrust(moved, installed.installed);
  expect(restored).toContain('command = "review"\nargs = []');
  expect(Bun.TOML.parse(restored)).toMatchObject({
    mcp_servers: { astra_review: { command: "review", args: [] } },
  });
});

test("refuses JSON trust markers moved into multiline TOML strings", () => {
  const installed = installCodexInterruptHookTrust(
    'model = "gpt-5.6-sol"\n',
    "/Users/test/.codex/hooks.json:interrupt:0:0",
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  const moved = installed.text
    .replace(MANAGED_INTERRUPT_HOOK_TRUST_START, "")
    .replace(
      'model = "gpt-5.6-sol"\n',
      'model = "gpt-5.6-sol"\n[metadata]\ndescription = """\n'
        + `${MANAGED_INTERRUPT_HOOK_TRUST_START}\nuser text\n"""\n`,
    );
  expect(() => restoreCodexInterruptHookTrust(moved, installed.installed)).toThrow("changed after setup");
});

test("removes only the parsed JSON trust table when matching lines appear in a string", () => {
  const installed = installCodexInterruptHookTrust(
    'model = "gpt-5.6-sol"\n',
    "/Users/test/.codex/hooks.json:interrupt:0:0",
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  const header = `[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`;
  const hash = `trusted_hash = ${JSON.stringify(installed.installed.trustedHash)}`;
  const changed = installed.text.replace(
    'model = "gpt-5.6-sol"\n',
    `model = "gpt-5.6-sol"\n[metadata]\ndescription = """\n${header}\n${hash}\n"""\n`,
  );
  const restored = restoreCodexInterruptHookTrust(changed, installed.installed);
  expect(restored).toContain(`description = """\n${header}\n${hash}\n"""`);
  expect(Bun.TOML.parse(restored)).toMatchObject({
    metadata: { description: `${header}\n${hash}\n` },
  });
  expect(restored).not.toContain('trusted_hash = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"\n# End codex-chatgpt-web JSON interrupt hook trust state');
});

test("refuses extra assignments in the owned JSON trust table", () => {
  const installed = installCodexInterruptHookTrust(
    'model = "gpt-5.6-sol"\n',
    "/Users/test/.codex/hooks.json:interrupt:0:0",
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  const changed = installed.text.replace(
    MANAGED_INTERRUPT_HOOK_TRUST_END,
    'approved = false\n' + MANAGED_INTERRUPT_HOOK_TRUST_END,
  );
  expect(() => restoreCodexInterruptHookTrust(changed, installed.installed)).toThrow("changed after setup");
});

test("Interrupt hook command is absolute, quoted, and bound to the exact application home", () => {
  expect(codexInterruptHookCommand(
    { runtimeCommand: ["/Applications/Codex Web GPT.app/runtime/bun", "/Applications/Codex Web GPT.app/app/cli.js"] },
    "/Users/test/Application Support/Codex Web GPT",
    "darwin",
  )).toBe(
    "'/Applications/Codex Web GPT.app/runtime/bun' '/Applications/Codex Web GPT.app/app/cli.js'"
      + " '--home' '/Users/test/Application Support/Codex Web GPT' 'hook' 'interrupt'",
  );
  expect(codexInterruptHookCommand(
    { runtimeCommand: ["C:\\Program Files\\Codex Web GPT\\bun.exe", "C:\\Program Files\\Codex Web GPT\\cli.js"] },
    "C:\\Users\\test\\Codex Web GPT",
    "win32",
  )).toBe(
    '"C:\\Program Files\\Codex Web GPT\\bun.exe" "C:\\Program Files\\Codex Web GPT\\cli.js"'
      + ' "--home" "C:\\Users\\test\\Codex Web GPT" "hook" "interrupt"',
  );
});

test("Interrupt hook trust hash is deterministic and changes with its exact command", () => {
  const first = codexInterruptHookHash("'runtime' 'hook' 'interrupt'");
  expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(codexInterruptHookHash("'runtime' 'hook' 'interrupt'")).toBe(first);
  expect(codexInterruptHookHash("'other-runtime' 'hook' 'interrupt'")).not.toBe(first);
});

test("refuses to remove a modified or duplicated managed hook", () => {
  const original = 'model = "gpt-5.6-sol"\n';
  const installed = installCodexInterruptHook(
    original,
    "/Users/test/.codex/config.toml",
    { runtimeCommand: ["/opt/runtime"] },
  );
  const modified = installed.text.replace("timeout = 3", "timeout = 2");
  expect(() => restoreCodexInterruptHook(modified, installed.installed)).toThrow("changed after setup");
  expect(() => restoreCodexInterruptHook(
    installed.text.replace(MANAGED_INTERRUPT_HOOK_END, `approved = false\n${MANAGED_INTERRUPT_HOOK_END}`),
    installed.installed,
  )).toThrow("changed after setup");
  for (const extension of [
    '\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "unexpected-command"\n',
    `\n[hooks.state.${JSON.stringify(installed.installed.stateKey)}.unexpected]\nvalue = true\n`,
  ]) {
    expect(() => restoreCodexInterruptHook(
      installed.text.replace(MANAGED_INTERRUPT_HOOK_END, extension + MANAGED_INTERRUPT_HOOK_END),
      installed.installed,
    )).toThrow("changed after setup");
  }
  const reordered = [
    "[[hooks.Interrupt]]",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    'command = "new-earlier-hook"',
    "",
    installed.text,
  ].join("\n");
  expect(() => restoreCodexInterruptHook(reordered, installed.installed)).toThrow("order changed after setup");
  expect(() => installCodexInterruptHook(installed.text, "/Users/test/.codex/config.toml", { runtimeCommand: ["/opt/runtime"] }))
    .toThrow("already contains");
});

test("preserves native TOML editor tables inserted before the trailing hook comment", () => {
  for (const ending of ["\n", "\r\n"]) {
    const original = 'model = "gpt-5.6-sol"\n';
    const installed = installCodexInterruptHook(original.replaceAll("\n", ending), "/Users/test/.codex/config.toml", {
      runtimeCommand: ["/opt/runtime"],
    });
    // Native config writes normalize line endings and insert tables before the trailing comment.
    const appended = "\n[features]\ngoals = true\n";
    const edited = installed.text.replaceAll("\r\n", "\n")
      .replace(MANAGED_INTERRUPT_HOOK_END, appended + MANAGED_INTERRUPT_HOOK_END);
    verifyCodexInterruptHook(edited, installed.installed);
    const restored = restoreCodexInterruptHook(edited, installed.installed);
    expect(restored).toBe(original + appended);
    verifyCodexInterruptHookRestored(restored);
    expect(() => restoreCodexInterruptHook(
      edited.replace("timeout = 3", "timeout = 2"), installed.installed,
    )).toThrow("changed after setup");
  }
});

test("restores a hook whose end comment moved before unchanged definitions without losing MCP settings", () => {
  for (const ending of ["\n", "\r\n"]) {
    const original = 'model = "gpt-5.6-sol"\n';
    const installed = installCodexInterruptHook(original.replaceAll("\n", ending), "/Users/test/.codex/config.toml", {
      runtimeCommand: ["/opt/runtime"],
    });
    const mcp = '\n[mcp_servers.node_repl]\ncommand = "my-mcp"\n\n[mcp_servers.node_repl.env]\nMODE = "user-setting"\n';
    const definitions = installed.installed.fragment.replaceAll("\r\n", "\n")
      .replace(`${MANAGED_INTERRUPT_HOOK_END}\n`, "");
    for (const beforeModel of [false, true]) {
      const movedComment = `${MANAGED_INTERRUPT_HOOK_END}\n`;
      const edited = (beforeModel ? movedComment + original : original + movedComment) + mcp + definitions;
      expect(Bun.TOML.parse(edited)).toMatchObject(Bun.TOML.parse(installed.text));
      verifyCodexInterruptHook(edited, installed.installed);
      const restored = restoreCodexInterruptHook(edited, installed.installed);
      expect(restored).toBe(original + mcp);
      verifyCodexInterruptHookRestored(restored);

      for (const changed of [
        edited.replace("timeout = 3", "timeout = 2"),
        edited + "approved = false\n",
        edited + '\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "unexpected-command"\n',
        edited + `\n[hooks.state.${JSON.stringify(installed.installed.stateKey)}.unexpected]\nvalue = true\n`,
        edited + movedComment,
      ]) {
        expect(() => restoreCodexInterruptHook(changed, installed.installed)).toThrow("changed after setup");
      }
      const markerInsideValue = original + 'description = """\n' + movedComment + '"""\n' + mcp + definitions;
      expect(() => restoreCodexInterruptHook(markerInsideValue, installed.installed)).toThrow("markers changed after setup");
    }
  }
});
