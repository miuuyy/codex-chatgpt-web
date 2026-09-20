import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptBrowserTabClosedError } from "../src/adapters/chatgpt-web/adapter-error";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

test.each([[true, false, true], [false, false, true], [true, true, true], [true, false, false]])("browser turns preserve recovery, ordering and final-only tools (owned=%s, tools=%s, multipart=%s)", async (owned, tools, multipart) => {
  const diagnostics = mkdtempSync(join(tmpdir(), "compaction-observation-"));
  const cancellationCase = owned && !tools && !multipart;
  const effort = tools ? "xhigh" : "high";
  const finalResponse = cancellationCase ? chatGptBrowserTabClosedError() : new Error("fixture reached final response observation");
  const capabilities = { localToolsEnabled: tools, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const progress = tools ? new ChatGptExternalTurnProgress() : undefined;
  const recoveryCallbacks: unknown[] = [];
  const actions: string[] = [];
  const sendBudgets: number[] = [];
  let stage = "";
  let released = false;
  let activated = 0;
  const frame = {};
  const hiddenDialog = {
    filter: () => hiddenDialog,
    last: () => hiddenDialog,
    isVisible: async () => false,
  };
  const page = Object.assign(new EventEmitter(), {
    evaluate: async () => ({}),
    isClosed: () => false,
    mainFrame: () => frame,
    locator: () => hiddenDialog,
  });
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnostics, ...(owned ? { browserHostDescriptorPath: "owned-descriptor" } : {}) },
    runStage: async (_trace: string, name: string, timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => {
      stage = name;
      if (name === "send" || name.endsWith("_send")) sendBudgets.push(timeout);
      return action(new AbortController().signal);
    },
    prepareTemporaryChatSurface: async () => {},
    selectModelAndEffort: async (_page: unknown, model: string, effort: string) => {
      actions.push(`effort:${effort}`);
      return resolveChatGptWebModelMode(model, effort, capabilities);
    },
    captureSubmissionBaseline: async () => ({}),
    attachPrompt: async (_page: unknown, _text: string, localTools: boolean) => {
      expect(localTools).toBe(false);
      actions.push("attach:plain");
    },
    attachPromptWithCompactionRetry: async (_page: unknown, _text: string, localTools: boolean) => {
      expect(localTools).toBe(tools);
      actions.push(localTools ? "attach:tools" : "attach:plain");
    },
    attachFiles: async () => { actions.push("files"); },
    sendAttachedPrompt: async (...args: unknown[]) => {
      // Context ingestion cannot mistake tool activity for acknowledgement of a part.
      expect(args[4]).toBe(stage === "send" ? progress : undefined);
      const lifecycle = args[5] as { onSendActivated(): Promise<void>; onSubmitted?: () => void };
      if (stage !== "send") expect(lifecycle.onSubmitted).toBeUndefined();
      await lifecycle.onSendActivated();
      if (cancellationCase) {
        // An observed size rejection must not replace the user's explicit tab-close verdict.
        const request = { method: () => "POST", url: () => "https://chatgpt.com/backend-api/f/conversation", frame: () => frame };
        page.emit("request", request);
        page.emit("response", {
          request: () => request, status: () => 413, headers: () => ({ "content-type": "application/json" }),
          json: async () => ({ detail: { code: "message_length_exceeds_limit" } }),
        });
      }
      recoveryCallbacks.push(args[7]);
      actions.push("send");
      return "user_turn";
    },
    waitForNewAssistantTurn: async (...args: unknown[]) => {
      expect(args[4]).toBe(stage === "send" ? progress : undefined);
      recoveryCallbacks.push(args[7]);
      actions.push("observe");
      if (stage === "send") throw finalResponse;
      return {};
    },
    waitForMultipartAcknowledgement: async () => { actions.push("ack"); },
  });
  try {
    await expect(worker.runBrowserTurn({
      traceId: "compaction_recovery_fixture",
      modelId: "gpt-5.6-sol",
      reasoning: effort,
      onSendActivated: () => { activated += 1; },
      capabilities,
      compaction: !tools,
      externalProgress: progress,
      completionFence: tools ? {
        begin: async () => { throw new Error("fixture must stop before completion"); },
        commit: async () => { throw new Error("fixture must stop before completion"); },
      } : undefined,
      prepare: async () => ({ text: "Summarize the context", images: [], multipart: multipart ? { parts: Array.from({ length: 6 }, (_, index) => JSON.stringify({ part: index + 1 })), commit: "Summarize" } : undefined, release: () => { released = true; } }),
    }, owned ? "owned-surface" : undefined, page)).rejects.toBe(finalResponse);
    expect(recoveryCallbacks.map(callback => typeof callback)).toEqual(
      Array(multipart ? 12 : 2).fill(owned ? "function" : "undefined"),
    );
    expect(actions).toEqual([
      ...(multipart ? [
        "effort:low",
        ...Array.from({ length: 5 }, (_, index) => [
          ...(index > 0 ? ["effort:low"] : []),
          "attach:plain", "send", "observe", "ack",
        ]).flat(),
      ] : []),
      `effort:${effort}`,
      tools ? "attach:tools" : "attach:plain", "files", "send", "observe",
    ]);
    expect(sendBudgets).toEqual(multipart ? Array(6).fill(180_000) : [20_000]);
    expect(released).toBe(true);
    expect(activated).toBe(1);
    expect(page.listenerCount("request")).toBe(0);
    expect(page.listenerCount("response")).toBe(0);
  } finally {
    rmSync(diagnostics, { recursive: true, force: true });
  }
});
