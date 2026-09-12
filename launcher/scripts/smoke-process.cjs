const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");

function killWindowsLauncher(executable, env = process.env, run = spawnSync) {
  // Only stop the copy installed by this test, never every app with the same name.
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; "
    + "$expected = $env:CODEX_WEB_GPT_SMOKE_EXECUTABLE; "
    + "Get-CimInstance Win32_Process | Where-Object { "
    + "$_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $expected, [StringComparison]::OrdinalIgnoreCase) "
    + "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ], {
    env: { ...env, CODEX_WEB_GPT_SMOKE_EXECUTABLE: executable },
    encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Unable to stop the installed smoke launcher: ${result.stderr || result.status}`);
}

async function runUntilSmokeMarker(command, args, options) {
  const timeout = options.timeout ?? 90_000;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", chunk => { output = (output + chunk.toString()).slice(-8_192); });
  }
  let closed = false;
  const close = new Promise(resolve => child.once("close", () => { closed = true; resolve(); }));
  try {
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearInterval(poll);
        clearTimeout(deadline);
        if (error) reject(error); else resolve();
      };
      const poll = setInterval(() => {
        if (fs.existsSync(options.markerPath)) finish();
      }, 50);
      const deadline = setTimeout(() => finish(new Error(
        `Packaged launcher did not write its readiness marker within ${timeout}ms\n${output}`,
      )), timeout);
      child.once("error", error => finish(error));
      child.once("close", (code, signal) => {
        if (code === 0 && fs.existsSync(options.markerPath)) finish();
        else finish(new Error(`Packaged launcher exited before readiness (status=${code}, signal=${signal})\n${output}`));
      });
    });
  } finally {
    if (child.pid && !closed) {
      if (process.platform === "win32") {
        const result = spawnSync("taskkill.exe", ["/F", "/T", "/PID", String(child.pid)], {
          encoding: "utf8", windowsHide: true, timeout: 15_000,
        });
        if (result.error || result.status !== 0) child.kill("SIGKILL");
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
      // Reap the owned process before callers remove its runtime directory.
      let timer;
      await Promise.race([close, new Promise(resolve => { timer = setTimeout(resolve, 2_000); })]);
      clearTimeout(timer);
      if (!closed) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        throw new Error(`Unable to stop owned smoke process ${child.pid}`);
      }
    }
  }
}

module.exports = { killWindowsLauncher, runUntilSmokeMarker };
