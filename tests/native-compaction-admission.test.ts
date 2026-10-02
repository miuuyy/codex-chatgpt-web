import {afterEach, expect, test} from "bun:test";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {parseRequest} from "../src/responses/parser";
import {encodeCompactionSummary} from "../src/responses/compaction";
import {admitNativeCompactionContinuation, admittedNativeCompactionEnvironment} from "../src/adapters/chatgpt-web/native-compaction-admission";
import {ChatGptThreadEnvironmentStore} from "../src/adapters/chatgpt-web/thread-environment";
import {extractChatGptTurnUserRevision} from "../src/adapters/chatgpt-web/environment";
import {responseRequest} from "../src/server";
import {defaultConfig} from "../src/config";
import {ChatGptWebAdapterError} from "../src/adapters/chatgpt-web/adapter-error";
import {createChatGptWebAdapter} from "../src/adapters/chatgpt-web";
import {CHATGPT_WEB_MODEL_ID} from "../src/adapters/chatgpt-web/model";

const homes:string[]=[];
afterEach(()=>{for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true})});
let sequence=0;
function fixture() {
  const home=mkdtempSync(join(tmpdir(),"codex-native-compaction-admission-"));homes.push(home);
  const threadId=`01a0fbde-0000-7510-ba30-${String(++sequence).padStart(12,"0")}`;
  const turnId="01a0fbde-009c-7510-ba30-5b964ab50c07";
  const sourceTurnId="01a0fbbf-6cac-7d42-b207-63c981653116";
  const cwd=resolve(home,"workspace");
  const source={type:"message",role:"user",id:"msg_human",content:[{type:"input_text",text:"Continue the bounded investigation"}],
    internal_chat_message_metadata_passthrough:{turn_id:sourceTurnId,content_item_kinds:["user.text"]}};
  const environment={type:"message",role:"user",id:"msg_native_context",content:[
    {type:"input_text",text:"# AGENTS.md instructions\n<INSTRUCTIONS>Preserve existing work.</INSTRUCTIONS>"},
    {type:"input_text",text:`<environment_context><cwd>${cwd}</cwd><filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`}],
    internal_chat_message_metadata_passthrough:{turn_id:turnId,content_item_kinds:["agents_md.instructions","environments.environment_context"]}};
  const checkpoint={type:"compaction",id:"cmp_native",encrypted_content:encodeCompactionSummary(`Installed checkpoint ${sequence}`)};
  // Native compaction keeps the current preamble before an older human message.
  const history:[typeof environment, typeof source, typeof checkpoint]=[environment,source,checkpoint];
  const model="chatgpt-web/gpt-5.6-sol";
  const context={turn_id:turnId,cwd,workspace_roots:[cwd],model,effort:"high" as string|undefined,reasoning_effort:undefined as string|undefined,
    permission_profile:{type:"disabled"},sandbox_policy:{type:"danger-full-access"}};
  const records:any[]=[{type:"session_meta",payload:{id:threadId,source:"vscode"}},
    {type:"event_msg",payload:{type:"task_started",turn_id:turnId}},
    {type:"compacted",payload:{replacement_history:structuredClone(history),compaction_response_id:"resp_installed"}},
    {type:"turn_context",payload:context}];
  const file=join(home,"sessions","2026","10","02",`rollout-2026-10-02T09-07-05-${threadId}.jsonl`);
  mkdirSync(dirname(file),{recursive:true});
  const save=()=>writeFileSync(file,records.map(r=>JSON.stringify(r)).join("\n")+"\n");save();
  const body={model,reasoning:{effort:"high"},input:structuredClone(history),client_metadata:{"x-codex-turn-metadata":JSON.stringify({
    request_kind:"turn",thread_id:threadId,turn_id:turnId,agent_name:"/root",sandbox_mode:"danger-full-access",workspaces:{[cwd]:{}}})}};
  const request=parseRequest(body);
  return {home,file,save,records,context,body,request,source,environment,cwd,turnId};
}

