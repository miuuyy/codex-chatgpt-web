import { createInterface } from "node:readline";
import { stdin, stderr, stdout } from "node:process";
import type { CodexProviderConfig } from "../../types";
import { ChatGptBrowserWorker, closeChatGptBrowserWorkers, type BrowserTurn } from "./browser-worker";
import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptWebCapabilities } from "./model";
import { createProcessLineWriter } from "./process-line-writer";
import { createBrowserHelperPromptSelection } from "./browser-helper-prompt-selection";
import type { CompiledChatGptWebPrompt } from "./prompt";
import { ChatGptMirroredTurnProgress } from "./turn-progress";
import type { ChatGptExternalTurnProgressSnapshot } from "./turn-progress";

interface RunMessage {
  type: "run";
  id: string;
  config: {
    appName: string;
    browserHostDescriptorPath: string;
    browserDiagnosticsPath?: string;
    turnTimeoutMs: number;
    autoApproveToolCalls: boolean;
  };
  turn: {
    traceId: string;
    modelId: string;
    reasoning?: string;
    capabilities: ChatGptWebCapabilities;
    nativeConnector?: boolean;
    resumeAvailable?: boolean;
    retainConversation?: boolean;
    requireRetainedConversation?: boolean;
    conversationKey?: string;
    compaction?: boolean;
    captureLunaCheckpoint?: boolean;
  };
}

interface VerifyMessage {
  type: "verify";
  id: string;
  config: {
    appName: string;
    browserHostDescriptorPath: string;
  };
}

interface InspectMessage {
  type: "inspect";
  id: string;
  config: VerifyMessage["config"];
  detectCapabilities: boolean;
}

interface SmokeMessage {
  type: "smoke";
  id: string;
  config: VerifyMessage["config"];
}

type MaintenanceMessage = VerifyMessage | InspectMessage | SmokeMessage;
type InputMessage = RunMessage
  | MaintenanceMessage
  | { type: "prepared_selected_ack"; id: string; prepared: CompiledChatGptWebPrompt }
  | { type: "send_activation_ack"; id: string }
  | { type: "progress"; id: string; snapshot: ChatGptExternalTurnProgressSnapshot }
  | { type: "abort"; id: string }
  | { type: "shutdown" };

let outputFailure: Error | undefined;
const handleOutputFailure = (error: Error): void => {
  if (outputFailure) return;
  outputFailure = error;
  void requestShutdown();
};
const protocolOutput = createProcessLineWriter(stdout, handleOutputFailure);
const diagnosticOutput = createProcessLineWriter(stderr, handleOutputFailure);

const writeProtocol = (message: unknown): boolean => protocolOutput.write(JSON.stringify(message));

