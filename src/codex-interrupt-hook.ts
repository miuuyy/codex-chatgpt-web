import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import type { AppConfig } from "./config";
import { getConfigDir } from "./config";
import type { InstalledCodexInterruptHook } from "./codex-integration-shared";

export const MANAGED_INTERRUPT_HOOK_START =
  "# Managed by codex-chatgpt-web: release the exact Responses request when its Codex turn is interrupted.";
export const MANAGED_INTERRUPT_HOOK_END =
  "# End codex-chatgpt-web interrupt lifecycle hook.";
export const MANAGED_INTERRUPT_HOOK_TRUST_START =
  "# Managed by codex-chatgpt-web: trust the Interrupt hook defined in hooks.json.";
export const MANAGED_INTERRUPT_HOOK_TRUST_END =
  "# End codex-chatgpt-web JSON interrupt hook trust state.";

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
}

/** Match codex_config::version_for_toml for the normalized Interrupt command hook. */
export function codexInterruptHookHash(command: string): string {
  const identity = canonicalJson({
    event_name: "interrupt",
    hooks: [{
      type: "command",
      command,
      timeout: 3,
      async: false,
    }],
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function posixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function cmdShellArgument(value: string): string {
  if (value.includes('"') || /[\r\n]/.test(value)) {
    throw new Error("Codex interrupt hook command contains an invalid Windows path character");
  }
  // Codex executes command hooks through cmd.exe /C on Windows. Quoting every argument preserves
  // spaces and shell metacharacters in the installed runtime path.
  return `"${value}"`;
}

export function codexInterruptHookCommand(
  config: Pick<AppConfig, "runtimeCommand">,
  home = getConfigDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const absoluteHome = platform === "win32" ? win32.resolve(home) : posix.resolve(home);
  const args = [...config.runtimeCommand, "--home", absoluteHome, "hook", "interrupt"];
  return args.map(platform === "win32" ? cmdShellArgument : posixShellArgument).join(" ");
}

function lineEnding(text: string): "\n" | "\r\n" | "\r" {
  return text.includes("\r\n") ? "\r\n" : text.includes("\n") ? "\n" : text.includes("\r") ? "\r" : "\n";
}

function interruptGroupCount(text: string): number {
  return text.split(/\r\n|\n|\r/).filter(line => /^\s*\[\[hooks\.Interrupt\]\]\s*(?:#.*)?$/.test(line)).length;
}

function managedMarkerCount(text: string): number {
  return text.split(MANAGED_INTERRUPT_HOOK_START).length - 1;
}

function canonicalConfigPath(configPath: string): string {
  const absolute = resolve(configPath);
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return join(realpathSync.native(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

export function codexInterruptHookStateKey(path: string, groupIndex: number, hookIndex: number): string {
  return `${canonicalConfigPath(path)}:interrupt:${groupIndex}:${hookIndex}`;
}

export function codexJsonInterruptHookStateKey(path: string, groupIndex: number, hookIndex: number): string {
  const absolute = resolve(path);
  let sourcePath = absolute;
  try {
    sourcePath = join(realpathSync.native(dirname(absolute)), basename(absolute));
  } catch {
    // Codex uses the canonical hooks directory when it exists, but must also support first-time paths.
  }
  return `${sourcePath}:interrupt:${groupIndex}:${hookIndex}`;
}

export function installCodexInterruptHook(
  text: string,
  configPath: string,
  config: Pick<AppConfig, "runtimeCommand">,
): { text: string; installed: InstalledCodexInterruptHook } {
  return installCodexInterruptHookCommand(text, configPath, codexInterruptHookCommand(config));
}

export function installCodexInterruptHookCommand(
  text: string,
  configPath: string,
  command: string,
): { text: string; installed: InstalledCodexInterruptHook } {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex config already contains a codex-chatgpt-web interrupt hook marker");
  }
  const groupIndex = interruptGroupCount(text);
  const stateKey = codexInterruptHookStateKey(configPath, groupIndex, 0);
  const trustedHash = codexInterruptHookHash(command);
  const ending = lineEnding(text);
  const core = [
    MANAGED_INTERRUPT_HOOK_START,
    "[[hooks.Interrupt]]",
    "",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    "timeout = 3",
    "",
    `[hooks.state.${JSON.stringify(stateKey)}]`,
    `trusted_hash = ${JSON.stringify(trustedHash)}`,
    MANAGED_INTERRUPT_HOOK_END,
  ].join(ending);
  const leading = text.length === 0
    ? ""
    : text.endsWith(`${ending}${ending}`)
      ? ""
      : text.endsWith(ending)
        ? ending
        : `${ending}${ending}`;
  const trailing = text.length > 0 && text.endsWith(ending) ? ending : "";
  const fragment = `${leading}${core}${trailing}`;
  return {
    text: `${text}${fragment}`,
    installed: { command, groupIndex, stateKey, trustedHash, fragment },
  };
}

export interface InstalledCodexInterruptHookTrust {
  stateKey: string;
  trustedHash: string;
  fragment: string;
}

export function installCodexInterruptHookTrust(
  text: string,
  stateKey: string,
  trustedHash: string,
): { text: string; installed: InstalledCodexInterruptHookTrust } {
  if (text.includes(MANAGED_INTERRUPT_HOOK_TRUST_START) || text.includes(MANAGED_INTERRUPT_HOOK_TRUST_END)) {
    throw new Error("Codex config already contains a codex-chatgpt-web JSON interrupt hook trust marker");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(trustedHash)) {
    throw new Error("Codex JSON interrupt hook trust hash is invalid");
  }
  const ending = lineEnding(text);
  const core = [
    MANAGED_INTERRUPT_HOOK_TRUST_START,
    `[hooks.state.${JSON.stringify(stateKey)}]`,
    `trusted_hash = ${JSON.stringify(trustedHash)}`,
    MANAGED_INTERRUPT_HOOK_TRUST_END,
  ].join(ending);
  const leading = text.length === 0
    ? ""
    : text.endsWith(`${ending}${ending}`)
      ? ""
      : text.endsWith(ending)
        ? ending
        : `${ending}${ending}`;
  const trailing = text.length > 0 && text.endsWith(ending) ? ending : "";
  const fragment = `${leading}${core}${trailing}`;
  return { text: `${text}${fragment}`, installed: { stateKey, trustedHash, fragment } };
}

function locateCodexInterruptHookTrust(text: string, installed: InstalledCodexInterruptHookTrust): {
  ranges: Array<{ start: number; end: number }>;
} {
  if (!installed.stateKey || !/^sha256:[a-f0-9]{64}$/.test(installed.trustedHash) || !installed.fragment) {
    throw new Error("Codex JSON interrupt hook trust journal entry is invalid");
  }
  const ending = lineEnding(text);
  const lineRanges = (line: string, allowComment = false): Array<{ start: number; end: number }> => {
    const suffix = allowComment ? "[ \\t]*(?:#.*)?" : "";
    const pattern = new RegExp(`(^|\\r\\n|\\n|\\r)${line.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}${suffix}(?=\\r\\n|\\n|\\r|$)`, "g");
    return [...text.matchAll(pattern)].map(match => {
      const start = match.index! + (match[1]?.length ?? 0);
      const lineEnd = start + match[0].length - (match[1]?.length ?? 0);
      return { start, end: text.startsWith(ending, lineEnd) ? lineEnd + ending.length : lineEnd };
    });
  };
  const lineRange = (line: string): { start: number; end: number } | undefined => {
    const matches = lineRanges(line);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const startMarker = lineRange(MANAGED_INTERRUPT_HOOK_TRUST_START);
  const endMarker = lineRange(MANAGED_INTERRUPT_HOOK_TRUST_END);
  if (!startMarker || !endMarker) {
    throw new Error("Codex JSON interrupt hook trust changed after setup; refusing to overwrite it");
  }
  let parsed: { hooks?: { state?: Record<string, unknown> } };
  try {
    parsed = Bun.TOML.parse(text) as { hooks?: { state?: Record<string, unknown> } };
    if (JSON.stringify(canonicalJson(parsed.hooks?.state?.[installed.stateKey]))
      !== JSON.stringify({ trusted_hash: installed.trustedHash })) {
      throw new Error("Trust state changed");
    }
  } catch {
    throw new Error("Codex JSON interrupt hook trust changed after setup; refusing to overwrite it");
  }
  const markerPreservesTomlValues = (marker: { start: number; end: number }): boolean => {
    try {
      const withoutMarker = text.slice(0, marker.start) + text.slice(marker.end);
      return JSON.stringify(canonicalJson(Bun.TOML.parse(text)))
        === JSON.stringify(canonicalJson(Bun.TOML.parse(withoutMarker)));
    } catch {
      return false;
    }
  };
  if (!markerPreservesTomlValues(startMarker) || !markerPreservesTomlValues(endMarker)) {
    throw new Error("Codex JSON interrupt hook trust changed after setup; refusing to overwrite it");
  }
  const stateHeaders = lineRanges(`[hooks.state.${JSON.stringify(installed.stateKey)}]`, true);
  const trustedHashes = lineRanges(`trusted_hash = ${JSON.stringify(installed.trustedHash)}`, true);
  const expected = structuredClone(parsed) as { hooks?: { state?: Record<string, unknown> } };
  delete expected.hooks?.state?.[installed.stateKey];
  const expectedValues = [expected];
  if (expected.hooks?.state && Object.keys(expected.hooks.state).length === 0) {
    const withoutState = structuredClone(expected) as { hooks?: { state?: Record<string, unknown> } };
    delete withoutState.hooks?.state;
    expectedValues.push(withoutState);
    if (withoutState.hooks && Object.keys(withoutState.hooks).length === 0) {
      const withoutHooks = structuredClone(withoutState);
      delete withoutHooks.hooks;
      expectedValues.push(withoutHooks);
    }
  }
  const stateTable = stateHeaders.flatMap(header => trustedHashes
    .filter(hash => hash.start === header.end)
    .filter(hash => {
      try {
        const withoutTable = text.slice(0, header.start) + text.slice(hash.end);
        const actual = JSON.stringify(canonicalJson(Bun.TOML.parse(withoutTable)));
        return expectedValues.some(expectedValue => actual === JSON.stringify(canonicalJson(expectedValue)));
      } catch {
        return false;
      }
    })
    .map(hash => ({ header, hash })));
  if (stateTable.length !== 1) {
    throw new Error("Codex JSON interrupt hook trust changed after setup; refusing to overwrite it");
  }
  const { header: stateHeader, hash: trustedHash } = stateTable[0]!;
  const adjustedStart = startMarker.start >= ending.length * 2
    && text.startsWith(ending, startMarker.start - ending.length)
    && text.startsWith(ending, startMarker.start - ending.length * 2)
    ? startMarker.start - ending.length
    : startMarker.start;
  const rawRanges = [
    { start: adjustedStart, end: startMarker.end },
    { start: stateHeader.start, end: trustedHash.end },
    endMarker,
  ].sort((left, right) => left.start - right.start);
  const ranges = rawRanges.reduce<Array<{ start: number; end: number }>>((merged, range) => {
    const previous = merged.at(-1);
    if (!previous || range.start >= previous.end) {
      merged.push({ ...range });
      return merged;
    }
    if (range.start < previous.end - ending.length) {
      throw new Error("Codex JSON interrupt hook trust changed after setup; refusing to overwrite it");
    }
    previous.end = Math.max(previous.end, range.end);
    return merged;
  }, []);
  return { ranges };
}

export function verifyCodexInterruptHookTrust(text: string, installed: InstalledCodexInterruptHookTrust): void {
  locateCodexInterruptHookTrust(text, installed);
}

export function restoreCodexInterruptHookTrust(text: string, installed: InstalledCodexInterruptHookTrust): string {
  const owned = locateCodexInterruptHookTrust(text, installed);
  return owned.ranges.sort((left, right) => right.start - left.start)
    .reduce((restored, range) => restored.slice(0, range.start) + restored.slice(range.end), text);
}

export function verifyCodexInterruptHookTrustRestored(text: string): void {
  if (text.includes(MANAGED_INTERRUPT_HOOK_TRUST_START) || text.includes(MANAGED_INTERRUPT_HOOK_TRUST_END)) {
    throw new Error("Codex JSON interrupt hook trust state is present while the bridge is disconnected");
  }
}

function hookTextPattern(text: string): string {
  return text.split(/\r\n|\n|\r/)
    .map(line => line.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join("(?:\\r\\n|\\n|\\r)");
}

function locateCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): Array<{
  start: number; end: number;
}> {
  const marker = installed.fragment.indexOf(MANAGED_INTERRUPT_HOOK_END);
  if (marker < 0) throw new Error("Codex interrupt lifecycle hook journal fragment is invalid");
  const ownedPrefix = installed.fragment.slice(0, marker);
  // Native config writes normalize CRLF to LF; commands and owned fields must still match exactly.
  const pattern = new RegExp(hookTextPattern(ownedPrefix), "g");
  const match = pattern.exec(text);
  if (!match || pattern.exec(text)) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  const first = match.index;
  const ownedEnd = first + match[0].length;
  if (interruptGroupCount(text.slice(0, first)) !== installed.groupIndex) {
    throw new Error("Codex interrupt lifecycle hook order changed after setup; refusing to overwrite it");
  }
  const endMarker = text.indexOf(MANAGED_INTERRUPT_HOOK_END);
  if (managedMarkerCount(text) !== 1 || endMarker < 0
    || (endMarker >= first && endMarker < ownedEnd)
    || text.split(MANAGED_INTERRUPT_HOOK_END).length !== 2) {
    throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
  }
  if (endMarker < first) {
    // A moved comment is independent of the owned definitions. Prove it is still a comment,
    // rather than matching text inside an unrelated TOML value, before removing it separately.
    const precedingConfig = text.slice(0, first);
    const withoutMarker = precedingConfig.slice(0, endMarker)
      + precedingConfig.slice(endMarker + MANAGED_INTERRUPT_HOOK_END.length);
    try {
      if (JSON.stringify(canonicalJson(Bun.TOML.parse(precedingConfig)))
        !== JSON.stringify(canonicalJson(Bun.TOML.parse(withoutMarker)))) {
        throw new Error("Marker removal changes TOML values");
      }
    } catch {
      throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
    }
  }
  if (codexInterruptHookHash(installed.command) !== installed.trustedHash) {
    throw new Error("Codex interrupt lifecycle hook journal hash is invalid");
  }
  // Codex's TOML editor inserts new tables before trailing comments. The end marker can therefore
  // move past unrelated config even though the owned hook fields remain unchanged.
  const appendedConfig = text.slice(ownedEnd, endMarker < first ? undefined : endMarker);
  const firstAssignment = appendedConfig.split(/\r\n|\n|\r/)
    .map(line => line.trim()).find(line => line && !line.startsWith("#"));
  if (firstAssignment && !/^\[\[?.+\]\]?(?:\s*#.*)?$/.test(firstAssignment)) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  if (firstAssignment) {
    // A later table can also extend the owned hook or trust state. Compare those exact
    // definitions with Bun's TOML parser before treating the inserted tables as unrelated.
    const ownedDefinitions = (fragment: string): string => {
      const { hooks } = Bun.TOML.parse(fragment) as {
        hooks: { Interrupt: unknown[]; state: Record<string, unknown> };
      };
      return JSON.stringify(canonicalJson([hooks.Interrupt[0], hooks.state[installed.stateKey]]));
    };
    try {
      if (ownedDefinitions(ownedPrefix) !== ownedDefinitions(ownedPrefix + appendedConfig)) {
        throw new Error("Modified owned definitions");
      }
    } catch {
      throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
    }
  }
  const end = endMarker + MANAGED_INTERRUPT_HOOK_END.length;
  const trailing = installed.fragment.slice(marker + MANAGED_INTERRUPT_HOOK_END.length);
  const trailingLength = new RegExp("^" + hookTextPattern(trailing)).exec(text.slice(end))?.[0].length ?? 0;
  return [{ start: first, end: ownedEnd }, { start: endMarker, end: end + trailingLength }];
}

export function verifyCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): void {
  locateCodexInterruptHook(text, installed);
}

export function restoreCodexInterruptHook(
  text: string,
  installed: InstalledCodexInterruptHook,
  options: { allowAbsent?: boolean } = {},
): string {
  // Explicit Setup can reinstall a fully removed hook. A stale journal alone does not mean
  // there is still a definition to remove; partial edits must retain the strict checks below.
  if (options.allowAbsent && managedMarkerCount(text) === 0 && !text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    const { hooks } = Bun.TOML.parse(text) as { hooks?: unknown };
    if (hooks === undefined) return text;
    if (hooks && typeof hooks === "object" && !Array.isArray(hooks) && !Object.hasOwn(hooks, "Interrupt")) {
      const state = (hooks as Record<string, unknown>).state;
      if (state === undefined || (state && typeof state === "object" && !Array.isArray(state)
        && !Object.hasOwn(state, installed.stateKey))) return text;
    }
  }
  const owned = locateCodexInterruptHook(text, installed).sort((left, right) => right.start - left.start);
  for (const range of owned) text = text.slice(0, range.start) + text.slice(range.end);
  return text;
}

export function verifyCodexInterruptHookRestored(text: string): void {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex interrupt lifecycle hook is present while the bridge is disconnected");
  }
}
