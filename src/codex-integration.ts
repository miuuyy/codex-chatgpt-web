import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile, expandUserPath, getConfigDir } from "./config";

const MANAGED_COMMENT = "# Managed by codex-chatgpt-web; `codex-chatgpt-web uninstall` restores prior values.";

/**
 * Codex only offers Responses over WebSocket on providers that advertise it, and built-in
 * providers are not overridable (`merge_configured_model_providers` uses `or_insert`). The local
 * route serves HTTP/SSE only, so the bridge installs its own provider that is byte-identical to
 * the built-in `openai` provider except for `base_url` and `supports_websockets = false`. Without
 * it Codex opens a WebSocket against the loopback route on every turn and burns its full
 * `stream_max_retries` budget ("Reconnecting 1/5 ... 5/5") before falling back to HTTP.
 */
const MANAGED_PROVIDER_ID = "codex-chatgpt-web";
const MANAGED_PROVIDER_HEADER = `[model_providers.${MANAGED_PROVIDER_ID}]`;
const MANAGED_PROVIDER_COMMENT = "# Managed by codex-chatgpt-web; the local route has no Responses WebSocket, so this pins HTTP/SSE.";

function managedProviderLines(installedUrl: string): string[] {
  return [
    MANAGED_PROVIDER_COMMENT,
    MANAGED_PROVIDER_HEADER,
    'name = "OpenAI"',
    `base_url = ${JSON.stringify(installedUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_websockets = false",
    "supports_standalone_web_search = true",
  ];
}

interface PreviousAssignment {
  present: boolean;
  rawLine?: string;
  value?: string;
  index?: number;
}

type ManagedAssignmentKey = "openai_base_url" | "model_provider" | "model_catalog_json";

export interface CodexIntegrationJournal {
  version: 5;
  active: boolean;
  configPath: string;
  installed: {
    openai_base_url: string;
    model_provider: string;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  format?: {
    lineEnding: "\n" | "\r\n";
    trailingNewline: boolean;
  };
}

interface LegacyCodexIntegrationJournalV4 {
  version: 4;
  active: boolean;
  configPath: string;
  installed: {
    openai_base_url: string;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  format?: {
    lineEnding: "\n" | "\r\n";
    trailingNewline: boolean;
  };
}

interface LegacyCodexIntegrationJournalV3 {
  version: 3;
  configPath: string;
  installed: {
    openai_base_url: string;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  format?: {
    lineEnding: "\n" | "\r\n";
    trailingNewline: boolean;
  };
}

interface LegacyCodexIntegrationJournal {
  version: 2;
  configPath: string;
  catalogPath: string;
  catalogSha256: string;
  providerBlock: string;
  installed: {
    model_provider: string;
    model_catalog_json: string;
  };
  previous: {
    model_provider: PreviousAssignment;
    model_catalog_json: PreviousAssignment;
  };
}

type ManagedRouteJournal =
  | CodexIntegrationJournal
  | LegacyCodexIntegrationJournalV4
  | LegacyCodexIntegrationJournalV3;

/** The managed provider id a journal installed, or `undefined` for pre-v5 base-url-only routes. */
function journalManagedProvider(journal: ManagedRouteJournal): string | undefined {
  return journal.version === 5 ? journal.installed.model_provider : undefined;
}
type AnyCodexIntegrationJournal = ManagedRouteJournal | LegacyCodexIntegrationJournal;

interface FileSnapshot {
  path: string;
  exists: boolean;
  data?: Buffer;
}

export interface InstallCodexIntegrationOptions {
  replaceExistingRoute?: boolean;
}

export interface UninstallCodexIntegrationResult {
  changed: boolean;
}

export interface SetCodexIntegrationActiveResult {
  changed: boolean;
  active: boolean;
}

export interface CodexModelContextOverride {
  model: string;
  contextWindow: number;
}

export function getCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return resolve(expandUserPath(configured || join(homedir(), ".codex")));
}

export function getCodexConfigPath(): string {
  return join(getCodexHome(), "config.toml");
}

export function getCodexModelsCachePath(): string {
  return join(getCodexHome(), "models_cache.json");
}

export function getCodexJournalPath(): string {
  return join(getConfigDir(), "codex", "integration-journal.json");
}

function routeUrl(config: AppConfig): string {
  return `http://${config.host}:${config.port}/v1`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotFile(path: string): FileSnapshot {
  return existsSync(path)
    ? { path, exists: true, data: readFileSync(path) }
    : { path, exists: false };
}

function restoreFileSnapshot(snapshot: FileSnapshot): void {
  if (snapshot.exists) {
    if (!snapshot.data) throw new Error(`File snapshot is missing data: ${snapshot.path}`);
    atomicWriteFile(snapshot.path, snapshot.data);
  } else {
    rmSync(snapshot.path, { force: true });
  }
}

function writeFilesWithCompensation(
  writes: Array<{ path: string; data: string | Uint8Array }>,
  removals: string[] = [],
): void {
  const paths = [...new Set([...writes.map(write => write.path), ...removals])];
  const snapshots = paths.map(snapshotFile);
  try {
    for (const write of writes) atomicWriteFile(write.path, write.data);
    for (const removal of removals) rmSync(removal, { force: true });
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const snapshot of [...snapshots].reverse()) {
      try {
        restoreFileSnapshot(snapshot);
      } catch (rollbackError) {
        rollbackFailures.push(`${snapshot.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(
      rollbackFailures.length > 0
        ? `${primary}; Codex integration rollback also failed: ${rollbackFailures.join("; ")}`
        : primary,
    );
  }
}

function firstTableIndex(lines: string[]): number {
  const index = lines.findIndex(line => /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line));
  return index < 0 ? lines.length : index;
}

function assignmentRegex(key: string): RegExp {
  return new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+?)\\s*$`);
}

function stripTomlComment(value: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return value.slice(0, index).trimEnd();
  }
  return value.trimEnd();
}

function decodeTomlString(raw: string, key: string): string {
  const value = stripTomlComment(raw).trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      throw new Error(`Could not parse ${key} in Codex config`);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  throw new Error(`${key} in Codex config must be a quoted string`);
}

function findTopLevelAssignment(lines: string[], key: string): PreviousAssignment {
  const regex = assignmentRegex(key);
  const matches: PreviousAssignment[] = [];
  for (let index = 0; index < firstTableIndex(lines); index += 1) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const match = regex.exec(line);
    if (match) matches.push({ present: true, rawLine: line, value: decodeTomlString(match[1]!, key), index });
  }
  if (matches.length > 1) throw new Error(`Codex config contains duplicate top-level ${key} assignments`);
  return matches[0] ?? { present: false };
}

function findTopLevelPositiveInteger(lines: string[], key: string): number | undefined {
  const regex = assignmentRegex(key);
  const matches: string[] = [];
  for (let index = 0; index < firstTableIndex(lines); index += 1) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const match = regex.exec(line);
    if (match) matches.push(stripTomlComment(match[1]!).trim());
  }
  if (matches.length > 1) throw new Error(`Codex config contains duplicate top-level ${key} assignments`);
  if (matches.length === 0) return undefined;
  const normalized = matches[0]!.replaceAll("_", "");
  if (!/^\d+$/.test(normalized)) throw new Error(`${key} in Codex config must be a positive integer`);
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} in Codex config must be a positive integer`);
  return value;
}

export function readCodexModelContextOverride(): CodexModelContextOverride | undefined {
  const path = getCodexConfigPath();
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  const lines = splitLines(text);
  const contextWindow = findTopLevelPositiveInteger(lines, "model_context_window");
  if (contextWindow === undefined) return undefined;
  const model = findTopLevelAssignment(lines, "model").value;
  return model ? { model, contextWindow } : undefined;
}

function assignments(lines: string[]): Record<ManagedAssignmentKey, PreviousAssignment> {
  return {
    openai_base_url: findTopLevelAssignment(lines, "openai_base_url"),
    model_provider: findTopLevelAssignment(lines, "model_provider"),
    model_catalog_json: findTopLevelAssignment(lines, "model_catalog_json"),
  };
}

function textFormat(text: string): NonNullable<CodexIntegrationJournal["format"]> {
  return {
    lineEnding: text.includes("\r\n") ? "\r\n" : "\n",
    trailingNewline: /\r?\n$/.test(text),
  };
}

function splitLines(text: string): string[] {
  return text.length > 0 ? text.replace(/\r?\n$/, "").split(/\r?\n/) : [];
}

/**
 * The Codex config belongs to the user. Every edit keeps each untouched line byte-for-byte,
 * including its own terminator, so a file with mixed line endings is never normalized.
 */
interface CodexConfigDocument {
  lines: string[];
  endings: string[];
}

function parseDocument(text: string): CodexConfigDocument {
  const lines: string[] = [];
  const endings: string[] = [];
  const lineBreak = /\r\n|\n|\r/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = lineBreak.exec(text)) !== null) {
    lines.push(text.slice(start, match.index));
    endings.push(match[0]);
    start = match.index + match[0].length;
  }
  if (start < text.length) {
    lines.push(text.slice(start));
    endings.push("");
  }
  return { lines, endings };
}

function renderDocument(document: CodexConfigDocument): string {
  return document.lines.map((line, index) => `${line}${document.endings[index] ?? ""}`).join("");
}

function dominantLineEnding(document: CodexConfigDocument): string {
  return document.endings.find(ending => ending.length > 0) ?? "\n";
}

function insertDocumentLine(document: CodexConfigDocument, index: number, line: string): void {
  const position = Math.max(0, Math.min(index, document.lines.length));
  const ending = dominantLineEnding(document);
  if (position === document.lines.length) {
    const lastIndex = document.lines.length - 1;
    const trailing = lastIndex >= 0 ? document.endings[lastIndex]! : ending;
    if (lastIndex >= 0) document.endings[lastIndex] = ending;
    document.lines.push(line);
    document.endings.push(trailing);
    return;
  }
  document.lines.splice(position, 0, line);
  document.endings.splice(position, 0, document.endings[position] ?? ending);
}

function removeDocumentLine(document: CodexConfigDocument, index: number): void {
  if (index < 0 || index >= document.lines.length) return;
  const wasLast = index === document.lines.length - 1;
  const trailing = document.endings[index] ?? "";
  document.lines.splice(index, 1);
  document.endings.splice(index, 1);
  if (wasLast && document.endings.length > 0) document.endings[document.endings.length - 1] = trailing;
}

function removeManagedComment(document: CodexConfigDocument): void {
  for (let index = document.lines.length - 1; index >= 0; index -= 1) {
    if (document.lines[index] === MANAGED_COMMENT) removeDocumentLine(document, index);
  }
}

/** Locate the managed `[model_providers.codex-chatgpt-web]` table as a half-open `[start, end)`. */
function findManagedProviderBlock(lines: string[]): { start: number; end: number } | undefined {
  const header = lines.findIndex(line => line.trim() === MANAGED_PROVIDER_HEADER);
  if (header < 0) return undefined;
  let start = header;
  if (start > 0 && lines[start - 1] === MANAGED_PROVIDER_COMMENT) start -= 1;
  let end = header + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end += 1;
  while (end - 1 > header && lines[end - 1]!.trim() === "") end -= 1;
  return { start, end };
}

function removeManagedProviderBlock(document: CodexConfigDocument): boolean {
  const block = findManagedProviderBlock(document.lines);
  if (!block) return false;
  let start = block.start;
  if (start > 0 && document.lines[start - 1]!.trim() === "") start -= 1;
  for (let index = block.end - 1; index >= start; index -= 1) removeDocumentLine(document, index);
  return true;
}

/**
 * Appends the managed provider table. The separating blank line is written here and consumed by
 * {@link removeManagedProviderBlock}, so install/uninstall is byte-symmetric.
 */
function appendManagedProviderBlock(document: CodexConfigDocument, installedUrl: string): void {
  const lines = managedProviderLines(installedUrl);
  if (document.lines.length > 0) lines.unshift("");
  for (const line of lines) insertDocumentLine(document, document.lines.length, line);
}

/** Point the top-level `model_provider` at the managed provider and rewrite its table. */
function writeManagedProvider(document: CodexConfigDocument, installedUrl: string): void {
  const assignment = `model_provider = ${JSON.stringify(MANAGED_PROVIDER_ID)}`;
  const existing = findTopLevelAssignment(document.lines, "model_provider");
  if (existing.index !== undefined) {
    document.lines[existing.index] = assignment;
  } else {
    const baseUrl = findTopLevelAssignment(document.lines, "openai_base_url");
    if (baseUrl.index === undefined) throw new Error("Managed Codex openai_base_url is missing");
    insertDocumentLine(document, baseUrl.index + 1, assignment);
  }
  removeManagedProviderBlock(document);
  appendManagedProviderBlock(document, installedUrl);
}

function installRoute(
  text: string,
  installedUrl: string,
  replaceExistingRoute: boolean,
): { text: string; previous: CodexIntegrationJournal["previous"] } {
  const document = parseDocument(text);
  const previous = assignments(document.lines);
  const conflicts = (Object.entries(previous) as Array<[ManagedAssignmentKey, PreviousAssignment]>)
    .filter(([, assignment]) => assignment.present)
    .map(([key, assignment]) => `${key}=${JSON.stringify(assignment.value)}`);
  if (conflicts.length > 0 && !replaceExistingRoute) {
    throw new Error(
      `Codex already configures model routing (${conflicts.join(", ")}). `
      + "Rerun with --replace-codex-route to replace it reversibly.",
    );
  }

  for (const key of ["model_provider", "model_catalog_json"] as const) {
    const location = findTopLevelAssignment(document.lines, key);
    if (location.index !== undefined) removeDocumentLine(document, location.index);
  }
  const currentBaseUrl = findTopLevelAssignment(document.lines, "openai_base_url");
  if (currentBaseUrl.index !== undefined) {
    document.lines[currentBaseUrl.index] = `openai_base_url = ${JSON.stringify(installedUrl)}`;
  } else {
    insertDocumentLine(document, firstTableIndex(document.lines), `openai_base_url = ${JSON.stringify(installedUrl)}`);
  }
  removeManagedComment(document);
  const installedBaseUrl = findTopLevelAssignment(document.lines, "openai_base_url");
  insertDocumentLine(document, installedBaseUrl.index!, MANAGED_COMMENT);
  writeManagedProvider(document, installedUrl);
  return { text: renderDocument(document), previous };
}

function verifyInstalledRoute(text: string, journal: ManagedRouteJournal): void {
  const lines = splitLines(text);
  const current = assignments(lines);
  if (current.openai_base_url.value !== journal.installed.openai_base_url) {
    throw new Error("Codex openai_base_url changed after setup; refusing to overwrite the user's newer value");
  }
  const managedProvider = journalManagedProvider(journal);
  if (managedProvider === undefined) {
    if (current.model_provider.present) {
      throw new Error("Codex model_provider or model_catalog_json changed after setup; refusing to overwrite the user's newer value");
    }
  } else {
    if (current.model_provider.value !== managedProvider) {
      throw new Error("Codex model_provider changed after setup; refusing to overwrite the user's newer value");
    }
    if (!findManagedProviderBlock(lines)) {
      throw new Error("Managed Codex model provider block changed after setup; refusing to overwrite it");
    }
  }
  if (current.model_catalog_json.present) {
    throw new Error("Codex model_provider or model_catalog_json changed after setup; refusing to overwrite the user's newer value");
  }
  if (!lines.includes(MANAGED_COMMENT)) {
    throw new Error("Managed Codex route marker changed after setup; refusing to overwrite it");
  }
}

function previousAssignmentMatches(current: PreviousAssignment, previous: PreviousAssignment): boolean {
  return current.present === previous.present
    && (!current.present || current.value === previous.value);
}

function verifyRestoredRoute(text: string, journal: ManagedRouteJournal): void {
  const lines = splitLines(text);
  const current = assignments(lines);
  for (const key of ["openai_base_url", "model_provider", "model_catalog_json"] as const) {
    if (!previousAssignmentMatches(current[key], journal.previous[key])) {
      throw new Error(`Codex ${key} changed while the bridge was disconnected; refusing to overwrite the user's newer value`);
    }
  }
  if (lines.includes(MANAGED_COMMENT)) {
    throw new Error("Managed Codex route marker is present while the bridge is disconnected");
  }
  if (findManagedProviderBlock(lines)) {
    throw new Error("Managed Codex model provider block is present while the bridge is disconnected");
  }
}

