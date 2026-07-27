import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
}

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", event => {
      try {
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    }, { once: true });
  });
}

test("Responses WebSocket accepts reusable response.create prewarms", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/v1/responses`);

  try {
    await opened(socket);

    const invalidMessage = nextJson(socket);
    socket.send(JSON.stringify({
      type: "response.create",
      generate: false,
      model: "chatgpt-web/not-enabled",
      input: [],
      stream: true,
    }));
    expect(await invalidMessage).toMatchObject({
      type: "error",
      status: 400,
      error: { type: "invalid_request_error" },
    });

    const firstMessage = nextJson(socket);
    socket.send(JSON.stringify({
      type: "response.create",
      generate: false,
      model: "chatgpt-web/high",
      input: [],
      stream: true,
    }));
    const first = await firstMessage;
    expect(first.type).toBe("response.completed");
    expect(first.sequence_number).toBe(0);
    expect(first.response).toMatchObject({
      object: "response",
      status: "completed",
      model: "chatgpt-web/high",
      output: [],
    });

    const firstId = (first.response as { id: string }).id;
    const secondMessage = nextJson(socket);
    socket.send(JSON.stringify({
      type: "response.create",
      generate: false,
      previous_response_id: firstId,
      model: "chatgpt-web/high",
      input: [],
      stream: true,
    }));
    const second = await secondMessage;
    expect(second.type).toBe("response.completed");
    expect((second.response as { id: string }).id).not.toBe(firstId);
  } finally {
    socket.close();
    await server.stop(true);
  }
});
