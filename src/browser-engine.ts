import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox } from "playwright-core";
import { runChecked } from "./process";

export type BrowserEngine = "chromium" | "firefox";

export function browserName(engine: BrowserEngine): string {
  return engine === "firefox" ? "Firefox" : "Chromium";
}

export function browserType(engine: BrowserEngine): typeof chromium | typeof firefox {
  return engine === "firefox" ? firefox : chromium;
}

export function defaultBrowserExecutable(engine: BrowserEngine): string | undefined {
  if (engine === "firefox") return undefined;
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "win32") {
    return join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
  }
  return "/usr/bin/google-chrome";
}

export function resolvedBrowserExecutable(config: {
  browserEngine: BrowserEngine;
  browserExecutablePath?: string;
}): string {
  return config.browserExecutablePath || browserType(config.browserEngine).executablePath();
}

export function ensureBrowserExecutable(config: {
  browserEngine: BrowserEngine;
  browserExecutablePath?: string;
}): string {
  let executable = resolvedBrowserExecutable(config);
  if (existsSync(executable)) return executable;
  if (config.browserEngine !== "firefox" || config.browserExecutablePath) {
    throw new Error(`${browserName(config.browserEngine)} was not found at ${executable}. Pass --browser-path with its executable path.`);
  }

  const packageEntry = fileURLToPath(import.meta.resolve("playwright-core"));
  const cli = join(dirname(packageEntry), "cli.js");
  runChecked(process.execPath, [cli, "install", "firefox"], { stdio: "inherit" });
  executable = resolvedBrowserExecutable(config);
  if (!existsSync(executable)) throw new Error(`Playwright did not install Firefox at ${executable}`);
  return executable;
}
