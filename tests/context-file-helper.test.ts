import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { createChatGptContextFile } from "../src/adapters/chatgpt-web/context-file";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

test.each([false, true])("context files cross the helper protocol only with negotiated support (legacy=%s)", async legacy => {
  const root = mkdtempSync(join(tmpdir(), "context-file-helper-"));
  const helper = join(root, "helper.ts"), descriptorPath = join(root, "launcher.json");
  const content = JSON.stringify({ version: 3, system: ["system"], messages: [{ role: "user", content: "kept exactly" }] });
  writeFileSync(helper, legacy ? `
    import { createInterface } from "node:readline";
    const send = value => process.stdout.write(JSON.stringify(value)+"\\n");
    send({type:"ready",features:[]});
    createInterface({input:process.stdin}).on("line",line=>{
      const message=JSON.parse(line);
      if(message.type==="run")send({type:"event",id:message.id,event:"prepared_selected",reused:false});
      if(message.type==="abort")send({type:"error",id:message.id,message:"aborted"});
      if(message.type==="shutdown")process.exit(0);
    });
  ` : `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    ChatGptBrowserWorker.prototype.run = async turn => {
      await turn.onPreparedSelected(false);
      const prepared = await turn.prepare();
      if(prepared.contextFile?.content !== ${JSON.stringify(content)})throw new Error("Context file was lost in IPC");
      turn.onTextDelta("FILE_IPC_OK");
      return "FILE_IPC_OK";
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `);
  writeFileSync(descriptorPath, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
    endpoint: "http://127.0.0.1:39001", control: { endpoint: "http://127.0.0.1:39002", token: "a".repeat(48) },
    helper: { executable: process.execPath, script: helper }, partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "a".repeat(32), surfaceTargets: { ["a".repeat(32)]: "owned-test-target" }, createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({ appName: "Codex Native2", browserHost: "launcher", browserHostDescriptorPath: descriptorPath,
    browserHelperScriptPath: helper, storageStatePath: join(root, "state.json"), chromeExecutablePath: "unused", turnTimeoutMs: 10_000,
    headed: true, autoApproveToolCalls: false,
  });
  let releases = 0;
  try {
    const result = client.run({ traceId: "context-file-test", modelId: "gpt-5.6-sol", reasoning: "max",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
      prepare: async () => ({ text: "Read exact file", images: [], contextFile: createChatGptContextFile(content, 400_000), release: () => { releases++; } }),
      onTextDelta: () => {},
    });
    if (legacy) await expect(result).rejects.toThrow("does not support context-file transport");
    else expect(await result).toBe("FILE_IPC_OK");
    expect(releases).toBe(1);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
