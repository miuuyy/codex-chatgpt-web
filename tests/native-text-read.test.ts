import {test,expect} from 'bun:test';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomBytes } from "node:crypto";
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeTextReadCommand} from '../src/adapters/chatgpt-web/native-text-read';
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

const posixTest = process.platform === "win32" ? test.skip : test;

const run=(path:string,offset=0,limit=65536)=>{
 const result=Bun.spawnSync(['/bin/sh','-c',nativeTextReadCommand(path,offset,limit)]);
 return {code:result.exitCode,value:JSON.parse(result.stdout.toString())};
};
posixTest('read-only text program preserves UTF-8 across bounded chunks and changes no files',()=>{
 const root=mkdtempSync(join(tmpdir(),'native-reader-'));
 try{
  const path=join(root,'text.txt');const text='甲乙丙丁\n尾行';writeFileSync(path,text);
  let output='',offset=0;
  do{const r=run(path,offset,4);expect(r.code).toBe(0);output+=r.value.text;
   expect(r.value.next_offset).toBeGreaterThan(offset);offset=r.value.next_offset;
   if(!r.value.truncated)break;
  }while(true);
  expect(output).toBe(text);expect(readFileSync(path,'utf8')).toBe(text);
  expect(readdirSync(root)).toEqual(['text.txt']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
posixTest('path is literal data even with quotes, backticks, substitutions, and newlines',()=>{
 const root=mkdtempSync(join(tmpdir(),'native-reader-'));
 try{
  const path=join(root,"x' `touch PWNED` $(touch PWNED)\n.txt");writeFileSync(path,'literal');
  expect(run(path)).toEqual({code:0,value:{text:'literal',offset:0,bytes_read:7,next_offset:7,file_size:7,truncated:false}});
  expect(readdirSync(root)).toEqual([path.slice(root.length+1)]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
posixTest('rejects nonregular, binary, invalid UTF-8 files, and invalid ranges',()=>{
 const root=mkdtempSync(join(tmpdir(),'native-reader-'));
 try{
  const path=join(root,'binary');writeFileSync(path,Buffer.from([0,1,2]));
  expect(run(path).code).toBe(2);expect(run(root).code).toBe(2);
  writeFileSync(path,Buffer.from([255]));expect(run(path).code).toBe(2);
  expect(run(path,2).code).toBe(2);
  expect(()=>nativeTextReadCommand('x\0y')).toThrow();
  expect(()=>nativeTextReadCommand('x',-1)).toThrow();
  expect(()=>nativeTextReadCommand('x',0,65537)).toThrow();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("Windows fails explicitly rather than invoking a POSIX program with different quoting", () => {
  if (process.platform === "win32") {
    expect(() => nativeTextReadCommand("text.txt")).toThrow("requires a POSIX command shell");
  } else {
    expect(nativeTextReadCommand("text.txt")).toContain("/usr/bin/python3 -I -S -B");
  }
});

posixTest("real MCP text read preserves trusted cwd and a native sandbox refusal", async () => {
  const socketPath = join(tmpdir(), `cgw-reader-${randomBytes(5).toString("hex")}.sock`);
  const broker = TurnBroker.forSocket(socketPath);
  const token = await broker.register({
    cwd: tmpdir(), roots: [tmpdir()], writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    tools: [{ name: "exec_command", description: "Native command tool", parameters: { type: "object" } }],
  }, 60_000);
  const client = new Client({ name: "native-reader-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
    cwd: process.cwd(), stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const reading = client.callTool({ name: "codex_read_text_file", arguments: {
      turn_token: token, path: "text.txt", offset: 0, max_bytes: 16,
    } });
    const [request] = await broker.nextToolBatch(token);
    expect(request).toMatchObject({ wireName: "exec_command", arguments: {
      workdir: tmpdir(), shell: "/bin/sh", login: false, max_output_tokens: 80_000,
    } });
    expect(request!.arguments!.cmd).toBe(nativeTextReadCommand("text.txt", 0, 16));
    broker.completeTool(token, request!.callId, {
      isError: true, content: [{ type: "text", text: "native read denied" }],
    });
    const result = await reading;
    expect(result.isError).toBeTrue();
    expect(result.content).toEqual([{ type: "text", text: "native read denied" }]);
  } finally {
    await client.close().catch(() => {});
    broker.revoke(token);
    await broker.close();
  }
});
