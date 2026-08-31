import { existsSync, readFileSync } from "node:fs";
import { stripUtf8Bom } from "./config";
import {
  MANAGED_COMMENT,
  MANAGED_ROUTE_COMMENT,
  MANAGED_MULTI_AGENT_LINE,
  MANAGED_MULTI_AGENT_V2_LINE,
  MANAGED_MULTI_AGENT_V2_TABLE_LINE,
  MANAGED_REMOTE_COMPACTION_LINE,
  MIN_COMPATIBILITY_V1_AGENT_DEPTH,
  getCodexConfigPath,
  managedAgentMaxDepthLine,
} from "./codex-integration-shared";
import type {
  CodexIntegrationJournal,
  CodexModelContextOverride,
  LegacyCodexIntegrationJournalV5,
  LegacyCodexIntegrationJournalV6,
  ManagedAssignmentKey,
  PreviousAssignment,
  PreviousAgentAssignment,
  PreviousFeatureAssignment,
} from "./codex-integration-shared";

export function firstTableIndex(lines: string[]): number {
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

export function findTopLevelAssignment(lines: string[], key: string): PreviousAssignment {
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
  return contextWindow === undefined ? undefined : { contextWindow };
}

export function assignments(lines: string[]): Record<ManagedAssignmentKey, PreviousAssignment> {
  return {
    openai_base_url: findTopLevelAssignment(lines, "openai_base_url"),
    model_provider: findTopLevelAssignment(lines, "model_provider"),
    model_catalog_json: findTopLevelAssignment(lines, "model_catalog_json"),
  };
}

export function textFormat(text: string): NonNullable<CodexIntegrationJournal["format"]> {
  return {
    lineEnding: text.includes("\r\n") ? "\r\n" : "\n",
    trailingNewline: /\r?\n$/.test(text),
  };
}

export function splitLines(text: string): string[] {
  const normalized = stripUtf8Bom(text);
  return normalized.length > 0 ? normalized.replace(/\r?\n$/, "").split(/\r?\n/) : [];
}

/**
 * The Codex config belongs to the user. Every edit keeps each untouched line byte-for-byte,
 * including its own terminator, so a file with mixed line endings is never normalized.
 */
interface CodexConfigDocument {
  lines: string[];
  endings: string[];
  utf8Bom: boolean;
}

export function parseDocument(text: string): CodexConfigDocument {
  const utf8Bom = text.startsWith("\uFEFF");
  text = stripUtf8Bom(text);
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
  return { lines, endings, utf8Bom };
}

export function renderDocument(document: CodexConfigDocument): string {
  const text = document.lines.map((line, index) => `${line}${document.endings[index] ?? ""}`).join("");
  return document.utf8Bom ? `\uFEFF${text}` : text;
}

function dominantLineEnding(document: CodexConfigDocument): string {
  return document.endings.find(ending => ending.length > 0) ?? "\n";
}

export function insertDocumentLine(document: CodexConfigDocument, index: number, line: string): void {
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

export function removeDocumentLine(document: CodexConfigDocument, index: number): void {
  if (index < 0 || index >= document.lines.length) return;
  const wasLast = index === document.lines.length - 1;
  const trailing = document.endings[index] ?? "";
  document.lines.splice(index, 1);
  document.endings.splice(index, 1);
  if (wasLast && document.endings.length > 0) document.endings[document.endings.length - 1] = trailing;
}

export function removeManagedComment(document: CodexConfigDocument): void {
  for (let index = document.lines.length - 1; index >= 0; index -= 1) {
    if (document.lines[index] === MANAGED_COMMENT || document.lines[index] === MANAGED_ROUTE_COMMENT) {
      removeDocumentLine(document, index);
    }
  }
}

interface TomlTableRange {
  headerIndex: number;
  endIndex: number;
}

function findTomlTable(lines: string[], tableName: string): TomlTableRange | undefined {
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`);
  const matches = lines
    .map((line, index) => header.test(line) ? index : -1)
    .filter(index => index >= 0);
  if (matches.length > 1) throw new Error(`Codex config contains duplicate [${tableName}] tables`);
  const headerIndex = matches[0];
  if (headerIndex === undefined) return undefined;
  const relativeEnd = lines
    .slice(headerIndex + 1)
    .findIndex(line => /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line));
  return {
    headerIndex,
    endIndex: relativeEnd < 0 ? lines.length : headerIndex + 1 + relativeEnd,
  };
}

function insertFeatureTable(document: CodexConfigDocument): TomlTableRange {
  if (document.lines.length > 0 && document.lines.at(-1)?.trim()) {
    insertDocumentLine(document, document.lines.length, "");
  }
  insertDocumentLine(document, document.lines.length, "[features]");
  return findTomlTable(document.lines, "features")!;
}

function setScalarFeature(
  document: CodexConfigDocument,
  key: string,
  managedLine: string,
): void {
  const current = findFeatureAssignment(document.lines, key);
  if (current.index !== undefined) {
    document.lines[current.index] = managedLine;
    return;
  }
  const table = findTomlTable(document.lines, "features") ?? insertFeatureTable(document);
  insertDocumentLine(document, table.endIndex, managedLine);
}

function findBooleanAssignmentInTable(
  lines: string[],
  tableName: "features" | "features.multi_agent_v2",
  key: string,
): PreviousFeatureAssignment {
  const table = findTomlTable(lines, tableName);
  if (!table) return { present: false, tablePresent: false, tableName };
  const regex = assignmentRegex(key);
  const matches: PreviousAssignment[] = [];
  for (let index = table.headerIndex + 1; index < table.endIndex; index += 1) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const match = regex.exec(line);
    if (!match) continue;
    const value = stripTomlComment(match[1]!).trim();
    if (value !== "true" && value !== "false") {
      throw new Error(`${key} in Codex [${tableName}] must be a boolean`);
    }
    matches.push({ present: true, rawLine: line, value, index });
  }
  if (matches.length > 1) {
    throw new Error(`Codex config contains duplicate [${tableName}].${key} assignments`);
  }
  return { ...(matches[0] ?? { present: false }), tablePresent: true, tableName };
}

export function findAgentMaxDepthAssignment(lines: string[]): PreviousAgentAssignment {
  const table = findTomlTable(lines, "agents");
  if (!table) return { present: false, tablePresent: false };
  const regex = assignmentRegex("max_depth");
  const matches: PreviousAssignment[] = [];
  for (let index = table.headerIndex + 1; index < table.endIndex; index += 1) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const match = regex.exec(line);
    if (!match) continue;
    const value = stripTomlComment(match[1]!).trim().replaceAll("_", "");
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
      throw new Error("max_depth in Codex [agents] must be a positive integer");
    }
    matches.push({ present: true, rawLine: line, value, index });
  }
  if (matches.length > 1) throw new Error("Codex config contains duplicate [agents].max_depth assignments");
  return { ...(matches[0] ?? { present: false }), tablePresent: true };
}

function setAgentMaxDepth(document: CodexConfigDocument, value: number): void {
  const current = findAgentMaxDepthAssignment(document.lines);
  const managedLine = managedAgentMaxDepthLine(value);
  if (current.index !== undefined) {
    document.lines[current.index] = managedLine;
    return;
  }
  let table = findTomlTable(document.lines, "agents");
  if (!table) {
    if (document.lines.length > 0 && document.lines.at(-1)?.trim()) {
      insertDocumentLine(document, document.lines.length, "");
    }
    insertDocumentLine(document, document.lines.length, "[agents]");
    table = findTomlTable(document.lines, "agents")!;
  }
  insertDocumentLine(document, table.endIndex, managedLine);
}

export function findFeatureAssignment(lines: string[], key: string): PreviousFeatureAssignment {
  return findBooleanAssignmentInTable(lines, "features", key);
}

export function findMultiAgentV2Assignment(lines: string[]): PreviousFeatureAssignment {
  const scalar = findFeatureAssignment(lines, "multi_agent_v2");
  const table = findTomlTable(lines, "features.multi_agent_v2");
  if (scalar.present && table) {
    throw new Error(
      "Codex config defines multi_agent_v2 as both [features] scalar and [features.multi_agent_v2] table",
    );
  }
  return table
    ? findBooleanAssignmentInTable(lines, "features.multi_agent_v2", "enabled")
    : scalar;
}

export function installCompatibilityV1Features(text: string): {
  text: string;
  previousMultiAgent: PreviousFeatureAssignment;
  previousMultiAgentV2: PreviousFeatureAssignment;
  previousAgentMaxDepth: PreviousAgentAssignment;
  installedAgentMaxDepth: number;
} {
  const document = parseDocument(text);
  const previousMultiAgent = findFeatureAssignment(document.lines, "multi_agent");
  const previousMultiAgentV2 = findMultiAgentV2Assignment(document.lines);
  const foundAgentMaxDepth = findAgentMaxDepthAssignment(document.lines);
  const previousAgentMaxDepth: PreviousAgentAssignment = !foundAgentMaxDepth.tablePresent
    && document.lines.length > 0
    && Boolean(document.lines.at(-1)?.trim())
    ? { ...foundAgentMaxDepth, separatorInserted: true }
    : foundAgentMaxDepth;
  const installedAgentMaxDepth = Math.max(
    previousAgentMaxDepth.present ? Number(previousAgentMaxDepth.value) : 0,
    MIN_COMPATIBILITY_V1_AGENT_DEPTH,
  );
  setScalarFeature(document, "multi_agent", MANAGED_MULTI_AGENT_LINE);
  if (previousMultiAgentV2.tableName === "features.multi_agent_v2") {
    const current = findBooleanAssignmentInTable(
      document.lines,
      "features.multi_agent_v2",
      "enabled",
    );
    if (current.index !== undefined) {
      document.lines[current.index] = MANAGED_MULTI_AGENT_V2_TABLE_LINE;
    } else {
      const table = findTomlTable(document.lines, "features.multi_agent_v2");
      if (!table) throw new Error("Codex [features.multi_agent_v2] table disappeared during setup");
      insertDocumentLine(document, table.endIndex, MANAGED_MULTI_AGENT_V2_TABLE_LINE);
    }
  } else {
    setScalarFeature(document, "multi_agent_v2", MANAGED_MULTI_AGENT_V2_LINE);
  }
  setAgentMaxDepth(document, installedAgentMaxDepth);
  return {
    text: renderDocument(document),
    previousMultiAgent,
    previousMultiAgentV2,
    previousAgentMaxDepth,
    installedAgentMaxDepth,
  };
}

function verifyInstalledBooleanFeature(
  text: string,
  key: string,
  expectedValue: "true" | "false",
  managedLine: string,
): void {
  const current = findFeatureAssignment(splitLines(text), key);
  if (current.value !== expectedValue || current.rawLine !== managedLine) {
    throw new Error(
      `Codex [features].${key} changed after setup; refusing to overwrite the user's newer value`,
    );
  }
}