const diagnostic = (...values: unknown[]): void => {
  diagnosticOutput.write(values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
};
console.info = diagnostic;
console.warn = diagnostic;
console.error = diagnostic;

const abortControllers = new Map<string, AbortController>();
const turnProgress = new Map<string, ChatGptMirroredTurnProgress>();
const preparedSelections = new Map<string, ReturnType<typeof createBrowserHelperPromptSelection>>();
const sendActivationWaiters = new Map<string, {
  resolve: () => void;
  reject: (error: Error) => void;
}>();
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;

function requestShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  let completeShutdown!: () => void;
  shutdownPromise = new Promise<void>(resolveShutdown => {
    completeShutdown = resolveShutdown;
  });
  shuttingDown = true;
  protocolOutput.close();
  diagnosticOutput.close();
  for (const controller of abortControllers.values()) controller.abort();
  for (const selection of preparedSelections.values()) selection.cancel();
  preparedSelections.clear();
  for (const waiter of sendActivationWaiters.values()) {
    waiter.reject(new DOMException("Browser helper is shutting down", "AbortError"));
  }
  sendActivationWaiters.clear();
  input.close();
  void closeChatGptBrowserWorkers().then(
    () => {
      completeShutdown();
      process.exit(0);
    },
    error => {
      diagnostic(`Browser helper shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      completeShutdown();
      process.exit(1);
    },
  );
  return shutdownPromise;
}

async function run(message: RunMessage): Promise<void> {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(message.id) || message.id !== message.turn.traceId) {
    throw new Error("Browser helper turn identity is invalid");
  }
  if (abortControllers.has(message.id)) throw new Error(`Browser helper turn already exists: ${message.id}`);
  if (message.turn.resumeAvailable !== undefined && typeof message.turn.resumeAvailable !== "boolean") {
    throw new Error("Browser helper resume availability is invalid");
  }
  if (message.turn.nativeConnector !== undefined && typeof message.turn.nativeConnector !== "boolean") {
    throw new Error("Browser helper native connector flag is invalid");
  }
  if (message.turn.retainConversation !== undefined && typeof message.turn.retainConversation !== "boolean") {
    throw new Error("Browser helper conversation retention flag is invalid");
  }
  if (message.turn.requireRetainedConversation !== undefined
    && typeof message.turn.requireRetainedConversation !== "boolean") {
    throw new Error("Browser helper retained-conversation requirement is invalid");
  }
  if (message.turn.conversationKey !== undefined && !/^[a-f0-9]{64}$/.test(message.turn.conversationKey)) {
    throw new Error("Browser helper conversation key is invalid");
  }
  if (message.turn.compaction !== undefined && typeof message.turn.compaction !== "boolean") {
    throw new Error("Browser helper compaction flag is invalid");
  }
  if (message.turn.captureLunaCheckpoint !== undefined && typeof message.turn.captureLunaCheckpoint !== "boolean") {
    throw new Error("Browser helper Luna checkpoint flag is invalid");
  }
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    chatgptWeb: {
      appName: message.config.appName,
      browserHost: "launcher",
      browserHostDescriptorPath: message.config.browserHostDescriptorPath,
      browserDiagnosticsPath: message.config.browserDiagnosticsPath,
      turnTimeoutMs: message.config.turnTimeoutMs,
      autoApproveToolCalls: message.config.autoApproveToolCalls,
    },
  };
  const abortController = new AbortController();
  abortControllers.set(message.id, abortController);
  // The Codex MCP broker runs in the daemon process, so this mirror is the only way the worker can
  // observe that a turn is still executing while its ChatGPT DOM is unavailable. Trace ids are
  // derived deterministically and can repeat, so each run starts a fresh mirror rather than
  // inheriting revisions recorded for an earlier turn that happened to share the id.
  const progress = new ChatGptMirroredTurnProgress();
  turnProgress.set(message.id, progress);
  const promptSelection = createBrowserHelperPromptSelection();
  preparedSelections.set(message.id, promptSelection);
  const prepareSelected = async () => ({ ...await promptSelection.wait(), release: () => {} });
  const turn: BrowserTurn = {
    traceId: message.turn.traceId,
    modelId: message.turn.modelId,
    reasoning: message.turn.reasoning,
    capabilities: message.turn.capabilities,
    ...(message.turn.nativeConnector ? { nativeConnector: true } : {}),
    prepare: prepareSelected,
    ...(message.turn.resumeAvailable ? { prepareResume: prepareSelected } : {}),
    ...(message.turn.retainConversation ? { retainConversation: true } : {}),
    ...(message.turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
    ...(message.turn.conversationKey ? { conversationKey: message.turn.conversationKey } : {}),
    abortSignal: abortController.signal,
    ...(message.turn.compaction ? { compaction: true } : {}),
    externalProgress: progress,
    onHeartbeat: () => writeProtocol({ type: "event", id: message.id, event: "heartbeat" }),
    onPreparedSelected: reused => {
      if (!writeProtocol({ type: "event", id: message.id, event: "prepared_selected", reused })) {
        throw new Error("Browser helper could not request prompt selection");
      }
      return promptSelection.wait().then(() => undefined);
    },
    onSendActivated: () => new Promise<void>((resolve, reject) => {
      if (sendActivationWaiters.has(message.id)) {
        reject(new Error("Browser helper Send activation already awaits acknowledgement"));
        return;
      }
      sendActivationWaiters.set(message.id, { resolve, reject });
      if (!writeProtocol({ type: "event", id: message.id, event: "send_activated" })) {
        sendActivationWaiters.delete(message.id);
        reject(new Error("Browser helper could not request the Send activation boundary"));
      }
    }),
    onSubmitted: () => {
      if (!writeProtocol({ type: "event", id: message.id, event: "submitted" })) {
        throw new Error("Browser helper could not persist ChatGPT submission evidence");
      }
    },
    onReasoningSummary: (text, continuation) => writeProtocol({
      type: "event",
      id: message.id,
      event: "reasoning",
      text,
      ...(continuation ? { continuation: true } : {}),
    }),
    onCommentary: (text, continuation) => writeProtocol({ type: "event", id: message.id, event: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
    onTextDelta: text => writeProtocol({ type: "event", id: message.id, event: "text", text }),
    ...(message.turn.captureLunaCheckpoint ? {
      captureLunaCheckpoint: true,
      onLunaCheckpoint: captured => writeProtocol({
        type: "event",
        id: message.id,
        event: "luna_checkpoint",
        ...captured,
      }),
    } : {}),
  };
  try {
    const text = await ChatGptBrowserWorker.forProvider(provider).run(turn);
    writeProtocol({ type: "result", id: message.id, text });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof ChatGptWebAdapterError ? {
        status: error.status,
        errorType: error.errorType,
        code: error.code,
        retryable: error.retryable,
      } : {}),
    });
  } finally {
    preparedSelections.get(message.id)?.cancel();
    preparedSelections.delete(message.id);
    const sendWaiter = sendActivationWaiters.get(message.id);
    sendActivationWaiters.delete(message.id);
    sendWaiter?.reject(new DOMException("Browser helper turn ended before Send acknowledgement", "AbortError"));
    abortControllers.delete(message.id);
    turnProgress.delete(message.id);
  }
}

async function verify(message: VerifyMessage): Promise<void> {
  try {
    const selected = await maintenanceWorker(message).verifyConnector();
    writeProtocol({ type: "result", id: message.id, text: selected });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function maintenanceWorker(message: MaintenanceMessage): ChatGptBrowserWorker {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(message.id)) {
    throw new Error("Browser helper maintenance identity is invalid");
  }
  const appName = message.config.appName?.trim();
  const browserHostDescriptorPath = message.config.browserHostDescriptorPath?.trim();
  if (!appName || appName.length > 80 || !browserHostDescriptorPath) {
    throw new Error("Browser helper maintenance config is invalid");
  }
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    chatgptWeb: { appName, browserHost: "launcher", browserHostDescriptorPath },
  };
  return ChatGptBrowserWorker.forProvider(provider);
}

async function maintain(message: InspectMessage | SmokeMessage): Promise<void> {
  if (abortControllers.has(message.id)) throw new Error(`Browser helper maintenance operation already exists: ${message.id}`);
  const abortController = new AbortController();
  abortControllers.set(message.id, abortController);
  try {
    const worker = maintenanceWorker(message);
    const value = message.type === "inspect"
      ? await worker.inspectSession(message.detectCapabilities)
      : await worker.smokeTest(abortController.signal);
    writeProtocol({ type: "result", id: message.id, value });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    abortControllers.delete(message.id);
  }
}

const input = createInterface({ input: stdin, crlfDelay: Infinity });
input.on("line", line => {
  if (shuttingDown) return;
  let message: InputMessage;
  try { message = JSON.parse(line) as InputMessage; }
  catch {
    writeProtocol({ type: "error", id: "protocol", message: "Browser helper received invalid JSON" });
    return;
  }
  if (message.type === "prepared_selected_ack") {
    const prepared = message.prepared;
    if (!prepared || typeof prepared.text !== "string" || !Array.isArray(prepared.images)) {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper prompt selection is invalid" });
      abortControllers.get(message.id)?.abort();
      return;
    }
    if (prepared.multipart !== undefined) {
      const multipart = prepared.multipart;
      if (!multipart || !Array.isArray(multipart.parts)
        || (multipart.parts.length !== 2 && multipart.parts.length !== 3)
        || multipart.parts.some(part => typeof part !== "string")
        || typeof multipart.commit !== "string") {
        writeProtocol({ type: "error", id: message.id, message: "Browser helper multipart prompt is invalid" });
        abortControllers.get(message.id)?.abort();
        return;
      }
    }
    const selection = preparedSelections.get(message.id);
    if (!selection) {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper has no pending prompt selection" });
      return;
    }
    selection.select(prepared);
  } else if (message.type === "send_activation_ack") {
    const waiter = sendActivationWaiters.get(message.id);
    if (!waiter) {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper has no pending Send activation" });
      return;
    }
    sendActivationWaiters.delete(message.id);
    waiter.resolve();
  } else if (message.type === "progress") {
    // Progress is only meaningful for a turn this helper is actually running. Creating a mirror
    // for any unrecognised id let late, malformed, or misaddressed frames grow this map without
    // bound, since nothing would ever remove an entry that has no turn to end it.
    if (!abortControllers.has(message.id)) return;
    const progress = turnProgress.get(message.id) ?? new ChatGptMirroredTurnProgress();
    turnProgress.set(message.id, progress);
    try {
      progress.apply(message.snapshot);
    } catch (error) {
      // Progress is a liveness hint, never response content or completion. Failing the turn over a
      // malformed frame would destroy an accepted ChatGPT turn that cannot be resent, so the frame
      // is dropped and the turn falls back to DOM-only health, which is the behaviour it had
      // before this transport existed.
      diagnostic(
        `[chatgpt-web] discarded an invalid MCP progress frame for ${message.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (message.type === "abort") {
    abortControllers.get(message.id)?.abort();
    preparedSelections.get(message.id)?.cancel();
    const waiter = sendActivationWaiters.get(message.id);
    sendActivationWaiters.delete(message.id);
    waiter?.reject(new DOMException("Browser helper turn aborted before Send acknowledgement", "AbortError"));
  }
  else if (message.type === "shutdown") {
    void requestShutdown();
  } else if (message.type === "verify") {
    void verify(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  } else if (message.type === "inspect" || message.type === "smoke") {
    void maintain(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  } else if (message.type === "run") {
    void run(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  } else {
    // Never treat an unrecognised frame as a run. Doing so dereferenced `message.turn` on a frame
    // that has none, so a newer daemon speaking to an older helper destroyed the turn with an
    // opaque TypeError instead of degrading.
    writeProtocol({
      type: "error",
      id: (message as { id?: string }).id ?? "unknown",
      message: `Browser helper received an unsupported message type: ${String((message as { type?: unknown }).type)}`,
    });
  }
});
input.on("close", () => {
  void requestShutdown();
});
process.once("SIGINT", () => {
  void requestShutdown();
});
process.once("SIGTERM", () => {
  void requestShutdown();
});

// Advertise optional frames so a newer daemon can tell whether this helper understands them. An
// older helper omits the field, and the daemon then withholds those frames instead of breaking it.
writeProtocol({ type: "ready", features: ["progress"] });