function assertPreservedPreviousAssignments(
  actual: CodexIntegrationJournal["previous"],
  expected: CodexIntegrationJournal["previous"],
): void {
  for (const key of ["openai_base_url", "model_provider", "model_catalog_json"] as const) {
    if (!previousAssignmentMatches(actual[key], expected[key])) {
      throw new Error(`Codex ${key} changed while the bridge was disconnected; refusing to replace it`);
    }
  }
}

function restoreManagedRoute(text: string, journal: ManagedRouteJournal): string {
  verifyInstalledRoute(text, journal);
  const document = parseDocument(text);
  removeManagedProviderBlock(document);
  removeManagedComment(document);
  if (journalManagedProvider(journal) !== undefined) {
    const installedProvider = findTopLevelAssignment(document.lines, "model_provider");
    if (installedProvider.index === undefined) throw new Error("Managed Codex model_provider is missing");
    removeDocumentLine(document, installedProvider.index);
  }
  const currentBaseUrl = findTopLevelAssignment(document.lines, "openai_base_url");
  if (currentBaseUrl.index === undefined) throw new Error("Managed Codex openai_base_url is missing");
  const previousBaseUrl = journal.previous.openai_base_url;
  if (previousBaseUrl.present) {
    if (!previousBaseUrl.rawLine) throw new Error("Codex integration journal is missing the prior openai_base_url line");
    document.lines[currentBaseUrl.index] = previousBaseUrl.rawLine;
  } else {
    removeDocumentLine(document, currentBaseUrl.index);
  }
  const removedAssignments = (["model_provider", "model_catalog_json"] as const)
    .map(key => ({ key, previous: journal.previous[key] }))
    .filter(item => item.previous.present)
    .sort((left, right) => (left.previous.index ?? Number.MAX_SAFE_INTEGER) - (right.previous.index ?? Number.MAX_SAFE_INTEGER));
  for (const item of removedAssignments) {
    if (!item.previous.rawLine) throw new Error(`Codex integration journal is missing the prior ${item.key} line`);
    const index = Math.min(item.previous.index ?? firstTableIndex(document.lines), firstTableIndex(document.lines));
    insertDocumentLine(document, index, item.previous.rawLine);
  }
  return renderDocument(document);
}

