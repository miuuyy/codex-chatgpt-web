import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MANAGED_INTERRUPT_HOOK_END,
  codexInterruptHookCommand,
  codexInterruptHookHash,
  installCodexInterruptHook,
  restoreCodexInterruptHook,
  verifyCodexInterruptHook,
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

test("keeps foreign TOML tables inserted between the managed hook and its trust state", () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    const original = 'model = "example"\n\n[[hooks.Interrupt]]\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "prior-hook"\n'.replaceAll("\n", ending);
    const installed = installCodexInterruptHook(original, "/Users/test/.codex/config.toml", { runtimeCommand: ["/opt/runtime"] });
    const foreign = '\n[marketplaces.claude-plugins-official]\nsource = "unchanged-user-setting"\n\n[mcp_servers.notes]\ncommand = "notes-server"\n\n'.replaceAll("\n", ending);
    const stateHeader = `[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`;
    const edited = installed.text.replace(stateHeader, foreign + stateHeader);
    const outside = installed.text + foreign;
    expect(Bun.TOML.parse(edited.replace(/\r\n?/g, "\n"))).toEqual(Bun.TOML.parse(outside.replace(/\r\n?/g, "\n")));
    verifyCodexInterruptHook(edited, installed.installed);
    const restored = restoreCodexInterruptHook(edited, installed.installed);
    expect(restored).toBe(original + foreign);
    const next = installCodexInterruptHook(restored, "/Users/test/.codex/config.toml", { runtimeCommand: ["/opt/new-runtime"] });
    verifyCodexInterruptHook(next.text, next.installed);
    expect(restoreCodexInterruptHook(next.text, next.installed)).toBe(restored);
    for (const changed of [
      edited.replace("timeout = 3", "timeout = 2"),
      edited.replace(installed.installed.trustedHash, "sha256:changed"),
      edited + `\n[hooks.state.${JSON.stringify(installed.installed.stateKey)}.extra]\nchanged = true\n`,
      edited + '\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "unexpected-hook"\n',
    ]) {
      expect(() => restoreCodexInterruptHook(changed, installed.installed)).toThrow("changed after setup");
    }
  }
});

test("keeps a managed trust state reordered before its interrupt hook", () => {
  for (const ending of ["\n", "\r\n"]) {
    const original = 'model = "example"\n'.replaceAll("\n", ending);
    const installed = installCodexInterruptHook(original, "/Users/test/.codex/config.toml", {
      runtimeCommand: ["/opt/runtime"],
    });
    const state = [
      `[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`,
      `trusted_hash = ${JSON.stringify(installed.installed.trustedHash)}`,
      "",
    ].join(ending);
    const reordered = installed.text.replace(state, "").replace(
      "# Managed by codex-chatgpt-web:",
      state + "# Managed by codex-chatgpt-web:",
    ).replace(
      `timeout = 3${ending}${ending}${MANAGED_INTERRUPT_HOOK_END}`,
      `timeout = 3${ending}${MANAGED_INTERRUPT_HOOK_END}`,
    );

    expect(Bun.TOML.parse(reordered.replace(/\r\n?/g, "\n"))).toEqual(
      Bun.TOML.parse(installed.text.replace(/\r\n?/g, "\n")),
    );
    verifyCodexInterruptHook(reordered, installed.installed);
    const restored = restoreCodexInterruptHook(reordered, installed.installed);
    expect(Bun.TOML.parse(restored.replace(/\r\n?/g, "\n"))).toEqual(Bun.TOML.parse(original));
    verifyCodexInterruptHookRestored(restored);

    for (const changed of [
      reordered.replace("timeout = 3", "timeout = 2"),
      reordered.replace(installed.installed.trustedHash, "sha256:changed"),
      reordered + state,
    ]) {
      expect(() => verifyCodexInterruptHook(changed, installed.installed)).toThrow("changed after setup");
    }
  }
});

test("accepts a literal-quoted trust-state key while preserving another config path's trust entry", () => {
  const original = 'model = "example"\n';
  const installed = installCodexInterruptHook(original, "/Users/test/.codex/config.toml", { runtimeCommand: ["/opt/runtime"] });
  // Use the Windows key from #443 without depending on this test host's path resolver.
  const stateKey = String.raw`D:\AppData\Codex\UserData\config.toml:interrupt:0:0`;
  const beforeHeader = `[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`;
  const journalHeader = `[hooks.state.${JSON.stringify(stateKey)}]`;
  const journal = {
    ...installed.installed,
    stateKey,
    fragment: installed.installed.fragment.replace(beforeHeader, journalHeader),
  };
  const alias = `[hooks.state.'C:\\Users\\test\\.codex\\config.toml:interrupt:0:0']\ntrusted_hash = ${JSON.stringify(journal.trustedHash)}\n`;
  for (const ending of ["\n", "\r\n"]) {
    const edited = installed.text.replace(beforeHeader, `[hooks.state.'${stateKey}']`)
      .replace(MANAGED_INTERRUPT_HOOK_END, alias + MANAGED_INTERRUPT_HOOK_END)
      .replaceAll("\n", ending);
    verifyCodexInterruptHook(edited, journal);
    expect(restoreCodexInterruptHook(edited, journal)).toBe((original + alias).replaceAll("\n", ending));
    for (const changed of [
      edited.replace("timeout = 3", "timeout = 2"),
      edited.replace(journal.trustedHash, "sha256:changed"),
      edited.replace(`[hooks.state.'${stateKey}']`, "[hooks.state.'different-key']"),
      edited + `\n[hooks.state.'${stateKey}'.extra]\nchanged = true\n`,
    ]) {
      expect(() => verifyCodexInterruptHook(changed, journal)).toThrow("changed after setup");
    }
  }
});
