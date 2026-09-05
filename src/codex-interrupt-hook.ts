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

function managedEndMarkerCount(text: string): number {
  return text.split(MANAGED_INTERRUPT_HOOK_END).length - 1;
}

function managedHookOwnedPrefix(
  installed: InstalledCodexInterruptHook,
  ending: "\n" | "\r\n" | "\r",
): string {
  return [
    MANAGED_INTERRUPT_HOOK_START,
    "[[hooks.Interrupt]]",
    "",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(installed.command)}`,
    "timeout = 3",
    "",
    `[hooks.state.${JSON.stringify(installed.stateKey)}]`,
    `trusted_hash = ${JSON.stringify(installed.trustedHash)}`,
  ].join(ending);
}

function locateCodexInterruptHook(
  text: string,
  installed: InstalledCodexInterruptHook,
): { start: number; ownedEnd: number; endMarkerStart: number; endMarkerEnd: number } {
  if (managedMarkerCount(text) !== 1 || managedEndMarkerCount(text) !== 1) {
    throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
  }
  const start = text.indexOf(MANAGED_INTERRUPT_HOOK_START);
  const ownedPrefix = managedHookOwnedPrefix(installed, lineEnding(text));
  if (start < 0 || !text.startsWith(ownedPrefix, start)) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  if (interruptGroupCount(text.slice(0, start)) !== installed.groupIndex) {
    throw new Error("Codex interrupt lifecycle hook order changed after setup; refusing to overwrite it");
  }
  const ownedEnd = start + ownedPrefix.length;
  const endMarkerStart = text.indexOf(MANAGED_INTERRUPT_HOOK_END, ownedEnd);
  if (endMarkerStart < ownedEnd) {
    throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
  }
  if (codexInterruptHookHash(installed.command) !== installed.trustedHash) {
    throw new Error("Codex interrupt lifecycle hook journal hash is invalid");
  }
  return {
    start,
    ownedEnd,
    endMarkerStart,
    endMarkerEnd: endMarkerStart + MANAGED_INTERRUPT_HOOK_END.length,
  };
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
  const stateKey = `${canonicalConfigPath(configPath)}:interrupt:${groupIndex}:0`;
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

export function verifyCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): void {
  locateCodexInterruptHook(text, installed);
}

export function restoreCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): string {
  const exact = text.indexOf(installed.fragment);
  if (exact >= 0 && text.indexOf(installed.fragment, exact + installed.fragment.length) < 0) {
    verifyCodexInterruptHook(text, installed);
    return text.replace(installed.fragment, "");
  }

  const located = locateCodexInterruptHook(text, installed);
  const fragmentStart = installed.fragment.indexOf(MANAGED_INTERRUPT_HOOK_START);
  const fragmentEnd = installed.fragment.indexOf(MANAGED_INTERRUPT_HOOK_END, fragmentStart);
  if (fragmentStart < 0 || fragmentEnd < fragmentStart) {
    throw new Error("Codex interrupt lifecycle hook journal fragment is invalid");
  }
  const recordedLeading = installed.fragment.slice(0, fragmentStart);
  const recordedTrailing = installed.fragment.slice(fragmentEnd + MANAGED_INTERRUPT_HOOK_END.length);
  const removalStart = recordedLeading
    && text.slice(Math.max(0, located.start - recordedLeading.length), located.start) === recordedLeading
    ? located.start - recordedLeading.length
    : located.start;
  const removalEnd = recordedTrailing
    && text.slice(located.endMarkerEnd, located.endMarkerEnd + recordedTrailing.length) === recordedTrailing
    ? located.endMarkerEnd + recordedTrailing.length
    : located.endMarkerEnd;
  const appendedCodexConfig = text.slice(located.ownedEnd, located.endMarkerStart);
  return `${text.slice(0, removalStart)}${appendedCodexConfig}${text.slice(removalEnd)}`;
}

export function verifyCodexInterruptHookRestored(text: string): void {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex interrupt lifecycle hook is present while the bridge is disconnected");
  }
}