function restoreLegacyV2(text: string, journal: LegacyCodexIntegrationJournal): string {
  if (!text.includes(journal.providerBlock)) {
    throw new Error("Managed legacy Codex provider block changed after setup; refusing migration");
  }
  const withoutProvider = text.replace(journal.providerBlock, "").replace(/\n{3,}/g, "\n\n");
  const document = parseDocument(withoutProvider);
  for (const key of ["model_provider", "model_catalog_json"] as const) {
    const current = findTopLevelAssignment(document.lines, key);
    if (current.value !== journal.installed[key] || current.index === undefined) {
      throw new Error(`Managed legacy Codex ${key} changed after setup; refusing migration`);
    }
    const previous = journal.previous[key];
    if (previous.present) {
      if (!previous.rawLine) throw new Error(`Legacy Codex integration journal is missing the prior ${key} line`);
      document.lines[current.index] = previous.rawLine;
    } else {
      removeDocumentLine(document, current.index);
    }
  }
  removeManagedComment(document);
  const restoredCatalog = findTopLevelAssignment(document.lines, "model_catalog_json");
  if (restoredCatalog.index !== undefined && restoredCatalog.value && !existsSync(resolve(restoredCatalog.value))) {
    removeDocumentLine(document, restoredCatalog.index);
  }
  return renderDocument(document);
}