function verifyInstalledMultiAgentV2Feature(
  text: string,
  previous: PreviousFeatureAssignment,
): void {
  if (previous.tableName !== "features.multi_agent_v2") {
    const current = findMultiAgentV2Assignment(splitLines(text));
    if (current.tableName !== "features"
      || current.value !== "false"
      || current.rawLine !== MANAGED_MULTI_AGENT_V2_LINE) {
      throw new Error(
        "Codex [features].multi_agent_v2 changed after setup; refusing to overwrite the user's newer value",
      );
    }
    return;
  }
  const lines = splitLines(text);
  if (findFeatureAssignment(lines, "multi_agent_v2").present) {
    throw new Error(
      "Codex [features].multi_agent_v2 changed after setup; refusing to overwrite the user's newer value",
    );
  }
  const current = findBooleanAssignmentInTable(lines, "features.multi_agent_v2", "enabled");
  if (current.value !== "false" || current.rawLine !== MANAGED_MULTI_AGENT_V2_TABLE_LINE) {
    throw new Error(
      "Codex [features.multi_agent_v2].enabled changed after setup; refusing to overwrite the user's newer value",
    );
  }
}

export function restoreBooleanFeature(
  text: string,
  key: string,
  expectedValue: "true" | "false",
  managedLine: string,
  previous: PreviousFeatureAssignment,
): string {
  verifyInstalledBooleanFeature(text, key, expectedValue, managedLine);
  const document = parseDocument(text);
  const current = findFeatureAssignment(document.lines, key);
  if (current.index === undefined) throw new Error(`Managed Codex ${key} is missing`);
  if (previous.present) {
    if (!previous.rawLine) {
      throw new Error(`Codex integration journal is missing the prior ${key} line`);
    }
    document.lines[current.index] = previous.rawLine;
  } else {
    removeDocumentLine(document, current.index);
    if (!previous.tablePresent) {
      const table = findTomlTable(document.lines, "features");
      if (!table) throw new Error("Managed Codex [features] table is missing");
      const remaining = document.lines
        .slice(table.headerIndex + 1, table.endIndex)
        .filter(line => line.trim().length > 0);
      if (remaining.length === 0) removeDocumentLine(document, table.headerIndex);
    }
  }
  return renderDocument(document);
}

