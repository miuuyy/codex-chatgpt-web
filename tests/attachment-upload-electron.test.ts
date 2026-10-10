import { expect, test } from "bun:test";
import { _electron } from "playwright-core";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { observeChatGptAttachmentUploads } from "../src/adapters/chatgpt-web/attachment-upload";

const executable = process.env.LAUNCHER_TEST_ELECTRON;

for (const event of ["file.processing.completed", "file.processing.error", "file.processing.file_ready"]) {
  test.skipIf(!executable)(`Electron handles already-finished upload response: ${event}`, async () => {
    const scratch = mkdtempSync(join(tmpdir(), "upload-electron-"));
    const main = join(scratch, "main.cjs");
    writeFileSync(main, `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const window=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});window.loadURL('about:blank');});`);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request =>
      new URL(request.url).pathname === "/backend-api/files/process_upload_stream"
        ? new Response(JSON.stringify({ event, file_id: "owned" }), { headers: { "content-type": "application/x-ndjson" } })
        : new Response("<main>Upload fixture</main>", { headers: { "content-type": "text/html" } }) });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
    }
    let app;
    try {
      app = await _electron.launch({ executablePath: executable, args: [main, `--user-data-dir=${join(scratch, "profile")}`], env });
      const page = await app.firstWindow();
      await page.goto(`http://127.0.0.1:${server.port}`);
      const context = page.context();
      const createSession = context.newCDPSession.bind(context);
      let activationError = "";
      // Delay only command dispatch until the real response has finished. All protocol
      // events, the CDP error and the response-body read still come from actual Electron.
      context.newCDPSession = async target => {
        const session = await createSession(target);
        const send = session.send.bind(session);
        const finished = new Set<string>();
        const waiting = new Map<string, () => void>();
        session.on("Network.loadingFinished", message => {
          finished.add(message.requestId);
          waiting.get(message.requestId)?.();
        });
        session.send = (async (method: string, params: any) => {
          if (method === "Network.streamResourceContent") {
            if (!finished.has(params.requestId)) await new Promise<void>(resolve => waiting.set(params.requestId, resolve));
            try { return await send(method, params); }
            catch (error) { activationError = String(error); throw error; }
          }
          return send(method as any, params);
        }) as typeof session.send;
        return session;
      };
      const observer = await observeChatGptAttachmentUploads(page, ["wanted.png"]);
      try {
        await page.evaluate(async () => {
          await fetch("/backend-api/files/process_upload_stream", { method: "POST", body: JSON.stringify({ file_name: "wanted.png", file_id: "owned" }) });
        });
        if (event === "file.processing.completed") await observer.wait(AbortSignal.timeout(3000));
        else await expect(observer.wait(AbortSignal.timeout(3000))).rejects.toThrow(
          event === "file.processing.error" ? "file.processing.error" : "without a completion event",
        );
        expect(activationError).toContain("already finished loading");
      } finally { await observer.dispose(); }
    } finally {
      await app?.close();
      server.stop(true);
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 15000);
}
