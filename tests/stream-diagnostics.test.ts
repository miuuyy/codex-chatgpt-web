import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ChatGptStreamDiagnostics, ChatGptStreamProjection } from "../src/adapters/chatgpt-web/stream-diagnostics";

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const message = (id = "PRIVATE-message") => ({ id, author: { role: "assistant" }, channel: "commentary",
  status: "in_progress", end_turn: false, content: { parts: ["PRIVATE-response-秘密"] } });

test("stream projection reads whole messages, batched patches and inherited value-only updates without retaining content", () => {
  const projection = new ChatGptStreamProjection();
  const input = frame({ message: message() })
    + frame({ p: "/message/content/parts/0", o: "append", v: "PRIVATE-more" })
    + frame({ v: "PRIVATE-continuation" })
    + frame({ p: "", o: "patch", v: [
      { p: "/message/channel", o: "replace", v: "final" },
      { p: "/message/status", o: "replace", v: "finished_successfully" },
      { p: "/message/end_turn", o: "replace", v: false },
      { v: true },
    ] })
    + "data: [DONE]\n\n";
  for (const byte of new TextEncoder().encode(input)) projection.push(Uint8Array.of(byte));
  const result = projection.snapshot();
  expect(result).toMatchObject({ doneMarker: true, unresolvedPatches: 0, malformedFrames: 0,
    incompleteFrame: false, messages: [{ message: 1, role: "assistant", channel: "final",
      status: "finished_successfully", endTurn: true }] });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(JSON.stringify(result)).not.toContain("秘密");
});

test("a nested patch cannot steal the root context of subsequent whole messages", () => {
  const projection = new ChatGptStreamProjection();
  const input = frame({ p: "", o: "add", v: { message: message("PRIVATE-history") } })
    + frame({ o: "patch", v: [{ p: "/message/status", o: "replace", v: "finished_successfully" }] })
    + frame({ o: "add", v: { message: message("PRIVATE-current") } })
    + frame({ p: "/message/channel", o: "replace", v: "final" })
    + frame({ p: "/message/end_turn", o: "replace", v: false })
    + frame({ v: true });
  projection.push(Buffer.from(input));
  expect(projection.snapshot().messages).toEqual([
    { message: 1, role: "assistant", channel: "commentary", status: "finished_successfully", endTurn: false },
    { message: 2, role: "assistant", channel: "final", status: "in_progress", endTurn: true },
  ]);
  expect(projection.snapshot().unresolvedPatches).toBe(0);
});

test("unknown context, partial frames and service errors remain explicit diagnostic gaps", () => {
  const projection = new ChatGptStreamProjection();
  projection.push(Buffer.from(frame({ v: true }) + frame({ error: "PRIVATE-error" }) + "data: broken\n\n"
    + frame({ p: "", o: "add", v: { message: message() } })
    + frame({ p: "/message/status", o: "replace", v: "PRIVATE-unknown-status" }) + "data: {"));
  expect(projection.snapshot()).toMatchObject({ serviceError: true, doneMarker: false,
    unresolvedPatches: 2, malformedFrames: 1, incompleteFrame: true });
  expect(JSON.stringify(projection.snapshot())).not.toContain("PRIVATE");
});

test("oversized frames are discarded and observation remains bounded across many messages", () => {
  const projection = new ChatGptStreamProjection();
  projection.push(Buffer.from("data: " + "x".repeat(260_000)));
  projection.push(Buffer.from("y\n\n"));
  for (let i = 0; i < 40; i++) projection.push(Buffer.from(frame({ message: message(`PRIVATE-${i}`) })));
  projection.push(Buffer.from("data: [DONE]\r\n\r\n"));
  expect(projection.snapshot()).toMatchObject({ oversizedFrames: 1, omittedMessages: 8, doneMarker: true });
  expect(projection.snapshot().messages).toHaveLength(32);
  expect(projection.snapshot().messages.at(-1)?.message).toBe(40);
  const { sanitizeForExport } = require("../launcher/electron/logging.cjs");
  const serialized = "[chatgpt-web] stream_lifecycle " + JSON.stringify(projection.snapshot());
  expect(sanitizeForExport(serialized)).not.toContain("[truncated]");
  expect(serialized).not.toContain("PRIVATE");
});

