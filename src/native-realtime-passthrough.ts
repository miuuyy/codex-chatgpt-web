const NATIVE_REALTIME_URL = "wss://api.openai.com/v1/live";
const NATIVE_REALTIME_HANDSHAKE_TIMEOUT_MS = 35_000;

const HANDSHAKE_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "upgrade",
]);

export type NativeRealtimeSocketFactory = (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket;

const BunWebSocket = WebSocket as unknown as {
  new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket;
};

export interface NativeRealtimeUpstreamOptions {
  url?: string;
  handshakeTimeoutMs?: number;
  createSocket?: NativeRealtimeSocketFactory;
}

export function nativeRealtimeHeaders(request: Request): Record<string, string> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
    throw new Error("Native Codex realtime passthrough requires the incoming Bearer authorization");
  }

  return Object.fromEntries(
    [...request.headers]
      .filter(([name]) => !HANDSHAKE_HEADERS.has(name.toLowerCase())),
  );
}

export function nativeRealtimeProtocols(request: Request): string[] {
  return (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map(protocol => protocol.trim())
    .filter(Boolean);
}

export function nativeRealtimeTarget(request: Request, upstreamUrl = NATIVE_REALTIME_URL): string {
  const incoming = new URL(request.url);
  const target = new URL(upstreamUrl);
  target.search = incoming.search;
  return target.toString();
}

export async function openNativeRealtimeUpstream(
  request: Request,
  options: NativeRealtimeUpstreamOptions = {},
): Promise<WebSocket> {
  const createSocket = options.createSocket ?? ((url, socketOptions) => new BunWebSocket(url, socketOptions));
  const protocols = nativeRealtimeProtocols(request);
  const upstream = createSocket(nativeRealtimeTarget(request, options.url), {
    headers: nativeRealtimeHeaders(request),
    ...(protocols.length > 0 ? { protocols } : {}),
    perMessageDeflate: true,
  });
  upstream.binaryType = "arraybuffer";

  return await new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      upstream.removeEventListener("open", onOpen);
      upstream.removeEventListener("error", onError);
      upstream.removeEventListener("close", onClose);
      if (error) {
        try { upstream.close(); } catch {}
        reject(error);
      } else {
        resolve(upstream);
      }
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error("Native Codex realtime upstream handshake failed"));
    const onClose = () => finish(new Error("Native Codex realtime upstream closed during handshake"));
    const onAbort = () => finish(new Error("Native Codex realtime client disconnected during handshake"));
    const timer = setTimeout(
      () => finish(new Error("Native Codex realtime upstream handshake timed out")),
      options.handshakeTimeoutMs ?? NATIVE_REALTIME_HANDSHAKE_TIMEOUT_MS,
    );

    upstream.addEventListener("open", onOpen, { once: true });
    upstream.addEventListener("error", onError, { once: true });
    upstream.addEventListener("close", onClose, { once: true });
    request.signal.addEventListener("abort", onAbort, { once: true });
  });
}