function readJournal(): AnyCodexIntegrationJournal | undefined {
  const path = getCodexJournalPath();
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (value.version === 5
    && typeof value.active === "boolean"
    && value.installed
    && value.previous
    && typeof value.configPath === "string") {
    return value as unknown as CodexIntegrationJournal;
  }
  if (value.version === 4
    && typeof value.active === "boolean"
    && value.installed
    && value.previous
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV4;
  }
  if (value.version === 3 && value.installed && value.previous && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV3;
  }
  if (value.version === 2 && value.installed && value.previous && typeof value.providerBlock === "string") {
    return value as unknown as LegacyCodexIntegrationJournal;
  }
  throw new Error(`Invalid Codex integration journal: ${path}`);
}

function assertJournalTargetsConfig(
  journal: AnyCodexIntegrationJournal,
  configPath: string,
): void {
  const pathIdentity = (value: string): string => {
    const normalized = resolve(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  if (pathIdentity(journal.configPath) !== pathIdentity(configPath)) {
    throw new Error(
      `Codex integration journal belongs to ${journal.configPath}, not the active config ${configPath}`,
    );
  }
}

export function preflightCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): void {
  const configPath = getCodexConfigPath();
  const currentText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const existing = readJournal();
  const installedUrl = routeUrl(config);
  if (existing) assertJournalTargetsConfig(existing, configPath);
  if (existing?.version === 3 || existing?.version === 4 || existing?.version === 5) {
    if (existing.version !== 3 && !existing.active) verifyRestoredRoute(currentText, existing);
    else verifyInstalledRoute(currentText, existing);
    return;
  }
  let baseline = currentText;
  if (existing?.version === 2) {
    if (existsSync(existing.catalogPath) && sha256(readFileSync(existing.catalogPath)) !== existing.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup; refusing migration: ${existing.catalogPath}`);
    }
    baseline = restoreLegacyV2(currentText, existing);
  }
  installRoute(baseline, installedUrl, options.replaceExistingRoute === true);
}

export function installCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): CodexIntegrationJournal {
  const configPath = getCodexConfigPath();
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const currentText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const existing = readJournal();
  const installedUrl = routeUrl(config);
  if (existing) assertJournalTargetsConfig(existing, configPath);

  if (existing?.version === 3 || existing?.version === 4 || existing?.version === 5) {
    let installedText: string;
    if (existing.version !== 3 && !existing.active) {
      verifyRestoredRoute(currentText, existing);
      const patched = installRoute(currentText, installedUrl, true);
      assertPreservedPreviousAssignments(patched.previous, existing.previous);
      installedText = patched.text;
    } else {
      verifyInstalledRoute(currentText, existing);
      const document = parseDocument(currentText);
      const current = findTopLevelAssignment(document.lines, "openai_base_url");
      document.lines[current.index!] = `openai_base_url = ${JSON.stringify(installedUrl)}`;
      // Also upgrades a v3/v4 base-url-only route in place by adding the managed provider.
      writeManagedProvider(document, installedUrl);
      installedText = renderDocument(document);
    }
    const updated: CodexIntegrationJournal = {
      ...existing,
      version: 5,
      active: true,
      installed: { openai_base_url: installedUrl, model_provider: MANAGED_PROVIDER_ID },
    };
    writeFilesWithCompensation([
      { path: configPath, data: installedText },
      { path: getCodexJournalPath(), data: `${JSON.stringify(updated, null, 2)}\n` },
    ], [getCodexModelsCachePath()]);
    return updated;
  }

  let baseline = currentText;
  if (existing?.version === 2) {
    if (existsSync(existing.catalogPath) && sha256(readFileSync(existing.catalogPath)) !== existing.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup; refusing migration: ${existing.catalogPath}`);
    }
    baseline = restoreLegacyV2(currentText, existing);
  }
  const patched = installRoute(baseline, installedUrl, options.replaceExistingRoute === true);
  const journal: CodexIntegrationJournal = {
    version: 5,
    active: true,
    configPath,
    installed: { openai_base_url: installedUrl, model_provider: MANAGED_PROVIDER_ID },
    previous: patched.previous,
    format: textFormat(baseline),
  };
  writeFilesWithCompensation([
    { path: configPath, data: patched.text },
    { path: getCodexJournalPath(), data: `${JSON.stringify(journal, null, 2)}\n` },
  ], [getCodexModelsCachePath()]);
  if (existing?.version === 2 && existsSync(existing.catalogPath)) rmSync(existing.catalogPath);
  return journal;
}

