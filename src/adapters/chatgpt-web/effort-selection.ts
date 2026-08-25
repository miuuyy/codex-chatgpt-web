export type ChatGptEffortIndex = 0 | 1 | 2 | 3 | 4;

export type ChatGptEffortOpenState =
  | {
    kind: "menu";
    optionCount: number;
    currentIndex?: number;
    targetLabel: string;
  }
  | {
    kind: "slider";
    min: number;
    max: number;
    value: number;
  };

export interface ChatGptEffortSelectionDriver {
  /** Read a semantically recognizable current state without opening or changing the control. */
  readCurrent(signal: AbortSignal): Promise<number | undefined>;
  /** Open the single proven effort control and return its single proven menu/slider shape. */
  openAndRead(targetIndex: ChatGptEffortIndex, signal: AbortSignal): Promise<ChatGptEffortOpenState>;
  /** Perform the one intended logical transition. `changed` is advisory, never authoritative. */
  transition(
    state: ChatGptEffortOpenState,
    targetIndex: ChatGptEffortIndex,
    signal: AbortSignal,
  ): Promise<{ changed: boolean }>;
  /** Re-resolve the DOM and return the actual current index, or undefined when it is ambiguous. */
  readActual(
    state: ChatGptEffortOpenState,
    targetIndex: ChatGptEffortIndex,
    signal: AbortSignal,
  ): Promise<number | undefined>;
  close(signal: AbortSignal): Promise<void>;
}

export interface ChatGptEffortSelectionResult {
  changed: boolean;
  transitions: 0 | 1;
}

export class ChatGptEffortStaleDomError extends Error {
  constructor(message = "ChatGPT effort DOM was replaced") {
    super(message);
    this.name = "ChatGptEffortStaleDomError";
  }
}

function abortError(): DOMException {
  return new DOMException("ChatGPT effort selection aborted", "AbortError");
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function stateIndex(state: ChatGptEffortOpenState): number | undefined {
  if (state.kind === "slider") return state.value - state.min;
  return state.currentIndex;
}

function assertTargetAvailable(state: ChatGptEffortOpenState, targetIndex: ChatGptEffortIndex): void {
  const optionCount = state.kind === "slider" ? state.max - state.min + 1 : state.optionCount;
  if (!Number.isInteger(optionCount) || optionCount < 1 || optionCount > 5 || targetIndex >= optionCount) {
    throw new Error(`ChatGPT effort control does not expose item index ${targetIndex} (optionCount=${optionCount})`);
  }
}

/**
 * One bounded logical flow: passive observation, one open/observation, at most one intended
 * transition, and an authoritative post-transition observation. The driver owns DOM-specific
 * bounded re-resolution; this coordinator never retries a transition.
 */
export async function ensureChatGptEffortSelection(
  driver: ChatGptEffortSelectionDriver,
  targetIndex: ChatGptEffortIndex,
  signal: AbortSignal,
): Promise<ChatGptEffortSelectionResult> {
  assertNotAborted(signal);
  const passiveCurrent = await driver.readCurrent(signal);
  assertNotAborted(signal);
  if (passiveCurrent === targetIndex) return { changed: false, transitions: 0 };

  let state: ChatGptEffortOpenState;
  try {
    state = await driver.openAndRead(targetIndex, signal);
  } catch (error) {
    if (!(error instanceof ChatGptEffortStaleDomError)) throw error;
    assertNotAborted(signal);
    state = await driver.openAndRead(targetIndex, signal);
  }
  assertNotAborted(signal);
  assertTargetAvailable(state, targetIndex);
  if (stateIndex(state) === targetIndex) {
    await driver.close(signal);
    return { changed: false, transitions: 0 };
  }

  const transition = await driver.transition(state, targetIndex, signal);
  assertNotAborted(signal);
  const actual = await driver.readActual(state, targetIndex, signal);
  assertNotAborted(signal);
  if (actual !== targetIndex) {
    throw new Error(
      `ChatGPT did not confirm effort item index ${targetIndex}`
      + ` (actual=${actual === undefined ? "ambiguous" : actual}; changed=${transition.changed})`,
    );
  }
  await driver.close(signal);
  return { changed: transition.changed, transitions: 1 };
}

export function chatGptEffortIndexFromControlLabel(value: string): ChatGptEffortIndex | undefined {
  const normalized = value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
  const labels = new Map<string, ChatGptEffortIndex>([
    ["instant", 0],
    ["medium", 1],
    ["high", 2],
    ["高い", 2],
    ["extra high", 3],
    ["pro", 4],
  ]);
  return labels.get(normalized);
}
