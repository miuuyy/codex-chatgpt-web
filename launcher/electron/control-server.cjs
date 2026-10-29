const { createServer } = require("node:http");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { releaseRetainedConversation } = require("./retained-turn-release.cjs");

const MAX_BODY_BYTES = 16 * 1024;
const MAX_MANUAL_START_BODY_BYTES = 3 * 1024 * 1024;
const MAX_AUTOMATIC_PASTE_PROMPT_CHARS = 2 * 1024 * 1024;
const MANUAL_SENT_OBSERVER_TIMEOUT_MS = 35_000;

function secureTokenMatches(expected, authorization) {
  const prefix = "Bearer ";
  if (typeof authorization !== "string" || !authorization.startsWith(prefix)) return false;
  const supplied = Buffer.from(authorization.slice(prefix.length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("request body is too large");
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
  constructor({ logger, getBrowserHost, getPreferences, resolveProxy, limits }) {
    this.logger = logger;
    this.getBrowserHost = getBrowserHost;
    this.getPreferences = getPreferences;
    this.resolveProxy = resolveProxy;
    this.limits = limits;
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
      || request.url === "/v1/turn/usage"
      || request.url === "/v1/turn/approval"
      || request.url === "/v1/turn/end";
    const isTurnRelease = request.url === "/v1/turn/release";
    const isTurnPaste = request.url === "/v1/turn/paste";
    const isTurnPasteRelease = request.url === "/v1/turn/paste/release";
    const isSessionInspect = request.url === "/v1/session/inspect";
    const isProxyResolution = request.url === "/v1/network/resolve-proxy";
    const manualAction = new Map([
      ["/v1/manual/start", "start"],
      ["/v1/manual/wait-sent", "wait-sent"],
      ["/v1/manual/wait-terminal", "wait-terminal"],
      ["/v1/manual/started", "started"],
      ["/v1/manual/end", "end"],
      ["/v1/manual/cancel", "cancel"],
    ]).get(request.url);
    if (request.method !== "POST" || (!isTurn && !isTurnRelease && !isTurnPaste && !isTurnPasteRelease && !isSessionInspect && !isProxyResolution && !manualAction)) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    try {
      const body = await readJson(
        request,
        manualAction === "start" || isTurnPaste ? MAX_MANUAL_START_BODY_BYTES : MAX_BODY_BYTES,
      );
      if (isProxyResolution) {
        const url = new URL(body?.url);
        if (url.origin !== "https://chatgpt.com" || url.username || url.password
          || !url.pathname.startsWith("/backend-api/codex/")) {
          throw new Error("Proxy resolution is restricted to native Codex requests");
        }
        if (!this.resolveProxy) throw new Error("Native proxy resolver is unavailable");
        let proxy;
        try { proxy = await this.resolveProxy(url.href); }
        catch { throw new Error("System proxy resolution failed"); }
        writeJson(response, 200, { proxy });
        return;
      }
      const preferences = this.getPreferences();
      const host = this.getBrowserHost();
      if (!host) throw new Error("browser host is not ready");
      if (isSessionInspect) {
        if (host.browserInteractionMode() === "manual") {
          const error = new Error(
            "ChatGPT session and capability inspection is disabled in Zero Risk mode",
          );
          error.code = "manual_browser_inspection_disabled";
          throw error;
        }
        const result = await host.inspectSession(body?.detectCapabilities === true);
        writeJson(response, 200, result);
        return;
      }
      if (isTurnRelease) {
        if (typeof body?.conversationKey !== "string" || !/^[a-f0-9]{64}$/.test(body.conversationKey)) {
          throw new Error("conversationKey is invalid");
        }
        const released = releaseRetainedConversation(host, body.conversationKey);
        this.logger.info("browser.retained_conversation_released", { released });
        writeJson(response, 200, { ok: true, released });
        return;
      }
      if (!body || typeof body !== "object" || !/^[A-Za-z0-9_-]{6,128}$/.test(body.traceId || "")) {
        throw new Error("traceId is invalid");
      }
      if (!Number.isInteger(body.helperPid) || body.helperPid < 1) {
        throw new Error("browser helper pid is invalid");
      }
      if (body.conversationKey !== undefined && !/^[a-f0-9]{64}$/.test(body.conversationKey)) {
        throw new Error("conversationKey is invalid");
      }
      if (body.connectorIdentity !== undefined
        && (typeof body.connectorIdentity !== "string"
          || !body.connectorIdentity.trim()
          || body.connectorIdentity.length > 80)) {
        throw new Error("connectorIdentity is invalid");
      }
      if (body.requireRetainedConversation !== undefined
        && typeof body.requireRetainedConversation !== "boolean") {
        throw new Error("requireRetainedConversation is invalid");
      }
      if (body.requireRetainedConversation === true && body.conversationKey === undefined) {
        throw new Error("requireRetainedConversation requires conversationKey");
      }
      if (body.connectorIdentity !== undefined && body.conversationKey === undefined) {
        throw new Error("connectorIdentity requires conversationKey");
      }
      if (body.retain !== undefined && typeof body.retain !== "boolean") {
        throw new Error("retain is invalid");
      }
      if (body.connectorBound !== undefined && typeof body.connectorBound !== "boolean") {
        throw new Error("connectorBound is invalid");
      }
      if (body.refreshViewport !== undefined && typeof body.refreshViewport !== "boolean") {
        throw new Error("refreshViewport is invalid");
      }
      if (body.refreshViewport !== undefined && request.url !== "/v1/turn/heartbeat") {
        throw new Error("refreshViewport is only valid for a turn heartbeat");
      }
      if (manualAction) {
        if (manualAction === "start") {
          if (host.browserInteractionMode() !== "manual") {
            throw new Error("Zero Risk is not enabled");
          }
          if (typeof body.prompt !== "string" || body.prompt.length < 1) {
            throw new Error("manual prompt is invalid");
          }
          if (body.resumePrompt !== undefined
            && (typeof body.resumePrompt !== "string" || body.resumePrompt.length < 1)) {
            throw new Error("manual resume prompt is invalid");
          }
          if (body.compaction !== undefined && body.compaction !== true) {
            throw new Error("manual compaction flag is invalid");
          }
          const lease = host.beginManualTurn(
            body.traceId,
            body.helperPid,
            body.prompt,
            body.conversationKey,
            body.resumePrompt,
            body.compaction === true,
          );
          this.logger.info("browser.manual_control_started", {
            traceId: body.traceId,
            reused: lease.reused,
          });
          writeJson(response, 200, { ok: true, ...lease });
          return;
        }
        if (manualAction === "wait-sent") {
          const observed = await host.waitManualSent(
            body.traceId,
            body.helperPid,
            MANUAL_SENT_OBSERVER_TIMEOUT_MS,
          );
          if (observed.status === "pending") {
            writeJson(response, 202, { ok: true, status: "pending" });
            return;
          }
          if (observed.status === "timeout") {
            writeJson(response, 408, { error: "Manual prompt was not confirmed within its allowed time", code: "manual_turn_timed_out" });
            return;
          }
          if (observed.status === "cancelled") {
            writeJson(response, 409, { error: "Zero Risk turn was cancelled", code: "turn_cancelled" });
            return;
          }
          if (observed.status !== "sent") {
            writeJson(response, 409, { error: "Zero Risk turn failed before Sent confirmation", code: "manual_turn_failed" });
            return;
          }
          writeJson(response, 200, { ok: true, status: "sent", sentAt: observed.sentAt });
          return;
        }
        if (manualAction === "wait-terminal") {
          const observed = await host.waitManualTerminal(
            body.traceId,
            body.helperPid,
            MANUAL_SENT_OBSERVER_TIMEOUT_MS,
          );
          if (observed.status === "pending") {
            writeJson(response, 202, { ok: true, status: "pending" });
            return;
          }
          if (observed.status === "timeout") {
            writeJson(response, 408, {
              error: "Codex Zero Risk did not start within its allowed time after Sent confirmation",
              code: "manual_turn_timed_out",
            });
            return;
          }
          if (!['cancelled', 'failed'].includes(observed.status)) {
            throw new Error("manual terminal state is invalid");
          }
          writeJson(response, 200, { ok: true, status: observed.status });
          return;
        }
        if (manualAction === "started") {
          host.markManualTurnStarted(body.traceId, body.helperPid);
          writeJson(response, 200, { ok: true });
          return;
        }
        if (manualAction === "cancel") {
          const result = host.cancelManualTurn(body.traceId, body.helperPid);
          writeJson(response, 200, { ok: true, ...result });
          return;
        }
        if (!['completed', 'failed', 'aborted'].includes(body.status)) {
          throw new Error("manual turn status is invalid");
        }
        const release = host.endManualTurn(
          body.traceId,
          body.helperPid,
          body.status,
          body.retain === true,
        );
        writeJson(response, 200, { ok: true, ...release });
        return;
      }
      if (isTurnPaste) {
        if (host.browserInteractionMode() === "manual") throw new Error("Automatic browser interaction is disabled");
        if (typeof body.prompt !== "string" || body.prompt.length < 1
          || body.prompt.length > MAX_AUTOMATIC_PASTE_PROMPT_CHARS) {
          throw new Error("automatic browser paste prompt is invalid");
        }
        const lease = await host.pasteTurnPrompt(body.traceId, body.helperPid, body.prompt);
        writeJson(response, 200, { ok: true, ...lease });
        return;
      }
      if (isTurnPasteRelease) {
        if (host.browserInteractionMode() === "manual") throw new Error("Automatic browser interaction is disabled");
        if (typeof body.pasteId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(body.pasteId)) {
          throw new Error("automatic browser paste lease is invalid");
        }
        const restored = host.releaseTurnPromptPaste(body.traceId, body.helperPid, body.pasteId);
        writeJson(response, 200, { ok: true, ...restored });
        return;
      }
      if (request.url === "/v1/turn/approval") {
        if (host.browserInteractionMode() === "manual") throw new Error("Automatic browser interaction is disabled");
        host.setTurnApprovalPending(body.traceId, body.helperPid, body.pending);
        this.logger.info("browser.tool_approval", { traceId: body.traceId, pending: body.pending });
        writeJson(response, 200, { ok: true });
        return;
      }
      if (request.url === "/v1/turn/usage") {
        if (host.browserInteractionMode() === "manual") throw new Error("Limits tracking is disabled in Zero Risk mode");
        // The same owner check as a heartbeat prevents another helper from charging this tab.
        host.heartbeatTurn(body.traceId, body.helperPid);
        if (!this.limits) throw new Error("Limits tracking is unavailable");
        const recorded = this.limits.record(body);
        writeJson(response, 200, { ok: true, recorded });
        return;
      }
      if (request.url === "/v1/turn/start") {
        if (host.browserInteractionMode() === "manual") {
          throw new Error("Automatic browser interaction is disabled");
        }
        const acquisition = new AbortController();
        const onClose = () => {
          if (!response.writableFinished) acquisition.abort(new Error("Browser turn acquisition caller disconnected"));
        };
        response.once("close", onClose);
        let lease;
        try {
          if (response.destroyed) onClose();
          lease = await host.beginTurn(
            body.traceId,
            preferences.showBrowserDuringTurns === true,
            body.helperPid,
            body.conversationKey,
            body.connectorIdentity,
            body.requireRetainedConversation === true,
            acquisition.signal,
          );
        } finally {
          response.off("close", onClose);
        }
        this.logger.info("browser.turn_started", { traceId: body.traceId });
        writeJson(response, 200, { ok: true, ...lease, trackUsage: this.limits?.enabled() === true });
        return;
      } else if (request.url === "/v1/turn/heartbeat") {
        host.heartbeatTurn(body.traceId, body.helperPid, body.refreshViewport === true, body.progress);
        this.logger.debug?.("browser.turn_heartbeat", { traceId: body.traceId });
        writeJson(response, 200, { ok: true });
        return;
      } else {
        if (!['completed', 'failed', 'aborted'].includes(body.status)) throw new Error("turn status is invalid");
        const release = await host.endTurn(
          body.traceId,
          body.helperPid,
          body.status,
          preferences.showBrowserDuringTurns === true,
          body.message,
          body.retain === true,
          body.connectorBound === true,
        );
        this.logger.info("browser.turn_ended", { traceId: body.traceId, status: body.status });
        writeJson(response, 200, { ok: true, ...release });
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("browser.control_rejected", { message });
      const cancelled = error?.code === "turn_cancelled";
      const retainedUnavailable = error?.code === "retained_conversation_unavailable";
      const ownerLost = error?.code === "turn_owner_lost";
      const manualInspectionDisabled = error?.code === "manual_browser_inspection_disabled";
      const manualOwnerLost = error?.code === "manual_turn_owner_lost";
      const manualTimedOut = error?.code === "manual_turn_timed_out";
      writeJson(
        response,
        cancelled || retainedUnavailable || ownerLost || manualInspectionDisabled || manualOwnerLost
          ? 409
          : manualTimedOut ? 408 : 400,
        {
        error: message,
        ...(cancelled ? { code: "turn_cancelled" } : {}),
        ...(retainedUnavailable ? { code: "retained_conversation_unavailable" } : {}),
        ...(ownerLost ? { code: "turn_owner_lost" } : {}),
        ...(manualInspectionDisabled ? { code: "manual_browser_inspection_disabled" } : {}),
        ...(manualOwnerLost ? { code: "manual_turn_owner_lost" } : {}),
        ...(manualTimedOut ? { code: "manual_turn_timed_out" } : {}),
        },
      );
    }
  }

  async close() {
    if (!this.server.listening) return;
    await new Promise((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }
}

module.exports = { BrowserControlServer, MAX_MANUAL_START_BODY_BYTES, MANUAL_SENT_OBSERVER_TIMEOUT_MS };