export function restoreMultiAgentV2Feature(
  text: string,
  previous: PreviousFeatureAssignment,
): string {
  if (previous.tableName !== "features.multi_agent_v2") {
    return restoreBooleanFeature(
      text,
      "multi_agent_v2",
      "false",
      MANAGED_MULTI_AGENT_V2_LINE,
      previous,
    );
  }
  verifyInstalledMultiAgentV2Feature(text, previous);
  const document = parseDocument(text);
  const current = findBooleanAssignmentInTable(
    document.lines,
    "features.multi_agent_v2",
    "enabled",
  );
  if (current.index === undefined) throw new Error("Managed Codex multi_agent_v2.enabled is missing");
  if (previous.present) {
    if (!previous.rawLine) {
      throw new Error("Codex integration journal is missing the prior multi_agent_v2.enabled line");
    }
    document.lines[current.index] = previous.rawLine;
  } else {
    removeDocumentLine(document, current.index);
  }
  return renderDocument(document);
}

export function verifyInstalledFeatures(
  text: string,
  journal: LegacyCodexIntegrationJournalV6 | LegacyCodexIntegrationJournalV5,
): void {
  verifyInstalledBooleanFeature(
    text,
    "remote_compaction_v2",
    "false",
    MANAGED_REMOTE_COMPACTION_LINE,
  );
  verifyInstalledBooleanFeature(text, "multi_agent", "true", MANAGED_MULTI_AGENT_LINE);
  if (journal.version === 6) {
    verifyInstalledMultiAgentV2Feature(text, journal.previousMultiAgentV2);
  }
}

