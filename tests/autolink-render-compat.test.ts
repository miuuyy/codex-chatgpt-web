import { afterAll, beforeAll, expect, test } from "bun:test";
import { patchAutolinkEmailCheck } from "../src/adapters/chatgpt-web/autolink-render-compat";

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fixtureDir = mkdtempSync(join(tmpdir(), "autolink-test-"));
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));
let original: (value: string) => string;
let optimized: (value: string) => string;
let bundled: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [new URL("./fixtures/autolink-render-entry.ts", import.meta.url).pathname], target: "node", minify: true });
  if (!build.success) throw new AggregateError(build.logs, "parser fixture build failed");
  bundled = await build.outputs[0]!.text();
  const patched = patchAutolinkEmailCheck(bundled);
  expect(patched.patched).toBeTrue();
  writeFileSync(join(fixtureDir, "original.mjs"), bundled);
  writeFileSync(join(fixtureDir, "optimized.mjs"), patched.source);
  original = (await import(join(fixtureDir, "original.mjs"))).render;
  optimized = (await import(join(fixtureDir, "optimized.mjs"))).render;
});

test("does not rewrite unknown or already-patched bundles", () => {
  expect(patchAutolinkEmailCheck("unknown new site version")).toEqual({ source: "unknown new site version", patched: false });
  const first = patchAutolinkEmailCheck(bundled);
  expect(patchAutolinkEmailCheck(first.source)).toEqual({ source: first.source, patched: false });
  expect(patchAutolinkEmailCheck(bundled + bundled).patched).toBeFalse();
});

test("preserves complete Markdown rendering, including email and nested labels", () => {
  const cases = [
    "hello@example.com", "a.b+c_d@example-domain.co.uk.", "(hello@example.com)",
    "[hello@example.com](https://example.invalid)", "![image hello@example.com](image.png)",
    "[**bold** and [nested] x@y.test](https://example.invalid)", "[not closed **strong** x@y.test",
    "www.example.org and https://example.org/a_(b)?c=d.", "x@@example.com a@b a@b.c a@b..com",
    "`a@b.com`\n\n```json\n{\"mail\":\"a@b.com\"}\n```",
    "Кириллица 😀 é 漢字 mail@example.org\nsecond line", "\\[escaped\\] \\*star\\* foo@bar.org",
    "[reference mail@example.org][ref]\n\n[ref]: https://example.invalid",
  ];
  let seed = 42;
  const atoms = ["word", " ", "[", "]", "(", ")", "**x**", "`x`", "a@b.test", "www.a.test", "https://a.test", "\n", "\\", "😀"];
  for (let i = 0; i < 250; i++) {
    let value = "";
    for (let j = 0; j < 60; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; value += atoms[seed % atoms.length]; }
    cases.push(value);
  }
  for (const value of cases) expect(optimized(value)).toBe(original(value));
});

test("large link-label failure path keeps the full output", () => {
  const value = "[" + "word **bold** ".repeat(1800) + "](https://example.invalid)";
  expect(optimized(value)).toBe(original(value));
}, 20_000);
