import { execFile } from "node:child_process";
import { readFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfigDir } from "../config";

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
export function windowCaptureScript(target: string, output: string, width: number, helper: string): string {
  if (!target.trim() || target.length > 512 || target.includes("\0")) throw new Error("Window target is invalid");
  if (!Number.isInteger(width) || width < 320 || width > 2560) throw new Error("Window capture width must be between 320 and 2560");
  return `Add-Type -Path ${quote(helper)} -ReferencedAssemblies System.Drawing\n[CosWindowCapture]::CaptureMatchingWindow(${quote(target)}, ${quote(output)}, ${width})`;
}

export async function captureWindow(target: string, width = 1280, signal?: AbortSignal) {
  if (process.platform !== "win32") throw new Error("Window observation is supported only on Windows");
  if (signal?.aborted) throw signal.reason;
  const directory = join(getConfigDir(), "captures");
  const output = join(directory, `window-${randomUUID()}.png`);
  const script = windowCaptureScript(target, output, width, join(import.meta.dir, "WindowCapture.cs"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const raw = await new Promise<string>((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      encoding: "utf8", timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024, signal,
    }, (error, stdout) => error ? reject(new Error("Window capture helper failed", { cause: error })) : resolve(stdout));
  });
  const result = JSON.parse(raw.trim());
  if (result.ok !== true) throw new Error(typeof result.error === "string" ? result.error : "Window capture failed");
  if (statSync(output).size > 16 * 1024 * 1024) throw new Error("Window capture exceeded its image size limit");
  const bytes = readFileSync(output);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Window capture did not produce a PNG");
  return { path: output, title: String(result.title ?? ""), pid: result.pid, data: bytes.toString("base64") };
}
