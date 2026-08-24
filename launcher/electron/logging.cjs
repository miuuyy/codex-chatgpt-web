const fs = require("node:fs");
const path = require("node:path");
const { renameAtomicFile } = require("./atomic-file.cjs");

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_MEMORY_RECORDS = 300;
const MAX_LOG_STRING_CHARS = 16 * 1024;

function redactText(value) {
  const redacted = value
    .replace(/tunnel_[a-f0-9]{32}/g, "[tunnel-id]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[runtime-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{20,}\b/gi, "Bearer [redacted]");
  return redacted.length > MAX_LOG_STRING_CHARS
    ? `${redacted.slice(0, MAX_LOG_STRING_CHARS)}…[truncated]`
    : redacted;
}

function redactExportText(value) {
  return redactText(value)
    .replace(/\b[A-Za-z]:\\+Users\\+[^\\/\r\n"'`<>|]+/gi, "[user-home]")
    .replace(/\/(?:Users|home)\/[^/\r\n"'`<>]+/g, "[user-home]")
    .replace(/((?:visible rows|sidebar (?:rows|titles)|conversation titles):)\s*[^\r\n]*/gi, "$1 [redacted]");
}

function sanitizeForExport(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactExportText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeForExport(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /^(?:prompt|response|html|dom|content|visibleRows|sidebarRows|sidebarTitles|conversationTitle|conversationTitles|chatTitle|chatTitles)$/i.test(key)
        ? "[redacted]"
        : sanitizeForExport(item, seen),
    ]),
  );
}

function exportSanitizedLogs({ filePath, destinationPath }) {
  const sourcePaths = [`${filePath}.1`, filePath];
  const destination = path.resolve(destinationPath);
  if (sourcePaths.some(sourcePath => path.resolve(sourcePath) === destination)) {
    throw new Error("Refusing to overwrite a launcher source log with an exported diagnostic");
  }
  const records = [];
  for (const sourcePath of sourcePaths) {
    let lines;
    try {
      lines = fs.readFileSync(sourcePath, "utf8").split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (!record
          || typeof record.at !== "string"
          || !["debug", "info", "warning", "error"].includes(record.level)
          || typeof record.event !== "string") continue;
        records.push({
          at: record.at,
          level: record.level,
          event: record.event,
          detail: record.detail && typeof record.detail === "object"
            ? sanitizeForExport(record.detail)
            : {},
        });
      } catch {}
    }
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    destination,
    records.length > 0 ? `${records.map(record => JSON.stringify(record)).join("\n")}\n` : "",
    { mode: 0o600 },
  );
  if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
  return records.length;
}

function sanitize(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /(?:authorization|cookie|runtimeKey|controlToken)/i.test(key)
        ? "[redacted]"
        : sanitize(item, seen),
    ]),
  );
}

function readRecent(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-MAX_MEMORY_RECORDS)
      .flatMap((line) => {
        try {
          const record = JSON.parse(line);
          if (!record
            || typeof record.at !== "string"
            || !["debug", "info", "warning", "error"].includes(record.level)
            || typeof record.event !== "string") return [];
          return [{
            at: record.at,
            level: record.level,
            event: record.event,
            detail: record.detail && typeof record.detail === "object"
              ? sanitize(record.detail)
              : {},
          }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function createLogger({ filePath, publish }) {
  const records = readRecent(filePath);

  const append = (level, event, detail = {}) => {
    const record = {
      at: new Date().toISOString(),
      level,
      event,
      detail: detail && typeof detail === "object" && !Array.isArray(detail) ? sanitize(detail) : {},
    };
    records.push(record);
    if (records.length > MAX_MEMORY_RECORDS) records.splice(0, records.length - MAX_MEMORY_RECORDS);
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const stat = fs.statSync(filePath, { throwIfNoEntry: false });
      if (stat && stat.size >= MAX_LOG_BYTES) {
        fs.rmSync(`${filePath}.1`, { force: true });
        renameAtomicFile(filePath, `${filePath}.1`);
      }
      fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {}
    publish?.(record);
    return record;
  };

  return {
    debug: (event, detail) => append("debug", event, detail),
    info: (event, detail) => append("info", event, detail),
    warn: (event, detail) => append("warning", event, detail),
    error: (event, detail) => append("error", event, detail),
    recent: (limit = 150) => records.slice(-Math.max(1, Math.min(300, limit))),
    filePath,
  };
}

function installProcessDiagnosticGuards({ filePath, streams = [process.stdout, process.stderr] }) {
  const guarded = new Set();
  for (const stream of streams) {
    if (!stream || typeof stream.on !== "function" || guarded.has(stream)) continue;
    guarded.add(stream);
    stream.on("error", (error) => {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        fs.appendFileSync(
          filePath,
          `${new Date().toISOString()} ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
          { mode: 0o600 },
        );
      } catch {
        // A lost diagnostic sink must not become a second process error.
      }
    });
  }
}

function registerLoggedIpc(ipcMain, logger, channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      logger.error("launcher.ipc_failed", {
        channel,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
}

module.exports = {
  createLogger,
  exportSanitizedLogs,
  installProcessDiagnosticGuards,
  readRecent,
  redactExportText,
  redactText,
  registerLoggedIpc,
  sanitize,
  sanitizeForExport,
};
