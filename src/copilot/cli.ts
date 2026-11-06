import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config";
import {
  COPILOT_DEFAULT_MODEL,
  getCopilotConfigPath,
  getCopilotHome,
  loadCopilotConfig,
  saveCopilotConfig,
  type CopilotConfig,
} from "./config";
import { CopilotBrowser, CopilotSignInRequiredError, closeCopilotBrowsers } from "./browser";
import { copilotCatalog } from "./models";
import { startCopilotServer } from "./server";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function applyOverrides(config: CopilotConfig, args: string[]): CopilotConfig {
  const port = option(args, "--port");
  const cdp = option(args, "--cdp");
  return {
    ...config,
    ...(port ? { port: Number(port) } : {}),
    browser: {
      ...config.browser,
      ...(cdp ? { mode: "cdp" as const, cdpUrl: cdp } : {}),
      ...(flag(args, "--headless") ? { headed: false } : {}),
      ...(flag(args, "--headed") ? { headed: true } : {}),
    },
  };
}

function printConfig(config: CopilotConfig): void {
  console.log(`config: ${getCopilotConfigPath()}`);
  console.log(`home:   ${getCopilotHome()}`);
  console.log(`listen: http://${config.host}:${config.port}/v1`);
  console.log(`browser: ${config.browser.mode}${config.browser.mode === "cdp" ? ` (${config.browser.cdpUrl})` : ""}`);
  if (config.browser.mode === "persistent") {
    console.log(`profile: ${config.browser.userDataDir}`);
    console.log(`chrome:  ${config.browser.chromeExecutablePath}`);
  }
  console.log("models:");
  for (const model of config.models) {
    console.log(`  ${model.id}  ->  Copilot model ${JSON.stringify(model.menuLabel)}`);
  }
}

async function login(args: string[]): Promise<void> {
  const config = applyOverrides(loadCopilotConfig({ create: true }), args);
  if (config.browser.mode === "cdp") {
    throw new Error(
      "browser.mode is cdp. Sign in inside the Chrome instance at "
        + `${config.browser.cdpUrl}, then run \`bun run copilot:doctor\`.`,
    );
  }
  console.log("Opening Microsoft 365 Copilot in a dedicated Chrome profile.");
  console.log("Sign in with the Microsoft account that has Copilot access. The window closes automatically after sign-in.");
  console.log(`Profile: ${config.browser.userDataDir}`);
  const browser = new CopilotBrowser(config);
  const deadline = Date.now() + config.loginTimeoutMs;
  let lastReported = "";
  try {
    while (Date.now() < deadline) {
      try {
        const page = await browser.open();
        console.log(`Signed in: ${page.title || "(no title)"} — ${page.url}`);
        return;
      } catch (error) {
        if (!(error instanceof CopilotSignInRequiredError)) {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== lastReported) {
            lastReported = message;
            console.log(`Waiting for sign-in: ${message}`);
          }
        }
      }
      await sleep(2_000);
    }
    throw new Error(
      `Sign-in did not complete within ${Math.round(config.loginTimeoutMs / 1_000)} seconds. `
        + "Run the command again and finish the Microsoft login in the opened window.",
    );
  } finally {
    await browser.close();
  }
}

