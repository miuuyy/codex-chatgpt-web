import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptBrowserTabClosedError } from "../src/adapters/chatgpt-web/adapter-error";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

test.each([
  [true, false, true, false, false, false, false],
  [false, false, true, false, false, false, false],
  [true, true, true, false, false, false, false],
  [true, false, false, false, false, false, false],
  [true, false, true, true, false, false, false],
  [true, true, false, false, true, false, false],
  [true, false, true, true, false, true, false],
  [true, false, true, false, false, false, true],
])("browser turns preserve recovery, ordering and final-only tools (owned=%s, tools=%s, multipart=%s, size rejected=%s, retained=%s, SSE=%s, GPT-6 Pro=%s)", async (owned, tools, multipart, sizeRejected, retained, sseRejection, gpt6Pro) => {
  const diagnostics = mkdtempSync(join(tmpdir(), "compaction-observation-"));
  const cancellationCase = owned && !tools && !multipart;
  const effort = gpt6Pro ? "max" : tools ? "xhigh" : "high";
  const finalResponse = cancellationCase ? chatGptBrowserTabClosedError() : new Error("fixture reached final response observation");
  const capabilities = { localToolsEnabled: tools, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const progress = tools ? new ChatGptExternalTurnProgress() : undefined;
  const recoveryCallbacks: unknown[] = [];
  const actions: string[] = [];
  const sendBudgets: number[] = [];
  let stage = "";
  let released = false;
  let activated = 0;
  let freshChatPreparations = 0;
  let rejectionAbortedWait = false;
  const frame = {};
  const page = Object.assign(new EventEmitter(), { evaluate: async () => ({}), isClosed: () => false, mainFrame: () => frame });
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnostics, ...(owned ? { browserHostDescriptorPath: "owned-descriptor" } : {}) },
    runStage: async (_trace: string, name: string, timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => {
      stage = name;
      if (name === "send" || name.endsWith("_send")) sendBudgets.push(timeout);
      return action(new AbortController().signal);
    },
    prepareChatSurface: async () => { freshChatPreparations += 1; },
    selectModelAndEffort: async (_page: unknown, model: string, effort: string, _capabilities: unknown,
      _diagnostic: unknown, trackUsage: boolean, family: string) => {
      expect(trackUsage).toBe(false);
      expect(family).toBe(gpt6Pro && effort === "max" ? "6" : "5.6");
      actions.push(`effort:${effort}`);
      return resolveChatGptWebModelMode(model, effort, capabilities);
    },
    captureSubmissionBaseline: async (_page: unknown, _text: string, acknowledged: unknown[] = []) => {
      expect(acknowledged).toHaveLength(actions.filter(action => action === "ack").length);
      return {};
    },
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
      if (cancellationCase || (sizeRejected && stage === "multipart_stage_2_send")) {
        // An observed size rejection must not replace the user's explicit tab-close verdict.
        const request = { method: () => "POST", url: () => "https://chatgpt.com/backend-api/f/conversation", frame: () => frame };
        page.emit("request", request);
        page.emit("response", {
          request: () => request, status: () => sseRejection ? 200 : 413,
          headers: () => ({ "content-type": sseRejection ? "text/event-stream" : "application/json" }),
          json: async () => ({ detail: { code: "message_length_exceeds_limit" } }),
          text: async () => 'data: {"error":"The message you submitted was too long, please edit it and resubmit.","error_code":"input_too_large","error_reason":"last_user_message"}\n\ndata: [DONE]\n\n',
        });
        page.emit("requestfinished", request);
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
      if (sizeRejected && stage === "multipart_stage_2_acknowledgement") {
        const signal = args[3] as AbortSignal;
        await new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("rejected stage kept waiting")), 250);
          const onAbort = () => { clearTimeout(timer); rejectionAbortedWait = true; reject(signal.reason); };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      return {};
    },
    waitForMultipartAcknowledgement: async () => { actions.push("ack"); return { identity: `stage:${actions.length}` }; },
  });
  if (retained) {
    // Exercise the real attachment path: the previous Send cleared its mention,
    // even though this conversation still belongs to the same launcher task.
    let connectorSelected = false;
    const composer = {
      fill: async () => { connectorSelected = false; },
      focus: async () => {}, press: async () => {},
    };
    const absentDialog = { filter: () => absentDialog, last: () => absentDialog, isVisible: async () => false };
    Object.assign(page, { locator: () => absentDialog });
    Object.assign(worker, {
      attachPrompt: (ChatGptBrowserWorker.prototype as any).attachPrompt,
      attachPromptWithCompactionRetry: (ChatGptBrowserWorker.prototype as any).attachPromptWithCompactionRetry,
      activeComposer: async () => composer,
      selectConnector: async () => { connectorSelected = true; actions.push("attach:tools"); return composer; },
      insertPromptText: async () => { expect(connectorSelected).toBeTrue(); },
      assertPromptAttached: async () => {},
      clearChatGptComposerState: async () => { connectorSelected = false; },
    });
  }
  const prepare = async () => ({ text: "Summarize the context", images: [], multipart: multipart ? { parts: Array.from({ length: 6 }, (_, index) => JSON.stringify({ part: index + 1 })), commit: "Summarize" } : undefined, release: () => { released = true; } });
  try {
    const run = worker.runBrowserTurn({
      traceId: "compaction_recovery_fixture",
      modelId: "gpt-5.6-sol",
      modelFamily: gpt6Pro ? "6" : "5.6",
      reasoning: effort,
      onSendActivated: () => { activated += 1; },
      capabilities,
      compaction: !tools,
      externalProgress: progress,
      completionFence: tools ? {
        begin: async () => { throw new Error("fixture must stop before completion"); },
        commit: async () => { throw new Error("fixture must stop before completion"); },
      } : undefined,
      prepare,
      prepareResume: prepare,
    }, owned ? "owned-surface" : undefined, page, retained);
    if (sizeRejected) {
      await expect(run).rejects.toMatchObject({ code: "context_length_exceeded", retryable: false });
      expect(rejectionAbortedWait).toBeTrue();
      expect(sendBudgets).toHaveLength(2);
      expect(actions.filter(action => action === "ack")).toHaveLength(1);
      expect(released).toBeTrue();
      expect(page.listenerCount("request")).toBe(0);
      expect(page.listenerCount("response")).toBe(0);
      expect(page.listenerCount("requestfinished")).toBe(0);
      expect(page.listenerCount("requestfailed")).toBe(0);
      return;
    }
    await expect(run).rejects.toBe(finalResponse);
    expect(freshChatPreparations).toBe(retained ? 0 : 1);
    expect(recoveryCallbacks.map(callback => typeof callback)).toEqual(
      Array(multipart ? 12 : 2).fill(owned ? "function" : "undefined"),
    );
    expect(actions).toEqual([
      ...(multipart ? [
        "effort:low",
        ...Array.from({ length: 5 }, (_, index) => [
          ...(index > 0 ? ["effort:low"] : []), "attach:plain", "send", "observe", "ack",
        ]).flat(),
      ] : []),
      `effort:${effort}`,
      tools ? "attach:tools" : "attach:plain", "files", "send", "observe",
    ]);
    expect(sendBudgets).toEqual(Array(multipart ? 6 : 1).fill(180_000));
    expect(released).toBe(true);
    expect(activated).toBe(1);
    expect(page.listenerCount("request")).toBe(0);
    expect(page.listenerCount("response")).toBe(0);
  } finally {
    rmSync(diagnostics, { recursive: true, force: true });
  }
});
