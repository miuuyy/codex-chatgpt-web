import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWriteFile, defaultChromeExecutable, expandUserPath, stripUtf8Bom } from "../config";

export const COPILOT_CONFIG_VERSION = 1;
export const COPILOT_HOME_ENV = "CODEX_COPILOT_WEB_HOME";
export const COPILOT_DEFAULT_PORT = 17842;
export const COPILOT_DEFAULT_MODEL = "copilot-web/auto";
export const COPILOT_URL = "https://copilot.cloud.microsoft/chat";

/**
 * The Copilot composer stops producing an answer when a message is around 128k characters
 * (measured against the compiled prompt, including the transport wrapper). Codex's context
 * counters are tokens, so expose a conservative token window that leaves room for the wrapper and
 * makes Codex compact before the character cap is reached.
 */
export const COPILOT_CONTEXT_WINDOW = 32_000;
export const COPILOT_AUTO_COMPACT_TOKEN_LIMIT = 24_000;
export const COPILOT_MAX_PROMPT_CHARS = 126_000;

export type CopilotReasoningLevel = "low" | "medium" | "high";

export interface CopilotReasoningOption {
  effort: CopilotReasoningLevel;
  description: string;
}

export interface CopilotModelConfig {
  /** Stable model slug exposed to Codex. */
  id: string;
  displayName: string;
  /** Exact label in Copilot's model picker. */
  menuLabel: string;
  description: string;
  contextWindow: number;
  autoCompactTokenLimit: number;
  defaultReasoningLevel: CopilotReasoningLevel;
  supportedReasoningLevels: CopilotReasoningOption[];
}

export interface CopilotBrowserConfig {
  /**
   * `persistent` launches a dedicated Chrome profile. `cdp` attaches to a Chrome instance the
   * user already started with --remote-debugging-port.
   */
  mode: "persistent" | "cdp";
  chromeExecutablePath: string;
  userDataDir: string;
  cdpUrl?: string;
  headed: boolean;
}

export interface CopilotConfig {
  version: typeof COPILOT_CONFIG_VERSION;
  host: "127.0.0.1";
  port: number;
  copilotUrl: string;
  browser: CopilotBrowserConfig;
  models: CopilotModelConfig[];
  turnTimeoutMs: number;
  loginTimeoutMs: number;
  sendTimeoutMs: number;
  responseStableMs: number;
  maxPromptChars: number;
  /** Start each Codex turn in a fresh Copilot conversation. */
  newChatPerTurn: boolean;
  /** Enable the text tool-call protocol used to relay Codex tools through Copilot. */
  toolProtocol: boolean;
  /** Optional bearer token required by the local Responses endpoint. */
  controlToken?: string;
}

export function getCopilotHome(): string {
  const configured = process.env[COPILOT_HOME_ENV]?.trim();
  return resolve(expandUserPath(configured || join(homedir(), ".codex-copilot-web")));
}

export function getCopilotConfigPath(): string {
  return join(getCopilotHome(), "config.json");
}

export function defaultCopilotModels(): CopilotModelConfig[] {
  return [
    {
      id: "copilot-web/auto",
      displayName: "Copilot Auto",
      menuLabel: "Auto",
      description: "Microsoft 365 Copilot chooses the model and effort for the turn.",
      contextWindow: COPILOT_CONTEXT_WINDOW,
      autoCompactTokenLimit: COPILOT_AUTO_COMPACT_TOKEN_LIMIT,
      defaultReasoningLevel: "medium",
      supportedReasoningLevels: [{ effort: "medium", description: "Automatic" }],
    },
    {
      id: "copilot-web/quick",
      displayName: "Copilot Quick Response",
      menuLabel: "Quick response",
      description: "Fast, lower-effort Copilot responses for small edits and simple questions.",
      contextWindow: COPILOT_CONTEXT_WINDOW,
      autoCompactTokenLimit: COPILOT_AUTO_COMPACT_TOKEN_LIMIT,
      defaultReasoningLevel: "low",
      supportedReasoningLevels: [{ effort: "low", description: "Quick response" }],
    },
    {
      id: "copilot-web/think-deeper",
      displayName: "Copilot Think Deeper",
      menuLabel: "Think deeper",
      description: "Extended reasoning for difficult coding and analysis tasks.",
      contextWindow: COPILOT_CONTEXT_WINDOW,
      autoCompactTokenLimit: COPILOT_AUTO_COMPACT_TOKEN_LIMIT,
      defaultReasoningLevel: "high",
      supportedReasoningLevels: [{ effort: "high", description: "Think deeper" }],
    },
    {
      id: "copilot-web/gpt",
      displayName: "Copilot GPT (OpenAI)",
      menuLabel: "GPT",
      description: "Uses the first model in Copilot's GPT (OpenAI) submenu; names vary by tenant.",
      contextWindow: COPILOT_CONTEXT_WINDOW,
      autoCompactTokenLimit: COPILOT_AUTO_COMPACT_TOKEN_LIMIT,
      defaultReasoningLevel: "medium",
      supportedReasoningLevels: [{ effort: "medium", description: "GPT (tenant-specific)" }],
    },
  ];
}