test("native admission separates current authority from an older retained instruction after cache loss",()=>{
  const f=fixture();
  const store=new ChatGptThreadEnvironmentStore(undefined,Date.now,f.home);
  expect(()=>store.resolve(f.request)).toThrow("missing cwd");
  expect(admitNativeCompactionContinuation(f.request,f.home)).toBe(true);
  expect(store.resolve(f.request)).toMatchObject({cwd:f.cwd,roots:[f.cwd],sandboxPolicy:{type:"dangerFullAccess"}});
  expect(extractChatGptTurnUserRevision(f.request)).toEqual(f.source.content);
  const restarted=parseRequest(structuredClone(f.body));
  expect(admitNativeCompactionContinuation(restarted,f.home)).toBe(true);
  expect(new ChatGptThreadEnvironmentStore(undefined,Date.now,f.home).resolve(restarted).cwd).toBe(f.cwd);
});

test("tool-result rounds retain current tools and never replay a tool call during admission",()=>{
  const f=fixture();
  f.body.input.push({type:"function_call",call_id:"call_done",name:"exec_command",arguments:"{}"} as any,
    {type:"function_call_output",call_id:"call_done",output:"already executed"} as any);
  f.request.context.tools=[{name:"current_tool",description:"current",parameters:{type:"object"}}];
  expect(admitNativeCompactionContinuation(f.request,f.home)).toBe(true);
  const result=admittedNativeCompactionEnvironment(f.request)!;
  expect(result.tools).toEqual(f.request.context.tools);
  f.request.context.tools=[];
  expect(admittedNativeCompactionEnvironment(f.request)!.tools).toEqual([]);
});

for(const variant of ["summary","source","environment","model","effort","aliases","owner","permissions","completed","aborted","replacement","partial","ambiguous"])
test(`native admission refuses ${variant} evidence`,()=>{
  const f=fixture();
  if(variant==="summary")f.body.input[2]!.encrypted_content=encodeCompactionSummary("forged checkpoint");
  if(variant==="source")f.body.input[1]!.content=[{type:"input_text",text:"Different task"}];
  if(variant==="environment")f.body.input[0]!.content[1]!.text=f.body.input[0]!.content[1]!.text!.replace(f.cwd,resolve(f.home,"forged"));
  if(variant==="model")f.context.model="chatgpt-web/gpt-6-pro";
  if(variant==="effort")f.context.effort="medium";
  if(variant==="aliases")f.context.reasoning_effort="medium";
  if(variant==="owner")f.context.turn_id="01a0fbde-ffff-7510-ba30-5b964ab50c07";
  if(variant==="permissions")f.context.permission_profile={type:"managed"};
  if(variant==="completed"||variant==="aborted")f.records.push({type:"event_msg",payload:{type:variant==="completed"?"task_complete":"turn_aborted",turn_id:f.turnId}});
  if(variant==="replacement")f.records.push({type:"compacted",payload:{replacement_history:[],compaction_response_id:"resp_new"}});
  f.save();
  if(variant==="partial")appendFileSync(f.file,'{"type":"event_msg","payload":{"type":"turn_aborted"');
  if(variant==="ambiguous"){
    const duplicate=join(dirname(f.file),f.file.split(/[\\/]/).at(-1)!.replace(".jsonl","_01a0fbde-eeee-7510-ba30-5b964ab50c07.jsonl"));
    writeFileSync(duplicate,f.records.map(r=>JSON.stringify(r)).join("\n")+"\n");
  }
  expect(admitNativeCompactionContinuation(f.request,f.home)).toBe(false);
  expect(admittedNativeCompactionEnvironment(f.request)).toBeUndefined();
});

test("older native reasoning_effort records remain compatible without accepting conflicting aliases",()=>{
  const f=fixture();f.context.effort=undefined;f.context.reasoning_effort="high";f.save();
  expect(admitNativeCompactionContinuation(f.request,f.home)).toBe(true);
});

