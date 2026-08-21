const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

test("managed tunnel commands extend the MCP transport lifetime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-ttl-"));
  const script = path.join(root, "print-env.cjs");
  fs.writeFileSync(script, "process.stdout.write(process.env.MCP_CONNECTION_MAX_TTL || 'missing');\n");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "2.1.1", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  try {
    const result = await supervisor.runTunnelCommand(
      { tunnel: { binaryPath: process.execPath, profileDir: root } },
      [script],
      5_000,
      "Tunnel TTL probe",
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "24h");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