export function deactivateCodexIntegration(): SetCodexIntegrationActiveResult {
  const existing = readJournal();
  if (!existing) return { changed: false, active: false };
  if (existing.version === 2) {
    throw new Error("Legacy Codex integration must be upgraded by Setup before the bridge can be disconnected");
  }
  assertJournalTargetsConfig(existing, getCodexConfigPath());
  if (!existsSync(existing.configPath)) throw new Error(`Codex config is missing: ${existing.configPath}`);
  const current = readFileSync(existing.configPath, "utf8");
  if (existing.version !== 3 && !existing.active) {
    verifyRestoredRoute(current, existing);
    return { changed: false, active: false };
  }
  const restored = restoreManagedRoute(current, existing);
  const disconnected: CodexIntegrationJournal = {
    ...existing,
    version: 5,
    active: false,
    installed: { openai_base_url: existing.installed.openai_base_url, model_provider: MANAGED_PROVIDER_ID },
  };
  writeFilesWithCompensation([
    { path: existing.configPath, data: restored },
    { path: getCodexJournalPath(), data: `${JSON.stringify(disconnected, null, 2)}\n` },
  ], [getCodexModelsCachePath()]);
  return { changed: true, active: false };
}

export function activateCodexIntegration(): SetCodexIntegrationActiveResult {
  const existing = readJournal();
  if (!existing) throw new Error("Codex integration is not installed");
  if (existing.version === 2) {
    throw new Error("Legacy Codex integration must be upgraded by Setup before the bridge can be reconnected");
  }
  assertJournalTargetsConfig(existing, getCodexConfigPath());
  if (!existsSync(existing.configPath)) throw new Error(`Codex config is missing: ${existing.configPath}`);
  const current = readFileSync(existing.configPath, "utf8");
  if (existing.version === 3 || existing.active) {
    verifyInstalledRoute(current, existing);
    return { changed: false, active: true };
  }
  verifyRestoredRoute(current, existing);
  const patched = installRoute(current, existing.installed.openai_base_url, true);
  assertPreservedPreviousAssignments(patched.previous, existing.previous);
  const connected: CodexIntegrationJournal = {
    ...existing,
    version: 5,
    active: true,
    installed: { openai_base_url: existing.installed.openai_base_url, model_provider: MANAGED_PROVIDER_ID },
  };
  writeFilesWithCompensation([
    { path: existing.configPath, data: patched.text },
    { path: getCodexJournalPath(), data: `${JSON.stringify(connected, null, 2)}\n` },
  ], [getCodexModelsCachePath()]);
  return { changed: true, active: true };
}

