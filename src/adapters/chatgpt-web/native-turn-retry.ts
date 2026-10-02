import { getCodexHome } from "../../codex-integration-shared";
import type { CodexParsedRequest } from "../../types";
import {
  chatGptTurnUserRevisionHistory, extractChatGptRootThreadMetadata, extractChatGptThreadSpawnLineage,
  extractChatGptTurnIdentity, rememberVerifiedNativeRetry,
} from "./environment";
import { verifyCurrentCodexFailedTurnRetry } from "./codex-rollout-environment";

/** Retry only an exact locally recorded failed instruction; never repair arbitrary turn ids. */
export function authenticateNativeFailedTurnRetry(parsed: CodexParsedRequest, codexHome = getCodexHome()): boolean {
  const identity = extractChatGptTurnIdentity(parsed);
  const source = chatGptTurnUserRevisionHistory(parsed).at(-1);
  const lineage = extractChatGptThreadSpawnLineage(parsed) ?? extractChatGptRootThreadMetadata(parsed);
  if (parsed._compactionRequest || !lineage || !identity.turnId || !source?.turnId || source.turnId === identity.turnId) return false;
  try {
    const verified = verifyCurrentCodexFailedTurnRetry({
      codexHome, lineage, turnId: identity.turnId, source,
      instruction: item => chatGptTurnUserRevisionHistory({ ...parsed, _rawBody: {
        ...parsed._rawBody as object, input: [item],
      } }).at(-1),
    });
    if (verified) rememberVerifiedNativeRetry(parsed, source);
    return verified;
  } catch { return false; }
}
