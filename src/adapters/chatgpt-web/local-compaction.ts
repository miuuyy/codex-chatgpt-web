import { getCodexHome } from "../../codex-integration-shared";
import type { CodexParsedRequest } from "../../types";
import {
  extractChatGptRootThreadMetadata,
  extractChatGptThreadSpawnLineage,
} from "./environment";
import { restoreCodexCompactionProvenance } from "./codex-rollout-environment";
import { registeredCodexHomes } from "./thread-environment";

/** Local Codex compaction requests a text summary through /responses, without a trigger item. */
export function normalizeLocalCompactionRequest(
  parsed: CodexParsedRequest,
  statePath?: string,
  codexHome = getCodexHome(),
): boolean {
  const body = parsed._rawBody as {
    client_metadata?: Record<string, unknown>;
    input?: Array<Record<string, unknown>>;
  } | undefined;
  const rawMetadata = body?.client_metadata?.["x-codex-turn-metadata"];
  let metadata;
  try { metadata = typeof rawMetadata === "string" ? JSON.parse(rawMetadata) : rawMetadata; }
  catch { return false; }
  if (metadata?.request_kind !== "compaction" || metadata.compaction?.implementation !== "responses") return false;
  const input = body?.input;
  const tail = Array.isArray(input) ? input.at(-1) : undefined;
  if (!tail || tail.type !== "message" || tail.role !== "user" || tail.id !== undefined) {
    throw new Error("Local Codex compaction requires its native summarization prompt");
  }

  // Use the existing compaction transaction, but keep the local caller's text response contract.
  // The synthetic prompt has no item id and must not replace the human source instruction.
  parsed._compactionRequest = true;
  parsed._rawBody = { ...body, input: [...input!.slice(0, -1), { type: "compaction_trigger" }] };
  parsed.context.messages.pop();
  const lineage = extractChatGptThreadSpawnLineage(parsed) ?? extractChatGptRootThreadMetadata(parsed);
  if (!lineage) throw new Error("Local Codex compaction requires canonical thread metadata");
  const normalized = parsed._rawBody as { input: Array<Record<string, unknown>> };
  normalized.input = restoreCodexCompactionProvenance({
    codexHome, additionalCodexHomes: registeredCodexHomes(statePath), lineage, input: normalized.input,
  });
  return true;
}
