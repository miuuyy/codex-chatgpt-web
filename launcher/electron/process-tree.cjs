const path = require("node:path");
const childProcess = require("node:child_process");

const DETACH_OWNED_CHILD = process.platform !== "win32";

function processRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves the process exists even though this user cannot signal it.
    return error?.code === "EPERM";
  }
}

function windowsTreeKillInvocation(pid) {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  return {
    file: path.join(systemRoot, "System32", "taskkill.exe"),
    args: ["/PID", String(pid), "/T", "/F"],
    options: { windowsHide: true, timeout: 10_000 },
  };
}

function terminateOwnedProcessTree(child, signal = "SIGTERM") {
  if (!child) return;
  const pid = child.pid;
  if (!Number.isInteger(pid) || pid < 1) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!child.kill(signal) && child.exitCode === null && child.signalCode === null) {
      throw new Error("Owned child process has no valid pid and refused termination");
    }
    return;
  }

  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const invocation = windowsTreeKillInvocation(pid);
    const result = childProcess.spawnSync(invocation.file, invocation.args, {
      ...invocation.options, stdio: "ignore",
    });
    if ((result.error || result.status !== 0) && processRunning(pid)) {
      const detail = result.error?.message || `taskkill exited with status ${result.status ?? "unknown"}`;
      throw new Error(`Could not terminate owned Windows process tree ${pid}: ${detail}`);
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw new Error(
      `Could not terminate owned process group ${pid}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function terminateOwnedProcessTreeAsync(child, signal = "SIGTERM") {
  if (!child || process.platform !== "win32" || !Number.isInteger(child.pid) || child.pid < 1) {
    terminateOwnedProcessTree(child, signal);
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  const invocation = windowsTreeKillInvocation(pid);
  await new Promise((resolve, reject) => {
    childProcess.execFile(invocation.file, invocation.args, { ...invocation.options, maxBuffer: 64 * 1024 }, error => {
      if (error && processRunning(pid)) reject(new Error(`Could not terminate owned Windows process tree ${pid}: ${error.message}`));
      else resolve();
    });
  });
}

module.exports = {
  DETACH_OWNED_CHILD,
  processRunning,
  terminateOwnedProcessTree,
  terminateOwnedProcessTreeAsync,
};
