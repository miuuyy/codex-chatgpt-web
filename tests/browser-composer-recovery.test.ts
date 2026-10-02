import {expect,test} from "bun:test";
import {ChatGptBrowserWorker} from "../src/adapters/chatgpt-web/browser-worker";

const activeComposer=(ChatGptBrowserWorker.prototype as unknown as {activeComposer(page:unknown,timeout:number):Promise<unknown>}).activeComposer;
function surface(onboarding: boolean) {
  let shown=true, clicks=0, probes=0;
  const composer={};
  const button={last:()=>button,isVisible:async()=>shown,click:async()=>{shown=false;clicks++;}};
  const dialog={filter:()=>dialog,last:()=>dialog,isVisible:async()=>onboarding&&shown,getByRole:()=>button,waitFor:async()=>{expect(shown).toBe(false);}};
  const editors={filter:()=>editors,count:async()=>{probes++;return shown?0:1;},first:()=>composer};
  return {page:{locator:(selector:string)=>selector==='[role="dialog"]'?dialog:editors},composer,clicks:()=>clicks,probes:()=>probes};
}
test("Temporary Chat onboarding is dismissed before waiting for a hidden composer",async()=> {
  const f=surface(true);
  expect(await activeComposer.call({},f.page,500)).toBe(f.composer);
  expect(f.clicks()).toBe(1);
  expect(f.probes()).toBe(2);
});
test("an unavailable composer has an explicit UI error and never accepts an unrelated dialog",async()=> {
  const f=surface(false);
  await expect(activeComposer.call({},f.page,20)).rejects.toMatchObject({status:409,code:"browser_composer_unavailable",retryable:false});
  expect(f.clicks()).toBe(0);
});
