import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  MANAGED_COMMENT,
  MANAGED_MULTI_AGENT_LINE,
  MANAGED_MULTI_AGENT_V2_LINE,
  MANAGED_MULTI_AGENT_V2_TABLE_LINE,
  MANAGED_REMOTE_COMPACTION_LINE,
} from "./codex-integration-shared";
import type {
  CodexIntegrationJournal,
  LegacyCodexIntegrationJournal,
  LegacyCodexIntegrationJournalV4,
  LegacyCodexIntegrationJournalV5,
  LegacyCodexIntegrationJournalV6,
  ManagedAssignmentKey,
  ManagedRouteJournal,
  PreviousAssignment,
  PreviousFeatureAssignment,
} from "./codex-integration-shared";
import {
  assignments,
  findFeatureAssignment,
  findMultiAgentV2Assignment,
  findTopLevelAssignment,
  firstTableIndex,
  insertDocumentLine,
  parseDocument,
  removeDocumentLine,
  removeManagedComment,
  renderDocument,
  restoreBooleanFeature,
  restoreManagedFeatures,
  restoreMultiAgentV2Feature,
  splitLines,
  verifyInstalledFeatures,
} from "./codex-integration-document";

function restoreOwnedManagedFeatures(text: string, journal: ManagedRouteJournal): string {
  let restored = text;
  if (journal.version === 6) {
    const current = findMultiAgentV2Assignment(splitLines(restored));
    const managedLine = journal.previousMultiAgentV2.tableName === "features.multi_agent_v2"
      ? MANAGED_MULTI_AGENT_V2_TABLE_LINE
      : MANAGED_MULTI_AGENT_V2_LINE;
    if (current.rawLine === managedLine && current.value === "false") {
      restored = restoreMultiAgentV2Feature(restored, journal.previousMultiAgentV2);
    }
  }
  if (journal.version === 5 || journal.version === 6) {
    const multiAgent = findFeatureAssignment(splitLines(restored), "multi_agent");
    if (multiAgent.rawLine === MANAGED_MULTI_AGENT_LINE && multiAgent.value === "true") {
      restored = restoreBooleanFeature(
        restored,
        "multi_agent",
        "true",
        MANAGED_MULTI_AGENT_LINE,
        journal.previousMultiAgent,
      );
    }
    const compaction = findFeatureAssignment(splitLines(restored), "remote_compaction_v2");
    if (compaction.rawLine === MANAGED_REMOTE_COMPACTION_LINE && compaction.value === "false") {
      restored = restoreBooleanFeature(
        restored,
        "remote_compaction_v2",
        "false",
        MANAGED_REMOTE_COMPACTION_LINE,
        journal.previousRemoteCompactionV2,
      );
    }
  }
  return restored;
}

function restoreStillManagedRouteAssignments(text: string, journal: ManagedRouteJournal): string {
  const document = parseDocument(text);
  removeManagedComment(document);
  const current = assignments(document.lines);
  const target = Object.fromEntries(
    (Object.keys(current) as ManagedAssignmentKey[]).map(key => {
      const stillManaged = key === "openai_base_url"
        ? current[key].present && current[key].value === journal.installed.openai_base_url
        : !current[key].present;
      return [key, stillManaged ? journal.previous[key] : current[key]];
    }),
  ) as Record<ManagedAssignmentKey, PreviousAssignment>;
  const currentIndices = Object.values(current)
    .flatMap(assignment => assignment.index === undefined ? [] : [assignment.index])
    .sort((left, right) => right - left);
  for (const index of currentIndices) removeDocumentLine(document, index);

  const previous = (Object.entries(target) as Array<[ManagedAssignmentKey, PreviousAssignment]>)
    .filter(([, assignment]) => assignment.present)
    .sort(([, left], [, right]) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER));
  for (const [key, assignment] of previous) {
    if (!assignment.rawLine) throw new Error(`Codex integration journal is missing the prior ${key} line`);
    const index = Math.min(assignment.index ?? firstTableIndex(document.lines), firstTableIndex(document.lines));
    insertDocumentLine(document, index, assignment.rawLine);
  }
  return renderDocument(document);
}
export function managedJournalIsActive(journal: ManagedRouteJournal): boolean {
  return journal.version === 3 || journal.active;
}

