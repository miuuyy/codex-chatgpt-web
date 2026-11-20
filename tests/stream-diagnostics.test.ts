import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ChatGptStreamDiagnostics, ChatGptStreamProjection } from "../src/adapters/chatgpt-web/stream-diagnostics";
import { parseChatGptServiceError, parseChatGptSizeRejection } from "../src/adapters/chatgpt-web/service-error";

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

test("stream projection exports only allowlisted service codes and reasons and confirms size errors once", () => {
  let rejected = 0;
  const projection = new ChatGptStreamProjection(() => { rejected += 1; });
  const error = { error: "PRIVATE-server-error", error_code: "input_too_large", error_reason: "last_user_message",
    request_id: "PRIVATE-request", prompt: "PRIVATE-prompt" };
  projection.push(Buffer.from(frame(error) + frame(error)
    + frame({ error_code: "PRIVATE-code", error_reason: "PRIVATE-reason", error: "PRIVATE-other" })
    + frame({ error_code: "message_length_exceeds_limit", error_reason: "PRIVATE-reason" })));
  expect(rejected).toBe(1);
  expect(projection.snapshot()).toMatchObject({ serviceError: true, serviceErrors: [
    { error_code: "input_too_large", error_reason: "last_user_message" },
    { error_code: "message_length_exceeds_limit" },
  ] });
  expect(JSON.stringify(projection.snapshot())).not.toContain("PRIVATE");
});

test("arbitrary strings, nested model text and incomplete service frames cannot confirm a size rejection", () => {
  let rejected = 0;
  const projection = new ChatGptStreamProjection(() => { rejected += 1; });
  for (const value of [
    { error: "input_too_large last_user_message message_length_exceeds_limit" },
    { error: "PRIVATE", error_code: "input_too_large PRIVATE", error_reason: "last_user_message" },
    { error: "PRIVATE", error_code: "input_too_large", error_reason: "PRIVATE" },
    { error: "PRIVATE", error_code: "input_too_large", error_reason: ["last_user_message"] },
    { error: "", error_code: "input_too_large", error_reason: "last_user_message" },
    { error: { text: "PRIVATE" }, error_code: "input_too_large", error_reason: "last_user_message" },
    { error_code: "input_too_large", error_reason: "last_user_message" },
    { message: { ...message(), content: { parts: [JSON.stringify({ error: "PRIVATE", error_code: "input_too_large", error_reason: "last_user_message" })] } } },
    { v: { error: "PRIVATE", error_code: "input_too_large", error_reason: "last_user_message" } },
    { detail: { code: "message_length_exceeds_limit PRIVATE" } },
    "input_too_large last_user_message",
  ]) projection.push(Buffer.from(frame(value)));
  projection.push(Buffer.from('data: {"error":"PRIVATE","error_code":"input_too_large","error_reason":"last_user_message"}'));
  expect(rejected).toBe(0);
  expect(projection.snapshot().incompleteFrame).toBeTrue();
  expect(JSON.stringify(projection.snapshot())).not.toContain("PRIVATE");
});

test("shared service error parser accepts exact SSE and HTTP detail codes without retaining error text", () => {
  const error = { error: "PRIVATE-server-error", error_code: "input_too_large", error_reason: "last_user_message" };
  expect(parseChatGptSizeRejection(error)).toEqual({ error_code: "input_too_large", error_reason: "last_user_message" });
  expect(parseChatGptSizeRejection({ detail: { code: "message_length_exceeds_limit", message: "PRIVATE" } }))
    .toEqual({ error_code: "message_length_exceeds_limit" });
  for (const value of [null, [], "PRIVATE", { error_code: "PRIVATE", error_reason: "last_user_message" },
    { detail: { code: "input_too_large" }, error: "PRIVATE", error_reason: "last_user_message" },
    { error_code: null, detail: { code: "input_too_large" }, error: "PRIVATE", error_reason: "last_user_message" },
    { v: error }, { message: error }, { error_code: ["message_length_exceeds_limit"] },
    { error_code: "input_too_large", error_reason: "PRIVATE", error: "PRIVATE" },
  ]) {
    expect(parseChatGptSizeRejection(value)).toBeUndefined();
    expect(JSON.stringify(parseChatGptServiceError(value)) ?? "").not.toContain("PRIVATE");
  }
});

test("service error diagnostics remain bounded and snapshots cannot mutate their retained codes", () => {
  const projection = new ChatGptStreamProjection();
  for (let i = 0; i < 100; i++) {
    projection.push(Buffer.from(frame({ error_code: "input_too_large", error_reason: `PRIVATE-${i}` })
      + frame({ error_code: `PRIVATE-${i}`, error_reason: "last_user_message" })));
  }
  const snapshot = projection.snapshot();
  expect(snapshot.serviceErrors).toEqual([{ error_code: "input_too_large" }]);
  snapshot.serviceErrors[0]!.error_code = "message_length_exceeds_limit";
  expect(projection.snapshot().serviceErrors).toEqual([{ error_code: "input_too_large" }]);
  expect(JSON.stringify(projection.snapshot())).not.toContain("PRIVATE");
});

