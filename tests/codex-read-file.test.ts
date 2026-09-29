import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkspaceDirectory, readWorkspaceTextFile, searchWorkspaceFiles } from "../src/adapters/chatgpt-web/mcp-server";

let base: string;
let workspace: string;
let outside: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "codex-read-file-"));
  workspace = join(base, "workspace");
  outside = join(base, "outside");
  mkdirSync(join(workspace, "docs"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(workspace, "docs", "policy.md"), Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\r\n"));
  writeFileSync(join(workspace, "bin.dat"), Buffer.from([1, 0, 2]));
  writeFileSync(join(outside, "secret.txt"), "secret");
  try { symlinkSync(join(outside, "secret.txt"), join(workspace, "link.txt")); } catch {}
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const env = () => ({ cwd: workspace, roots: [workspace] });

describe("codex_read_file", () => {
  test("reads a line window relative to cwd", async () => {
    const r = await readWorkspaceTextFile(env(), "docs/policy.md", 1, 220);
    expect(r.start_line).toBe(1);
    expect(r.end_line).toBe(220);
    expect(r.total_lines).toBe(300);
    expect(r.truncated).toBe(true);
    expect(String(r.content).split("\n")[219]).toBe("line 220");
  });
  test("rejects paths outside the workspace roots", async () => {
    await expect(readWorkspaceTextFile(env(), join(outside, "secret.txt"))).rejects.toThrow(/workspace roots/);
    await expect(readWorkspaceTextFile(env(), "../outside/secret.txt")).rejects.toThrow(/workspace roots/);
  });
  test("rejects symlinks escaping the workspace", async () => {
    await expect(readWorkspaceTextFile(env(), "link.txt")).rejects.toThrow();
  });
  test("rejects directories and binary files", async () => {
    await expect(readWorkspaceTextFile(env(), "docs")).rejects.toThrow(/regular file/);
    await expect(readWorkspaceTextFile(env(), "bin.dat")).rejects.toThrow(/Binary/);
  });
});

describe("codex_list_dir", () => {
  test("lists entries sorted with types", async () => {
    const r = await listWorkspaceDirectory(env(), ".");
    const names = (r.entries as { name: string; type: string }[]).map(entry => `${entry.name}:${entry.type}`);
    expect(names).toContain("docs:dir");
    expect(names).toContain("bin.dat:file");
  });
  test("rejects directories outside the workspace roots", async () => {
    await expect(listWorkspaceDirectory(env(), outside)).rejects.toThrow(/workspace roots/);
  });
  test("rejects files", async () => {
    await expect(listWorkspaceDirectory(env(), "bin.dat")).rejects.toThrow(/Not a directory/);
  });
});

describe("codex_search_files", () => {
  test("finds literal text with file and line", async () => {
    const r = await searchWorkspaceFiles(env(), "line 42", ".", { maxResults: 5 });
    const matches = r.matches as { file: string; line: number; text: string }[];
    expect(matches[0]).toMatchObject({ line: 42, text: "line 42" });
    expect(matches[0]!.file.replaceAll("\\", "/")).toBe("docs/policy.md");
  });
  test("treats the query literally unless regex is requested", async () => {
    expect(((await searchWorkspaceFiles(env(), "line 4.", ".")).matches as unknown[]).length).toBe(0);
    expect(((await searchWorkspaceFiles(env(), "^line 4.$", ".", { regex: true })).matches as unknown[]).length).toBe(10);
  });
  test("caps results and skips binaries", async () => {
    const r = await searchWorkspaceFiles(env(), "line", ".", { maxResults: 3 });
    expect((r.matches as unknown[]).length).toBe(3);
    expect(r.truncated).toBe(true);
  });
  test("never searches outside the workspace roots", async () => {
    await expect(searchWorkspaceFiles(env(), "secret", outside)).rejects.toThrow(/workspace roots/);
  });
});