test("CDP observes only owned POSTs after Send and retains DONE across a subsequent network abort", async () => {
  const reports: any[] = [];
  const session = new EventEmitter() as any;
  const initial = frame({ message: message() });
  const buffered = Promise.withResolvers<{ bufferedData: string }>();
  session.send = async (method: string) => method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } }
    : method === "Network.streamResourceContent" ? buffered.promise : {};
  session.detach = async () => {};
  const page = { context: () => ({ newCDPSession: async () => session }) } as any;
  const observer = new ChatGptStreamDiagnostics(value => reports.push(value));
  await observer.attach(page);
  const request = (id: string, owner = "main", url = "https://chatgpt.com/backend-api/f/conversation") =>
    session.emit("Network.requestWillBeSent", { requestId: id, frameId: owner, request: { method: "POST", url } });
  request("before-send");
  observer.begin();
  request("foreign-frame", "other");
  request("foreign-url", "main", "https://chatgpt.com/backend-api/other");
  request("owned");
  for (const id of ["before-send", "foreign-frame", "foreign-url", "owned"]) {
    session.emit("Network.responseReceived", { requestId: id, response: { status: 200, mimeType: "text/event-stream" } });
  }
  session.emit("Network.dataReceived", { requestId: "owned", data: Buffer.from(
    frame({ p: "/message/end_turn", o: "replace", v: true }) + "data: [DONE]\n\n",
  ).toString("base64") });
  session.emit("Network.loadingFailed", { requestId: "owned", canceled: true, errorText: "PRIVATE-error" });
  buffered.resolve({ bufferedData: Buffer.from(initial).toString("base64") });
  await new Promise(resolve => setImmediate(resolve));
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ request: 1, submission: 1, terminal: "aborted", unavailable: false,
    doneMarker: true, messages: [{ message: 1, endTurn: true }] });
  expect(JSON.stringify(reports)).not.toContain("PRIVATE");
  await observer.dispose();
  request("after-dispose");
  await observer.dispose();
  expect(reports).toHaveLength(1);
});

test("unsupported observation does not fail the browser task or claim a successful capture", async () => {
  const reports: any[] = [];
  const observer = new ChatGptStreamDiagnostics(value => reports.push(value));
  await observer.attach({ context: () => ({ newCDPSession: async () => { throw new Error("PRIVATE-failure"); } }) } as any);
  expect(reports).toEqual([{ unavailable: true, reason: "observer_unavailable" }]);
  await observer.dispose();
});

test("failed owned streams export only recognized network codes, including failures before an assistant appears", async () => {
  const reports: any[] = [];
  const session = new EventEmitter() as any;
  session.send = async (method: string) => method === "Page.getFrameTree"
    ? { frameTree: { frame: { id: "main" } } }
    : method === "Network.streamResourceContent" ? { bufferedData: Buffer.from(frame({ message: {
      ...message(), author: { role: "system" }, status: "finished_successfully", end_turn: true,
    } })).toString("base64") } : {};
  session.detach = async () => {};
  const observer = new ChatGptStreamDiagnostics(value => reports.push(value));
  await observer.attach({ context: () => ({ newCDPSession: async () => session }) } as any);
  observer.begin();
  for (const [index, error] of ["net::ERR_CONNECTION_RESET", "net::ERR_CERT_AUTHORITY_INVALID",
    "net::ERR_CONNECTION_RESET PRIVATE-url", "net::ERR_PRIVATE_SECRET", "PRIVATE-error"].entries()) {
    const requestId = String(index);
    session.emit("Network.requestWillBeSent", { requestId, frameId: "main",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" } });
    session.emit("Network.responseReceived", { requestId, response: { status: 200, mimeType: "text/event-stream" } });
    session.emit("Network.loadingFailed", { requestId, canceled: false, errorText: error });
  }
  await new Promise(resolve => setImmediate(resolve));
  expect(reports.map(report => report.networkError)).toEqual([
    "net::ERR_CONNECTION_RESET", "net::ERR_CERT_AUTHORITY_INVALID", "unknown", "unknown", "unknown",
  ]);
  expect(reports.every(report => report.terminal === "failed" && report.doneMarker === false
    && report.messages.length === 1 && report.messages[0].role === "system")).toBeTrue();
  expect(JSON.stringify(reports)).not.toContain("PRIVATE");
  await observer.dispose();
});

test("late events from a detached page cannot change a new page's capture with the same request id", async () => {
  const reports: any[] = [];
  const sessions = [0, 1].map(() => {
    const session = new EventEmitter() as any;
    session.send = async (method: string) => method === "Page.getFrameTree"
      ? { frameTree: { frame: { id: "main" } } } : {};
    session.detach = async () => {};
    return session;
  });
  const observer = new ChatGptStreamDiagnostics(value => reports.push(value));
  const page = (session: any) => ({ context: () => ({ newCDPSession: async () => session }) }) as any;
  await observer.attach(page(sessions[0]));
  observer.begin();
  await observer.attach(page(sessions[1]));
  sessions[1].emit("Network.requestWillBeSent", { requestId: "reused", frameId: "main",
    request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" } });
  sessions[0].emit("Network.loadingFinished", { requestId: "reused" });
  await observer.dispose();
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ terminal: "detached", unavailable: true, doneMarker: false });
});
