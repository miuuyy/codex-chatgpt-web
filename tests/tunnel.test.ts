import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { TUNNEL_VERSION, installTunnelClient, parseTunnelStatus, removeTunnelInstallFile, tunnelClientInstallAction, tunnelCommandOutput, tunnelConnectLaunchError } from "../src/tunnel";

test("pins the fixed tunnel-client and migrates only the previously shipped version", () => {
  expect(TUNNEL_VERSION).toBe("0.0.12");
  expect(tunnelClientInstallAction("0.0.12")).toBe("reuse");
  expect(tunnelClientInstallAction("0.0.10")).toBe("upgrade");
  expect(() => tunnelClientInstallAction("0.0.11")).toThrow("not a trusted upgrade source");
  expect(() => tunnelClientInstallAction("9.9.9")).toThrow("not a trusted upgrade source");
});

test("Windows tunnel install cleanup retries transient file locks with bounded backoff", async () => {
  const waits: number[] = [];
  let attempts = 0;
  await removeTunnelInstallFile("staged.exe", {
    platform: "win32",
    remove() {
      attempts += 1;
      if (attempts < 4) throw Object.assign(new Error("locked"), { code: "EBUSY" });
    },
    wait: async delay => { waits.push(delay); },
    retryDelaysMs: [10, 20, 30, 40],
  });
  expect(attempts).toBe(4);
  expect(waits).toEqual([10, 20, 30]);
});

test("Windows tunnel install cleanup succeeds after one EBUSY retry", async () => {
  const waits: number[] = [];
  let attempts = 0;
  await removeTunnelInstallFile("staged.exe", {
    platform: "win32",
    remove() {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("locked"), { code: "EBUSY" });
    },
    wait: async delay => { waits.push(delay); },
    retryDelaysMs: [100, 200],
  });
  expect(attempts).toBe(2);
  expect(waits).toEqual([100]);
});

test("Windows tunnel install cleanup retries EPERM", async () => {
  let attempts = 0;
  await removeTunnelInstallFile("staged.exe", {
    platform: "win32",
    remove() {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("denied"), { code: "EPERM" });
    },
    wait: async () => {},
  });
  expect(attempts).toBe(2);
});

test("Windows tunnel install cleanup preserves the last lock error after bounded retries", async () => {
  let attempts = 0;
  const terminal = Object.assign(new Error("still locked"), { code: "EBUSY" });
  await expect(removeTunnelInstallFile("staged.exe", {
    platform: "win32",
    remove() {
      attempts += 1;
      throw terminal;
    },
    wait: async () => {},
    retryDelaysMs: [10, 20],
  })).rejects.toBe(terminal);
  expect(attempts).toBe(3);
});

test("tunnel install cleanup does not retry unrelated or non-Windows failures", async () => {
  for (const [platform, code] of [["win32", "EACCES"], ["linux", "EBUSY"]] as const) {
    let attempts = 0;
    await expect(removeTunnelInstallFile("staged", {
      platform,
      remove() { attempts += 1; throw Object.assign(new Error("failed"), { code }); },
      wait: async () => {},
    })).rejects.toMatchObject({ code });
    expect(attempts).toBe(1);
  }
});

function windowsTunnelDownload(binary: Uint8Array) {
  const asset = `tunnel-client-v${TUNNEL_VERSION}-windows-amd64.zip`;
  const archive = zipSync({ "tunnel-client.exe": binary });
  const checksum = createHash("sha256").update(archive).digest("hex");
  return async (url: string): Promise<Uint8Array> => url.endsWith("SHA256SUMS.txt")
    ? new TextEncoder().encode(`${checksum}  ${asset}\n`)
    : archive;
}

