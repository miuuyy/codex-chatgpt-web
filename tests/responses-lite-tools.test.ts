import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { responseRequest } from "../src/server";

const freeformFormat = {
  type: "grammar",
  syntax: "lark",
  definition: 'start: "tool"',
};

function responsesLiteTools() {
  return [{
    type: "namespace",
    name: "functions",
    description: "",
    tools: [
      { type: "custom", name: "exec", description: "Run native Codex code", format: freeformFormat },
      {
        type: "function",
        name: "wait",
        description: "Wait for native Codex code",
        strict: false,
        parameters: { type: "object", properties: {} },
      },
    ],
  }, {
    type: "namespace",
    name: "mcp__python",
    description: "Python tools",
    tools: [{
      type: "custom",
      name: "run_script",
      description: "Run a Python script",
      format: freeformFormat,
    }],
  }];
}

test("Responses Lite exposes native exec from the default functions namespace only", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/luna",
    input: [{ type: "additional_tools", role: "developer", tools: responsesLiteTools() }],
  });

  expect(parsed.context.tools).toContainEqual(expect.objectContaining({
    name: "exec",
    freeform: true,
  }));
  const waitTool = parsed.context.tools?.find(tool => tool.name === "wait");
  expect(waitTool).toEqual(expect.objectContaining({ name: "wait" }));
  expect(waitTool).not.toHaveProperty("namespace");
  expect(parsed.context.tools?.some(tool => tool.name === "run_script")).toBe(false);
});

test("Responses Lite native exec survives a complete server request as one custom call", async () => {
  const config = defaultConfig("full");
  config.solAvailable = false;
  config.proAvailable = false;
  const turnId = "turn_responses_lite_exec_regression";
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      stream: false,
      metadata: { turn_id: turnId, thread_id: "thread_responses_lite_exec_regression" },
      input: [{
        type: "additional_tools",
        role: "developer",
        tools: responsesLiteTools().slice(0, 1),
      }, {
        type: "message",
        id: "msg_responses_lite_exec_regression",
        role: "user",
        content: [{ type: "input_text", text: "Use the native exec tool" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    }),
  }), config, () => ({
    name: "responses-lite-exec-regression",
    async runTurn(parsed, _incoming, emit) {
      expect(parsed.context.tools).toContainEqual(expect.objectContaining({ name: "exec", freeform: true }));
      emit({ type: "tool_call_start", id: "call_exec", name: "exec" });
      emit({ type: "tool_call_delta", arguments: JSON.stringify({ input: "text('ok')" }) });
      emit({ type: "tool_call_end" });
      emit({ type: "done", endTurn: false });
    },
  }), { rememberState: false });

  expect(response.status).toBe(200);
  const body = await response.json() as { output: Array<Record<string, unknown>> };
  const calls = body.output.filter(item => item.type === "custom_tool_call");
  expect(calls).toEqual([expect.objectContaining({
    call_id: "call_exec",
    name: "exec",
    input: "text('ok')",
  })]);
});

test("Responses Lite relays deferred tool discovery as a client tool_search call", async () => {
  const config = defaultConfig("full");
  config.solAvailable = false;
  config.proAvailable = false;
  const turnId = "turn_responses_lite_tool_search_regression";
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      stream: false,
      metadata: { turn_id: turnId, thread_id: "thread_responses_lite_tool_search_regression" },
      input: [{
        type: "additional_tools",
        role: "developer",
        tools: [{
          type: "tool_search",
          description: "Discover deferred tools",
          parameters: {
            type: "object",
            properties: { query: { type: "string" }, limit: { type: "number" } },
            required: ["query"],
          },
        }],
      }, {
        type: "message",
        id: "msg_responses_lite_tool_search_regression",
        role: "user",
        content: [{ type: "input_text", text: "Discover the requested tool" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    }),
  }), config, () => ({
    name: "responses-lite-tool-search-regression",
    async runTurn(parsed, _incoming, emit) {
      expect(parsed.context.tools).toContainEqual(expect.objectContaining({
        name: "tool_search",
        toolSearch: true,
      }));
      emit({ type: "tool_call_start", id: "call_tool_search", name: "tool_search" });
      emit({ type: "tool_call_delta", arguments: JSON.stringify({ query: "GitHub issue", limit: 5 }) });
      emit({ type: "tool_call_end" });
      emit({ type: "done", endTurn: false });
    },
  }), { rememberState: false });

  expect(response.status).toBe(200);
  const body = await response.json() as { output: Array<Record<string, unknown>> };
  expect(body.output.filter(item => item.type === "tool_search_call")).toEqual([
    expect.objectContaining({
      call_id: "call_tool_search",
      execution: "client",
      arguments: { query: "GitHub issue", limit: 5 },
      status: "completed",
    }),
  ]);
});