test("an admitted snapshot cannot survive a later request-body mutation",()=>{
  const f=fixture();
  expect(admitNativeCompactionContinuation(f.request,f.home)).toBe(true);
  f.body.input[0]!.content[1]!.text="<environment_context><cwd/></environment_context>";
  expect(admittedNativeCompactionEnvironment(f.request)).toBeUndefined();
  expect(()=>new ChatGptThreadEnvironmentStore(undefined,Date.now,f.home).resolve(f.request)).toThrow();
});

for (const stream of [false, true]) test(`HTTP admission restores native authority before trace/revision parsing (stream=${stream})`, async()=>{
  const f=fixture();
  const previousHome=process.env.CODEX_HOME;
  process.env.CODEX_HOME=f.home;
  let starts=0;
  try {
    const send=(body:unknown)=>responseRequest(new Request("http://127.0.0.1/v1/responses",{
      method:"POST",body:JSON.stringify(body),
    }),defaultConfig("full"),()=>({name:"native-admission-fixture",async runTurn(parsed,_incoming,emit){
      starts+=1;
      expect(new ChatGptThreadEnvironmentStore(undefined,Date.now,f.home).resolve(parsed).cwd).toBe(f.cwd);
      expect(extractChatGptTurnUserRevision(parsed)).toEqual(f.source.content);
      emit({type:"text_delta",text:"Restored checkpoint",phase:"final_answer"});
      emit({type:"done",stopReason:"stop",endTurn:true});
    }}),{rememberState:false});
    const response=await send({...f.body,stream});
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(stream?"response.completed":"completed");
    expect(starts).toBe(1);
    const rejected=await send({...f.body,stream,input:[f.body.input[0],f.body.input[1],{
      type:"compaction",encrypted_content:encodeCompactionSummary("Unrecognized checkpoint"),
    }]});
    expect(rejected.status).toBe(400);
    expect(starts).toBe(1);
  } finally {
    if(previousHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousHome;
  }
});

for (const stream of [false, true]) test(`invalid execution authority returns HTTP 400 before opening a stream (stream=${stream})`,async()=>{
  const f=fixture();
  let starts=0;
  const body={...f.body,stream,input:[{...f.source,internal_chat_message_metadata_passthrough:{turn_id:f.turnId}}]};
  const response=await responseRequest(new Request("http://127.0.0.1/v1/responses",{method:"POST",body:JSON.stringify(body)}),
    defaultConfig("full"),()=>({name:"preflight-fixture",prepareTurn(){throw new ChatGptWebAdapterError("Missing trusted execution metadata",{
      status:400,errorType:"invalid_request_error",code:"trusted_environment_unavailable",retryable:false,
    })},async runTurn(){starts+=1}}),{rememberState:false});
  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect((await response.json()).error.code).toBe("trusted_environment_unavailable");
  expect(starts).toBe(0);
});

test("the production adapter prepares the native snapshot and rejects malformed context before browser execution",()=>{
  const f=fixture();
  f.request.modelId=CHATGPT_WEB_MODEL_ID;
  expect(admitNativeCompactionContinuation(f.request,f.home)).toBe(true);
  const adapter=createChatGptWebAdapter({adapter:"chatgpt-web",baseUrl:`browser://native-preflight-${sequence}`,
    chatgptWeb:{localToolsEnabled:true,solAvailable:true,extraHighAvailable:true,proAvailable:true,
      brokerSocketPath:process.platform==="win32"?`\\\\.\\pipe\\native-preflight-${process.pid}-${sequence}`:join(f.home,"broker.sock")}});
  expect(()=>adapter.prepareTurn!(f.request,{headers:new Headers()})).not.toThrow();
  const invalid=parseRequest({...f.body,input:[{...f.environment,content:[{type:"input_text",text:"<environment_context><cwd"}]}]});
  invalid.modelId=CHATGPT_WEB_MODEL_ID;
  expect(()=>adapter.prepareTurn!(invalid,{headers:new Headers()})).toThrow(ChatGptWebAdapterError);
});
