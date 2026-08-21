import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("CI and release workflows install the pinned Bun 1.4 stable release", () => {
  const root = resolve(import.meta.dir, "..");
  const packageManager = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    packageManager: string;
  }).packageManager;
  expect(packageManager).toBe("bun@1.4.0+34cbb9a40");
  expect(readFileSync(resolve(root, "README.zh-CN.md"), "utf8"))
    .toContain("Bun 1.4.0+34cbb9a40");

  const workflows = [".github/workflows/ci.yml", ".github/workflows/release.yml"]
    .map(path => readFileSync(resolve(root, path), "utf8"))
    .join("\n");
  expect(workflows).not.toContain("bun-version: canary");
  expect(workflows).not.toContain("ReleaseTag canary");
  expect(workflows.match(/bun-version: 1\.4\.0/g)?.length).toBe(3);
  expect(workflows.match(/-Revision 1\.4\.0\+34cbb9a40/g)?.length).toBe(2);
});
