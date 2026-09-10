import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_COMPACTION_CONTROL_WIRE_NAME } from "../src/adapters/chatgpt-web/native-compaction-control";
import {
  callTurnBroker,
  RemoteTurnBroker,
  TurnBroker,
  type BrokerToolResult,
} from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

const testTempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
const root = mkdtempSync(join(testTempRoot, "cgw-zero-risk-mcp-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const nonceA = "surface_nonce_A_0123456789";
const nonceB = "surface_nonce_B_0123456789";

function endpoint(name: string): string {
  return defaultBrokerEndpoint(join(root, name));
}

function environment(tools: ChatGptTurnEnvironment["tools"] = []): ChatGptTurnEnvironment {
  return {
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools,
  };
}

function toolResult(value: Record<string, unknown>): BrokerToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

describe("Zero Risk turn broker lifecycle", () => {
  test("requires both Launcher Sent and connector start before tools can run", async () => {
    const socketPath = endpoint("strict-lifecycle");
    const broker = TurnBroker.forSocket(socketPath);
    try {
      // The TTL bounds human setup, not local named-pipe scheduling. Keep enough margin for loaded
      // Windows CI, then cross that exact boundary after activation to prove the turn remains live.
      const setupTtlMs = 5_000;
      const requestId = await broker.registerSafe(environment(), nonceA, setupTtlMs, "safe-lifecycle");
      const earlyClaim = callTurnBroker<{ bindingId: string }>(
        socketPath,
        { method: "claim", token: requestId, contract: "safe" },
        null,
      );
      expect(await Promise.race([
        earlyClaim.then(() => "claimed"),
        Bun.sleep(20).then(() => "waiting_for_confirmation"),
      ])).toBe("waiting_for_confirmation");
      await expect(callTurnBroker(socketPath, { method: "claim", token: requestId, contract: "native" }))
        .rejects.toThrow("requires the Zero Risk MCP contract");
      expect(() => broker.startSafeTurn("request_missing_012345678901234567890123"))
        .toThrow("request_id is invalid");

      const started = broker.waitForSafeStart(requestId);
      const ownerBatch = broker.nextToolBatch(requestId);
      expect(await Promise.race([
        ownerBatch.then(() => "delivered"),
        Bun.sleep(20).then(() => "waiting_for_start"),
      ])).toBe("waiting_for_start");
      expect(() => broker.confirmSafeTurnSent(requestId, nonceB)).toThrow("local browser binding does not match");
      expect(broker.confirmSafeTurnSent(requestId, nonceA)).toEqual({ confirmed: true, duplicate: false });
      await expect(earlyClaim).rejects.toThrow("codex_turn_start");
      expect(await Promise.race([
        started.then(() => "started"),
        Bun.sleep(20).then(() => "waiting_for_connector"),
      ])).toBe("waiting_for_connector");
      expect(broker.startSafeTurn(requestId)).toEqual({ started: true, duplicate: false });
      await started;
      expect(broker.confirmSafeTurnSent(requestId, nonceA)).toEqual({ confirmed: true, duplicate: true });
      expect(broker.startSafeTurn(requestId)).toEqual({ started: true, duplicate: true });

      await Bun.sleep(setupTtlMs + 25);
      const claimed = await callTurnBroker<{ bindingId: string; activityId: string }>(socketPath, {
        method: "claim",
        token: requestId,
        contract: "safe",
      });
      const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
        method: "invoke",
        bindingId: claimed.bindingId,
        wireName: "exec_command",
        freeform: false,
        arguments: { cmd: "pwd" },
      }, null);
      const [request] = await ownerBatch;
      expect(request).toMatchObject({ wireName: "exec_command", arguments: { cmd: "pwd" } });
      expect(() => broker.completeSafeTurn(requestId, "premature"))
        .toThrow("1 pending Codex tool invocation");
      broker.completeTool(requestId, request!.callId, toolResult({ output: root }));
      await expect(invocation).resolves.toMatchObject({ structuredContent: { output: root } });
      expect(() => broker.completeSafeTurn(requestId, "activity still settling"))
        .toThrow("1 active Codex MCP request");
      await callTurnBroker(socketPath, {
        method: "activity_complete",
        token: requestId,
        activityId: claimed.activityId,
      });

      const completed = broker.waitForSafeCompletion(requestId);
      expect(broker.completeSafeTurn(requestId, "final answer")).toEqual({
        completed: true,
        duplicate: false,
      });
      await expect(completed).resolves.toBe("final answer");
      expect(broker.completeSafeTurn(requestId, "final answer")).toEqual({
        completed: true,
        duplicate: true,
      });
      expect(() => broker.completeSafeTurn(requestId, "conflicting answer"))
        .toThrow("conflicts with the accepted final_answer");
      expect(() => broker.completeSafeTurn(requestId, "   ")).toThrow("must not be empty");
      await expect(callTurnBroker(socketPath, { method: "claim", token: requestId, contract: "safe" }))
        .rejects.toThrow("already terminal");
    } finally {
      await broker.close();
    }
  }, 15_000);

  test("holds an early Zero Risk completion behind the Launcher confirmation", async () => {
    const socketPath = endpoint("early-completion");
    const broker = TurnBroker.forSocket(socketPath);
    try {
      const requestId = await broker.registerSafe(environment(), nonceA, undefined, "safe-early-completion");
      const completion = callTurnBroker<{ completed: true; duplicate: boolean }>(socketPath, {
        method: "safe_complete",
        token: requestId,
        finalAnswer: "early final",
      }, null);
      expect(await Promise.race([
        completion.then(() => "completed"),
        Bun.sleep(20).then(() => "waiting_for_confirmation"),
      ])).toBe("waiting_for_confirmation");

      broker.startSafeTurn(requestId);
      expect(await Promise.race([
        completion.then(() => "completed"),
        Bun.sleep(20).then(() => "waiting_for_confirmation"),
      ])).toBe("waiting_for_confirmation");
      broker.confirmSafeTurnSent(requestId, nonceA);
      await expect(completion).resolves.toEqual({ completed: true, duplicate: false });
      await expect(broker.waitForSafeCompletion(requestId)).resolves.toBe("early final");
    } finally {
      await broker.close();
    }
  });

  test("isolates parallel surfaces and cancellation rejects only the revoked turn", async () => {
    const socketPath = endpoint("parallel-isolation");
    const broker = TurnBroker.forSocket(socketPath);
    try {
      const first = await broker.registerSafe(environment(), nonceA, undefined, "safe-first");
      const second = await broker.registerSafe(environment(), nonceB, undefined, "safe-second");
      const secondStartAbort = new AbortController();
      const secondStart = broker.waitForSafeStart(second, secondStartAbort.signal);
      const ownerBatchAbort = new AbortController();
      const abandonedBatch = broker.nextToolBatch(second, ownerBatchAbort.signal);
      const firstCompletion = broker.waitForSafeCompletion(first);
      const secondCompletion = broker.waitForSafeCompletion(second);

      expect(() => broker.startSafeTurn(`${first}_wrong`)).toThrow("request_id is invalid");
      broker.startSafeTurn(first);
      broker.confirmSafeTurnSent(first, nonceA);
      await expect(broker.waitForSafeStart(first)).resolves.toBeUndefined();
      expect(await Promise.race([
        secondStart.then(() => "started"),
        Bun.sleep(20).then(() => "pending"),
      ])).toBe("pending");
      secondStartAbort.abort();
      await expect(secondStart).rejects.toMatchObject({ name: "AbortError" });
      ownerBatchAbort.abort();
      await expect(abandonedBatch).rejects.toMatchObject({ name: "AbortError" });

      broker.revoke(first, new Error("operator cancelled first Zero Risk turn"));
      await expect(firstCompletion).rejects.toThrow("operator cancelled first Zero Risk turn");
      broker.startSafeTurn(second);
      broker.confirmSafeTurnSent(second, nonceB);
      broker.completeSafeTurn(second, "second survived");
      await expect(secondCompletion).resolves.toBe("second survived");

      expect(() => broker.startSafeTurn(first)).toThrow("invalid, expired, or revoked");
    } finally {
      await broker.close();
    }
  });

  test("allows Zero Risk completion as the one-shot compaction result while keeping Harness tools blocked", async () => {
    const socketPath = endpoint("compaction-completion");
    const broker = TurnBroker.forSocket(socketPath);
    try {
      const requestId = await broker.registerSafe(environment(), nonceA, undefined, "safe-compaction");
      broker.startSafeTurn(requestId);
      broker.confirmSafeTurnSent(requestId, nonceA);
      broker.requestCompaction(requestId, toolResult({ compact: true }));
      await expect(callTurnBroker(socketPath, { method: "claim", token: requestId, contract: "safe" }))
        .rejects.toThrow("awaiting completion for Codex context compaction");

      const summary = broker.waitForSafeCompletion(requestId);
      expect(broker.completeSafeTurn(requestId, "complete compacted summary")).toEqual({
        completed: true,
        duplicate: false,
      });
      await expect(summary).resolves.toBe("complete compacted summary");
    } finally {
      await broker.close();
    }
  });

  test("exposes the same lifecycle through RemoteTurnBroker", async () => {
    const socketPath = endpoint("remote-owner");
    const broker = TurnBroker.forSocket(socketPath);
    const remote = new RemoteTurnBroker(socketPath);
    try {
      await broker.listen();
      await remote.assertCompatible();
      const requestId = await remote.registerSafe(environment(), nonceA, 5_000, "remote-safe");
      expect(await remote.confirmSafeTurnSent(requestId, nonceA)).toEqual({ confirmed: true, duplicate: false });
      expect(await callTurnBroker<{ started: true; duplicate: boolean }>(socketPath, {
        method: "safe_start",
        token: requestId,
      })).toEqual({ started: true, duplicate: false });
      const cancelledWait = new AbortController();
      const abandonedCompletion = remote.waitForSafeCompletion(requestId, cancelledWait.signal);
      await Bun.sleep(10);
      cancelledWait.abort();
      await expect(abandonedCompletion).rejects.toMatchObject({ name: "AbortError" });
      expect(await remote.requestCompaction(requestId, toolResult({ compact: true }))).toBe(0);
      expect(await remote.compactionDeliveryCount(requestId)).toBe(0);
      const completed = remote.waitForSafeCompletion(requestId);
      await callTurnBroker(socketPath, {
        method: "safe_complete",
        token: requestId,
        finalAnswer: "remote final",
      });
      await expect(completed).resolves.toBe("remote final");
      await remote.revoke(requestId);
    } finally {
      await broker.close();
    }
  }, 15_000);
});