export function verifyCompatibilityV1Features(
  text: string,
  previousMultiAgentV2: PreviousFeatureAssignment,
  installedAgentMaxDepth: number,
): void {
  verifyInstalledBooleanFeature(text, "multi_agent", "true", MANAGED_MULTI_AGENT_LINE);
  verifyInstalledMultiAgentV2Feature(text, previousMultiAgentV2);
  const depth = findAgentMaxDepthAssignment(splitLines(text));
  if (depth.value !== String(installedAgentMaxDepth)
    || depth.rawLine !== managedAgentMaxDepthLine(installedAgentMaxDepth)) {
    throw new Error(
      "Codex [agents].max_depth changed after Compatibility V1 setup; refusing to overwrite the user's newer value",
    );
  }
}

export function restoreCompatibilityV1Features(
  text: string,
  previousMultiAgent: PreviousFeatureAssignment,
  previousMultiAgentV2: PreviousFeatureAssignment,
  previousAgentMaxDepth: PreviousAgentAssignment,
  installedAgentMaxDepth: number,
): string {
  let restored = restoreBooleanFeature(
    restoreMultiAgentV2Feature(text, previousMultiAgentV2),
    "multi_agent",
    "true",
    MANAGED_MULTI_AGENT_LINE,
    previousMultiAgent,
  );
  restored = restoreCompatibilityV1AgentDepth(
    restored,
    previousAgentMaxDepth,
    installedAgentMaxDepth,
  );
  return restored;
}

export function restoreCompatibilityV1AgentDepth(
  text: string,
  previousAgentMaxDepth: PreviousAgentAssignment,
  installedAgentMaxDepth: number,
): string {
  verifyCompatibilityV1AgentDepth(text, installedAgentMaxDepth);
  const document = parseDocument(text);
  const current = findAgentMaxDepthAssignment(document.lines);
  if (current.index === undefined) throw new Error("Managed Codex [agents].max_depth is missing");
  if (previousAgentMaxDepth.present) {
    if (!previousAgentMaxDepth.rawLine) {
      throw new Error("Codex integration journal is missing the prior [agents].max_depth line");
    }
    document.lines[current.index] = previousAgentMaxDepth.rawLine;
  } else {
    removeDocumentLine(document, current.index);
    if (!previousAgentMaxDepth.tablePresent) {
      const table = findTomlTable(document.lines, "agents");
      if (!table) throw new Error("Managed Codex [agents] table is missing");
      const remaining = document.lines
        .slice(table.headerIndex + 1, table.endIndex)
        .filter(line => line.trim().length > 0);
      if (remaining.length === 0) {
        const headerIndex = table.headerIndex;
        removeDocumentLine(document, headerIndex);
        if (previousAgentMaxDepth.separatorInserted && document.lines[headerIndex - 1] === "") {
          removeDocumentLine(document, headerIndex - 1);
        }
      }
    }
  }
  return renderDocument(document);
}

function verifyCompatibilityV1AgentDepth(text: string, installedAgentMaxDepth: number): void {
  const depth = findAgentMaxDepthAssignment(splitLines(text));
  if (depth.value !== String(installedAgentMaxDepth)
    || depth.rawLine !== managedAgentMaxDepthLine(installedAgentMaxDepth)) {
    throw new Error(
      "Codex [agents].max_depth changed after Compatibility V1 setup; refusing to overwrite the user's newer value",
    );
  }
}

export function restoreManagedFeatures(
  text: string,
  journal: LegacyCodexIntegrationJournalV6 | LegacyCodexIntegrationJournalV5,
): string {
  const withoutMultiAgentV2 = journal.version === 6
    ? restoreMultiAgentV2Feature(text, journal.previousMultiAgentV2)
    : text;
  const withoutMultiAgent = restoreBooleanFeature(
    withoutMultiAgentV2,
    "multi_agent",
    "true",
    MANAGED_MULTI_AGENT_LINE,
    journal.previousMultiAgent,
  );
  return restoreBooleanFeature(
    withoutMultiAgent,
    "remote_compaction_v2",
    "false",
    MANAGED_REMOTE_COMPACTION_LINE,
    journal.previousRemoteCompactionV2,
  );
}