async function serviceStreamFixture(onInputTooLarge: () => void, bufferedData: string | Promise<string> = "") {
  const reports: any[] = [];
  const session = new EventEmitter() as any;
  session.send = async (method: string) => method === "Page.getFrameTree"
    ? { frameTree: { frame: { id: "main" } } }
    : method === "Network.streamResourceContent" ? { bufferedData: await bufferedData } : {};
  session.detach = async () => {};
  const observer = new ChatGptStreamDiagnostics(value => reports.push(value), onInputTooLarge);
  await observer.attach({ context: () => ({ newCDPSession: async () => session }) } as any);
  const request = (id: string, owner = "main") => session.emit("Network.requestWillBeSent", {
    requestId: id, frameId: owner, request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
  });
  const response = (id: string, status = 200) => session.emit("Network.responseReceived", {
    requestId: id, response: { status, mimeType: "text/event-stream" },
  });
  const data = (id: string, text: string) => session.emit("Network.dataReceived", {
    requestId: id, data: Buffer.from(text).toString("base64"),
  });
  return { reports, session, observer, request, response, data };
}

test("owned HTTP 200 SSE confirms size rejection eagerly before the stream aborts", async () => {
  let rejected = 0;
  const fixture = await serviceStreamFixture(() => { rejected += 1; });
  fixture.observer.begin();
  fixture.request("PRIVATE-request");
  fixture.response("PRIVATE-request");
  await new Promise(resolve => setImmediate(resolve));
  const error = frame({ error: "PRIVATE-server-error", error_code: "input_too_large", error_reason: "last_user_message" });
  fixture.data("PRIVATE-request", error.slice(0, -1));
  expect(rejected).toBe(0);
  fixture.data("PRIVATE-request", error.slice(-1));
  expect(rejected).toBe(1);
  expect(fixture.reports).toEqual([]);
  fixture.data("PRIVATE-request", error);
  expect(rejected).toBe(1);
  fixture.session.emit("Network.loadingFailed", {
    requestId: "PRIVATE-request", canceled: true, errorText: "net::ERR_ABORTED",
  });
  await new Promise(resolve => setImmediate(resolve));
  expect(fixture.reports).toHaveLength(1);
  expect(fixture.reports[0]).toMatchObject({ terminal: "aborted", networkError: "net::ERR_ABORTED",
    serviceErrors: [{ error_code: "input_too_large", error_reason: "last_user_message" }] });
  expect(JSON.stringify(fixture.reports)).not.toContain("PRIVATE");
  await fixture.observer.dispose();
});

test("an aborted stream confirms a size rejection from its initially buffered bytes", async () => {
  let rejected = 0;
  const buffered = Promise.withResolvers<string>();
  const fixture = await serviceStreamFixture(() => { rejected += 1; }, buffered.promise);
  fixture.observer.begin(); fixture.request("owned"); fixture.response("owned");
  fixture.session.emit("Network.loadingFailed", { requestId: "owned", canceled: true, errorText: "net::ERR_ABORTED" });
  buffered.resolve(Buffer.from(frame({ error: "PRIVATE", error_code: "input_too_large", error_reason: "last_user_message" })).toString("base64"));
  await new Promise(resolve => setImmediate(resolve));
  expect(rejected).toBe(1);
  expect(fixture.reports[0]).toMatchObject({ terminal: "aborted", serviceError: true });
  expect(JSON.stringify(fixture.reports)).not.toContain("PRIVATE");
  await fixture.observer.dispose();
});

test("foreign, pre-send, non-200 and superseded submission streams never invoke recovery", async () => {
  let rejected = 0;
  const error = frame({ error: "PRIVATE", error_code: "input_too_large", error_reason: "last_user_message" });
  const fixture = await serviceStreamFixture(() => { rejected += 1; });
  fixture.request("pre-send");
  fixture.observer.begin();
  fixture.request("foreign", "other"); fixture.request("non-200"); fixture.request("old");
  fixture.response("pre-send"); fixture.response("foreign"); fixture.response("non-200", 500); fixture.response("old");
  await new Promise(resolve => setImmediate(resolve));
  fixture.data("pre-send", error); fixture.data("foreign", error); fixture.data("non-200", error);
  fixture.observer.begin(); fixture.data("old", error);
  expect(rejected).toBe(0);
  await fixture.observer.dispose();
  fixture.data("old", error);
  expect(rejected).toBe(0);
  expect(JSON.stringify(fixture.reports)).not.toContain("PRIVATE");
});

test.each(["superseded", "detached"])("late buffered rejection cannot recover a %s capture", async disposition => {
  let rejected = 0;
  const buffered = Promise.withResolvers<string>();
  const fixture = await serviceStreamFixture(() => { rejected += 1; }, buffered.promise);
  fixture.observer.begin(); fixture.request("owned"); fixture.response("owned");
  if (disposition === "superseded") fixture.observer.begin();
  else await fixture.observer.dispose();
  buffered.resolve(Buffer.from(frame({ error: "PRIVATE", error_code: "input_too_large", error_reason: "last_user_message" })).toString("base64"));
  await new Promise(resolve => setImmediate(resolve));
  expect(rejected).toBe(0);
  await fixture.observer.dispose();
  expect(JSON.stringify(fixture.reports)).not.toContain("PRIVATE");
});

test("a recovery callback failure cannot replace stream diagnostics", async () => {
  const fixture = await serviceStreamFixture(() => { throw new Error("PRIVATE-callback"); });
  fixture.observer.begin(); fixture.request("owned"); fixture.response("owned");
  await new Promise(resolve => setImmediate(resolve));
  expect(() => fixture.data("owned", frame({ error_code: "message_length_exceeds_limit" }))).not.toThrow();
  fixture.session.emit("Network.loadingFinished", { requestId: "owned" });
  await new Promise(resolve => setImmediate(resolve));
  expect(fixture.reports[0]).toMatchObject({ terminal: "finished", serviceError: true,
    serviceErrors: [{ error_code: "message_length_exceeds_limit" }] });
  expect(JSON.stringify(fixture.reports)).not.toContain("PRIVATE");
  await fixture.observer.dispose();
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
