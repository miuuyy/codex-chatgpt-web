import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalLoopController, explicitGoalObjective } from "../src/cos/goal-loop";
import { limitMcpTextContent, limitOutputText } from "../src/cos/output-limit";
import { windowCaptureScript } from "../src/cos/window-capture";
import { readCosConfig } from "../src/cos/config";
import { createCosDashboardHandler } from "../src/cos/dashboard";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temporary = () => { const dir = mkdtempSync(join(tmpdir(), "cos-test-")); dirs.push(dir); return dir; };
test("CoS features require profile-local opt-in and explicit goals", () => {
  expect(readCosConfig(temporary())).toMatchObject({ dashboard: false, goalLoop: false, observeWindow: false, outputLimit: false });
  for (const value of ["autonomous 완전 자동", "quoted [goal] build", "please follow a goal", "```\n[goal] quoted"]) expect(explicitGoalObjective(value)).toBeUndefined();
  expect(explicitGoalObjective("[goal] finish the build")).toBe("finish the build");
});
test("output budgets preserve UTF-8 boundaries and non-text metadata", () => {
  const text = "한글😀".repeat(1000);
  for (let size = 0; size < 200; size++) {
    const limited = limitOutputText(text, size);
    expect(Buffer.byteLength(limited)).toBeLessThanOrEqual(size);
    expect(limited).not.toContain("�");
  }
  const image = { type: "image", data: "unchanged", mimeType: "image/png" };
  const content = limitMcpTextContent([{ type: "text", text }, image, { type: "text", text, annotations: { priority: 1 } }, null], 100);
  expect(content[1]).toBe(image);
  expect(content[2]).toMatchObject({ annotations: { priority: 1 } });
  expect(content[3]).toBeNull();
  expect(content.reduce<number>((sum, item) => sum + ((item as any)?.type === "text" ? Buffer.byteLength((item as any).text) : 0), 0)).toBeLessThanOrEqual(100);
});
test("external evaluator failures and fallback share the same durable 30-dispatch budget", async () => {
  const file = join(temporary(), "runtime", "goals.json");
  let goals = new GoalLoopController(file);
  goals.begin("thread", "[goal] finish");
  for (let i = 0; i < 30; i++) {
    await goals.evaluate("thread", "- [ ] unfinished", async () => { throw new Error("offline"); });
    expect(goals.consume("thread")).toBeString();
    expect(goals.consume("thread")).toBeUndefined();
  }
  goals = new GoalLoopController(file);
  goals.begin("thread", "[goal] finish");
  await goals.evaluate("thread", "- [ ] unfinished", async () => ({ action: "continue", reply: "next" }));
  expect(goals.consume("thread")).toBeUndefined();
  expect(goals.status("thread").currentTurn).toBe(30);
});
test("cancellation, new instructions, completion and restart discard queued follow-ups", async () => {
  const file = join(temporary(), "goals.json"), goals = new GoalLoopController(file);
  goals.begin("thread", "[goal] finish");
  let release!: (value: { action: "continue"; reply: string }) => void;
  const pending = goals.evaluate("thread", "answer", () => new Promise(resolve => { release = resolve; }));
  goals.begin("thread", "new ordinary instruction");
  release({ action: "continue", reply: "stale" });
  await pending;
  expect(goals.consume("thread")).toBeUndefined();
  goals.begin("thread", "[goal] new goal");
  await goals.evaluate("thread", "answer", async () => ({ action: "continue", reply: "next" }));
  expect(new GoalLoopController(file).consume("thread")).toBeUndefined();
  await goals.evaluate("thread", "done", async () => ({ action: "stop" }));
  expect(goals.consume("thread")).toBeUndefined();
});
test("window capture validates bounds and quotes PowerShell arguments as data", () => {
  expect(windowCaptureScript("a';& echo bad", "C:/one's/output.png", 1280, "C:/helper.cs")).toContain("'a'';& echo bad'");
  expect(() => windowCaptureScript("x", "out", 1, "helper")).toThrow("width");
  expect(() => windowCaptureScript("\0", "out", 1280, "helper")).toThrow("target");
});
test("dashboard rejects forged host and cross-origin goal control", async () => {
  const origin = "http://127.0.0.1:17842", handler = createCosDashboardHandler(async () => ({}), origin);
  expect((await handler(new Request("http://evil.example/"))).status).toBe(403);
  expect((await handler(new Request(origin + "/api/goal/stop", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: '{}' }))).status).toBe(403);
});
