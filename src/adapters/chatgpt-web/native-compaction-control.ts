import { COMPACT_PROMPT } from "../../responses/compaction";
import type { CompactionTransactionHandle } from "./compaction-transaction";

export const CODEX_COMPACTION_CONTROL_WIRE_NAME = "codex.control.compaction_handoff";
export const CODEX_ACTIVE_COMPACTION_REQUEST_MARKER = "CODEX_ACTIVE_COMPACTION_REQUEST";

function compactionControlBinding(transaction: CompactionTransactionHandle): string[] {
  return [
    "Submit the complete checkpoint through the attached Codex Native control plane by calling codex_tool_call exactly once with the binding below.",
    "This one-shot control token is valid only for the reserved compaction operation; do not use it with codex_exec, codex_tool_inventory, or any outer Codex tool.",
    "<codex_compaction_control>",
    `turn_token ${transaction.token}`,
    `wire_name ${CODEX_COMPACTION_CONTROL_WIRE_NAME}`,
    `handoff_id ${transaction.handoffId}`,
    "</codex_compaction_control>",
    `Call codex_tool_call exactly once with ${JSON.stringify({
      turn_token: transaction.token,
      wire_name: CODEX_COMPACTION_CONTROL_WIRE_NAME,
      arguments: {
        handoff_id: transaction.handoffId,
        summary: "<complete checkpoint summary>",
      },
    })}.`,
  ];
}

/**
 * Stop an active browser response only if it asks for another tool after Codex requested
 * compaction. Results for calls already handed to Codex remain byte-for-byte canonical: when they
 * are enough to finish the task, that ordinary final answer remains publishable. A later tool call
 * is intercepted before execution and receives this instruction; the retained conversation then
 * receives the sole structured checkpoint request on a clean message boundary.
 */
export function activeCompactionToolResultInstruction(): string {
  return [
    `<${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
    "Codex reached its context limit before this newly requested tool could be sent for execution. The tool was not executed.",
    "Stop ordinary task work now, call no more tools, and end this Web response normally.",
    "Do not create or submit a checkpoint in this response. After it settles, the retained conversation will receive exactly one separate structured compaction handoff request.",
    `</${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
  ].join("\n");
}

/**
 * Stop instruction for local (Grok CLI) compaction, where the checkpoint is written outside
 * ChatGPT. The tool call is intercepted for the same reason as above, but this conversation gets no
 * structured handoff request afterwards, so it is told not to wait for one or write a checkpoint.
 */
export function localCompactionToolResultInstruction(): string {
  return [
    `<${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
    "Codex reached its context limit before this newly requested tool could be sent for execution. The tool was not executed.",
    "Stop ordinary task work now, call no more tools, and end this Web response normally.",
    "Do not create or submit a checkpoint. Codex is compacting its own history locally; this conversation will receive no compaction request and closes once this response settles.",
    `</${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
  ].join("\n");
}

/** Zero Risk version of the local compaction stop instruction, delivered on the same response. */
export function zeroRiskLocalCompactionToolResultInstruction(toolExecuted: boolean): string {
  return [
    `<${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
    toolExecuted
      ? "Codex reached its context limit while this Web response was waiting for the tool result above."
      : "Codex reached its context limit before the requested tool could be sent for execution. The tool was not executed.",
    toolExecuted
      ? "Consume that canonical result, stop ordinary task work now, and do not call any more work tools."
      : "Stop ordinary task work now and do not call any more work tools.",
    "Do not produce a checkpoint summary. Codex is compacting its own history locally.",
    "End this response now with codex_turn_complete, reporting only what was already established.",
    `</${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
  ].join("\n");
}

/**
 * Zero Risk cannot submit a second browser message automatically. When Codex compacts at an
 * already-visible native tool boundary, the same manually submitted response returns the
 * checkpoint through the same Zero Risk request instead.
 */
export function zeroRiskActiveCompactionToolResultInstruction(toolExecuted: boolean): string {
  return [
    `<${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
    toolExecuted
      ? "Codex reached its context limit while this Web response was waiting for the tool result above."
      : "Codex reached its context limit before the requested tool could be sent for execution. The tool was not executed.",
    toolExecuted
      ? "Consume that canonical result, stop ordinary task work now, and do not call any more work tools."
      : "Stop ordinary task work now and do not call any more work tools.",
    COMPACT_PROMPT,
    "Call no more work tools. Return only the complete checkpoint summary to Codex with codex_turn_complete.",
    `</${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
  ].join("\n");
}

export function structuredCompactionHandoffInstruction(
  transaction: CompactionTransactionHandle,
): string {
  return [
    "Automatic Codex context compaction has started. Stop ordinary task work and do not call any more work tools.",
    COMPACT_PROMPT,
    ...compactionControlBinding(transaction),
    "After the control call returns submitted=true, call no more tools. The bridge will close this one-purpose Web response after accepting the checkpoint.",
    "The outer bridge accepts compaction only after the structured checkpoint is valid and its owned browser turn has physically settled.",
  ].join("\n");
}
