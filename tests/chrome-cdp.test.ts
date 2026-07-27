import { expect, test } from "bun:test";
import { CdpConnection, CdpPage } from "../src/chrome-cdp";

test("direct Chrome DevTools commands preserve session scope and errors", async () => {
  const received: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, upgrade) {
      if (upgrade.upgrade(req)) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        received.push(message);
        if (message.method === "Fail.test") {
          socket.send(JSON.stringify({
            id: message.id,
            error: { code: -32000, message: "expected failure" },
          }));
        } else {
          socket.send(JSON.stringify({
            id: message.id,
            result: { ok: true, echoed: message.params },
          }));
        }
      },
    },
  });
  const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}/devtools/browser/test`);
  try {
    await expect(connection.send("Runtime.test", { value: 7 }, "session-1")).resolves.toEqual({
      ok: true,
      echoed: { value: 7 },
    });
    expect(received[0]).toMatchObject({
      method: "Runtime.test",
      params: { value: 7 },
      sessionId: "session-1",
    });
    await expect(connection.send("Fail.test")).rejects.toThrow("expected failure");
  } finally {
    connection.close();
    server.stop(true);
  }
});

test("direct Chrome appends text at the end of a contenteditable composer", async () => {
  const received: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, upgrade) {
      if (upgrade.upgrade(req)) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        received.push(message);
        const result = message.method === "Runtime.evaluate"
          ? { result: { type: "boolean", value: true } }
          : {};
        socket.send(JSON.stringify({ id: message.id, result }));
      },
    },
  });
  const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}/devtools/browser/test`);
  try {
    const page = new CdpPage(connection, "target-1", "session-1");
    await page.activate();
    await page.appendText("#prompt-textarea", " local context");
    expect(received).toHaveLength(3);
    expect(received[0]).toMatchObject({
      method: "Target.activateTarget",
      params: { targetId: "target-1" },
    });
    expect(received[1]).toMatchObject({
      method: "Runtime.evaluate",
      sessionId: "session-1",
    });
    expect(received[2]).toMatchObject({
      method: "Input.insertText",
      params: { text: " local context" },
      sessionId: "session-1",
    });
  } finally {
    connection.close();
    server.stop(true);
  }
});

test("direct Chrome clicks only after the target geometry settles", async () => {
  const received: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, upgrade) {
      if (upgrade.upgrade(req)) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        received.push(message);
        const result = message.method === "Runtime.evaluate"
          ? { result: { type: "object", value: { x: 12, y: 34 } } }
          : {};
        socket.send(JSON.stringify({ id: message.id, result }));
      },
    },
  });
  const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}/devtools/browser/test`);
  try {
    const page = new CdpPage(connection, "target-1", "session-1");
    await page.clickElement("document.querySelector('button')");
    expect(received).toHaveLength(3);
    expect((received[0]!.params as { expression: string }).expression).toContain("requestAnimationFrame");
    expect((received[0]!.params as { expression: string }).expression).toContain("elementFromPoint");
    expect(received[1]).toMatchObject({
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 12, y: 34, pointerType: "mouse" },
      sessionId: "session-1",
    });
    expect(received[2]).toMatchObject({
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseReleased", x: 12, y: 34, pointerType: "mouse" },
      sessionId: "session-1",
    });
  } finally {
    connection.close();
    server.stop(true);
  }
});

test("direct Chrome submits a focused composer with Enter", async () => {
  const received: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, upgrade) {
      if (upgrade.upgrade(req)) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        received.push(message);
        const result = message.method === "Runtime.evaluate"
          ? { result: { type: "boolean", value: true } }
          : {};
        socket.send(JSON.stringify({ id: message.id, result }));
      },
    },
  });
  const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}/devtools/browser/test`);
  try {
    const page = new CdpPage(connection, "target-1", "session-1");
    await page.pressEnter("#prompt-textarea");
    expect(received).toHaveLength(3);
    expect(received[0]).toMatchObject({
      method: "Runtime.evaluate",
      sessionId: "session-1",
    });
    expect(received[1]).toMatchObject({
      method: "Input.dispatchKeyEvent",
      params: { type: "rawKeyDown", key: "Enter", code: "Enter" },
      sessionId: "session-1",
    });
    expect(received[2]).toMatchObject({
      method: "Input.dispatchKeyEvent",
      params: { type: "keyUp", key: "Enter", code: "Enter" },
      sessionId: "session-1",
    });
  } finally {
    connection.close();
    server.stop(true);
  }
});
