/**
 * One signed-in ChatGPT account gets exactly one active browser turn. Additional Codex turns may
 * wait in-process, but they must not fan out into parallel ChatGPT tabs because that traffic shape
 * trips account-level anti-burst controls even when ordinary interactive ChatGPT remains usable.
 */
export const MAX_CHATGPT_BROWSER_TABS = 1;

/** Bound queued Codex work so single-flight serialization cannot grow without limit. */
export const MAX_CHATGPT_PENDING_TURNS = 5;
