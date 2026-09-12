import { expect, test } from "bun:test";
import {
  chatgptWebBlockedGatewayWireNames,
  isSpawnCollaborationWireName,
} from "../src/collaboration-tools";
import { parseRequest } from "../src/responses/parser";

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
