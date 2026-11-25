import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChatGptBrowserWorker, resolveBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_COMPOSER_SELECTOR } from "../src/chatgpt-ui/composer";
import { assertNewChatPage, chatGptNewChatUrl, CHATGPT_NEW_CHAT_URL } from "../src/chatgpt-session";
import { normalizeChatGptProjectUrl } from "../src/chatgpt-project-url";
import { defaultConfig, getConfigPath, loadConfig } from "../src/config";

const PROJECT = "https://chatgpt.com/g/g-p-69abc123def4567890abcdef12345678-test-project/project";

test("project URL validator accepts only the canonical project page", () => {
  expect(normalizeChatGptProjectUrl(PROJECT)).toBe(PROJECT);
  expect(normalizeChatGptProjectUrl(`${PROJECT}/`)).toBe(PROJECT);
  const invalid: unknown[] = [
    undefined, null, 42, "", " ", ` ${PROJECT}`, `${PROJECT} `, "not a url",
    "http://chatgpt.com/g/g-p-abc/project",
    "https://chatgpt.com.evil.example/g/g-p-abc/project",
    "https://user:pw@chatgpt.com/g/g-p-abc/project",
    "https://chatgpt.com:8443/g/g-p-abc/project",
    `${PROJECT}?temporary-chat=true`,
    `${PROJECT}#x`,
    "https://chatgpt.com/",
    "https://chatgpt.com/c/abc",
    "https://chatgpt.com/g/g-p-abc/c/def",
    "https://chatgpt.com/g/g-abc/project",
    "https://chatgpt.com/g/g-p-/project",
    "https://chatgpt.com/g/g-p-abc/project/extra",
    "https://chatgpt.com/g/g-p-abc%2F..%2Fx/project",
    `https://chatgpt.com/g/g-p-${"a".repeat(400)}/project`,
  ];
  for (const value of invalid) expect(() => normalizeChatGptProjectUrl(value)).toThrow();
});

test("new-chat URL helper keeps defaults and fails closed on project/Temporary Chat conflicts", () => {
  expect(chatGptNewChatUrl()).toBe(CHATGPT_NEW_CHAT_URL);
  expect(chatGptNewChatUrl(true)).toBe("https://chatgpt.com/?temporary-chat=true");
  expect(chatGptNewChatUrl(false, PROJECT)).toBe(PROJECT);
  expect(() => chatGptNewChatUrl(true, PROJECT)).toThrow("Temporary Chat");
  expect(() => chatGptNewChatUrl(false, "https://example.com/g/g-p-a/project")).toThrow();
  expect(() => chatGptNewChatUrl(false, "")).toThrow();
});

test("worker navigates to the project page, accepts it, and rejects other surfaces", async () => {
  const prepare = (ChatGptBrowserWorker.prototype as any).prepareChatSurface;
  for (const initial of ["https://chatgpt.com/c/previous-task", CHATGPT_NEW_CHAT_URL, "about:blank", PROJECT]) {
    let url = initial;
    const navigations: string[] = [];
    const absent: any = { filter: () => absent, last: () => absent, isVisible: async () => false };
    const composer: any = { count: async () => 1, nth: () => composer, isVisible: async () => true };
    const page: any = {
      url: () => url,
      goto: async (next: string) => { url = next; navigations.push(next); },
      locator: (selector: string) => selector === CHATGPT_COMPOSER_SELECTOR ? composer : absent,
    };
    const config = { useTemporaryChats: false, chatgptProjectUrl: PROJECT };
    expect(await prepare.call({ config, activeComposer: async () => composer }, page)).toBe(composer);
    expect(navigations).toEqual(initial === PROJECT ? [] : [PROJECT]);
    await expect(assertNewChatPage(page, false, PROJECT)).resolves.toBeUndefined();
    for (const invalid of [
      "https://chatgpt.com/c/previous-task", CHATGPT_NEW_CHAT_URL, "https://chatgpt.com/g/g-p-other/project",
      "https://example.com/",
    ]) {
      url = invalid;
      await expect(assertNewChatPage(page, false, PROJECT)).rejects.toThrow("requested new chat");
    }
  }
});

