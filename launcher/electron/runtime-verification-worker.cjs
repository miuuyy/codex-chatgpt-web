const { parentPort, workerData } = require("node:worker_threads");
const { validateRuntimeBundle, ensurePackagedRuntime, waitForPackagedRuntimeSource } = require("./runtime-install.cjs");

(async () => {
  const { task, options } = workerData;
  let value;
  if (task === "validate") value = validateRuntimeBundle(options.root, options.identity);
  else {
    const app = { isPackaged: true, getVersion: () => options.version };
    if (task === "install") value = ensurePackagedRuntime({ app, coreHome: options.coreHome, resourcesPath: options.resourcesPath });
    else if (task === "wait") value = await waitForPackagedRuntimeSource({ app, resourcesPath: options.resourcesPath });
    else throw new Error("Unknown runtime verification operation");
  }
  parentPort.postMessage({ ok: true, value });
})().catch(error => parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }));
