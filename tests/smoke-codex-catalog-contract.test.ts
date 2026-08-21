import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("catalog smoke preserves the bundled native model row byte-for-byte", () => {
  const source = readFileSync(join(import.meta.dir, "..", "scripts", "smoke-codex-catalog.ts"), "utf8");

  expect(source).toContain("JSON.stringify(nativeSol) !== JSON.stringify(sourceNativeSol)");
  expect(source).not.toContain("nativeSol?.multi_agent_version");
});
