import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig, saveConfig } from "../src/config";
import { getServiceStatus, installService, uninstallService } from "../src/service";

if (process.platform !== "win32") {
  process.stdout.write("WINDOWS_SERVICE_SMOKE_SKIPPED\n");
  process.exit(0);
}
if (getServiceStatus().installed) {
  throw new Error("Refusing the isolated smoke because CodexChatGPTWebBridge already exists");
}

const home = join(homedir(), `.codex-chatgpt-web-service-smoke-${process.pid}-${Date.now()}`);
process.env.CODEX_CHATGPT_WEB_HOME = home;
const launcher = resolve("dist", "runtime", "bin", "codex-chatgpt-web.cmd");
if (!existsSync(launcher)) throw new Error(`Build the relocatable runtime first: ${launcher}`);

const portServer = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = portServer.port;
portServer.stop();
const config = {
  ...defaultConfig("browser-only"),
  port,
  runtimeCommand: [launcher],
  acknowledgedUnofficialAt: new Date().toISOString(),
};
mkdirSync(join(home, "browser"), { recursive: true });
writeFileSync(config.storageStatePath, "{}\n");
saveConfig(config);

try {
  installService(config);
  const deadline = Date.now() + 15_000;
  let health: Response | undefined;
  while (Date.now() < deadline) {
    try {
      health = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (health.ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  if (!health?.ok) throw new Error("Scheduled Task daemon did not become healthy");
  if (!getServiceStatus().installed) throw new Error("Scheduled Task disappeared during the smoke");
  process.stdout.write("WINDOWS_SERVICE_SMOKE_OK\n");
} finally {
  if (getServiceStatus().installed) await uninstallService(config);
  rmSync(home, { recursive: true, force: true });
}
