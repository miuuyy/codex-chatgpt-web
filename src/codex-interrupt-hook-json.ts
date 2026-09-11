import { createHash } from "node:crypto";

type JsonObject = Record<string, unknown>;

export interface InstalledCodexInterruptHookJson {
  mode: "json";
  command: string;
  groupIndex: number;
  hookIndex: number;
  entryHash: string;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
}

function unsupportedShape(message: string): never {
  throw new Error(`Codex hooks.json has an unsupported shape: ${message}`);
}

function parseHooksJson(text: string): JsonObject {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error("Codex hooks.json is malformed JSON");
  }
  if (!isJsonObject(document)) {
    unsupportedShape("the root value must be an object");
  }
  if (document.hooks === undefined) {
    return document;
  }
  if (!isJsonObject(document.hooks)) {
    unsupportedShape("hooks must be an object");
  }
  for (const [eventName, groups] of Object.entries(document.hooks)) {
    if (!Array.isArray(groups)) {
      unsupportedShape(`hooks.${eventName} must be an array`);
    }
    for (const group of groups) {
      if (!isJsonObject(group)) {
        unsupportedShape(`hooks.${eventName} groups must be objects`);
      }
      if (!Array.isArray(group.hooks)) {
        unsupportedShape(`hooks.${eventName} groups must contain a hooks array`);
      }
      for (const hook of group.hooks) {
        if (!isJsonObject(hook) || typeof hook.type !== "string") {
          unsupportedShape(`hooks.${eventName} hook entries must have a string type`);
        }
        if (hook.type === "command" && (typeof hook.command !== "string" || hook.command.length === 0)) {
          unsupportedShape(`hooks.${eventName} command hook entries must have a non-empty command`);
        }
        if (hook.timeout !== undefined && (typeof hook.timeout !== "number" || !Number.isFinite(hook.timeout))) {
          unsupportedShape(`hooks.${eventName} hook entry timeouts must be finite numbers`);
        }
      }
    }
  }
  return document;
}

function interruptGroups(document: JsonObject): JsonObject[] | undefined {
  if (document.hooks === undefined) {
    return undefined;
  }
  const hooks = document.hooks as JsonObject;
  if (hooks.Interrupt === undefined) {
    return undefined;
  }
  return hooks.Interrupt as JsonObject[];
}

function commandEntry(command: string): JsonObject {
  return { type: "command", command, timeout: 3 };
}

function entryHash(entry: JsonObject): string {
  const serialized = JSON.stringify(canonicalJson(entry));
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function serializeHooksJson(document: JsonObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function assertInstalledRecord(installed: InstalledCodexInterruptHookJson): void {
  if (
    installed.mode !== "json"
    || typeof installed.command !== "string"
    || installed.command.length === 0
    || !Number.isSafeInteger(installed.groupIndex)
    || installed.groupIndex < 0
    || !Number.isSafeInteger(installed.hookIndex)
    || installed.hookIndex < 0
    || !/^sha256:[a-f0-9]{64}$/.test(installed.entryHash)
  ) {
    throw new Error("Codex JSON interrupt hook journal entry is invalid");
  }
  if (entryHash(commandEntry(installed.command)) !== installed.entryHash) {
    throw new Error("Codex JSON interrupt hook journal entry does not match its command");
  }
}

function locateInstalledHook(
  text: string,
  installed: InstalledCodexInterruptHookJson,
): { document: JsonObject; groups: JsonObject[]; hooks: JsonObject[] } {
  assertInstalledRecord(installed);
  const document = parseHooksJson(text);
  const groups = interruptGroups(document);
  if (!groups || installed.groupIndex >= groups.length) {
    throw new Error("Codex JSON interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  const group = groups[installed.groupIndex];
  const hooks = group.hooks as JsonObject[];
  if (installed.hookIndex >= hooks.length || entryHash(hooks[installed.hookIndex]) !== installed.entryHash) {
    throw new Error("Codex JSON interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  const occurrences = groups.flatMap(candidate => candidate.hooks as JsonObject[])
    .filter(candidate => entryHash(candidate) === installed.entryHash).length;
  if (occurrences !== 1) {
    throw new Error("Codex JSON interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  return { document, groups, hooks };
}

export function installCodexInterruptHookJson(
  text: string,
  command: string,
): { text: string; installed: InstalledCodexInterruptHookJson } {
  if (command.length === 0) {
    throw new Error("Codex JSON interrupt hook command must not be empty");
  }
  const document = parseHooksJson(text);
  const existingGroups = interruptGroups(document) ?? [];
  const groupIndex = existingGroups.length;
  for (const group of existingGroups) {
    for (const hook of group.hooks as JsonObject[]) {
      if (hook.type === "command" && hook.command === command) {
        throw new Error("Codex hooks.json already contains this codex-chatgpt-web interrupt command hook");
      }
    }
  }
  const entry = commandEntry(command);
  const group = { hooks: [entry] };
  if (document.hooks === undefined) {
    document.hooks = { Interrupt: [group] };
  } else {
    const hooks = document.hooks as JsonObject;
    if (hooks.Interrupt === undefined) {
      hooks.Interrupt = [group];
    } else {
      (hooks.Interrupt as JsonObject[]).push(group);
    }
  }
  return {
    text: serializeHooksJson(document),
    installed: {
      mode: "json",
      command,
      groupIndex,
      hookIndex: 0,
      entryHash: entryHash(entry),
    },
  };
}

export function verifyCodexInterruptHookJson(
  text: string,
  installed: InstalledCodexInterruptHookJson,
): void {
  locateInstalledHook(text, installed);
}

export function restoreCodexInterruptHookJson(
  text: string,
  installed: InstalledCodexInterruptHookJson,
): string {
  const { document, groups, hooks } = locateInstalledHook(text, installed);
  hooks.splice(installed.hookIndex, 1);
  const group = groups[installed.groupIndex];
  if (hooks.length === 0 && Object.keys(group).length === 1) {
    groups.splice(installed.groupIndex, 1);
  }
  if (groups.length === 0) {
    const hookDefinitions = document.hooks as JsonObject;
    delete hookDefinitions.Interrupt;
    if (Object.keys(hookDefinitions).length === 0) {
      delete document.hooks;
    }
  }
  return serializeHooksJson(document);
}