test("browser config normalizes the project URL and rejects Temporary Chat conflicts", () => {
  const resolveFor = (chatgptWeb: Record<string, unknown>) => resolveBrowserConfig({ chatgptWeb } as any);
  expect(resolveFor({ useTemporaryChats: false, chatgptProjectUrl: `${PROJECT}/` }).chatgptProjectUrl).toBe(PROJECT);
  expect("chatgptProjectUrl" in resolveFor({ useTemporaryChats: false })).toBeFalse();
  expect(() => resolveFor({ useTemporaryChats: true, chatgptProjectUrl: PROJECT })).toThrow("Temporary Chat");
  expect(() => resolveFor({ chatgptProjectUrl: PROJECT })).toThrow("Temporary Chat");
  expect(() => resolveFor({ useTemporaryChats: false, chatgptProjectUrl: "https://example.com/" })).toThrow();
});

let home = "";
const previous = process.env.CODEX_CHATGPT_WEB_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-project-config-"));
  process.env.CODEX_CHATGPT_WEB_HOME = home;
});
afterEach(() => {
  if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

function writeConfig(extra: Record<string, unknown>) {
  const path = getConfigPath();
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...defaultConfig("browser-only"), ...extra }));
}

test("config loads a valid project URL only with ordinary chats and omits it by default", () => {
  writeConfig({});
  expect(loadConfig().chatgptProjectUrl).toBeUndefined();
  expect(loadConfig().useTemporaryChats).toBe(true);
  writeConfig({ useTemporaryChats: false, chatgptProjectUrl: `${PROJECT}/` });
  expect(loadConfig().chatgptProjectUrl).toBe(PROJECT);
  writeConfig({ useTemporaryChats: false });
  expect("chatgptProjectUrl" in loadConfig()).toBeFalse();
});

test("config rejects invalid project URLs and Temporary Chat conflicts", () => {
  writeConfig({ useTemporaryChats: false, chatgptProjectUrl: "https://example.com/g/g-p-a/project" });
  expect(() => loadConfig()).toThrow("Invalid chatgptProjectUrl");
  writeConfig({ useTemporaryChats: false, chatgptProjectUrl: 7 });
  expect(() => loadConfig()).toThrow("Invalid chatgptProjectUrl");
  writeConfig({ useTemporaryChats: true, chatgptProjectUrl: PROJECT });
  expect(() => loadConfig()).toThrow("requires Temporary Chat to be off");
  const noFlag: Record<string, unknown> = { chatgptProjectUrl: PROJECT };
  writeConfig(noFlag);
  expect(() => loadConfig()).toThrow("requires Temporary Chat to be off");
});

async function runCli(args: string[], extraEnv: Record<string, string>) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { ...process.env, ...extraEnv }, stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("setup CLI documents and validates the project flags before any configuration is written", async () => {
  const env = { CODEX_HOME: join(home, "codex"), CODEX_CHATGPT_WEB_HOME: join(home, "app"), CODEX_WEB_GPT_DEV_HOME: join(home, "dev") };
  const help = await runCli(["--help"], env);
  expect(help.stdout).toContain("--project-url");
  expect(help.stdout).toContain("--clear-project-url");
  for (const command of [["setup"], ["dev", "setup"]]) {
    const bad = await runCli([...command, "--browser-only", "--project-url", "https://example.com/g/g-p-a/project"], env);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("ChatGPT Project URL");
    const both = await runCli([...command, "--browser-only", "--project-url", PROJECT, "--clear-project-url"], env);
    expect(both.exitCode).toBe(1);
    const conflict = await runCli([...command, "--browser-only", "--temporary-chats", "--project-url", PROJECT], env);
    expect(conflict.exitCode).toBe(1);
  }
});
