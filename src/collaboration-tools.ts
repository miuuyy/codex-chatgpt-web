import type { CodexTool } from "./types";

export const COLLABORATION_TOOL_NAMES = new Set([
  "spawn_agent",
  "followup_task",
  "send_message",
  "list_agents",
  "wait_agent",
  "interrupt_agent",
]);

export const COLLABORATION_NAMESPACES = [
  "collaboration",
  "collaboration-optimize",
  "collaboration_optimize",
  "multi_agent_v1",
  "multi_agent_v2",
] as const;

const SPAWN_FAMILY_NAMES = new Set([
  "spawn_agent",
  "followup_task",
  "send_message",
  "list_agents",
]);

function collaborationBaseName(wireName: string): string | undefined {
  const lower = wireName.toLowerCase();
  const separator = lower.lastIndexOf("__");
  if (separator === -1) return lower;
  return (COLLABORATION_NAMESPACES as readonly string[]).includes(lower.slice(0, separator))
    ? lower.slice(separator + 2)
    : undefined;
}

export function isCollaborationTool(tool: CodexTool): boolean {
  const namespace = (tool.namespace ?? "").toLowerCase();
  if ((COLLABORATION_NAMESPACES as readonly string[]).includes(namespace)) return true;
  // A short name inside an unrelated namespace is not a Codex collaboration tool.
  if (namespace) return false;
  const name = collaborationBaseName(tool.name);
  return name !== undefined && COLLABORATION_TOOL_NAMES.has(name);
}

export function isSpawnCollaborationWireName(name: string): boolean {
  const baseName = collaborationBaseName(name);
  return baseName !== undefined && SPAWN_FAMILY_NAMES.has(baseName);
}

export function chatgptWebBlockedGatewayWireNames(): string[] {
  const names = new Set<string>(SPAWN_FAMILY_NAMES);
  for (const namespace of COLLABORATION_NAMESPACES) {
    for (const tool of SPAWN_FAMILY_NAMES) names.add(`${namespace}__${tool}`);
  }
  return [...names];
}