test("Windows tunnel install removes its verified temporary executable", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-tunnel-install-"));
  const binary = new TextEncoder().encode("fixture tunnel-client binary");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "tunnel-client.exe.install-999999-stale.exe"), "stale");
  try {
    const executable = await installTunnelClient({
      platform: "win32",
      architecture: "x64",
      configDir: root,
      fetchBytes: windowsTunnelDownload(binary),
      randomUUID: () => "fixture-id",
      runChecked: command => {
        expect(existsSync(command)).toBe(true);
        return { status: 0, stdout: `${TUNNEL_VERSION}+fixture`, stderr: "" };
      },
    });
    expect(readFileSync(executable)).toEqual(Buffer.from(binary));
    expect(readdirSync(join(root, "bin")).filter(name => name.includes(".install-"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a valid installed Windows tunnel-client is reused without downloading", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-tunnel-reuse-"));
  const binary = new TextEncoder().encode("fixture tunnel-client binary");
  let downloads = 0;
  const download = windowsTunnelDownload(binary);
  const runVersion = () => ({ status: 0, stdout: `${TUNNEL_VERSION}+fixture`, stderr: "" });
  try {
    const executable = await installTunnelClient({
      platform: "win32",
      architecture: "x64",
      configDir: root,
      fetchBytes: async url => { downloads += 1; return download(url); },
      runChecked: runVersion,
    });
    expect(downloads).toBe(2);
    expect(await installTunnelClient({
      platform: "win32",
      architecture: "x64",
      configDir: root,
      fetchBytes: async () => { throw new Error("valid install must not download"); },
      runChecked: runVersion,
    })).toBe(executable);
    expect(downloads).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an untracked Windows tunnel-client is adopted only after matching the pinned download", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-tunnel-adopt-"));
  const executable = join(root, "bin", "tunnel-client.exe");
  const manifest = join(root, "bin", "tunnel-client-manifest.json");
  const binary = new TextEncoder().encode("fixture tunnel-client binary");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(executable, binary);
  try {
    const commands: string[] = [];
    expect(await installTunnelClient({
      platform: "win32",
      architecture: "x64",
      configDir: root,
      fetchBytes: windowsTunnelDownload(binary),
      runChecked: command => {
        commands.push(command);
        return { status: 0, stdout: `${TUNNEL_VERSION}+fixture`, stderr: "" };
      },
    })).toBe(executable);
    expect(commands).toEqual([executable]);
    expect(existsSync(manifest)).toBe(true);
    expect(readdirSync(join(root, "bin")).filter(name => name.includes(".install-"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("temporary cleanup failure does not replace tunnel-client verification failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-tunnel-error-context-"));
  const primary = new Error("synthetic verification failure");
  try {
    const caught = await installTunnelClient({
      platform: "win32",
      architecture: "x64",
      configDir: root,
      fetchBytes: windowsTunnelDownload(new TextEncoder().encode("fixture tunnel-client binary")),
      runChecked: () => { throw primary; },
      removeOptions: {
        remove: () => { throw Object.assign(new Error("synthetic cleanup EBUSY"), { code: "EBUSY" }); },
        wait: async () => {},
        retryDelaysMs: [],
      },
    }).then(() => undefined, error => error);
    expect(caught.message).toStartWith("synthetic verification failure;");
    expect(caught.message).toContain("temporary tunnel-client cleanup also failed");
    expect(caught.cause).toBe(primary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("tunnel status boundary", () => {
  test("requires the exact alias to have a locally verified ready runtime", () => {
    expect(parseTunnelStatus(JSON.stringify({
      entries: [{ alias: "ours", runtime_state: "ready" }],
    }), "ours")).toEqual({
      ok: true,
      processRunning: true,
      healthy: true,
      ready: true,
      state: "ready",
      detail: "process_running=true healthy=true ready=true",
    });
    for (const state of ["stopped", "starting", "healthy"]) {
      expect(parseTunnelStatus(JSON.stringify({ entries: [
        { alias: "other", runtime_state: "ready" }, { alias: "ours", runtime_state: state },
      ] }), "ours")).toMatchObject({
        ok: false, processRunning: state !== "stopped", healthy: state === "healthy", ready: false,
      });
    }
  });

  test("redacts tunnel ids and keys from safe diagnostics", () => {
    const result = parseTunnelStatus(
      "failed tunnel_0123456789abcdef0123456789abcdef with sk-secretsecretsecret",
      "ours",
      1,
    );
    expect(result.detail).toBe("failed [tunnel-id] with [redacted-key]");
    expect(result.detail).not.toContain("0123456789abcdef");
  });

  test("surfaces and redacts an immediate managed-runtime launch failure", () => {
    const detail = tunnelConnectLaunchError(JSON.stringify({
      running: false,
      healthy: false,
      ready: false,
      exit_code: 1,
      launch_diagnostics: {
        log_tail: "403 for tunnel_0123456789abcdef0123456789abcdef using sk-secretsecretsecret",
      },
    }));

    expect(detail).toBe(
      "running=false; healthy=false; ready=false; exit_code=1; runtime_log=403 for [tunnel-id] using [redacted-key]",
    );
  });

  test("accepts a healthy managed launch while setup waits for control-plane readiness", () => {
    expect(tunnelConnectLaunchError(JSON.stringify({
      running: true,
      healthy: true,
      ready: true,
    }))).toBeUndefined();

    expect(tunnelConnectLaunchError(JSON.stringify({
      running: true,
      healthy: true,
      ready: false,
    }))).toBeUndefined();

    expect(tunnelConnectLaunchError(JSON.stringify({
      running: true,
      healthy: false,
      ready: false,
    }))).toContain("running=true; healthy=false; ready=false");

    expect(tunnelConnectLaunchError("not json")).toBe("tunnel-client returned non-JSON connect output");
  });

  test("missing, ambiguous, or malformed local inventory cannot report ready", () => {
    const ready = { alias: "ours", runtime_state: "ready" };
    for (const output of ["invalid JSON", "{}", JSON.stringify({ entries: [ready, ready] }),
      JSON.stringify({ entries: [{ ...ready, runtime_state: "unknown" }] })]) {
      expect(parseTunnelStatus(output, "ours")).toMatchObject({ ok: false, ready: false });
      expect(parseTunnelStatus(output, "ours").detail).toContain("invalid local inventory");
    }
    expect(parseTunnelStatus(JSON.stringify({ entries: [{ ...ready, alias: "other" }] }), "ours"))
      .toMatchObject({ ok: false, processRunning: false, healthy: false, ready: false, state: "stopped" });
  });

  test("status diagnostics do not discard stderr when a failed command also wrote stdout", () => {
    expect(tunnelCommandOutput({
      status: 1,
      stdout: '{"partial":true}',
      stderr: "runtime process exited with status 1",
    })).toBe('runtime process exited with status 1\n{"partial":true}');
    expect(tunnelCommandOutput({
      status: 0,
      stdout: '{"ready":true}',
      stderr: "non-fatal warning",
    })).toBe('{"ready":true}');
  });
});
