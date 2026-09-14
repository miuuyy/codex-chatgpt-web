import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import {
  parseChatGptWebCompactionModel,
  type ChatGptWebCompactionModel,
} from "./chatgpt-web-compaction-policy";
import { loadConfig, saveConfig } from "./config";
import { readLauncherBrowserHostDescriptor } from "./launcher-browser-host";

export function authorizeLauncherControl(operation: string): string {
  const descriptorPath = process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR?.trim();
  const supplied = process.env.CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN?.trim();
  delete process.env.CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN;
  if (!descriptorPath || !supplied) {
    throw new Error(`Launcher-controlled ${operation} requires a live launcher authorization`);
  }
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const expectedBytes = Buffer.from(descriptor.control.token);
  const suppliedBytes = Buffer.from(supplied);
  if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
    throw new Error(`Launcher-controlled ${operation} authorization is invalid`);
  }
  return descriptorPath;
}

export async function runCompactionModelConfigCommand(args: string[]): Promise<void> {
  const [action, rawModel, ...rest] = args;
  if (action !== "compaction-model" || !rawModel || rest.length > 1) {
    throw new Error(
      "Config command must be: config compaction-model <follow|extra-high|5.6-pro|5.5-pro> --launcher-control",
    );
  }
  if (rest[0] !== "--launcher-control") {
    throw new Error("Compaction model must be changed through Codex Web GPT Settings");
  }

  let model: ChatGptWebCompactionModel | undefined;
  if (rawModel !== "follow") {
    try {
      model = parseChatGptWebCompactionModel(rawModel);
    } catch {
      throw new Error("Invalid compaction model; choose follow, extra-high, 5.6-pro, or 5.5-pro");
    }
  }

  const authorizedDescriptorPath = authorizeLauncherControl("compaction model configuration");
  const config = loadConfig();
  if (config.browserHost !== "launcher" || !config.browserHostDescriptorPath
    || resolve(config.browserHostDescriptorPath) !== resolve(authorizedDescriptorPath)) {
    throw new Error("Launcher authorization does not own this configuration");
  }

  // The daemon samples this value when the next eligible compaction starts.
  if (model === undefined) delete config.compactionModel;
  else config.compactionModel = model;
  saveConfig(config);
  process.stdout.write(`${JSON.stringify({ compactionModel: model ?? null })}\n`);
}
