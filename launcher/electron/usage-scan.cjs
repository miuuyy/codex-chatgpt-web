const fs = require("node:fs");
const path = require("node:path");

const DAY_MS = 24 * 60 * 60 * 1000;
const SCAN_HORIZON_MS = 8 * DAY_MS;
const MAX_SCANNED_TURNS = 2000;
const RATE_LIMIT_PATTERN = /rate.?limit|too many requests|太多请求|太多要求|429/i;

function emptyReport(now) {
  return {
    generatedAt: new Date(now).toISOString(),
    last24h: { completed: 0, failed: 0, rateLimited: 0 },
    last7d: { completed: 0, failed: 0, rateLimited: 0 },
    lastRateLimitAt: null,
    lastFailureAt: null,
    lastFailureError: null,
    scannedTurns: 0,
    truncated: false,
  };
}

function readFinalCheckpoint(dir, files) {
  const finals = files.filter((name) => name.endsWith("turn-completed.json") || name.endsWith("turn-failed.json"));
  if (finals.length === 0) return null;
  const name = finals.sort().pop();
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    return {
      failed: name.endsWith("turn-failed.json"),
      capturedAt: typeof parsed.capturedAt === "string" ? Date.parse(parsed.capturedAt) : NaN,
      error: typeof parsed.error === "string" ? parsed.error : null,
    };
  } catch {
    return { failed: name.endsWith("turn-failed.json"), capturedAt: NaN, error: null };
  }
}

/**
 * Estimate ChatGPT Web usage from the bridge's own browser-turn diagnostics. ChatGPT exposes no
 * numeric quota API, so these counts cover only bridge-driven turns on this machine; messages sent
 * through the ChatGPT UI elsewhere (and every staged multipart message inside one turn) are not
 * counted here.
 */
function scanWebUsage(coreHome, now = Date.now()) {
  const report = emptyReport(now);
  const root = path.join(coreHome, "diagnostics", "browser-turns");
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return report;
  }
  const horizon = now - SCAN_HORIZON_MS;
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!Number.isFinite(stat.mtimeMs) || stat.mtimeMs < horizon) continue;
    candidates.push({ dir, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  report.truncated = candidates.length > MAX_SCANNED_TURNS;
  for (const candidate of candidates.slice(0, MAX_SCANNED_TURNS)) {
    let files;
    try {
      files = fs.readdirSync(candidate.dir);
    } catch {
      continue;
    }
    const final = readFinalCheckpoint(candidate.dir, files);
    if (!final) continue;
    report.scannedTurns += 1;
    const at = Number.isFinite(final.capturedAt) ? final.capturedAt : candidate.mtimeMs;
    const rateLimited = final.error !== null && RATE_LIMIT_PATTERN.test(final.error);
    const within24h = now - at < DAY_MS;
    const within7d = now - at < 7 * DAY_MS;
    for (const bucket of [within24h ? report.last24h : null, within7d ? report.last7d : null]) {
      if (!bucket) continue;
      if (final.failed) bucket.failed += 1;
      else bucket.completed += 1;
      if (rateLimited) bucket.rateLimited += 1;
    }
    if (final.failed && (report.lastFailureAt === null || at > Date.parse(report.lastFailureAt))) {
      report.lastFailureAt = new Date(at).toISOString();
      report.lastFailureError = final.error;
    }
    if (rateLimited && (report.lastRateLimitAt === null || at > Date.parse(report.lastRateLimitAt))) {
      report.lastRateLimitAt = new Date(at).toISOString();
    }
  }
  return report;
}

module.exports = { scanWebUsage };
