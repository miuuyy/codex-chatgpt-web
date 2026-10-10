import type { Page } from "playwright-core";
import { StringDecoder } from "node:string_decoder";
import { ChatGptWebAdapterError } from "./adapter-error";

/** Observe only processing requests for files attached by this turn, on its owned frame. */
export async function observeChatGptAttachmentUploads(page: Page, names: string[]) {
  const session = await page.context().newCDPSession(page);
  const origin = new URL(page.url()).origin;
  const { frameTree } = await session.send("Page.getFrameTree").catch(async error => {
    await session.detach().catch(() => {});
    throw error;
  });
  const expected = new Set(names);
  const completed = new Set<string>();
  const streams = new Map<string, { name: string; fileId?: string; decoder: StringDecoder; pending: string; buffered?: string[]; activation?: Promise<void> }>();
  let failure: Error | undefined;
  let disposed = false;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Uploads can fail before the caller finishes waiting for the attachment cards.
  void ready.catch(() => {});
  const fail = (message: string, status = 502) => {
    if (disposed || failure) return;
    failure = new ChatGptWebAdapterError(
      `ChatGPT attachment upload failed before the prompt was sent: ${message}. The original prompt and attachments were preserved.`,
      { status, errorType: "server_error", code: "chatgpt_attachment_upload_failed", retryable: false },
    );
    reject(failure);
  };
  const consume = (id: string, data: string, final = false) => {
    const stream = streams.get(id);
    if (!stream || disposed || completed.has(stream.name)) return;
    stream.pending += data;
    const lines = stream.pending.split(/\r?\n/);
    stream.pending = final ? "" : lines.pop()!;
    if (stream.pending.length > 1024 * 1024) return fail("unrecognized upload processing stream");
    for (const line of lines) {
      if (!line.trim()) continue;
      let envelope;
      try { envelope = JSON.parse(line); } catch { continue; }
      const event = envelope.data && typeof envelope.data === "object" ? envelope.data : envelope;
      const name = event.event ?? envelope.event;
      if (typeof name !== "string") continue;
      if (stream.fileId && event.file_id && event.file_id !== stream.fileId) continue;
      if (/\.(error|failed|cancelled|unknown)$/.test(name)) return fail(`processing event ${name}`);
      if (name === "file.processing.completed") {
        completed.add(stream.name);
        if ([...expected].every(name => completed.has(name))) resolve();
        return;
      }
    }
  };
  const onRequest = (event: any) => {
    if (disposed || event.frameId !== frameTree.frame.id || event.request.method !== "POST") return;
    const url = new URL(event.request.url);
    if (url.origin !== origin || !(url.pathname === "/backend-api/files/process_upload_stream"
      || /^\/backend-api\/files\/upload_reservations\/[^/]+\/claim_and_finish$/.test(url.pathname))) return;
    let body;
    try { body = JSON.parse(event.request.postData ?? ""); } catch { return; }
    if (!expected.has(body.file_name)) return;
    streams.set(event.requestId, { name: body.file_name, fileId: body.file_id, decoder: new StringDecoder("utf8"), pending: "", buffered: [] });
  };
  const onResponse = (event: any) => {
    const stream = streams.get(event.requestId);
    if (!stream || disposed) return;
    if (event.response.status < 200 || event.response.status >= 300) {
      fail(`upload processing HTTP ${event.response.status}`, event.response.status);
      return;
    }
    // Processing-completed can arrive before the response closes; ChatGPT may then cancel it.
    // Stream the observed bytes rather than waiting for response.text() or a loadingfinished event.
    stream.activation = session.send("Network.streamResourceContent", { requestId: event.requestId }).then(result => {
      consume(event.requestId, stream.decoder.write(Buffer.from(result.bufferedData, "base64")));
      for (const data of stream.buffered ?? []) consume(event.requestId, stream.decoder.write(Buffer.from(data, "base64")));
      stream.buffered = undefined;
    }).catch(() => {
      // A short response may already be complete when streaming is enabled. A CDP
      // observation failure is not an upload failure: loadingFinished must validate
      // the complete body, or loadingFailed must report the transport failure.
      // Keep ready pending until that authoritative terminal event is processed.
    });
  };
  const onData = (event: any) => {
    const stream = streams.get(event.requestId);
    if (!stream || !event.data) return;
    if (stream.buffered) stream.buffered.push(event.data);
    else consume(event.requestId, stream.decoder.write(Buffer.from(event.data, "base64")));
  };
  const onFinished = (event: any) => {
    const stream = streams.get(event.requestId);
    if (!stream || disposed || completed.has(stream.name)) return;
    // Handles a short response which finished before streamResourceContent was enabled.
    void (stream.activation ?? Promise.resolve()).then(async () => {
      if (disposed || completed.has(stream.name)) return;
      const body = await session.send("Network.getResponseBody", { requestId: event.requestId });
      stream.pending = "";
      consume(event.requestId, body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body, true);
      if (!completed.has(stream.name)) fail("upload processing ended without a completion event");
    }).catch(() => { if (!completed.has(stream.name)) fail("upload processing ended without confirmation"); });
  };
  const onFailed = (event: any) => {
    const stream = streams.get(event.requestId);
    if (stream) void (stream.activation ?? Promise.resolve()).then(() => {
      if (!completed.has(stream.name)) fail("upload processing connection failed");
    });
  };
  const listeners: Record<string, (event: any) => void> = { "Network.requestWillBeSent": onRequest, "Network.responseReceived": onResponse,
    "Network.dataReceived": onData, "Network.loadingFinished": onFinished, "Network.loadingFailed": onFailed };
  const onEvent = (event: { method: string; params?: object }) => listeners[event.method]?.(event.params);
  session.on("event", onEvent);
  const dispose = async () => {
    disposed = true;
    session.off("event", onEvent);
    await session.detach().catch(() => {});
  };
  try { await session.send("Network.enable"); } catch (error) { await dispose(); throw error; }
  return {
    throwIfFailed: () => { if (failure) throw failure; },
    wait: (signal?: AbortSignal) => new Promise<void>((yes, no) => {
      const abort = () => no(signal?.reason ?? new DOMException("Upload observation aborted", "AbortError"));
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      ready.then(yes, no).finally(() => signal?.removeEventListener("abort", abort));
    }),
    dispose,
  };
}