export function verifyManagedJournalState(text: string, journal: ManagedRouteJournal): void {
  if (journal.version === 3 || journal.active) verifyInstalledRoute(text, journal);
  else verifyRestoredRoute(text, journal);
}

export function replacementBaseline(
  currentText: string,
  configExists: boolean,
  journal: ManagedRouteJournal,
): string {
  if (!configExists) return "";
  if (!managedJournalIsActive(journal)) return currentText;

  let baseline = restoreOwnedManagedFeatures(currentText, journal);
  baseline = restoreStillManagedRouteAssignments(baseline, journal);
  return baseline;
}

export function installRoute(
  text: string,
  installedUrl: string,
  replaceExistingRoute: boolean,
): { text: string; previous: CodexIntegrationJournal["previous"] } {
  const document = parseDocument(text);
  const previous = assignments(document.lines);
  const conflicts = (Object.entries(previous) as Array<[ManagedAssignmentKey, PreviousAssignment]>)
    .filter(([key, assignment]) => assignment.present
      && !(key === "model_provider" && assignment.value === "openai"))
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
  return { text: renderDocument(document), previous };
}

export function verifyInstalledRoute(text: string, journal: ManagedRouteJournal): void {
  const lines = splitLines(text);
  const current = assignments(lines);
  if (current.openai_base_url.value !== journal.installed.openai_base_url) {
    throw new Error("Codex openai_base_url changed after setup; refusing to overwrite the user's newer value");
  }
  if (current.model_provider.present || current.model_catalog_json.present) {
    throw new Error("Codex model_provider or model_catalog_json changed after setup; refusing to overwrite the user's newer value");
  }
  if (!lines.includes(MANAGED_COMMENT)) {
    throw new Error("Managed Codex route marker changed after setup; refusing to overwrite it");
  }
  if (journal.version === 5 || journal.version === 6) verifyInstalledFeatures(text, journal);
}

function previousAssignmentMatches(current: PreviousAssignment, previous: PreviousAssignment): boolean {
  return current.present === previous.present
    && (!current.present || current.value === previous.value);
}

export function verifyRestoredRoute(
  text: string,
  journal: CodexIntegrationJournal | LegacyCodexIntegrationJournalV6 | LegacyCodexIntegrationJournalV5 | LegacyCodexIntegrationJournalV4,
): void {
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
  if (journal.version === 5 || journal.version === 6) {
    const previousFeatures: Array<readonly [string, PreviousFeatureAssignment]> = [
      ["remote_compaction_v2", journal.previousRemoteCompactionV2],
      ["multi_agent", journal.previousMultiAgent],
    ];
    if (journal.version === 6) {
      previousFeatures.push(["multi_agent_v2", journal.previousMultiAgentV2]);
    }
    for (const [key, previous] of previousFeatures) {
      const current = key === "multi_agent_v2"
        ? findMultiAgentV2Assignment(lines)
        : findFeatureAssignment(lines, key);
      const matches = current.present === previous.present
        && (current.tableName ?? "features") === (previous.tableName ?? "features")
        && (!current.present || current.rawLine === previous.rawLine);
      if (!matches) {
        throw new Error(
          `Codex [features].${key} changed while the bridge was disconnected; refusing to overwrite the user's newer value`,
        );
      }
    }
  }
}

export function assertPreservedPreviousAssignments(
  actual: CodexIntegrationJournal["previous"],
  expected: CodexIntegrationJournal["previous"],
): void {
  for (const key of ["openai_base_url", "model_provider", "model_catalog_json"] as const) {
    if (!previousAssignmentMatches(actual[key], expected[key])) {
      throw new Error(`Codex ${key} changed while the bridge was disconnected; refusing to replace it`);
    }
  }
}

export function restoreManagedRoute(text: string, journal: ManagedRouteJournal): string {
  verifyInstalledRoute(text, journal);
  const document = parseDocument(text);
  removeManagedComment(document);
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
  const restoredRoute = renderDocument(document);
  return journal.version === 5 || journal.version === 6
    ? restoreManagedFeatures(restoredRoute, journal)
    : restoredRoute;
}

export function restoreLegacyV2(text: string, journal: LegacyCodexIntegrationJournal): string {
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
