import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

function collaborationEvents(name: string): AdapterEvent[] {
  return [
    { type: "tool_call_start", id: `call_${name}`, name: `collaboration__${name}` },
    { type: "tool_call_delta", arguments: '{"message":"plain task"}' },
    { type: "tool_call_end" },
    { type: "done", endTurn: false, stopReason: "tool_use" },
  ];
}

const collaborationMap = new Map([
  ["collaboration__spawn_agent", { namespace: "collaboration", name: "spawn_agent" }],
  ["collaboration__send_message", { namespace: "collaboration", name: "send_message" }],
  ["collaboration__followup_task", { namespace: "collaboration", name: "followup_task" }],
  ["collaboration__wait_agent", { namespace: "collaboration", name: "wait_agent" }],
]);

async function* streamed(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  yield* events;
}

describe("MultiAgent V2 plaintext collaboration contract", () => {
  for (const name of ["spawn_agent", "send_message", "followup_task"]) {
    test(`marks ${name} arguments as explicit plaintext in JSON and SSE`, async () => {
      const events = collaborationEvents(name);
      const response = buildResponseJSON(events, "chatgpt-web/pro", {
        toolNsMap: collaborationMap,
      }) as { output: Array<Record<string, unknown>> };
      expect(response.output.at(-1)).toMatchObject({
        type: "function_call",
        namespace: "collaboration",
        name,
        encrypted_function_args: [],
      });

      const body = await new Response(bridgeToResponsesSSE(
        streamed(events),
        "chatgpt-web/pro",
        collaborationMap,
      )).text();
      const items = body
        .split("\n")
        .filter(line => line.startsWith("data: "))
        .flatMap(line => {
          const payload = line.slice(6);
          if (payload === "[DONE]") return [];
          const event = JSON.parse(payload) as { type?: string; item?: Record<string, unknown> };
          return event.type === "response.output_item.done" && event.item ? [event.item] : [];
        });
      expect(items.at(-1)).toMatchObject({
        namespace: "collaboration",
        name,
        encrypted_function_args: [],
      });
    });
  }

  test("does not mark non-message collaboration calls", () => {
    const response = buildResponseJSON(collaborationEvents("wait_agent"), "chatgpt-web/pro", {
      toolNsMap: collaborationMap,
    }) as { output: Array<Record<string, unknown>> };
    expect(response.output.at(-1)).not.toHaveProperty("encrypted_function_args");
  });
});
