import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import {
  loadConfig,
  saveConfig,
  type AppConfig,
} from "./config";
import {
  parseChatGptWebProModelVersion,
  type ChatGptWebProModelVersion,
} from "./chatgpt-web-models";
import { readLauncherBrowserHostDescriptor } from "./launcher-browser-host";
import { assertServiceIdle } from "./service";

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

function updateProModelVersion(
  config: AppConfig,
  version: ChatGptWebProModelVersion | undefined,
): void {
  if (version === undefined) delete config.proModelVersion;
  else config.proModelVersion = version;
}

export async function runProModelVersionConfigCommand(args: string[]): Promise<void> {
  const action = args.shift();
  const rawVersion = args.shift();
  const launcherControlIndex = args.indexOf("--launcher-control");
  const launcherControl = launcherControlIndex >= 0;
  if (launcherControl) args.splice(launcherControlIndex, 1);
  if (action !== "pro-model-version" || !rawVersion || args.length > 0) {
    throw new Error("Config command must be: config pro-model-version <follow|5.6|5.5|6> --launcher-control");
  }
  let version: ChatGptWebProModelVersion | undefined;
  if (rawVersion !== "follow") {
    try {
      version = parseChatGptWebProModelVersion(rawVersion);
    } catch {
      throw new Error("Invalid Pro model version; choose follow, 5.6, 5.5, or 6");
    }
  }
  if (!launcherControl) {
    throw new Error("Pro model configuration must be changed through Codex Web GPT Settings");
  }
  const authorizedDescriptorPath = authorizeLauncherControl("Pro model configuration");
  const config = loadConfig();
  if (config.browserHost !== "launcher" || !config.browserHostDescriptorPath
    || resolve(config.browserHostDescriptorPath) !== resolve(authorizedDescriptorPath)) {
    throw new Error("Launcher authorization does not own this configuration");
  }
  await assertServiceIdle(config);
  updateProModelVersion(config, version);
  saveConfig(config);
  process.stdout.write(`${JSON.stringify({ proModelVersion: version ?? null })}\n`);
}