describe("Zero Risk public MCP ABI", () => {
  test("exposes start and completion while hiding the bridge namespace", async () => {
    const socketPath = endpoint("stdio-contract");
    const broker = TurnBroker.forSocket(socketPath);
    const ownNamespace = "mcp__codex_safe";
    const requestId = await broker.registerSafe(environment([
      { name: "exec", description: "Recursive freeform gateway", parameters: {}, freeform: true },
      { name: "exec_command", description: "Run a command", parameters: { type: "object" } },
      { name: "codex_tool_inventory", description: "Top-level recursive bridge", parameters: { type: "object" } },
      { name: CODEX_COMPACTION_CONTROL_WIRE_NAME, description: "Internal compaction", parameters: { type: "object" } },
      { name: "codex_exec", namespace: ownNamespace, description: "Recursive bridge", parameters: { type: "object" } },
      { name: "codex_turn_complete", namespace: ownNamespace, description: "Recursive completion", parameters: { type: "object" } },
      { name: "shadow_tool", namespace: ownNamespace, description: "Same recursive namespace", parameters: { type: "object" } },
      { name: "read_thread", namespace: "mcp__codex_app", description: "Read a Codex task", parameters: { type: "object" } },
      { name: "useful_tool", namespace: "mcp__useful", description: "Useful external tool", parameters: { type: "object" } },
    ]), nonceA, 60_000, "safe-stdio");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--contract", "safe", "--broker-socket", socketPath],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "codex-safe-contract-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect(client.getInstructions()).toContain("begin with codex_turn_start using the request_id");
      expect(client.getInstructions()).toContain("send the complete answer with codex_turn_complete");
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual([
        "codex_apply_patch",
        "codex_exec",
        "codex_read_thread",
        "codex_tool_call",
        "codex_tool_inventory",
        "codex_turn_complete",
        "codex_turn_start",
        "codex_view_image",
        "codex_write_stdin",
      ]);
      expect(listed.tools.find(tool => tool.name === "codex_turn_start")?.description)
        .toContain("request_id included in the pasted Codex Web GPT request");
      expect(listed.tools.find(tool => tool.name === "codex_tool_inventory")?.description)
        .toStartWith("List tools available to the connected Zero Risk request");
      const startSchema = listed.tools.find(tool => tool.name === "codex_turn_start")?.inputSchema;
      expect(startSchema).toMatchObject({ required: ["request_id"] });
      expect(JSON.stringify(startSchema)).not.toContain("turn_token");
      expect(JSON.stringify(startSchema)).not.toContain("surface_nonce");
      const inventorySchema = listed.tools.find(tool => tool.name === "codex_tool_inventory")?.inputSchema;
      expect(inventorySchema).toMatchObject({ required: expect.arrayContaining(["request_id"]) });
      expect(JSON.stringify(inventorySchema)).not.toContain("turn_token");

      expect(broker.confirmSafeTurnSent(requestId, nonceA)).toEqual({ confirmed: true, duplicate: false });
      const beforeStart = await client.callTool({
        name: "codex_tool_inventory",
        arguments: { request_id: requestId },
      });
      expect(beforeStart.isError).toBe(true);
      expect(JSON.stringify(beforeStart.content))
        .toContain("codex_turn_start with its request_id first");

      const remoteStart = await client.callTool({
        name: "codex_turn_start",
        arguments: { request_id: requestId },
      });
      expect(remoteStart.structuredContent).toEqual({
        started: true,
        duplicate: false,
      });
      const inventoryAfterStart = client.callTool({
        name: "codex_tool_inventory",
        arguments: { request_id: requestId },
      });
      const [inventoryRequest] = await broker.nextToolBatch(requestId);
      expect(inventoryRequest).toMatchObject({ wireName: "exec", freeform: true });
      expect(inventoryRequest?.input).toContain("ALL_TOOLS");
      expect(inventoryRequest?.input).toContain("codex_turn_complete");
      broker.completeTool(requestId, inventoryRequest!.callId, {
        content: [{ type: "text", text: JSON.stringify({ tools: [], total: 0 }) }],
      });
      const inventory = await inventoryAfterStart;
      expect(inventory.structuredContent).toMatchObject({
        total: 3,
        tools: [
          { wire_name: "exec_command" },
          { wire_name: "mcp__codex_app__read_thread" },
          { wire_name: "mcp__useful__useful_tool" },
        ],
      });
      expect(JSON.stringify(inventory)).not.toContain(ownNamespace);
      expect(JSON.stringify(inventory)).not.toContain("Top-level recursive bridge");
      expect(JSON.stringify(inventory)).not.toContain("Recursive freeform gateway");
      expect(JSON.stringify(inventory)).not.toContain(CODEX_COMPACTION_CONTROL_WIRE_NAME);

      const threadRead = client.callTool({
        name: "codex_read_thread",
        arguments: {
          request_id: requestId,
          threadId: "thread_test",
          hostId: "local",
          turnLimit: 1,
          includeOutputs: false,
        },
      });
      const [threadReadRequest] = await broker.nextToolBatch(requestId);
      expect(threadReadRequest).toMatchObject({
        wireName: "mcp__codex_app__read_thread",
        freeform: false,
        arguments: {
          threadId: "thread_test",
          hostId: "local",
          turnLimit: 1,
          includeOutputs: false,
        },
      });
      broker.completeTool(requestId, threadReadRequest!.callId, toolResult({ title: "Referenced task" }));
      expect((await threadRead).structuredContent).toEqual({ title: "Referenced task" });

      const recursive = await client.callTool({
        name: "codex_tool_call",
        arguments: {
          request_id: requestId,
          wire_name: `${ownNamespace}__shadow_tool`,
          arguments: {},
        },
      });
      expect(recursive.isError).toBe(true);
      expect(JSON.stringify(recursive.content)).toContain("not available in this turn");

      const recursiveGateway = await client.callTool({
        name: "codex_tool_call",
        arguments: {
          request_id: requestId,
          wire_name: "exec",
          input: "await tools.mcp__codex_safe__codex_turn_complete({});",
        },
      });
      expect(recursiveGateway.isError).toBe(true);
      expect(JSON.stringify(recursiveGateway.content)).toContain("not available in this turn");

      const useful = client.callTool({
        name: "codex_tool_call",
        arguments: {
          request_id: requestId,
          wire_name: "mcp__useful__useful_tool",
          arguments: { query: "test" },
        },
      });
      const [request] = await broker.nextToolBatch(requestId);
      expect(request).toMatchObject({
        wireName: "mcp__useful__useful_tool",
        arguments: { query: "test" },
      });
      broker.completeTool(requestId, request!.callId, toolResult({ ok: true }));
      expect((await useful).structuredContent).toEqual({ ok: true });

      const complete = await client.callTool({
        name: "codex_turn_complete",
        arguments: { request_id: requestId, final_answer: "done" },
      });
      expect(complete.structuredContent).toEqual({
        completed: true,
        duplicate: false,
      });
      await expect(broker.waitForSafeCompletion(requestId)).resolves.toBe("done");
    } finally {
      await client.close().catch(() => {});
      broker.revoke(requestId);
      await broker.close();
    }
  }, 30_000);
});