async function serve(args: string[]): Promise<void> {
  const config = applyOverrides(loadCopilotConfig({ create: true }), args);
  printConfig(config);
  const server = startCopilotServer(config);
  console.log("");
  console.log(`codex-copilot-web listening on http://${config.host}:${server.port}/v1`);
  console.log("The Copilot browser opens lazily on the first /v1/responses request.");
  const shutdown = async (): Promise<void> => {
    console.log("\nShutting down codex-copilot-web...");
    await closeCopilotBrowsers();
    server.stop(true);
    process.exit(0);
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

async function doctor(args: string[]): Promise<void> {
  const config = applyOverrides(loadCopilotConfig({ create: true }), args);
  printConfig(config);
  const browser = new CopilotBrowser(config);
  try {
    const result = await browser.probe(option(args, "--prompt"));
    console.log("");
    console.log(`signed_in: ${result.signedIn}`);
    console.log(`url: ${result.url}`);
    console.log(`title: ${result.title}`);
    console.log(`composer_matches: ${result.composerMatches}`);
    console.log(`model_button: ${result.modelButtonLabel ?? "(not found)"}`);
    console.log(`new_chat_matches: ${result.newChatMatches}`);
    console.log(`send_matches: ${result.sendMatches}`);
    console.log(`stop_matches: ${result.stopMatches}`);
    if (result.response !== undefined) {
      console.log("");
      console.log("probe response:");
      console.log(result.response);
    }
  } finally {
    await browser.close();
  }
}

async function probe(args: string[]): Promise<void> {
  const config = applyOverrides(loadCopilotConfig({ create: true }), args);
  const browser = new CopilotBrowser(config);
  try {
    const prompt = flag(args, "--no-send")
      ? undefined
      : (option(args, "--prompt") ?? "Reply with exactly: COPILOT_PROBE_OK");
    console.log(prompt ? `Sending probe prompt: ${JSON.stringify(prompt)}` : "Inspecting the Copilot page without sending a prompt.");
    const result = await browser.probe(prompt);
    const directory = join(getCopilotHome(), "diagnostics");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`wrote ${path}`);
    console.log(`signed_in=${result.signedIn} composer_matches=${result.composerMatches} model=${JSON.stringify(result.modelButtonLabel)}`);
    console.log(`candidates: ${result.candidates.map(candidate => `${candidate.selector}=${candidate.count}`).join(", ")}`);
    if (result.response !== undefined) {
      console.log("");
      console.log("extracted response:");
      console.log(result.response);
    }
  } finally {
    await browser.close();
  }
}

function codexConfig(args: string[]): void {
  const config = applyOverrides(loadCopilotConfig({ create: true }), args);
  const catalogPath = option(args, "--catalog") ?? join(getCopilotHome(), "models.json");
  atomicWriteFile(catalogPath, `${JSON.stringify(copilotCatalog(config), null, 2)}\n`);
  const model = option(args, "--model") ?? COPILOT_DEFAULT_MODEL;
  if (!config.models.some(candidate => candidate.id === model)) {
    throw new Error(`Unknown model ${JSON.stringify(model)}. Available: ${config.models.map(m => m.id).join(", ")}`);
  }
  console.log(`# Wrote the Copilot model catalog to ${catalogPath}`);
  console.log("# Paste this into ~/.codex/config.toml (or merge it with the existing top-level values).");
  console.log("");
  console.log(`model = ${JSON.stringify(model)}`);
  console.log('model_provider = "copilot-web"');
  console.log(`model_catalog_json = ${JSON.stringify(catalogPath)}`);
  console.log("");
  console.log("[model_providers.copilot-web]");
  console.log('name = "Microsoft 365 Copilot Web"');
  console.log(`base_url = ${JSON.stringify(`http://${config.host}:${config.port}/v1`)}`);
  console.log('env_key = "COPILOT_WEB_API_KEY"');
  console.log('wire_api = "responses"');
  console.log("supports_websockets = false");
  console.log("");
  console.log("# The local server ignores the key unless controlToken is configured.");
  console.log("# export COPILOT_WEB_API_KEY=local");
  console.log("# bun run copilot:serve");
}

function models(args: string[]): void {
  const config = applyOverrides(loadCopilotConfig({ create: true }), args);
  console.log(JSON.stringify(copilotCatalog(config), null, 2));
}

function init(args: string[]): void {
  const config = applyOverrides(loadCopilotConfig({ create: false }), args);
  saveCopilotConfig(config);
  printConfig(config);
  console.log("");
  console.log(`Wrote ${getCopilotConfigPath()}`);
}

export async function runCopilotCli(argv: string[]): Promise<void> {
  const [command = "serve", ...args] = argv;
  switch (command) {
    case "init":
      init(args);
      return;
    case "login":
      await login(args);
      return;
    case "serve":
      await serve(args);
      return;
    case "doctor":
      await doctor(args);
      return;
    case "probe":
      await probe(args);
      return;
    case "config":
      codexConfig(args);
      return;
    case "models":
      models(args);
      return;
    default:
      throw new Error(
        `Unknown command ${JSON.stringify(command)}. Use init, login, serve, doctor, probe, config, or models.`,
      );
  }
}

if (import.meta.main) {
  runCopilotCli(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
