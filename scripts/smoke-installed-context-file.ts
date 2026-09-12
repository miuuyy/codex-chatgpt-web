import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { allowWebOnlySmokeRequest, WEB_ONLY_SMOKE_MODELS } from "./web-only-request-guard";

// Uses Codex ONLY as a local client/tool executor. The guardian rejects every non-WebGPT model.
const model = process.argv[2] ?? "chatgpt-web/pro";
if (!WEB_ONLY_SMOKE_MODELS.includes(model)) throw new Error("Only explicit ChatGPT Web automatic modes are allowed");
const instant = model === "chatgpt-web/light";
const backend = process.env.CGW_SMOKE_BACKEND ?? "http://127.0.0.1:17841";
const codexExecutable = process.env.CGW_SMOKE_CODEX_EXECUTABLE
  ?? (process.platform === "darwin" ? "/Applications/ChatGPT.app/Contents/Resources/codex" : "codex");
const root = resolve("runtime", `installed-file-smoke-${Date.now()}`);
const catalogRoot = join(root, "catalog");
// Resume authority is verified against the same native rollout home used by the installed server.
// Do not change that authority or copy forged history into it; use the normal client home.
const clientHome = process.env.CODEX_HOME || join(homedir(), ".codex");
mkdirSync(catalogRoot, { recursive: true, mode: 0o700 });
const catalogResponse = await fetch(`${backend}/v1/models`, { headers: { authorization: "Bearer web-only-test" } });
if (!catalogResponse.ok) throw new Error("Installed WebGPT model catalog unavailable");
const catalog = await catalogResponse.json() as any;
const selectedModel = catalog.models?.find((row: any) => row.slug === model);
if (!selectedModel) throw new Error(`Installed WebGPT has no ${model} row`);
writeFileSync(join(catalogRoot, "models.json"), JSON.stringify({ models: [selectedModel] }), { mode: 0o600 });
const requests: Array<{ path: string; model?: string; accepted: boolean; bytes: number }> = [];
const guardian = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/v1/models") return Response.json({ models: [selectedModel] });
  if (request.method !== "POST" || !["/v1/responses", "/v1/responses/compact"].includes(path)) return new Response("Not allowed", { status: 403 });
  const raw = await request.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const accepted = allowWebOnlySmokeRequest(request.method, path, body.model, model);
  requests.push({ path, model: body.model, accepted, bytes: Buffer.byteLength(raw) });
  writeFileSync(join(root, "requests.json"), JSON.stringify(requests, null, 2), { mode: 0o600 });
  if (!accepted) return Response.json({ error: { message: `Only ${model} is permitted by this test`, type: "invalid_request_error" } }, { status: 403 });
  const headers = new Headers(request.headers);
  headers.delete("host"); headers.delete("content-length");
  return fetch(`${backend}${path}`, { method: "POST", headers, body: raw, signal: request.signal, redirect: "manual" });
} });
const clientConfig = [
  "--ignore-user-config",
  "-c", 'model_provider="web_only"', "-c", 'approval_policy="never"',
  "-c", "features.memories=false",
  "-c", `model_catalog_json=${JSON.stringify(join(catalogRoot, "models.json"))}`,
  "-c", `model_providers.web_only={name="WebGPT-only test guardian",base_url="http://127.0.0.1:${guardian.port}/v1",env_key="CGW_LOCAL_TEST_KEY",wire_api="responses",supports_websockets=false}`,
];
const head = "HEAD" + randomBytes(6).toString("hex").toUpperCase();
const tail = "TAIL" + randomBytes(6).toString("hex").toUpperCase();
const toolOne = "TOOLONE" + randomBytes(6).toString("hex").toUpperCase();
const toolTwo = "TOOLTWO" + randomBytes(6).toString("hex").toUpperCase();
writeFileSync(join(root, "expected.json"), JSON.stringify({ head, tail, toolOne, toolTwo }), { mode: 0o600 });
async function run(label: string, prompt: string, thread?: string) {
  const args = ["exec", ...clientConfig, ...(thread ? ["resume", thread] : ["--sandbox", "read-only", "--skip-git-repo-check"]),
    "--json", "--model", model, "--output-last-message", join(root, `${label}-answer.txt`), "-"];
  const child = Bun.spawn([codexExecutable, ...args], {
    cwd: process.cwd(), env: { ...process.env, CODEX_HOME: clientHome, CGW_LOCAL_TEST_KEY: "web-only-test" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write(prompt); child.stdin.end();
  const timeout = setTimeout(() => child.kill(), 10 * 60_000);
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timeout);
  writeFileSync(join(root, `${label}.jsonl`), stdout, { mode: 0o600 });
  writeFileSync(join(root, `${label}.stderr.log`), stderr, { mode: 0o600 });
  const events = stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const id = events.find(event => event.type === "thread.started")?.thread_id ?? thread;
  let answer = "";
  try { answer = readFileSync(join(root, `${label}-answer.txt`), "utf8"); } catch { /* failed turn */ }
  const commands = events.filter(event => event.type === "item.completed" && event.item?.type === "command_execution").map(event => event.item);
  const tool = label === "first" ? toolOne : toolTwo;
  const passed = exitCode === 0 && !!id && answer.includes(head) && answer.includes(tail)
    && commands.some(command => command.exit_code === 0 && command.aggregated_output?.includes(tool));
  console.log(JSON.stringify({ event: "INSTALLED_FILE_TURN", label, passed, exitCode, thread: id, commands: commands.length, answer: answer.slice(-2_000), root }));
  if (!passed) throw new Error(`Installed file-context ${label} turn failed; inspect ${root}`);
  return id as string;
}
console.log(JSON.stringify({ event: "INSTALLED_FILE_SMOKE_START", model, root, port: guardian.port }));
try {
  // Dense text exercises ~300k total tokens without exceeding Codex's single-input character cap.
  // Instant exercises its composer character bound while remaining below its own token ceiling.
  const filler = instant ? " information".repeat(60_000) : "x;".repeat(290_000);
  const thread = await run("first", `這是僅限 ${model} 的驗證。禁止切換模型、建立子代理、改檔、提交或重啟服務。保留最早與最後的兩個識別值。\n${head}\n`
    + filler + `\n${tail}\n現在實際使用 exec_command 執行 rtk proxy printf ${toolOne}，不能只口頭聲稱。完成後回覆最早與最後的識別值，以及工具真實輸出。`);
  await new Promise(resolve => setTimeout(resolve, 60_000));
  await run("second", `延續上一輪，不修改任何檔案、不建立子代理。實際使用 exec_command 執行 rtk proxy printf ${toolTwo}。然後從上一輪內容取回最早與最後的識別值，連同工具輸出一起回答。`, thread);
  if (requests.some(request => !request.accepted)) throw new Error("A non-WebGPT request was attempted and blocked");
  writeFileSync(join(root, "success.json"), JSON.stringify({ passed: true, model, thread, requests: requests.length }), { mode: 0o600 });
  console.log(JSON.stringify({ event: "INSTALLED_FILE_SMOKE_OK", root, thread, requests: requests.length }));
} finally {
  await guardian.stop(true);
}