export function defaultCopilotConfig(): CopilotConfig {
  const home = getCopilotHome();
  return {
    version: COPILOT_CONFIG_VERSION,
    host: "127.0.0.1",
    port: COPILOT_DEFAULT_PORT,
    copilotUrl: COPILOT_URL,
    browser: {
      mode: "persistent",
      chromeExecutablePath: defaultChromeExecutable(),
      userDataDir: join(home, "chrome-profile"),
      headed: true,
    },
    models: defaultCopilotModels(),
    turnTimeoutMs: 15 * 60_000,
    loginTimeoutMs: 10 * 60_000,
    sendTimeoutMs: 30_000,
    responseStableMs: 3_000,
    maxPromptChars: COPILOT_MAX_PROMPT_CHARS,
    newChatPerTurn: true,
    toolProtocol: true,
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function booleanValue(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function stringValue(value: unknown, fallback: string, label: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function reasoningLevel(value: unknown, fallback: CopilotReasoningLevel, label: string): CopilotReasoningLevel {
  if (value === undefined) return fallback;
  if (value !== "low" && value !== "medium" && value !== "high") {
    throw new Error(`${label} must be low, medium, or high`);
  }
  return value;
}

function parseModel(value: unknown, index: number, defaults: CopilotModelConfig[]): CopilotModelConfig {
  const model = record(value, `models[${index}]`);
  const fallback = defaults[index] ?? defaults[0]!;
  const id = stringValue(model.id, fallback.id, `models[${index}].id`);
  if (!/^copilot-web\/[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    throw new Error(`models[${index}].id must start with copilot-web/`);
  }
  const supported = model.supportedReasoningLevels === undefined
    ? fallback.supportedReasoningLevels
    : (() => {
      if (!Array.isArray(model.supportedReasoningLevels) || model.supportedReasoningLevels.length === 0) {
        throw new Error(`models[${index}].supportedReasoningLevels must be a non-empty array`);
      }
      return model.supportedReasoningLevels.map((entry, levelIndex) => {
        const option = record(entry, `models[${index}].supportedReasoningLevels[${levelIndex}]`);
        return {
          effort: reasoningLevel(option.effort, "medium", `models[${index}].supportedReasoningLevels[${levelIndex}].effort`),
          description: stringValue(
            option.description,
            String(option.effort ?? "Reasoning"),
            `models[${index}].supportedReasoningLevels[${levelIndex}].description`,
          ),
        };
      });
    })();
  return {
    id,
    displayName: stringValue(model.displayName, fallback.displayName, `models[${index}].displayName`),
    menuLabel: stringValue(model.menuLabel, fallback.menuLabel, `models[${index}].menuLabel`),
    description: stringValue(model.description, fallback.description, `models[${index}].description`),
    contextWindow: positiveInteger(model.contextWindow, fallback.contextWindow, `models[${index}].contextWindow`),
    autoCompactTokenLimit: positiveInteger(
      model.autoCompactTokenLimit,
      fallback.autoCompactTokenLimit,
      `models[${index}].autoCompactTokenLimit`,
    ),
    defaultReasoningLevel: reasoningLevel(
      model.defaultReasoningLevel,
      fallback.defaultReasoningLevel,
      `models[${index}].defaultReasoningLevel`,
    ),
    supportedReasoningLevels: supported,
  };
}

export function parseCopilotConfig(value: unknown): CopilotConfig {
  const defaults = defaultCopilotConfig();
  const root = record(value, "Copilot config");
  if (root.version !== undefined && root.version !== COPILOT_CONFIG_VERSION) {
    throw new Error(`Unsupported Copilot config version: ${String(root.version)}`);
  }
  const browser = root.browser === undefined ? defaults.browser : record(root.browser, "browser");
  const mode = browser.mode === undefined ? defaults.browser.mode : browser.mode;
  if (mode !== "persistent" && mode !== "cdp") {
    throw new Error("browser.mode must be persistent or cdp");
  }
  const models = root.models === undefined
    ? defaults.models
    : (() => {
      if (!Array.isArray(root.models) || root.models.length === 0) {
        throw new Error("models must be a non-empty array");
      }
      return root.models.map((model, index) => parseModel(model, index, defaults.models));
    })();
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) throw new Error(`Duplicate Copilot model id: ${model.id}`);
    ids.add(model.id);
  }
  const config: CopilotConfig = {
    version: COPILOT_CONFIG_VERSION,
    host: "127.0.0.1",
    port: positiveInteger(root.port, defaults.port, "port"),
    copilotUrl: stringValue(root.copilotUrl, defaults.copilotUrl, "copilotUrl"),
    browser: {
      mode,
      chromeExecutablePath: stringValue(
        browser.chromeExecutablePath,
        defaults.browser.chromeExecutablePath,
        "browser.chromeExecutablePath",
      ),
      userDataDir: resolve(expandUserPath(stringValue(
        browser.userDataDir,
        defaults.browser.userDataDir,
        "browser.userDataDir",
      ))),
      ...(browser.cdpUrl === undefined
        ? {}
        : { cdpUrl: stringValue(browser.cdpUrl, defaults.browser.cdpUrl ?? "", "browser.cdpUrl") }),
      headed: booleanValue(browser.headed, defaults.browser.headed, "browser.headed"),
    },
    models,
    turnTimeoutMs: positiveInteger(root.turnTimeoutMs, defaults.turnTimeoutMs, "turnTimeoutMs"),
    loginTimeoutMs: positiveInteger(root.loginTimeoutMs, defaults.loginTimeoutMs, "loginTimeoutMs"),
    sendTimeoutMs: positiveInteger(root.sendTimeoutMs, defaults.sendTimeoutMs, "sendTimeoutMs"),
    responseStableMs: positiveInteger(root.responseStableMs, defaults.responseStableMs, "responseStableMs"),
    maxPromptChars: positiveInteger(root.maxPromptChars, defaults.maxPromptChars, "maxPromptChars"),
    newChatPerTurn: booleanValue(root.newChatPerTurn, defaults.newChatPerTurn, "newChatPerTurn"),
    toolProtocol: booleanValue(root.toolProtocol, defaults.toolProtocol, "toolProtocol"),
    ...(root.controlToken === undefined
      ? {}
      : { controlToken: stringValue(root.controlToken, "", "controlToken") }),
  };
  if (config.browser.mode === "cdp" && !config.browser.cdpUrl) {
    throw new Error("browser.cdpUrl is required when browser.mode is cdp");
  }
  if (config.port > 65_535) throw new Error("port must be at most 65535");
  return config;
}

export function loadCopilotConfig(options: { create?: boolean } = {}): CopilotConfig {
  const path = getCopilotConfigPath();
  if (!existsSync(path)) {
    const config = defaultCopilotConfig();
    if (options.create) saveCopilotConfig(config);
    return config;
  }
  return parseCopilotConfig(JSON.parse(stripUtf8Bom(readFileSync(path, "utf8"))));
}

export function saveCopilotConfig(config: CopilotConfig): void {
  atomicWriteFile(getCopilotConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

export function resolveCopilotModel(config: CopilotConfig, modelId: string): CopilotModelConfig {
  const model = config.models.find(candidate => candidate.id === modelId);
  if (!model) {
    const available = config.models.map(candidate => candidate.id).join(", ");
    throw new Error(`Unknown Copilot model ${JSON.stringify(modelId)}. Available models: ${available}`);
  }
  return model;
}
