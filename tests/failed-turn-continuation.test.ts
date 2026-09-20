import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import type { CodexParsedRequest } from "../src/types";
import { isCodexFailedTurnContinuation } from "../src/adapters/chatgpt-web/codex-rollout-environment";

const threadId = "01a0b3d4-41b2-71c1-b691-d865f009ba3c";
const sourceTurn = "01a0b5cd-944c-7b93-bbe3-6ba31fbf51cb";
const currentTurn = "01a0b5cd-e87f-7a51-9e82-c9cba99cc92b";
const source = { itemId: "msg_original", turnId: sourceTurn, content: [{ type: "input_text", text: "Continue" }] };
const event = (type: string, turn_id: string, extra = {}) => ({ type: "event_msg", payload: { type, turn_id, ...extra } });
const message = { type: "response_item", payload: {
  type: "message", role: "user", id: source.itemId, content: source.content,
  internal_chat_message_metadata_passthrough: { turn_id: sourceTurn },
} };

test.each(["valid", "success", "aborted", "tool", "assistant", "changed", "wrong turn", "missing boundary", "new instruction", "incomplete failure", "chained retry", "capacity text"])(
  "failed turn retry checks native history: %s", variant => {
    const codexHome = mkdtempSync(join(tmpdir(), "failed-turn-"));
    try {
      const sessions = join(codexHome, "sessions", "2026", "09", "18");
      mkdirSync(sessions, { recursive: true });
      const records: unknown[] = [
        { type: "session_meta", payload: { id: threadId, source: "vscode" } },
        event("task_started", sourceTurn), message,
      ];
      if (variant === "tool") records.push({ type: "response_item", payload: { type: "function_call", name: "exec" } });
      if (variant === "assistant") records.push({ type: "response_item", payload: { type: "message", role: "assistant", content: [] } });
      if (variant === "aborted") records.push(event("turn_aborted", sourceTurn));
      if (variant !== "incomplete failure") records.push(event("task_complete", sourceTurn, {
        error: variant === "success" ? null
          : variant === "capacity text"
            ? { message: "Selected model is at capacity. Please try a different model." }
            : { message: "Selected model is at capacity.", codex_error_info: "server_overloaded" },
      }));
      if (variant === "chained retry") {
        const intermediate = "01a0b5ce-bdb3-7601-99fd-dfac4bb4903d";
        records.push(event("task_started", intermediate), event("task_complete", intermediate, {
          error: { message: "ChatGPT web current user message conflicts with native Codex turn_id metadata" },
        }));
      }
      if (variant !== "missing boundary") records.push(event("task_started", currentTurn));
      records.push({ type: "turn_context", payload: { turn_id: variant === "wrong turn" ? sourceTurn : currentTurn } });
      if (variant === "new instruction") records.push({ ...message, payload: { ...message.payload, id: "msg_new" } });
      writeFileSync(join(sessions, `rollout-2026-09-18T02-23-47-${threadId}.jsonl`), records.map(x => JSON.stringify(x)).join("\n") + "\n");
      const accepted = isCodexFailedTurnContinuation({ codexHome, turnId: currentTurn,
        lineage: { threadId, sandboxType: "dangerFullAccess", workspaceRoots: [] },
        source: variant === "changed" ? { ...source, content: "changed" } : source,
      });
            const valid = variant === "valid" || variant === "chained retry" || variant === "capacity text";
      expect(accepted).toBe(valid);
      const parsed: CodexParsedRequest = {
        modelId: "gpt-5.6-sol", stream: true, options: {}, context: { messages: [] },
        _rawBody: { input: [{ ...message.payload, content: variant === "changed" ? "changed" : source.content }],
          client_metadata: { "x-codex-turn-metadata": JSON.stringify({
            thread_id: threadId, turn_id: currentTurn, request_kind: "turn", sandbox: "none", workspaces: {},
          }) },
        },
      };
      if (valid) expect(extractChatGptTurnUserRevision(parsed, codexHome)).toEqual(source.content);
      else expect(() => extractChatGptTurnUserRevision(parsed, codexHome)).toThrow("conflicts with native Codex turn_id");
    } finally { rmSync(codexHome, { recursive: true, force: true }); }
  },
);
