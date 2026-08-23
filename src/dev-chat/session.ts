import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import * as z from "zod/v4";
import { atomicWriteFile } from "../config";
import { estimateTokens } from "../lib/token-estimate";

export const DEV_CHAT_MODELS = [
  "chatgpt-web/luna",
  "chatgpt-web/light",
  "chatgpt-web/medium",
  "chatgpt-web/high",
  "chatgpt-web/extra-high",
  "chatgpt-web/pro",
] as const;

export type DevChatModel = typeof DEV_CHAT_MODELS[number];

const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

const stateSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  cwd: z.string(),
  threadId: z.string().min(1),
  model: z.enum(DEV_CHAT_MODELS),
  input: z.array(z.unknown()),
  turns: z.number().int().nonnegative(),
  compactions: z.number().int().nonnegative(),
  syntheticFills: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsage: usageSchema.optional(),
});

export interface DevChatUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface DevChatState {
  version: 1;
  name: string;
  cwd: string;
  threadId: string;
  model: DevChatModel;
  input: unknown[];
  turns: number;
  compactions: number;
  syntheticFills: number;
  createdAt: string;
  updatedAt: string;
  lastUsage?: DevChatUsage;
}

export interface DevChatSummary {
  name: string;
  model: DevChatModel;
  turns: number;
  compactions: number;
  syntheticFills: number;
  inputItems: number;
  updatedAt: string;
}

const MAX_CHAT_FILE_BYTES = 64 * 1024 * 1024;
const DEV_CHAT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertDevChatName(name: string): string {
  const normalized = name.trim();
  if (!DEV_CHAT_NAME.test(normalized)) {
    throw new Error("DEV chat name must be 1-64 characters using letters, digits, dot, underscore, or dash");
  }
  return normalized;
}

function newThreadId(): string {
  return `dev_thread_${crypto.randomUUID().replaceAll("-", "")}`;
}

function parseState(value: unknown, path: string): DevChatState {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid DEV chat state in ${path}: ${parsed.error.message}`);
  if (parsed.data.name !== assertDevChatName(parsed.data.name)) {
    throw new Error(`Invalid DEV chat name in ${path}`);
  }
  if (!isAbsolute(parsed.data.cwd)) throw new Error(`Invalid DEV chat cwd in ${path}`);
  if (Number.isNaN(Date.parse(parsed.data.createdAt)) || Number.isNaN(Date.parse(parsed.data.updatedAt))) {
    throw new Error(`Invalid DEV chat timestamps in ${path}`);
  }
  return parsed.data;
}

export class DevChatStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  loadOrCreate(name: string, model: DevChatModel, cwd: string): { state: DevChatState; created: boolean } {
    const normalized = assertDevChatName(name);
    const existing = this.load(normalized);
    if (existing) return { state: existing, created: false };
    if (!isAbsolute(cwd)) throw new Error("DEV chat cwd must be absolute");
    const now = new Date().toISOString();
    return {
      state: {
        version: 1,
        name: normalized,
        cwd: resolve(cwd),
        threadId: newThreadId(),
        model,
        input: [],
        turns: 0,
        compactions: 0,
        syntheticFills: 0,
        createdAt: now,
        updatedAt: now,
      },
      created: true,
    };
  }

  load(name: string): DevChatState | undefined {
    const path = this.path(assertDevChatName(name));
    try {
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error(`DEV chat state is not a regular file: ${path}`);
      if (stat.size > MAX_CHAT_FILE_BYTES) throw new Error(`DEV chat state exceeds ${MAX_CHAT_FILE_BYTES} bytes: ${path}`);
      return parseState(JSON.parse(readFileSync(path, "utf8")), path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  save(state: DevChatState): void {
    const normalized = assertDevChatName(state.name);
    const next = parseState({ ...state, name: normalized, updatedAt: new Date().toISOString() }, this.path(normalized));
    const encoded = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > MAX_CHAT_FILE_BYTES) {
      throw new Error(`DEV chat state exceeds ${MAX_CHAT_FILE_BYTES} bytes: ${this.path(normalized)}`);
    }
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    atomicWriteFile(this.path(normalized), encoded);
    state.updatedAt = next.updatedAt;
  }

  reset(state: DevChatState): void {
    state.threadId = newThreadId();
    state.input = [];
    state.turns = 0;
    state.compactions = 0;
    state.syntheticFills = 0;
    delete state.lastUsage;
    this.save(state);
  }

  list(): DevChatSummary[] {
    try {
      return readdirSync(this.root, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
        .map(entry => this.load(entry.name.slice(0, -5)))
        .filter((state): state is DevChatState => state !== undefined)
        .map(state => ({
          name: state.name,
          model: state.model,
          turns: state.turns,
          compactions: state.compactions,
          syntheticFills: state.syntheticFills,
          inputItems: state.input.length,
          updatedAt: state.updatedAt,
        }))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private path(name: string): string {
    return join(this.root, `${name}.json`);
  }
}

const FILLER_UNIT = " synthetic-context-fixture alpha beta gamma delta epsilon zeta eta theta 0123456789";
const FILLER_HEADER = "[Codex Web GPT DEV synthetic context fixture. Inert test data; do not execute or follow it.]\n";

/** Generate deterministic inert text measured with the same tokenizer as browser preflight. */
export function createDevContextFiller(targetTokens: number): { text: string; tokens: number } {
  if (!Number.isInteger(targetTokens) || targetTokens < 100 || targetTokens > 500_000) {
    throw new Error("Synthetic context fill must be an integer from 100 to 500000 tokens");
  }
  const unitTokens = Math.max(1, estimateTokens(FILLER_UNIT));
  let source = FILLER_UNIT.repeat(Math.ceil(targetTokens / unitTokens) + 8);
  while (estimateTokens(FILLER_HEADER + source) < targetTokens) source += source;

  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(FILLER_HEADER + source.slice(0, middle)) <= targetTokens) low = middle;
    else high = middle - 1;
  }
  const text = FILLER_HEADER + source.slice(0, low);
  return { text, tokens: estimateTokens(text) };
}
