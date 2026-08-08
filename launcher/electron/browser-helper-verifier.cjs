const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { createInterface } = require("node:readline");

const BROWSER_HELPER_OPERATION_TIMEOUT_MS = 90_000;

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

function writeMessage(child, message) {
  if (child.exitCode !== null
    || child.signalCode !== null
    || child.stdin.destroyed
    || child.stdin.writableEnded) {
    return Promise.reject(new Error("Browser helper verification input is closed"));
  }
  return new Promise((resolve, reject) => {
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await writeMessage(child, { type: "shutdown" }).catch(() => {});
  if (await waitForExit(child, 5_000)) return;
  if (!child.kill("SIGTERM") && child.exitCode === null && child.signalCode === null) {
    throw new Error("Browser helper verification process refused termination");
  }
  if (!await waitForExit(child, 2_000)) {
    throw new Error("Browser helper verification process did not exit after termination");
  }
}

async function runBrowserHelperOperation({ helper, descriptorPath, appName, operation, payload = {}, logger }) {
  if (!helper || typeof helper.executable !== "string" || typeof helper.script !== "string") {
    throw new Error("Browser helper verification command is invalid");
  }
  if (typeof descriptorPath !== "string" || !descriptorPath || typeof appName !== "string" || !appName) {
    throw new Error("Browser helper verification config is invalid");
  }
  if (!["verify", "inspect", "smoke"].includes(operation)) {
    throw new Error(`Unsupported browser helper operation: ${String(operation)}`);
  }
  const id = `${operation}-${randomBytes(12).toString("hex")}`;
  const child = spawn(helper.executable, [helper.script], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let completed = false;
  let sent = false;
  let timer;
  const output = createInterface({ input: child.stdout });
  const errors = createInterface({ input: child.stderr });
  errors.on("line", (line) => logger?.info("browser.connector_helper", { message: line.slice(0, 2_000) }));

  const result = new Promise((resolve, reject) => {
    const finish = (error, value) => {
      if (completed) return;
      completed = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    // A callback on write() does not consume the stream's separate `error` event. On Windows,
    // closing the helper's read side can therefore surface ERROR_BROKEN_PIPE/EOF as an uncaught
    // exception in Electron's main process even when the write promise is already handled.
    child.stdin.on("error", (error) => finish(
      error instanceof Error ? error : new Error(String(error)),
    ));
    child.stdout.on("error", (error) => finish(
      error instanceof Error ? error : new Error(String(error)),
    ));
    child.stderr.on("error", (error) => finish(
      error instanceof Error ? error : new Error(String(error)),
    ));
    output.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); }
      catch {
        finish(new Error("Browser helper verification emitted invalid JSON"));
        return;
      }
      if (message?.type === "ready") {
        if (sent) {
          finish(new Error("Browser helper verification emitted duplicate readiness"));
          return;
        }
        sent = true;
        void writeMessage(child, {
          ...payload,
          type: operation,
          id,
          config: { appName, browserHostDescriptorPath: descriptorPath },
        }).catch(error => finish(error instanceof Error ? error : new Error(String(error))));
        return;
      }
      if (message?.id !== id) {
        finish(new Error("Browser helper verification response identity is invalid"));
        return;
      }
      if (message.type === "result") {
        finish(null, message);
        return;
      }
      if (message.type === "error" && typeof message.message === "string") {
        finish(new Error(message.message));
        return;
      }
      finish(new Error("Browser helper verification emitted an unexpected message"));
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => finish(new Error(
      `Browser helper verification exited ${signal ? `from signal ${signal}` : `with status ${code ?? 1}`}`,
    )));
    timer = setTimeout(
      () => finish(new Error(`Browser helper ${operation} timed out`)),
      BROWSER_HELPER_OPERATION_TIMEOUT_MS,
    );
  });

  let value;
  let primaryError;
  try {
    value = await result;
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
  }
  try {
    await stopChild(child);
  } catch (cleanupError) {
    const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    if (primaryError) throw new Error(`${primaryError.message}; browser helper cleanup failed: ${cleanup}`);
    throw cleanupError;
  } finally {
    output.close();
    errors.close();
  }
  if (primaryError) throw primaryError;
  return value;
}

async function verifyConnectorWithBrowserHelper(options) {
  const message = await runBrowserHelperOperation({ ...options, operation: "verify" });
  if (message.text !== options.appName) {
    throw new Error("Browser helper verified a different ChatGPT connector");
  }
  return { ok: true, appName: options.appName };
}

module.exports = { runBrowserHelperOperation, verifyConnectorWithBrowserHelper };