export function uninstallCodexIntegration(): UninstallCodexIntegrationResult {
  const journal = readJournal();
  if (!journal) return { changed: false };
  if (!existsSync(journal.configPath)) throw new Error(`Codex config is missing: ${journal.configPath}`);
  const current = readFileSync(journal.configPath, "utf8");
  let restored: string;
  if (journal.version === 2) {
    if (existsSync(journal.catalogPath) && sha256(readFileSync(journal.catalogPath)) !== journal.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup: ${journal.catalogPath}`);
    }
    restored = restoreLegacyV2(current, journal);
  } else if (journal.version !== 3 && !journal.active) {
    verifyRestoredRoute(current, journal);
    restored = current;
  } else {
    restored = restoreManagedRoute(current, journal);
  }
  const configSnapshot = snapshotFile(journal.configPath);
  const catalogSnapshot = journal.version === 2 ? snapshotFile(journal.catalogPath) : undefined;
  const modelsCacheSnapshot = snapshotFile(getCodexModelsCachePath());
  try {
    atomicWriteFile(journal.configPath, restored);
    if (catalogSnapshot?.exists) rmSync(catalogSnapshot.path);
    rmSync(modelsCacheSnapshot.path, { force: true });
    rmSync(getCodexJournalPath(), { force: true });
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const snapshot of [modelsCacheSnapshot, catalogSnapshot, configSnapshot]) {
      if (!snapshot) continue;
      try {
        restoreFileSnapshot(snapshot);
      } catch (caught) {
        rollbackFailures.push(`${snapshot.path}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackFailures.length > 0
      ? `${primary}; Codex integration rollback also failed: ${rollbackFailures.join("; ")}`
      : primary);
  }
  return { changed: true };
}

