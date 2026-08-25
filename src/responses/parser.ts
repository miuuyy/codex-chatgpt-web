import type {
  CodexAssistantMessage,
  CodexContentPart,
  CodexContext,
  CodexMessage,
  CodexParsedRequest,
  CodexRequestOptions,
  CodexTextContent,
  CodexThinkingContent,
  CodexTool,
  CodexToolCall,
} from "../types";
import { namespacedToolName } from "../types";
import { responsesRequestSchema } from "./schema";
import { compactionItemToText } from "./compaction";
import { previousResponseReplayPrefixLength } from "./state";
import { decodeReasoningEnvelope } from "./reasoning-envelope";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObj(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function toolAbiSignature(tool: CodexTool): string {
  return canonicalJson({
    name: tool.name,
    namespace: tool.namespace,
    description: tool.description,
    parameters: tool.parameters,
    strict: tool.strict,
    freeform: tool.freeform,
    customFormat: tool.customFormat,
    toolSearch: tool.toolSearch,
  });
}

type InputBlock =
  | { type: "input_text"; text: string }
  | { type: "text"; text: string }
  | { type: "input_image"; image_url?: string; file_id?: string; detail?: string }
  | { type: "input_file"; file_id?: string; filename?: string };

function inputContentParts(blocks: unknown[] | string | undefined): string | CodexContentPart[] {
  if (typeof blocks === "string") return blocks;
  if (!blocks) return [];
  const parts: CodexContentPart[] = [];
  for (const raw of blocks) {
    const block = raw as InputBlock;
    if (block.type === "input_text" || block.type === "text") {
      parts.push({ type: "text", text: (block as { text: string }).text });
    } else if (block.type === "input_image") {
      const b = block as { image_url?: string; file_id?: string; detail?: string };
      if (b.image_url) {
        // Preserve the image as a structured part — adapters send it as a native image block.
        // NEVER inline the (often base64 data-URL) image_url as text: that explodes the token count.
        parts.push({ type: "image", imageUrl: b.image_url, ...(b.detail ? { detail: normalizeImageDetail(b.detail) } : {}) });
      } else {
        parts.push({ type: "text", text: `[image: ${b.file_id ?? "?"}]` }); // file_id ref → no inline data
      }
    } else if (block.type === "input_file") {
      const ref = (block as { file_id?: string; filename?: string }).file_id ?? (block as { filename?: string }).filename ?? "?";
      parts.push({ type: "text", text: `[file: ${ref}]` });
    }
  }
  // Collapse to a plain string only for a single TEXT part; images must stay structured.
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

function containsOpaqueEncryptedContent(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some(block => isObj(block)
    && block.type === "encrypted_content"
    && typeof block.encrypted_content === "string"
    && block.encrypted_content.length > 0);
}

type OutputBlock = { type: "output_text"; text: string } | { type: "text"; text: string } | { type: "refusal"; refusal: string };

function outputTextOf(blocks: unknown[] | string | undefined): CodexTextContent[] {
  if (typeof blocks === "string") return blocks.length > 0 ? [{ type: "text", text: blocks }] : [];
  if (!blocks) return [];
  const out: CodexTextContent[] = [];
  for (const raw of blocks) {
    const b = raw as OutputBlock;
    if (b.type === "output_text" || b.type === "text") out.push({ type: "text", text: (b as { text: string }).text });
    else if (b.type === "refusal") out.push({ type: "text", text: `[refusal: ${(b as { refusal: string }).refusal}]` });
  }
  return out;
}

function mapToolChoice(value: unknown): CodexRequestOptions["toolChoice"] {
  if (value === undefined || value === null) return undefined;
  if (value === "auto" || value === "none" || value === "required") return value;
  if (isObj(value) && "type" in value) {
    const t = (value as { type: string }).type;
    if ((t === "function" || t === "custom") && "name" in value) {
      return { name: (value as { name: string }).name };
    }
    if (t === "allowed_tools" && Array.isArray(value.tools)) {
      const names = value.tools
        .map(allowedToolName)
        .filter((name): name is string => Boolean(name));
      return names.length > 0
        ? { allowedTools: [...new Set(names)], mode: value.mode === "required" ? "required" : "auto" }
        : "none";
    }
    return "auto";
  }
  return undefined;
}

function allowedToolName(tool: unknown): string | undefined {
  if (!isObj(tool)) return undefined;
  if (typeof tool.name === "string" && tool.name.length > 0) return tool.name;
  if (tool.type === "web_search" || tool.type === "web_search_preview") return "web_search";
  if (tool.type === "tool_search") return "tool_search";
  return undefined;
}

const DEFAULT_FUNCTION_NAMESPACE = "functions";

function normalizedToolNamespace(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value !== DEFAULT_FUNCTION_NAMESPACE
    ? value
    : undefined;
}

function buildTools(tools: unknown[] | undefined): CodexTool[] | undefined {
  if (!tools) return undefined;
  const out: CodexTool[] = [];
  const seenWireNames = new Map<string, string>();
  const pushTool = (tool: CodexTool) => {
    const wireName = namespacedToolName(tool.namespace, tool.name);
    const signature = toolAbiSignature(tool);
    const previous = seenWireNames.get(wireName);
    if (previous === signature) return;
    if (previous !== undefined) {
      throw new Error(`responses tool parse error: duplicate Codex tool wire name: ${wireName}`);
    }
    seenWireNames.set(wireName, signature);
    out.push(tool);
  };
  const toolName = (t: Record<string, unknown>, kind: string): string => {
    if (typeof t.name !== "string" || t.name.length === 0
      || t.name.trim() !== t.name || /[\x00-\x1f\x7f]/.test(t.name)) {
      throw new Error(`responses tool parse error: invalid ${kind} tool name`);
    }
    return t.name;
  };
  const toolDescription = (t: Record<string, unknown>, kind: string): string => {
    if (t.description === undefined || t.description === null) return "";
    if (typeof t.description !== "string") {
      throw new Error(`responses tool parse error: invalid ${kind} tool description`);
    }
    return t.description;
  };
  const toolParameters = (t: Record<string, unknown>, kind: string): Record<string, unknown> => {
    if (t.parameters === undefined || t.parameters === null) return {};
    if (!isObj(t.parameters)) {
      throw new Error(`responses tool parse error: invalid ${kind} tool parameters`);
    }
    return t.parameters;
  };
  const customFormat = (t: Record<string, unknown>): CodexTool["customFormat"] => {
    if (t.format === undefined || t.format === null) return undefined;
    if (!isObj(t.format) || typeof t.format.type !== "string") {
      throw new Error("responses tool parse error: invalid custom tool format");
    }
    if (t.format.type === "text") return { type: "text" };
    if (t.format.type === "grammar") {
      if ((t.format.syntax !== "lark" && t.format.syntax !== "regex")
        || typeof t.format.definition !== "string") {
        throw new Error("responses tool parse error: invalid custom tool grammar format");
      }
      return { type: "grammar", syntax: t.format.syntax, definition: t.format.definition };
    }
    throw new Error("responses tool parse error: invalid custom tool format type");
  };
  const pushFn = (t: Record<string, unknown>, namespace?: string) => {
    const tool: CodexTool = {
      name: toolName(t, "function"),
      description: toolDescription(t, "function"),
      parameters: toolParameters(t, "function"),
    };
    if (t.strict !== undefined) {
      if (typeof t.strict !== "boolean") {
        throw new Error("responses tool parse error: invalid function tool strict flag");
      }
      tool.strict = t.strict;
    }
    if (namespace) tool.namespace = namespace;
    pushTool(tool);
  };
  const pushCustom = (t: Record<string, unknown>, namespace?: string) => {
    const format = customFormat(t);
    const tool: CodexTool = {
      name: toolName(t, "custom"),
      description: toolDescription(t, "custom"),
      parameters: { type: "object", properties: { input: { type: "string", description: "Raw tool input. For apply_patch, begin exactly with `*** Begin Patch` (no trailing `***`), then use its standard patch envelope." } }, required: ["input"] },
      freeform: true,
      ...(format ? { customFormat: format } : {}),
    };
    if (namespace) tool.namespace = namespace;
    pushTool(tool);
  };
  for (const t of tools) {
    if (!isObj(t) || typeof t.type !== "string") {
      throw new Error("responses tool parse error: malformed tool entry");
    }
    if (t.type === "function") {
      pushFn(t);
    } else if (t.type === "namespace") {
      // MCP tools arrive grouped under a namespace tool; flatten the inner function tools so
      // chat-completions models receive them (round-trip restores the namespace in the bridge).
      const wireNamespace = toolName(t, "namespace");
      const namespace = normalizedToolNamespace(wireNamespace);
      if (!Array.isArray(t.tools)) {
        throw new Error("responses tool parse error: invalid namespace tools array");
      }
      for (const inner of t.tools as unknown[]) {
        if (!isObj(inner) || typeof inner.type !== "string") {
          throw new Error(`responses tool parse error: malformed nested tool entry in namespace ${wireNamespace}`);
        }
        if (inner.type === "function") pushFn(inner, namespace);
        else if (inner.type === "custom") {
          // Codex's built-in command gateway is transported as namespace `functions` + custom
          // `exec`, but its dedicated MCP route is the historical bare wire name `exec`.
          // Preserve namespace for every other custom tool so names do not collide or misroute.
          pushCustom(inner, wireNamespace === DEFAULT_FUNCTION_NAMESPACE && inner.name === "exec"
            ? undefined
            : wireNamespace);
        }
        // Unknown nested tool kinds stay non-executable until the parser has an explicit ABI for
        // their call/result semantics.
      }
    }
    else if (t.type === "custom") {
      // Freeform custom tool (e.g. apply_patch). Chat models can't emit a lark grammar, so expose a
      // function with a single string `input` carrying the raw tool body; the bridge relays the model's
      // call back as a custom_tool_call (Codex's freeform handler rejects a function_call → fatal abort).
      pushCustom(t);
    }
    else if (t.type === "tool_search") {
      // Client-executed tool discovery — the gateway to deferred tools (subagents, extra MCP tools).
      // Expose as a function so chat models can call it; the bridge relays it as a tool_search_call.
      pushTool({
        name: "tool_search",
        description: t.description === undefined
          ? "Search for additional tools to load for the next turn."
          : toolDescription(t, "tool_search"),
        parameters: (t.parameters === undefined ? {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query for tools to load." },
            limit: { type: "number", description: "Maximum number of tools to return." },
          },
          required: ["query"],
        } : toolParameters(t, "tool_search")),
        toolSearch: true,
      });
    }
    else if ((t.type === "computer_use" || t.type === "computer_use_preview") && typeof t.name === "string") {
      // Explicit compatibility allowlist for named client-executed computer-use definitions.
      // Unknown and OpenAI-hosted kinds remain non-executable until they have a defined call ABI.
      pushFn(t);
    }
  }
  return out.length > 0 ? out : undefined;
}

function ensureAssistantPlaceholder(messages: CodexMessage[], modelId: string, now: number): CodexAssistantMessage {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") return last;
  const placeholder: CodexAssistantMessage = { role: "assistant", content: [], model: modelId, timestamp: now };
  messages.push(placeholder);
  return placeholder;
}

/**
 * Tool-call output content. Preserves images (e.g. Codex `view_image` returns
 * `input_image` items): returns content parts when any image is present, else a plain joined string.
 * Never inlines an image_url as text (that would explode the token count).
 */
function outputToToolResultContent(output: string | unknown[] | undefined): string | CodexContentPart[] {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  const parts: CodexContentPart[] = [];
  let hasImage = false;
  for (const raw of output) {
    if (!isObj(raw)) continue;
    if (raw.type === "output_text" || raw.type === "text" || raw.type === "input_text") {
      if (typeof raw.text === "string") parts.push({ type: "text", text: raw.text });
    } else if (raw.type === "refusal" && typeof raw.refusal === "string") {
      parts.push({ type: "text", text: `[refusal: ${raw.refusal}]` });
    } else if (raw.type === "input_image" && typeof raw.image_url === "string") {
      parts.push({ type: "image", imageUrl: raw.image_url, ...(typeof raw.detail === "string" ? { detail: normalizeImageDetail(raw.detail) } : {}) });
      hasImage = true;
    } else if (raw.type === "encrypted_content") {
      // codex-rs FunctionCallOutputContentItem::EncryptedContent — opaque to routed models.
      parts.push({ type: "text", text: "[encrypted content omitted]" });
    }
  }
  if (!hasImage) return parts.map(p => (p.type === "text" ? p.text : "")).join("");
  return parts;
}

/**
 * codex-rs ImageDetail allows "original", but chat-completions providers only accept
 * auto|low|high on image_url.detail — degrade "original" to "high" (the codex default).
 */
function normalizeImageDetail(detail: string): string {
  return detail === "original" ? "high" : detail;
}

function findToolById(messages: CodexMessage[], callId: string): { name: string; namespace?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (const part of m.content) {
      if (part.type === "toolCall" && part.id === callId) return { name: part.name, namespace: part.namespace };
    }
  }
  return { name: "" };
}

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function parseRequest(body: unknown): CodexParsedRequest {
  const replayedInputPrefixLength = previousResponseReplayPrefixLength(body);
  const parsed = responsesRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`responses parse error: ${parsed.error.message}`);
  }
  const data = parsed.data;
  const now = Date.now();
  const messages: CodexMessage[] = [];
  const systemPrompt: string[] = [];
  // Responses reasoning siblings belong to the following assistant, including across call items.
  // Keep them off the message list until that assistant arrives; turn boundaries clear the array.
  const pendingReasoning: Array<{ part: CodexThinkingContent; envelopeSigned: boolean }> = [];
  // Assistant placeholder that folds pending reasoning into the same turn before tool calls.
  const assistantHolderWithReasoning = (): CodexAssistantMessage => {
    const holder = ensureAssistantPlaceholder(messages, data.model, now);
    if (pendingReasoning.length > 0) {
      holder.content.push(...pendingReasoning.map(entry => entry.part));
      pendingReasoning.length = 0;
    }
    return holder;
  };
  // Tool specs surfaced by a prior tool_search (deferred tools, e.g. subagents). Codex does not
  // re-list these in `tools`, but chat models can only call listed tools — so we re-inject them.
  const loadedToolSpecs: unknown[] = [];
  // Remote compaction v2: the input tail carries `{type:"compaction_trigger"}` and Codex expects a
  // synthetic `{type:"compaction"}` output item (src/responses/compaction.ts). Flagged for the server.
  let compactionRequest = false;
  let opaqueMultiAgentV2Payload = false;

  if (typeof data.instructions === "string" && data.instructions.length > 0) {
    systemPrompt.push(data.instructions);
  }

  if (typeof data.input === "string") {
    messages.push({ role: "user", content: data.input, timestamp: now });
  } else if (data.input) {
    for (const item of data.input) {
      const effectiveType = (item as { type?: string }).type ?? ("role" in item ? "message" : undefined);

      if (effectiveType === "compaction_trigger") {
        compactionRequest = true;
        continue;
      }

      if (effectiveType === "additional_tools") {
        // Codex Desktop responses_lite WS path: tools ride INSIDE input as an
        // `additional_tools` item ({type, role, tools:[...]}) instead of body.tools.
        // Same spec wire shapes (function/namespace/custom/tool_search) — collect and
        // merge through the exact buildTools path so surface detection (collabSurface)
        // and chat-model tool listing see them. The item itself never becomes a message;
        // the native passthrough keeps it verbatim in _rawBody.
        const at = item as { tools?: unknown[] };
        if (Array.isArray(at.tools)) loadedToolSpecs.push(...at.tools);
        continue;
      }

      if (effectiveType === "compaction" || effectiveType === "compaction_summary" || effectiveType === "context_compaction") {
        // A stored summary from a previous compaction. Decode our ocx1 envelope into plain text so
        // the routed model keeps the compacted context; real OpenAI-encrypted blobs degrade to a note.
        // `context_compaction` (encrypted_content optional) is codex-rs's local-compaction marker;
        // with no payload it is a pure marker (the summary follows as its own user message), so it
        // is dropped silently. It must not flag `_compactionRequest`.
        const encrypted = (item as { encrypted_content?: unknown }).encrypted_content;
        if (effectiveType === "context_compaction" && typeof encrypted !== "string") continue;
        pendingReasoning.length = 0;
        messages.push({
          role: "user",
          content: compactionItemToText(typeof encrypted === "string" ? encrypted : undefined),
          timestamp: now,
        });
        continue;
      }

      if (effectiveType === "agent_message") {
        const agentMessage = item as {
          author?: string;
          recipient?: string;
          content?: unknown;
        };

        if (containsOpaqueEncryptedContent(agentMessage.content)) {
          opaqueMultiAgentV2Payload = true;
        }

        const content = inputContentParts(
          agentMessage.content as unknown[] | string | undefined,
        );

        const hasContent =
          typeof content === "string"
            ? content.trim().length > 0
            : content.length > 0;

        // An agent_message is external input delivered to the parent agent.
        // Preserve it as a user-role turn so signed reasoning blocks
        // on either side are never merged into one modified assistant response.
        pendingReasoning.length = 0;
        messages.push({
          role: "user",
          content: hasContent ? content : "(sub-agent message received)",
          timestamp: now,
        });

        continue;
      }

      if (effectiveType === "message") {
        const msg = item as { role?: string; content?: unknown; phase?: "commentary" | "final_answer" };
        switch (msg.role) {
          case "system": {
            pendingReasoning.length = 0;
            const text = inputContentParts(msg.content as unknown[] | string | undefined);
            const flat = typeof text === "string" ? text : text.map(p => (p.type === "text" ? p.text : "")).join("");
            if (flat.length > 0) systemPrompt.push(flat);
            break;
          }
          case "user":
          case "developer": {
            pendingReasoning.length = 0;
            const content = inputContentParts(msg.content as unknown[] | string | undefined);
            messages.push({ role: msg.role, content, timestamp: now });
            break;
          }
          case "assistant": {
            const parts = outputTextOf(msg.content as unknown[] | string | undefined);
            messages.push({
              role: "assistant",
              content: pendingReasoning.length > 0
                ? [...pendingReasoning.map(entry => entry.part), ...parts]
                : parts,
              ...(msg.phase ? { phase: msg.phase } : {}),
              model: data.model,
              timestamp: now,
            });
            pendingReasoning.length = 0;
            break;
          }
        }
        continue;
      }

      if (effectiveType === "reasoning") {
        const reasoning = item as { id?: string; summary?: { text: string }[]; content?: { text: string }[]; encrypted_content?: string };
        const fromSummary = (reasoning.summary ?? []).map(c => c.text).join("");
        const text = fromSummary || (reasoning.content ?? []).map(c => c.text).join("");
        const envelope = typeof reasoning.encrypted_content === "string"
          ? decodeReasoningEnvelope(reasoning.encrypted_content)
          : null;
        const thinkingText = envelope?.txt || text;

        // Native/non-ocxr1 encrypted-only reasoning is opaque here. Do not create a detached
        // assistant turn or invent replayable plaintext/signatures from the encrypted payload.
        if (thinkingText.length > 0) {
          const part: CodexThinkingContent = {
            type: "thinking",
            thinking: thinkingText,
            signature: envelope?.sig ?? JSON.stringify(reasoning),
            ...(envelope?.red ? { redacted: envelope.red } : {}),
            ...(reasoning.id ? { itemId: reasoning.id } : {}),
          };
          const envelopeSigned = typeof envelope?.sig === "string";
          const previous = pendingReasoning[pendingReasoning.length - 1];

          if (!envelopeSigned && previous && !previous.envelopeSigned) {
            previous.part = {
              ...part,
              thinking: `${previous.part.thinking}\n${part.thinking}`,
            };
          } else {
            pendingReasoning.push({ part, envelopeSigned });
          }
        }
        continue;
      }

      if (effectiveType === "function_call") {
        const call = item as { id?: string; call_id: string; name: string; arguments?: string; namespace?: string };
        // Tolerate empty/non-JSON arguments (e.g. a no-arg tool call serialized as "") instead of
        // throwing — a single poisoned history item would otherwise 400 every subsequent turn.
        let args: Record<string, unknown> = {};
        const rawArgs = call.arguments?.trim();
        if (rawArgs) {
          try {
            const parsed: unknown = JSON.parse(rawArgs);
            if (isObj(parsed)) args = parsed;
          } catch {
            console.warn(`[parser] function_call ${call.call_id} has non-JSON arguments; defaulting to {}`);
          }
        }
        // Do NOT map Responses item `id` (fc_/ctc_/…) onto `thoughtSignature`. That field is
        // reserved for genuine opaque thought tokens. A Responses item id is not such a token;
        // continuity comes from the in-process replay cache and any real stored signature.
        const toolCall: CodexToolCall = {
          type: "toolCall", id: call.call_id, name: call.name, arguments: args,
          ...(call.namespace ? { namespace: call.namespace } : {}),
        };
        assistantHolderWithReasoning().content.push(toolCall);
        continue;
      }

      if (effectiveType === "custom_tool_call") {
        const call = item as { id?: string; call_id: string; name: string; input: string; namespace?: string };
        const namespace = call.namespace === "functions" && call.name === "exec"
          ? undefined
          : call.namespace;
        const toolCall: CodexToolCall = {
          type: "toolCall", id: call.call_id, name: call.name,
          arguments: { input: call.input ?? "" },
          customWireName: call.name,
          ...(namespace ? { namespace } : {}),
        };
        assistantHolderWithReasoning().content.push(toolCall);
        continue;
      }

      if (effectiveType === "local_shell_call") {
        // codex-rs LocalShellCall replay: pair it as an assistant toolCall so the subsequent
        // function_call_output (same call_id) doesn't become an orphaned tool result.
        const call = item as { id?: string; call_id?: string; action?: { type?: string; command?: string[] } };
        const callId = call.call_id ?? call.id;
        if (callId) {
          const command = Array.isArray(call.action?.command) ? call.action.command : [];
          assistantHolderWithReasoning().content.push({
            type: "toolCall", id: callId, name: "shell",
            arguments: command.length > 0 ? { command } : {},
          });
        }
        continue;
      }

      if (effectiveType === "web_search_call") {
        // Replayed hosted web-search evidence has no paired result payload that routed providers can
        // consume. Keep it out of assistant-visible text so the model cannot echo it as a fake result.
        pendingReasoning.length = 0;
        continue;
      }

      if (effectiveType === "tool_search_call") {
        // Preserve the model's prior tool_search call as an assistant tool call so multi-turn
        // history stays complete (otherwise the model re-issues tool_search forever).
        const call = item as { id?: string; call_id?: string; arguments?: unknown };
        const callId = call.call_id ?? call.id ?? "";
        assistantHolderWithReasoning().content.push({
          type: "toolCall", id: callId, name: "tool_search",
          arguments: isObj(call.arguments) ? call.arguments : {},
        });
        continue;
      }

      if (effectiveType === "tool_search_output") {
        pendingReasoning.length = 0;
        // Pair the tool_search call with its result so the model sees what was loaded.
        const out = item as { call_id?: string; status?: string; tools?: unknown[] };
        const specs = Array.isArray(out.tools) ? (out.tools as Record<string, unknown>[]) : [];
        loadedToolSpecs.push(...specs);
        // List the EXACT wire names the model must call (flattened for namespaced specs), matching
        // how buildTools exposes them — otherwise the model guesses wrong names (e.g. the bare namespace).
        const wireNames = (buildTools(specs) ?? [])
          .map(tool => namespacedToolName(tool.namespace, tool.name));
        const failed = typeof out.status === "string" && out.status !== "completed" && out.status !== "success";
        messages.push({
          role: "toolResult", toolCallId: out.call_id ?? "", toolName: "tool_search",
          content: failed && wireNames.length === 0
            ? `Tool search failed (status: ${out.status}).`
            : wireNames.length
              ? `Tool search loaded these tools — they are now in your available tools. Call one by its EXACT name: ${wireNames.join(", ")}.`
              : "Tool search returned no tools.",
          isError: failed && wireNames.length === 0, timestamp: now,
        });
        continue;
      }

      if (effectiveType === "function_call_output") {
        pendingReasoning.length = 0;
        const output = item as { call_id: string; output?: string | unknown[] };
        const toolInfo = findToolById(messages, output.call_id);
        messages.push({
          role: "toolResult", toolCallId: output.call_id,
          toolName: toolInfo.name, toolNamespace: toolInfo.namespace,
          content: outputToToolResultContent(output.output), isError: false, timestamp: now,
        });
        continue;
      }

      if (effectiveType === "custom_tool_call_output") {
        pendingReasoning.length = 0;
        const output = item as { call_id: string; output: string | unknown[] };
        const toolInfo = findToolById(messages, output.call_id);
        messages.push({
          role: "toolResult", toolCallId: output.call_id,
          toolName: toolInfo.name, toolNamespace: toolInfo.namespace,
          // Same payload shape as function_call_output (codex-rs FunctionCallOutputPayload):
          // string or content items — normalize arrays instead of leaking raw wire blocks.
          content: outputToToolResultContent(output.output), isError: false, timestamp: now,
        });
      }
    }
  }

  const declaredTools = buildTools(data.tools as unknown[] | undefined) ?? [];
  const loadedTools = buildTools(loadedToolSpecs) ?? [];
  const loadedToolNames = new Set(loadedTools.map(t => namespacedToolName(t.namespace, t.name)));
  const seenTools = new Map<string, string>();
  const mergedTools = [...declaredTools, ...loadedTools]
    .filter(t => {
      const k = namespacedToolName(t.namespace, t.name);
      const signature = toolAbiSignature(t);
      const previous = seenTools.get(k);
      if (previous === signature) return false;
      if (previous !== undefined) {
        throw new Error(`responses tool parse error: duplicate Codex tool wire name: ${k}`);
      }
      seenTools.set(k, signature);
      return true;
    })
    .map(t => loadedToolNames.has(namespacedToolName(t.namespace, t.name))
      ? { ...t, loadedFromToolSearch: true }
      : t);
  const context: CodexContext = {
    ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
    messages,
    ...(mergedTools.length > 0 ? { tools: mergedTools } : {}),
  };

  const options: CodexRequestOptions = {};
  if (data.max_output_tokens !== undefined) options.maxOutputTokens = data.max_output_tokens;
  if (data.temperature !== undefined) options.temperature = data.temperature;
  if (data.top_p !== undefined) options.topP = data.top_p;
  if (data.stop !== undefined && data.stop !== null) {
    options.stopSequences = typeof data.stop === "string" ? [data.stop] : data.stop;
  }
  const tc = mapToolChoice(data.tool_choice);
  if (tc !== undefined) options.toolChoice = tc;
  if (data.parallel_tool_calls !== undefined) options.parallelToolCalls = data.parallel_tool_calls;
  // Upstream codex-rs converts "ultra" to "max" at the inference boundary (core/src/client.rs
  // `reasoning_effort_for_request`), so current clients never send it — but a catalog that
  // advertises ultra plus an older/direct caller can. Degrade it to max like upstream instead of
  // silently dropping reasoning altogether.
  const requestedEffort = data.reasoning?.effort === "ultra" ? "max" : data.reasoning?.effort;
  if (requestedEffort && REASONING_EFFORTS.has(requestedEffort)) {
    options.reasoning = requestedEffort;
  }
  const summaryMode = data.reasoning?.summary;
  if (!summaryMode || summaryMode === "none") options.hideThinkingSummary = true;
  if (data.presence_penalty !== undefined) options.presencePenalty = data.presence_penalty;
  if (data.frequency_penalty !== undefined) options.frequencyPenalty = data.frequency_penalty;
  if (data.service_tier !== undefined) options.serviceTier = data.service_tier;
  if (data.prompt_cache_key !== undefined) options.promptCacheKey = data.prompt_cache_key;

  return {
    modelId: data.model,
    ...(data.previous_response_id ? { previousResponseId: data.previous_response_id } : {}),
    context,
    stream: data.stream === true,
    options,
    _rawBody: body,
    ...(replayedInputPrefixLength > 0 ? { _replayPrefixLen: replayedInputPrefixLength } : {}),
    ...(compactionRequest ? { _compactionRequest: true } : {}),
    ...(opaqueMultiAgentV2Payload ? { _opaqueMultiAgentV2Payload: true } : {}),
  };
}
