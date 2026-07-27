import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ultraWorkerCommand } from "../src/adapters/chatgpt-web/mcp-server";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fakeCodex(lines: string[]): Promise<{ root: string; executable: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-ultra-worker-"));
  tempRoots.push(root);
  const executable = join(root, "codex");
  const body = [
    "#!/bin/sh",
    'printf "%s\\n" "$@" > worker-args.txt',
    ...lines.map(line => `printf '%s\\n' ${JSON.stringify(line)}`),
  ].join("\n");
  await writeFile(executable, body, "utf8");
  await chmod(executable, 0o755);
  return { root, executable };
}

async function runWorker(
  executable: string,
  cwd: string,
  task = "Inspect the catalog's state",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["/bin/zsh", "-lc", ultraWorkerCommand("gpt-5.6-sol", task)], {
    cwd,
    env: { ...Bun.env, CODEX_CHATGPT_WEB_CODEX_BIN: executable },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("Ultra native worker wrapper", () => {
  test("returns only the native task id and final report", async () => {
    const fake = await fakeCodex([
      JSON.stringify({ type: "thread.started", thread_id: "worker_task_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", aggregated_output: "NOISY_PRIVATE_TOOL_OUTPUT" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Focused worker report" },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100 } }),
    ]);

    const result = await runWorker(fake.executable, fake.root);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("NOISY_PRIVATE_TOOL_OUTPUT");
    expect(JSON.parse(result.stdout)).toEqual({
      worker_task_id: "worker_task_123",
      exit_code: 0,
      final_report: "Focused worker report",
      final_report_truncated: false,
      errors: [],
    });
    expect(await Bun.file(join(fake.root, "worker-args.txt")).text()).toContain("Inspect the catalog's state");
  });

  test("fails closed when a successful process has no final report", async () => {
    const fake = await fakeCodex([
      JSON.stringify({ type: "thread.started", thread_id: "worker_task_456" }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
    ]);

    const result = await runWorker(fake.executable, fake.root);
    expect(result.exitCode).toBe(91);
    expect(JSON.parse(result.stdout)).toMatchObject({
      worker_task_id: "worker_task_456",
      exit_code: 0,
      final_report: null,
    });
  });
});