export function inspectCodexIntegration(): {
  installed: boolean;
  active: boolean;
  configPath: string;
  routeUrl?: string;
  journal?: AnyCodexIntegrationJournal;
  errors: string[];
} {
  const journal = readJournal();
  const errors: string[] = [];
  if (journal) {
    try {
      assertJournalTargetsConfig(journal, getCodexConfigPath());
      const text = readFileSync(journal.configPath, "utf8");
      if (journal.version !== 2 && journal.version !== 3 && !journal.active) verifyRestoredRoute(text, journal);
      else if (journal.version === 3 || journal.version === 4 || journal.version === 5) verifyInstalledRoute(text, journal);
      else {
        const lines = splitLines(text);
        for (const key of ["model_provider", "model_catalog_json"] as const) {
          if (findTopLevelAssignment(lines, key).value !== journal.installed[key]) {
            errors.push(`Codex ${key} no longer matches this installation`);
          }
        }
        if (!text.includes(journal.providerBlock)) errors.push("Managed legacy Codex provider block no longer matches this installation");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    installed: Boolean(journal),
    active: journal?.version === 4 || journal?.version === 5 ? journal.active : Boolean(journal),
    configPath: getCodexConfigPath(),
    ...(journal?.version === 3 || journal?.version === 4 || journal?.version === 5
      ? { routeUrl: journal.installed.openai_base_url }
      : {}),
    ...(journal ? { journal } : {}),
    errors,
  };
}
