import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chatGptReasoningLimitError, ChatGptModelAvailabilityObserver } from "../src/adapters/chatgpt-web/model-availability";

const metadata = () => ({
  type: "conversation_detail_metadata",
  intended_default_model_slug: "gpt-6-thinking", default_model_slug: "gpt-6-t-mini",
  blocked_features: [{ name: "reason", resets_after: new Date(Date.now() + 3_600_000).toISOString() }],
  model_limits: [{ model_slug: "gpt-6-thinking", resets_after: new Date(Date.now() + 3_600_000).toISOString() }],
});

test("explicit reasoning restriction and fallback report the reset without claiming Pro exhaustion", () => {
  const data = metadata();
  const error = chatGptReasoningLimitError(data, "6", "high");
  expect(error).toMatchObject({ status: 429, code: "chatgpt_reasoning_limit", retryable: false });
  expect(error?.message).toContain(data.model_limits[0]!.resets_after);
  expect(error?.message).toContain("remaining Pro message allowance");
  for (const [family, effort] of [["5.6", "high"], ["6", "low"], ["6", "max"]] as const) {
    expect(chatGptReasoningLimitError(data, family, effort)).toBeUndefined();
  }
});

test("catalogs, unused quota labels, missing evidence and expired restrictions are not active limits", () => {
  for (const change of [
    { type: "catalog" }, { blocked_features: [] }, { model_limits: [] },
    { default_model_slug: "gpt-6-thinking" }, { intended_default_model_slug: "gpt-5-6-thinking" },
    { blocked_features: [{ name: "reason", resets_after: "invalid" }] },
    { model_limits: [{ model_slug: "gpt-6-pro", resets_after: new Date(Date.now() + 10000).toISOString() }] },
  ]) expect(chatGptReasoningLimitError({ ...metadata(), ...change }, "6", "high")).toBeUndefined();
  expect(chatGptReasoningLimitError(metadata(), "6", "high", Date.now() + 7_200_000)).toBeUndefined();
  expect(chatGptReasoningLimitError({ text: "Usage limit reached" }, "6", "high")).toBeUndefined();
});

test("observer fences foreign, navigated, disposed and already submitted responses", async () => {
  const page = Object.assign(new EventEmitter(), { mainFrame: () => mainFrame });
  const mainFrame = {};
  const errors: unknown[] = [];
  const observer = new ChatGptModelAvailabilityObserver("6", "high", error => errors.push(error));
  const response = (json: () => Promise<unknown>, frame = mainFrame, url = "https://chatgpt.com/backend-api/conversation/init") => ({
    url: () => url, status: () => 200, request: () => ({ frame: () => frame }), json,
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  observer.attach(page as any);
  page.emit("response", response(async () => metadata(), {}));
  page.emit("response", response(async () => metadata(), mainFrame, "https://example.com/backend-api/conversation/init"));
  await flush();
  expect(errors).toHaveLength(0);
  let finish!: (data: unknown) => void;
  page.emit("response", response(() => new Promise(resolve => { finish = resolve; })));
  page.emit("framenavigated", mainFrame);
  finish(metadata()); await flush();
  expect(errors).toHaveLength(0);
  page.emit("response", response(async () => metadata())); await flush();
  expect(errors).toHaveLength(1);
  observer.dispose();
  expect(page.listenerCount("response")).toBe(0);
  observer.attach(page as any);
  page.emit("response", response(() => new Promise(resolve => { finish = resolve; })));
  page.emit("request", { frame: () => mainFrame, method: () => "POST", url: () => "https://chatgpt.com/backend-api/f/conversation" });
  finish(metadata()); await flush();
  expect(errors).toHaveLength(1);
  expect(page.listenerCount("response")).toBe(0);
});
