import { expect, test } from "bun:test";
import {
  chatgptWebBlockedGatewayWireNames,
  isSpawnCollaborationWireName,
} from "../src/collaboration-tools";
import { parseRequest } from "../src/responses/parser";
import { transportBoundRawExecProgram } from "../src/adapters/chatgpt-web/mcp-server";

const collaborationTools = [
  {
    type: "function",
    name: "exec_command",
    description: "Run a command",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "namespace",
    name: "collaboration",
    tools: [
      {
        type: "function",
        name: "spawn_agent",
        description: "Spawn a sub-agent",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "send_message",
        description: "Message an agent",
        parameters: { type: "object", properties: {} },
      },
    ],
  },
  {
    type: "namespace",
    name: "multi_agent_v1",
    tools: [
      {
        type: "function",
        name: "spawn_agent",
        description: "Compatibility V1 spawn",
        parameters: { type: "object", properties: {} },
      },
    ],
  },
];

test("ChatGPT Web requests keep collaboration tools when Web sub-agents are allowed", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/pro",
    tools: collaborationTools,
  }, { allowWebSubagents: true });
  const names = (parsed.context.tools ?? []).map(tool => tool.name);
  expect(names).toContain("exec_command");
  expect(names).toContain("spawn_agent");
  expect(names).toContain("send_message");
});

test("ChatGPT Web requests drop collaboration tools so spawn_agent is not advertised", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/pro",
    tools: collaborationTools,
  });

  const names = (parsed.context.tools ?? []).map(tool => tool.name);
  expect(names).toContain("exec_command");
  expect(names).not.toContain("spawn_agent");
  expect(names).not.toContain("send_message");
  expect(parsed.context.tools?.some(tool => tool.namespace === "collaboration")).toBe(false);
  expect(parsed.context.tools?.some(tool => tool.namespace === "multi_agent_v1")).toBe(false);
});

test("official and CPA requests keep collaboration tools for spawn_agent", () => {
  for (const model of ["gpt-5.6-sol", "CPA/gemini-3-pro"]) {
    const parsed = parseRequest({ model, tools: collaborationTools });
    const names = (parsed.context.tools ?? []).map(tool => tool.name);
    expect(names).toContain("exec_command");
    expect(names).toContain("spawn_agent");
    expect(names).toContain("send_message");
    expect(parsed.context.tools?.some(tool => tool.namespace === "collaboration")).toBe(true);
  }
});

test("ChatGPT Web gateway exclusions keep spawn_agent from being reopened", () => {
  const blocked = chatgptWebBlockedGatewayWireNames();
  expect(blocked).toContain("spawn_agent");
  expect(blocked).toContain("collaboration__spawn_agent");
  expect(blocked).toContain("multi_agent_v1__spawn_agent");
  expect(blocked).toContain("collaboration__send_message");
  expect(blocked).not.toContain("collaboration__wait_agent");
  expect(isSpawnCollaborationWireName("collaboration__spawn_agent")).toBe(true);
  expect(isSpawnCollaborationWireName("multi_agent_v2__followup_task")).toBe(true);
  expect(isSpawnCollaborationWireName("collaboration__wait_agent")).toBe(false);
  expect(isSpawnCollaborationWireName("exec_command")).toBe(false);
});

test("Web sub-agent filtering preserves unrelated namespaced messaging tools", () => {
  for (const name of ["send_message", "list_agents", "spawn_agent"]) {
    const parsed = parseRequest({
      model: "chatgpt-web/pro",
      tools: [{ type: "namespace", name: "slack", tools: [
        { type: "function", name, parameters: { type: "object", properties: {} } },
      ] }],
    });
    expect(parsed.context.tools?.map(tool => tool.name)).toEqual([name]);
    expect(isSpawnCollaborationWireName(`slack__${name}`)).toBe(false);
    expect(chatgptWebBlockedGatewayWireNames()).not.toContain(`slack__${name}`);
  }
});

test("current collaboration namespace and normalized gateway names obey the same setting", async () => {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  for (const namespace of ["collaboration", "multi_agent_v1", "multi_agent_v2", "collaboration-optimize", "collaboration_optimize"]) {
    const wireName = `${namespace}__spawn_agent`;
    const request = {
      model: "chatgpt-web/pro",
      tools: [{ type: "namespace", name: namespace, tools: [
        { type: "function", name: "spawn_agent", parameters: { type: "object", properties: {} } },
      ] }],
    };
    expect(parseRequest(request).context.tools ?? []).toEqual([]);
    expect(parseRequest(request, { allowWebSubagents: true }).context.tools).toHaveLength(1);
    expect(isSpawnCollaborationWireName(wireName)).toBe(true);
    let calls = 0;
    const tools = { [wireName]: async () => { calls++; } };
    const input = `await tools[${JSON.stringify(wireName)}]({});`;
    const blocked = new AsyncFunction("tools", transportBoundRawExecProgram(input, "exec", chatgptWebBlockedGatewayWireNames()));
    await expect(blocked(tools)).rejects.toThrow("ChatGPT Web cannot run Codex");
    expect(calls).toBe(0);
    const allowed = new AsyncFunction("tools", transportBoundRawExecProgram(input, "exec", []));
    await allowed(tools);
    expect(calls).toBe(1);
  }
});

test("raw gateway preserves unrelated messaging tools while sub-agents are disabled", async () => {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  let calls = 0;
  const program = new AsyncFunction("tools", transportBoundRawExecProgram(
    "await tools.slack__send_message({});", "exec", chatgptWebBlockedGatewayWireNames(),
  ));
  await program({ slack__send_message: async () => { calls++; } });
  expect(calls).toBe(1);
});
