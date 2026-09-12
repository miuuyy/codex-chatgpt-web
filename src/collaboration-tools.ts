import type { CodexTool } from "./types";

export const COLLABORATION_TOOL_NAMES = new Set([
  "spawn_agent",
  "followup_task",
  "send_message",
  "list_agents",
  "wait_agent",
]);

export const COLLABORATION_NAMESPACES = [
  "collaboration",
  "multi_agent_v1",
  "multi_agent_v2",
] as const;

const SPAWN_FAMILY_NAMES = new Set([
  "spawn_agent",
  "followup_task",
  "send_message",
  "list_agents",
]);

function collaborationBaseName(wireName: string): string {
  const lower = wireName.toLowerCase();
  const separator = lower.lastIndexOf("__");
  return separator === -1 ? lower : lower.slice(separator + 2);
}

export function isCollaborationTool(tool: CodexTool): boolean {
  const namespace = (tool.namespace ?? "").toLowerCase();
  if ((COLLABORATION_NAMESPACES as readonly string[]).includes(namespace)) return true;
  const name = tool.name.toLowerCase();
  return name.startsWith("collaboration__")
    || name.startsWith("multi_agent_v1__")
    || name.startsWith("multi_agent_v2__")
    || COLLABORATION_TOOL_NAMES.has(name);
}

export function isSpawnCollaborationWireName(name: string): boolean {
  return SPAWN_FAMILY_NAMES.has(collaborationBaseName(name));
}

export function chatgptWebBlockedGatewayWireNames(): string[] {
  const names = new Set<string>(SPAWN_FAMILY_NAMES);
  for (const namespace of COLLABORATION_NAMESPACES) {
    for (const tool of SPAWN_FAMILY_NAMES) names.add(`${namespace}__${tool}`);
  }
  return [...names];
}
