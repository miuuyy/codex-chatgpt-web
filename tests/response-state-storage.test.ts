import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function probe(mode: string, original?: string) {
  const root = mkdtempSync(join(tmpdir(), "response-bytes-"));
  const snapshot = join(root, "responses-state.json");
  try {
    if (original !== undefined) writeFileSync(snapshot, original);
    const process = Bun.spawnSync([Bun.argv[0]!, "run", join(import.meta.dir, "fixtures/response-state-probe.ts"), mode], {
      env: { ...Bun.env, CODEX_CHATGPT_WEB_HOME: root }, stdout: "pipe", stderr: "pipe", timeout: 20_000,
    });
    expect(process.exitCode).toBe(0);
    return { result: JSON.parse(process.stdout.toString()), text: readFileSync(snapshot, "utf8"), diagnostics: process.stderr.toString() };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("Korean and emoji entry limits use serialized UTF-8 bytes", () => {
  const { result } = probe("entry");
  expect(result.ids).toEqual([]);
  expect(result.bytes).toBe(Buffer.byteLength('{"version":1,"states":[]}'));
  expect(result.memoryRecovered).toBe(true);
});

test("snapshot envelope and commas count toward the byte cap and latest records win", () => {
  const { result } = probe("total");
  expect(result.bytes).toBeLessThanOrEqual(24 * 1024 * 1024);
  expect(result.ids.length).toBeLessThan(30);
  expect(result.ids.at(-1)).toBe("state-29");
  expect(result.ids).not.toContain("state-0");
}, 30_000);

test("v1 snapshots restore complete history after process restart", () => {
  const original = JSON.stringify({ version: 1, states: [["saved", { createdAt: Date.now(), items: [{ role: "user", content: "기존 문맥🙂" }, { role: "assistant", content: "result" }] }]] });
  const { result, text } = probe("load", original);
  expect(result.recovered).toBe(true);
  expect(result.prefix).toBe(2);
  expect(JSON.parse(text).states.map((entry: [string, unknown]) => entry[0])).toEqual(["saved", "new"]);
});

test.each(['{"version":1,"states":', JSON.stringify({ version: 1, states: [["saved", { createdAt: Date.now(), items: [] }], ["broken", { items: [] }]] })])(
  "corrupt snapshots remain untouched and no partial context is recovered", original => {
    const { result, text, diagnostics } = probe("load", original);
    expect(text).toBe(original);
    expect(result.recovered).toBe(false);
    expect(diagnostics).toContain("Response snapshot preserved");
  },
);

test("oversized snapshots are preserved before parsing and cannot be overwritten", () => {
  const original = " ".repeat(24 * 1024 * 1024 + 1);
  const { result, text, diagnostics } = probe("load", original);
  expect(text.length).toBe(original.length);
  expect(result.recovered).toBe(false);
  expect(diagnostics).toContain("exceeds UTF-8 byte limit");
}, 30_000);
