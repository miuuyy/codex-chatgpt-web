const { createServer } = require("node:http");
const { randomBytes, timingSafeEqual } = require("node:crypto");

const MAX_BODY_BYTES = 16 * 1024;

function secureTokenMatches(expected, authorization) {
  const prefix = "Bearer ";
  if (typeof authorization !== "string" || !authorization.startsWith(prefix)) return false;
  const supplied = Buffer.from(authorization.slice(prefix.length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) throw new Error("request body is empty");
  return JSON.parse(text);
}

function writeJson(response, status, body) {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(encoded.length),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(encoded);
}

class BrowserControlServer {
  constructor({ logger, getBrowserHost, getPreferences }) {
    this.logger = logger;
    this.getBrowserHost = getBrowserHost;
    this.getPreferences = getPreferences;
    this.token = randomBytes(32).toString("base64url");
    this.port = 0;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("browser.control_request_failed", { message });
        if (response.destroyed) return;
        if (response.headersSent) {
          response.destroy();
          return;
        }
        try {
          writeJson(response, 500, { error: "internal_error" });
        } catch {
          response.destroy();
        }
      });
    });
    this.server.on("error", (error) => {
      this.logger.error("browser.control_server_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    this.server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        this.port = address && typeof address === "object" ? address.port : 0;
        if (!this.port) reject(new Error("Browser control server did not receive a port"));
        else resolve();
      });
    });
    this.logger.info("browser.control_started", { port: this.port });
    return this;
  }

  descriptor() {
    if (!this.port) throw new Error("Browser control server is not started");
    return { endpoint: `http://127.0.0.1:${this.port}`, token: this.token };
  }

  async handle(request, response) {
    if (!secureTokenMatches(this.token, request.headers.authorization)) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const isTurn = request.url === "/v1/turn/start"
      || request.url === "/v1/turn/heartbeat"
      || request.url === "/v1/turn/end";
    const isSessionInspect = request.url === "/v1/session/inspect";
    if (request.method !== "POST" || (!isTurn && !isSessionInspect)) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    try {
      const body = await readJson(request);
      const host = this.getBrowserHost();
      if (!host) throw new Error("browser host is not ready");
      if (isSessionInspect) {
        const result = await host.inspectSession(body?.detectCapabilities === true);
        writeJson(response, 200, result);
        return;
      }
      if (!body || typeof body !== "object" || !/^[A-Za-z0-9_-]{6,128}$/.test(body.traceId || "")) {
        throw new Error("traceId is invalid");
      }
      if (!Number.isInteger(body.helperPid) || body.helperPid < 1) {
        throw new Error("browser helper pid is invalid");
      }
      const preferences = this.getPreferences();
      if (request.url === "/v1/turn/start") {
        const lease = host.beginTurn(body.traceId, preferences.showBrowserDuringTurns === true, body.helperPid);
        this.logger.info("browser.turn_started", { traceId: body.traceId });
        writeJson(response, 200, { ok: true, ...lease });
        return;
      } else if (request.url === "/v1/turn/heartbeat") {
        host.heartbeatTurn(body.traceId, body.helperPid);
        this.logger.debug?.("browser.turn_heartbeat", { traceId: body.traceId });
        writeJson(response, 200, { ok: true });
        return;
      } else {
        if (!['completed', 'failed', 'aborted'].includes(body.status)) throw new Error("turn status is invalid");
        await host.endTurn(
          body.traceId,
          body.helperPid,
          body.status,
          preferences.showBrowserDuringTurns === true,
          body.message,
        );
        this.logger.info("browser.turn_ended", { traceId: body.traceId, status: body.status });
      }
      writeJson(response, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("browser.control_rejected", { message });
      writeJson(response, 400, { error: message });
    }
  }

  async close() {
    if (!this.server.listening) return;
    await new Promise((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }
}

module.exports = { BrowserControlServer };
