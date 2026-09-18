import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatRuntimeBuildStamp,
  parseRuntimeBuildStamp,
  runtimeBuildStamp,
} from "../src/build-stamp";

function manifest(build: unknown): string {
  return JSON.stringify({ schemaVersion: 2, entrypoint: "app/cli.js", build });
}

test("a complete build stamp survives the manifest round trip", () => {
  expect(parseRuntimeBuildStamp(
    manifest({ commit: "abcdef123456", dirty: false, builtAt: "2026-09-18T00:00:00.000Z" }),
  )).toEqual({
    commit: "abcdef123456",
    dirty: false,
    builtAt: "2026-09-18T00:00:00.000Z",
  });
});

test.each([
  ["invalid JSON", "{{{"],
  ["missing build", manifest(undefined)],
  ["non-object build", manifest("abcdef")],
  ["missing commit", manifest({ dirty: false, builtAt: "2026-09-18T00:00:00.000Z" })],
  ["wrong dirty type", manifest({ commit: "abcdef123456", dirty: "false", builtAt: "x" })],
])("%s yields no build stamp", (_label, raw) => {
  expect(parseRuntimeBuildStamp(raw)).toBeUndefined();
});

test("runtime build stamp reads a manifest from disk and tolerates a missing file", () => {
  const root = mkdtempSync(join(tmpdir(), "build-stamp-"));
  const path = join(root, "manifest.json");
  expect(runtimeBuildStamp(path)).toBeUndefined();
  writeFileSync(path, manifest({
    commit: "abcdef123456",
    dirty: true,
    builtAt: "2026-09-18T00:00:00.000Z",
  }));
  expect(runtimeBuildStamp(path)).toEqual({
    commit: "abcdef123456",
    dirty: true,
    builtAt: "2026-09-18T00:00:00.000Z",
  });
});

test("build stamp formatting distinguishes unstamped, clean, and dirty builds", () => {
  expect(formatRuntimeBuildStamp(undefined)).toContain("build stamp is unavailable");
  expect(formatRuntimeBuildStamp({
    commit: "abcdef123456",
    dirty: false,
    builtAt: "2026-09-18T00:00:00.000Z",
  })).toBe("built from abcdef123456 at 2026-09-18T00:00:00.000Z");
  expect(formatRuntimeBuildStamp({
    commit: "abcdef123456",
    dirty: true,
    builtAt: "2026-09-18T00:00:00.000Z",
  })).toBe("built from abcdef123456 (dirty tree) at 2026-09-18T00:00:00.000Z");
});
