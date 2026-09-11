import { expect, test } from "bun:test";
import {
  installCodexInterruptHookJson,
  restoreCodexInterruptHookJson,
  verifyCodexInterruptHookJson,
} from "../src/codex-interrupt-hook-json";

const command = "'/opt/Codex Web/runtime/bun' 'hook' 'interrupt'";

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

test("installs a distinct JSON Interrupt command hook and preserves user hooks", () => {
  const original = JSON.stringify({
    hooks: {
      Interrupt: [{ hooks: [{ type: "command", command: "user-interrupt", timeout: 5 }] }],
      Stop: [{ hooks: [{ type: "command", command: "user-stop" }] }],
    },
    metadata: { owner: "user" },
  });

  const installed = installCodexInterruptHookJson(original, command);
  const document = parse(installed.text) as { hooks: Record<string, unknown> };
  const groups = document.hooks.Interrupt as Array<{ hooks: Array<Record<string, unknown>> }>;

  expect(installed.installed).toMatchObject({
    mode: "json",
    command,
    groupIndex: 1,
    hookIndex: 0,
  });
  expect(installed.installed.entryHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(groups).toHaveLength(2);
  expect(groups[0]).toEqual({ hooks: [{ type: "command", command: "user-interrupt", timeout: 5 }] });
  expect(groups[1]).toEqual({ hooks: [{ type: "command", command, timeout: 3 }] });
  verifyCodexInterruptHookJson(installed.text, installed.installed);
});

test("rejects an existing codex-chatgpt-web JSON command instead of duplicating it", () => {
  const original = JSON.stringify({
    hooks: { Interrupt: [{ hooks: [{ type: "command", command, timeout: 3 }] }] },
  });

  expect(() => installCodexInterruptHookJson(original, command)).toThrow("already contains");
});

test("rejects malformed and unsupported JSON documents before changing them", () => {
  for (const invalid of [
    "{\"hooks\":",
    "[]",
    JSON.stringify({ hooks: [] }),
    JSON.stringify({ hooks: { Interrupt: {} } }),
    JSON.stringify({ hooks: { Interrupt: [{}] } }),
    JSON.stringify({ hooks: { Interrupt: [{ hooks: [{ type: "command" }] }] } }),
  ]) {
    expect(() => installCodexInterruptHookJson(invalid, command)).toThrow();
  }
});

test("refuses removal when the journaled JSON hook entry changed", () => {
  const installed = installCodexInterruptHookJson("{}", command);
  const modified = installed.text.replace("\"timeout\": 3", "\"timeout\": 2");

  expect(() => verifyCodexInterruptHookJson(modified, installed.installed)).toThrow("changed after setup");
  expect(() => restoreCodexInterruptHookJson(modified, installed.installed)).toThrow("changed after setup");
});

test("removes only the owned entry and keeps user hooks added later", () => {
  const original = JSON.stringify({
    hooks: { Interrupt: [{ hooks: [{ type: "command", command: "user-interrupt" }] }] },
  });
  const installed = installCodexInterruptHookJson(original, command);
  const document = parse(installed.text) as { hooks: { Interrupt: Array<{ hooks: Array<Record<string, unknown>> }> } };
  document.hooks.Interrupt[1].hooks.push({ type: "command", command: "later-user-hook" });

  const restored = restoreCodexInterruptHookJson(JSON.stringify(document), installed.installed);
  expect(parse(restored)).toEqual({
    hooks: {
      Interrupt: [
        { hooks: [{ type: "command", command: "user-interrupt" }] },
        { hooks: [{ type: "command", command: "later-user-hook" }] },
      ],
    },
  });
});
