import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import {
  connectLauncherBrowserHost,
  LAUNCHER_BROWSER_HOST_KIND,
  LAUNCHER_BROWSER_IDLE_URL,
} from "../src/launcher-browser-host";

// A disposable, unauthenticated browser proves that attaching a second worker
// does not turn either the owned page or another existing page back to light.
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("launcher CDP attachments preserve native dark appearance across pages", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-theme-test-"));
  // Start outside Playwright so neither media nor focus is already emulated.
  const child = Bun.spawn([
    process.env.CHATGPT_DOM_TEST_BROWSER!,
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${root}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--force-dark-mode",
    "about:blank",
  ], { stdout: "ignore", stderr: "ignore" });
  let browser: Browser | undefined;
  const connections: Awaited<ReturnType<typeof connectLauncherBrowserHost>>[] = [];
  try {
    let port = 0;
    const deadline = Date.now() + 10_000;
    while (!port && Date.now() < deadline) {
      try {
        port = Number(readFileSync(join(root, "DevToolsActivePort"), "utf8").split("\n")[0]);
      } catch { /* Chrome has not written its endpoint yet. */ }
      if (!port) await Bun.sleep(50);
    }
    expect(port).toBeGreaterThan(0);
    const endpoint = `http://127.0.0.1:${port}`;
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    const context = browser.contexts()[0]!;
    const page = context.pages()[0]!;
    const other = await context.newPage();
    for (const target of [page, other]) await target.setContent("<form><input aria-label='Draft'></form>");
    const dark = () => Promise.all([page, other].map(target => target.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)));
    expect(await dark()).toEqual([true, true]);
    await other.bringToFront();
    expect(await page.evaluate(() => document.hasFocus())).toBe(false);
    const native = await context.newCDPSession(page);
    const { targetInfo } = await native.send("Target.getTargetInfo");
    await native.detach();
    const surfaceId = "theme_surface_id_0123456789ABCDE";
    const descriptor = join(root, "descriptor.json");
    writeFileSync(descriptor, JSON.stringify({
      version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
      endpoint,
      control: { endpoint: "http://127.0.0.1:39111", token: "theme-fixture-token-0123456789abcdefghijklmnop" },
      helper: { executable: process.execPath, script: import.meta.path },
      partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
      surfaceId, surfaceTargets: { [surfaceId]: targetInfo.targetId }, createdAt: new Date().toISOString(),
    }), { mode: 0o600 });
    for (let i = 0; i < 2; i++) {
      const connection = await connectLauncherBrowserHost(descriptor);
      connections.push(connection);
      expect(await dark()).toEqual([true, true]);
      expect(await connection.page.evaluate(() => document.hasFocus())).toBe(true);
      if (i === 1) {
        await connection.page.locator("input").fill("kept");
        expect(await connection.page.locator("input").inputValue()).toBe("kept");
      }
      await connection.browser.close();
      connections.pop();
      if (i === 0) {
        // Test emulation cleanup before typing: input.focus() can itself give
        // the document focus independently of the CDP override.
        expect(await page.evaluate(() => document.hasFocus())).toBe(false);
      }
      expect(await dark()).toEqual([true, true]);
    }
  } finally {
    for (const connection of connections) await connection.browser.close();
    await browser?.close();
    child.kill("SIGTERM");
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
