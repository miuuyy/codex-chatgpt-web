import {afterEach, expect, test} from "bun:test";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {authenticateNativeFailedTurnRetry} from "../src/adapters/chatgpt-web/native-turn-retry";
import {extractChatGptTurnUserRevision} from "../src/adapters/chatgpt-web/environment";
import {chatGptTurnExecutionKey} from "../src/adapters/chatgpt-web/turn-execution";
import {parseRequest} from "../src/responses/parser";
import {defaultConfig} from "../src/config";
import {responseRequest} from "../src/server";

const roots: string[]=[];
afterEach(()=> { for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
const threadId="11111111-1111-7111-8111-111111111111";
const oldTurn="22222222-2222-7222-8222-222222222222";
const turnId="33333333-3333-7333-8333-333333333333";
function fixture(error: unknown={codex_error_info:"server_overloaded"}) {
  const home=mkdtempSync(join(tmpdir(),"native-retry-")); roots.push(home);
  const directory=join(home,"sessions/2026/10/02"); mkdirSync(directory,{recursive:true});
  const source={type:"message",id:"msg_continue",role:"user",content:[{type:"input_text",text:"continue\n"}],internal_chat_message_metadata_passthrough:{turn_id:oldTurn,content_item_kinds:["user.text"]}};
  const metadata={thread_id:threadId,turn_id:turnId,request_kind:"turn",sandbox:"none",workspaces:{[home]:{}}};
  const context={type:"turn_context",payload:{turn_id:turnId,cwd:home,workspace_roots:[home],permission_profile:{type:"disabled"},sandbox_policy:{type:"danger-full-access"}}};
  const rows: unknown[]=[{type:"session_meta",payload:{id:threadId,source:"cli"}},
    {type:"response_item",payload:source},{type:"event_msg",payload:{type:"task_complete",turn_id:oldTurn,error}},
    {type:"event_msg",payload:{type:"task_started",turn_id:turnId}},context];
  const file=join(directory,`rollout-2026-10-02T06-00-00-${threadId}.jsonl`);
  const save=()=>writeFileSync(file,rows.map(row=>JSON.stringify(row)).join("\n")+"\n"); save();
  const request=()=>parseRequest({model:"chatgpt-web/gpt-5.6-sol",input:[structuredClone(source)],client_metadata:{"x-codex-turn-metadata":JSON.stringify(metadata)}});
  return {home,source,metadata,context,rows,file,save,request};
}

test("a capacity-failed native task resumes under a new turn id without a synthetic abort notice",()=> {
  const f=fixture(), parsed=f.request();
  expect(()=>chatGptTurnExecutionKey(parsed)).toThrow("conflicts with native Codex turn_id");
  expect(authenticateNativeFailedTurnRetry(parsed,f.home)).toBe(true);
  expect(extractChatGptTurnUserRevision(parsed)).toEqual(f.source.content);
  expect(chatGptTurnExecutionKey(parsed)).toBeString();
  const raw=parsed._rawBody as {client_metadata:Record<string,string>};
  raw.client_metadata["x-codex-turn-metadata"]=JSON.stringify({...f.metadata,turn_id:oldTurn.replace(/.$/,"9")});
  expect(()=>chatGptTurnExecutionKey(parsed)).toThrow("conflicts with native Codex turn_id");
});

test("retry evidence is confined to one exact request and native instruction",()=> {
  const f=fixture(), parsed=f.request();
  expect(authenticateNativeFailedTurnRetry(parsed,f.home)).toBe(true);
  expect(()=>chatGptTurnExecutionKey(f.request())).toThrow();
  for(const mutation of [{id:"forged_id"},{content:"another instruction"},{internal_chat_message_metadata_passthrough:{turn_id:turnId.replace(/.$/,"9")}}]) {
    const forged=f.request(); Object.assign((forged._rawBody as {input:object[]}).input[0]!,mutation);
    expect(authenticateNativeFailedTurnRetry(forged,f.home)).toBe(false);
    expect(()=>chatGptTurnExecutionKey(forged)).toThrow();
  }
});

test("successful, cancelled and unrelated failed tasks cannot revive an older instruction",()=> {
  for(const error of [null,{codex_error_info:"turn_aborted"},{codex_error_info:"other",message:"unrelated failure"}]) {
    const f=fixture(error), parsed=f.request();
    expect(authenticateNativeFailedTurnRetry(parsed,f.home)).toBe(false);
    expect(()=>chatGptTurnExecutionKey(parsed)).toThrow();
  }
});

test("newer instructions, cancellation and checkpoint replacement invalidate retry authority",()=> {
  for(const item of [
    {type:"response_item",payload:{type:"message",id:"new_task",role:"user",content:"do something else",internal_chat_message_metadata_passthrough:{turn_id:turnId}}},
    {type:"response_item",payload:{type:"message",id:"abort_notice",role:"user",content:"<turn_aborted>cancelled</turn_aborted>",internal_chat_message_metadata_passthrough:{turn_id:oldTurn}}},
    {type:"event_msg",payload:{type:"task_aborted",turn_id:oldTurn}},
    {type:"response_item",payload:{type:"compaction",encrypted_content:"checkpoint"}},
    {type:"event_msg",payload:{type:"task_complete",turn_id:turnId,error:null}},
  ]) {
    const f=fixture(); f.rows.push(item); f.save();
    expect(authenticateNativeFailedTurnRetry(f.request(),f.home)).toBe(false);
  }
});

test("native session and latest turn ownership must match even when the failure exists",()=> {
  for(const mutation of ["session","currentTurn","malformed"]) {
    const f=fixture();
    if(mutation==="session") (f.rows[0] as {payload:{id:string}}).payload.id=turnId;
    if(mutation==="currentTurn") f.context.payload.turn_id=oldTurn;
    f.save();
    if(mutation==="malformed") writeFileSync(f.file,'{"broken":}\n');
    expect(authenticateNativeFailedTurnRetry(f.request(),f.home)).toBe(false);
  }
});

test("Responses authenticates the native retry before constructing its adapter", async () => {
  const f=fixture();
  const previous=process.env.CODEX_HOME;
  process.env.CODEX_HOME=f.home;
  let constructions=0;
  const send=()=>responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ ...f.request()._rawBody as object, store:false }),
  }),defaultConfig("browser-only"),()=> {
    constructions++;
    return {name:"native-retry-probe", async runTurn(parsed) {
      expect(extractChatGptTurnUserRevision(parsed)).toEqual(f.source.content);
      expect(chatGptTurnExecutionKey(parsed)).toBeString();
    }};
  });
  try {
    const accepted=await send();
    await accepted.text();
    expect(accepted.status).toBe(200);
    expect(constructions).toBe(1);
    f.rows.push({type:"event_msg",payload:{type:"task_aborted",turn_id:turnId}}); f.save();
    const rejected=await send();
    expect(rejected.status).toBe(400);
    expect(constructions).toBe(1);
  } finally {
    if(previous===undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME=previous;
  }
});
