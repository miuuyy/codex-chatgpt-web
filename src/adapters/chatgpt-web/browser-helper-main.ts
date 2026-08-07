import { createInterface } from "node:readline";
import { stdin, stderr, stdout } from "node:process";
import type { CodexProviderConfig } from "../../types";
import { ChatGptBrowserWorker, closeChatGptBrowserWorkers, type BrowserTurn } from "./browser-worker";
import type { ChatGptWebCapabilities } from "./model";
import { validateBrowserHelperPreparedPrompt } from "./browser-helper-prompt";
import { createProcessLineWriter } from "./process-line-writer";
import type { CompiledChatGptWebPrompt } from "./prompt";
import { isChatGptCapacityError } from "./capacity-error";
import { isChatGptTransientLimitError } from "./transient-limit-error";

interface RunMessage {
  type: "run";
  id: string;
  config: {
    appName: string;
    browserHostDescriptorPath: string;
    autoApproveToolCalls: boolean;
  };
  turn: {
    traceId: string;
    modelId: string;
    reasoning?: string;
    capabilities: ChatGptWebCapabilities;
    prepared: CompiledChatGptWebPrompt;
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

type InputMessage = RunMessage | VerifyMessage | { type: "abort"; id: string } | { type: "shutdown" };

let outputFailure: Error | undefined;
const handleOutputFailure = (error: Error): void => {
  if (outputFailure) return;
  outputFailure = error;
  void requestShutdown();
};
const protocolOutput = createProcessLineWriter(stdout, handleOutputFailure);
const diagnosticOutput = createProcessLineWriter(stderr, handleOutputFailure);

const writeProtocol = (message: unknown): void => {
  protocolOutput.write(JSON.stringify(message));
};

const writeProtocolError = (id: string, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  writeProtocol({
    type: "error",
    id,
    name: error instanceof Error ? error.name : "Error",
    message,
    ...(isChatGptTransientLimitError(error) ? {
      code: error.code,
      stage: error.stage,
      dismissals: error.dismissals,
    } : isChatGptCapacityError(error) ? {
      code: error.code,
      stage: error.stage,
    } : {}),
  });
};

const diagnostic = (...values: unknown[]): void => {
  diagnosticOutput.write(values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
};
console.info = diagnostic;
console.warn = diagnostic;
console.error = diagnostic;

const abortControllers = new Map<string, AbortController>();
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
  const prepared = validateBrowserHelperPreparedPrompt(message.turn.prepared);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    chatgptWeb: {
      appName: message.config.appName,
      browserHost: "launcher",
      browserHostDescriptorPath: message.config.browserHostDescriptorPath,
      autoApproveToolCalls: message.config.autoApproveToolCalls,
    },
  };
  const abortController = new AbortController();
  abortControllers.set(message.id, abortController);
  const turn: BrowserTurn = {
    traceId: message.turn.traceId,
    modelId: message.turn.modelId,
    reasoning: message.turn.reasoning,
    capabilities: message.turn.capabilities,
    prepare: async () => ({ ...prepared, release: () => {} }),
    abortSignal: abortController.signal,
    onHeartbeat: () => writeProtocol({ type: "event", id: message.id, event: "heartbeat" }),
    onReasoningSummary: (text, continuation) => writeProtocol({
      type: "event",
      id: message.id,
      event: "reasoning",
      text,
      ...(continuation ? { continuation: true } : {}),
    }),
    onCommentary: (text, continuation) => writeProtocol({ type: "event", id: message.id, event: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
    onTextDelta: text => writeProtocol({ type: "event", id: message.id, event: "text", text }),
  };
  try {
    const text = await ChatGptBrowserWorker.forProvider(provider).run(turn);
    writeProtocol({ type: "result", id: message.id, text });
  } catch (error) {
    writeProtocolError(message.id, error);
  } finally {
    abortControllers.delete(message.id);
  }
}

async function verify(message: VerifyMessage): Promise<void> {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(message.id)) {
    throw new Error("Browser helper verification identity is invalid");
  }
  const appName = message.config.appName?.trim();
  const browserHostDescriptorPath = message.config.browserHostDescriptorPath?.trim();
  if (!appName || appName.length > 80 || !browserHostDescriptorPath) {
    throw new Error("Browser helper verification config is invalid");
  }
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    chatgptWeb: {
      appName,
      browserHost: "launcher",
      browserHostDescriptorPath,
    },
  };
  try {
    const selected = await ChatGptBrowserWorker.forProvider(provider).verifyConnector();
    writeProtocol({ type: "result", id: message.id, text: selected });
  } catch (error) {
    writeProtocolError(message.id, error);
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
  if (message.type === "abort") abortControllers.get(message.id)?.abort();
  else if (message.type === "shutdown") {
    void requestShutdown();
  } else if (message.type === "verify") {
    void verify(message).catch(error => writeProtocolError(message.id, error));
  } else {
    void run(message).catch(error => writeProtocolError(message.id, error));
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

writeProtocol({ type: "ready" });
