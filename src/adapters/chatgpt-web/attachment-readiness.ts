export interface ChatGptAttachmentFile {
  name: string;
  mimeType: string;
}

export interface ChatGptFileInputCandidate {
  accept: string;
  dataTestId: string;
  disabled: boolean;
  multiple: boolean;
}

export interface ChatGptAttachmentReadiness {
  exactTilesVisible: boolean;
  exactInputNamePolls: number;
  sendVisible: boolean;
  sendEnabled: boolean;
  sendAriaDisabled: string | null;
}

export const CHATGPT_ATTACHMENT_INPUT_STABLE_POLLS = 3;

const IMAGE_ONLY_FILE_INPUT_TEST_IDS = new Set([
  "camera-input",
  "upload-photo-input",
  "upload-photos-input",
]);

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

function fileMatchesAcceptToken(file: ChatGptAttachmentFile, token: string): boolean {
  const normalized = token.trim().toLowerCase();
  if (!normalized || normalized === "*/*") return true;
  if (normalized.startsWith(".")) return extension(file.name) === normalized;
  if (normalized.endsWith("/*")) {
    return file.mimeType.toLowerCase().startsWith(normalized.slice(0, -1));
  }
  return file.mimeType.toLowerCase() === normalized;
}

/**
 * Select only an input whose declared contract can carry the complete batch.
 * In particular, a ChatGPT image picker must never receive a text document merely because
 * Playwright can programmatically populate it.
 */
export function chatGptFileInputAcceptsFiles(
  candidate: ChatGptFileInputCandidate,
  files: readonly ChatGptAttachmentFile[],
): boolean {
  if (candidate.disabled || files.length === 0) return false;
  if (files.length > 1 && !candidate.multiple) return false;

  const hasNonImage = files.some(file => !file.mimeType.toLowerCase().startsWith("image/"));
  if (hasNonImage && IMAGE_ONLY_FILE_INPUT_TEST_IDS.has(candidate.dataTestId.toLowerCase())) {
    return false;
  }

  const acceptTokens = candidate.accept
    .split(",")
    .map(token => token.trim())
    .filter(Boolean);
  if (acceptTokens.length === 0) return true;
  return files.every(file => acceptTokens.some(token => fileMatchesAcceptToken(file, token)));
}

export function sameExactFileNames(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  if (actual.length !== expected.length) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.every((name, index) => name === right[index]);
}

/**
 * A send is safe only when the current composer exposes an enabled send control and ChatGPT has
 * provided exact attachment evidence. Stable FileList names are an accepted fallback for UI
 * variants that omit attachment groups, but only after three consecutive exact observations.
 */
export function chatGptAttachmentsReady(state: ChatGptAttachmentReadiness): boolean {
  const attachmentsRegistered = state.exactTilesVisible
    || state.exactInputNamePolls >= CHATGPT_ATTACHMENT_INPUT_STABLE_POLLS;
  return attachmentsRegistered
    && state.sendVisible
    && state.sendEnabled
    && state.sendAriaDisabled !== "true";
}
