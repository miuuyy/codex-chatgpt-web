const path = require("node:path");
const { Worker } = require("node:worker_threads");

// A fresh full verification for each operation; no size/mtime cache can grant integrity.
function verifyRuntimeInWorker(task, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "runtime-verification-worker.cjs"), { workerData: { task, options } });
    let outcome;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      finish(new Error("Runtime verification worker exceeded its two-minute budget"));
    }, 120_000);
    worker.once("message", message => { outcome = message; });
    worker.once("error", error => finish(error));
    worker.once("exit", code => {
      if (code !== 0 || !outcome) finish(new Error("Runtime verification worker did not complete"));
      else if (!outcome.ok) finish(new Error(outcome.error));
      else finish(null, outcome.value);
    });
  });
}

module.exports = { verifyRuntimeInWorker };
