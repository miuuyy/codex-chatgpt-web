import {test,expect} from "bun:test";
import {chromium,type Browser} from "playwright-core";
import {observeChatGptAttachmentUploads} from "../src/adapters/chatgpt-web/attachment-upload";
import {ChatGptBrowserWorker} from "../src/adapters/chatgpt-web/browser-worker";
import {ChatGptWebAdapterError} from "../src/adapters/chatgpt-web/adapter-error";

const executable=process.env.CHATGPT_DOM_TEST_BROWSER;
const html=`<form><div id="prompt-textarea" contenteditable="true">original message</div><input data-testid="upload-photos-input" type="file" multiple><button data-testid="send-button" type="button" onclick="window.sends++">Send</button></form>
<script>window.sends=0;document.querySelector('input').onchange=()=>{const card=document.createElement('div');card.role='group';card.setAttribute('aria-label','codex-input-image-1.png');card.textContent='photo';document.querySelector('form').append(card);window.job=fetch('/backend-api/files/process_upload_stream',{method:'POST',body:JSON.stringify({file_name:'codex-input-image-1.png',file_id:'owned-file'})}).then(r=>r.text()).catch(()=>{});};</script>`;

async function fixture(run:(browser:Browser,base:string)=>Promise<void>,handler:(request:Request)=>Response|Promise<Response>){
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>new URL(r.url).pathname==='/'?new Response(html,{headers:{'content-type':'text/html'}}):new URL(r.url).pathname==='/favicon.ico'?new Response(''):handler(r)});
 const browser=await chromium.launch({executablePath:executable,headless:true});
 try{await run(browser,`http://127.0.0.1:${server.port}`);}finally{await browser.close();server.stop(true);}
}
const prompt={text:'original message',images:[{ref:'codex-input-image-1',imageUrl:'data:image/png;base64,'+Buffer.from('test').toString('base64')}]};

test.skipIf(!executable)('an enabled send button cannot bypass delayed processing or an HTTP 503',async()=>{
 await fixture(async(browser,base)=>{
  const page=await browser.newPage();await page.goto(base);
  const worker=Object.create(ChatGptBrowserWorker.prototype) as any;
  let error:any;try{await worker.attachFiles(page,prompt,AbortSignal.timeout(5000));}catch(e){error=e;}
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);expect(error.code).toBe('chatgpt_attachment_upload_failed');expect(error.message).toContain('HTTP 503');
  expect(error.retryable).toBe(false);expect(await page.evaluate(()=> (window as any).sends)).toBe(0);
  expect(await page.locator('#prompt-textarea').textContent()).toBe('original message');expect(await page.getByRole('group').count()).toBe(1);
 },async()=>{await Bun.sleep(250);return new Response('unavailable',{status:503});});
},10000);

test.skipIf(!executable)('processing completion is required and accepted before the upload stream closes',async()=>{
 let completed=false;
 await fixture(async(browser,base)=>{
  const page=await browser.newPage();await page.goto(base);const worker=Object.create(ChatGptBrowserWorker.prototype) as any;
  let returned=false;const attachment=worker.attachFiles(page,prompt,AbortSignal.timeout(5000)).then(()=>{returned=true;});
  await Bun.sleep(150);expect(returned).toBe(false);await attachment;expect(completed).toBe(true);
  expect(await page.evaluate(()=> (window as any).sends)).toBe(0);
  await page.getByTestId('send-button').click();expect(await page.evaluate(()=> (window as any).sends)).toBe(1);
 },()=>new Response(new ReadableStream({async start(controller){
  controller.enqueue(new TextEncoder().encode('{"event":"file.processing.file_ready","file_id":"owned-file"}\n'));
  await Bun.sleep(350);completed=true;controller.enqueue(new TextEncoder().encode('{"event":"file.processing.completed","file_id":"owned-file"}\n'));
  // Deliberately keep the response open: success must not wait for loadingfinished.
 }}),{headers:{'content-type':'application/x-ndjson'}}));
},10000);

test.skipIf(!executable)('HTTP 200 processing errors fail and unrelated uploads cannot complete this turn',async()=>{
 await fixture(async(browser,base)=>{
  const page=await browser.newPage();await page.goto(base);const observer=await observeChatGptAttachmentUploads(page,['wanted.png']);
  try{
   await page.evaluate(async()=>{await fetch('/backend-api/files/process_upload_stream',{method:'POST',body:JSON.stringify({file_name:'other.png'})});});
   let returned=false;void observer.wait().then(()=>{returned=true;},()=>{});await Bun.sleep(80);expect(returned).toBe(false);
   await page.evaluate(async()=>{await fetch('/backend-api/files/process_upload_stream',{method:'POST',body:JSON.stringify({file_name:'wanted.png'})});});
   await expect(observer.wait()).rejects.toThrow('file.processing.error');
  }finally{await observer.dispose();}
 },async request=>{const body=await request.json() as any;return new Response(JSON.stringify({event:body.file_name==='wanted.png'?'file.processing.error':'file.processing.completed'})+'\n',{headers:{'content-type':'application/x-ndjson'}});});
},10000);

test.skipIf(!executable)('unfinished processing is cancelled without leaking the browser observation',async()=>{
 await fixture(async(browser,base)=>{
  const page=await browser.newPage();await page.goto(base);const observer=await observeChatGptAttachmentUploads(page,['wanted.png']);
  try{await expect(observer.wait(AbortSignal.timeout(80))).rejects.toThrow();}finally{await observer.dispose();}
  expect(await page.evaluate(()=>document.title)).toBe('');
 },()=>new Response(''));
},10000);


test.skipIf(!executable)('all owned files must complete, including a final event without a newline',async()=>{
 await fixture(async(browser,base)=>{
  const page=await browser.newPage();await page.goto(base);
  const observer=await observeChatGptAttachmentUploads(page,['first.png','second.png']);
  try{
   let returned=false;void observer.wait().then(()=>{returned=true;},()=>{});
   await page.evaluate(async()=>{await fetch('/backend-api/files/process_upload_stream',{method:'POST',body:JSON.stringify({file_name:'first.png'})});});
   await Bun.sleep(80);expect(returned).toBe(false);
   await page.evaluate(async()=>{await fetch('/backend-api/files/process_upload_stream',{method:'POST',body:JSON.stringify({file_name:'second.png'})});});
   await observer.wait(AbortSignal.timeout(3000));expect(returned).toBe(true);
  }finally{await observer.dispose();}
 },()=>new Response(JSON.stringify({event:'file.processing.completed'}),{headers:{'content-type':'application/x-ndjson'}}));
},10000);

test.skipIf(!executable)('file-ready without terminal completion fails when the response ends',async()=>{
 await fixture(async(browser,base)=>{
  const page=await browser.newPage();await page.goto(base);
  const observer=await observeChatGptAttachmentUploads(page,['wanted.png']);
  try{
   await page.evaluate(async()=>{await fetch('/backend-api/files/process_upload_stream',{method:'POST',body:JSON.stringify({file_name:'wanted.png'})});});
   await expect(observer.wait(AbortSignal.timeout(3000))).rejects.toThrow('without a completion event');
  }finally{await observer.dispose();}
 },()=>new Response(JSON.stringify({event:'file.processing.file_ready'})+'\n',{headers:{'content-type':'application/x-ndjson'}}));
},10000);
