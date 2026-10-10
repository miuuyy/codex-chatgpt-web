import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {withoutRetiredTurnHandles} from '../src/adapters/chatgpt-web/prompt';

test.skipIf(!process.env.LAUNCHER_TEST_ELECTRON)('actual Chromium link regex stalls before encoding and remains responsive after lossless encoding',async()=>{
 const original=JSON.stringify([{type:'input_text',text:'```a``` '.repeat(12)}]);
 const userData=mkdtempSync(join(tmpdir(),'context-regexp-'));
 const env: NodeJS.ProcessEnv={...process.env,CHATGPT_LINK_TEST_INPUT:withoutRetiredTurnHandles(original)};
 delete env.ELECTRON_RUN_AS_NODE;
 const child=Bun.spawn([process.env.LAUNCHER_TEST_ELECTRON!,resolve(import.meta.dir,'../launcher/tests/fixtures/context-markdown-regexp.cjs'),`--user-data-dir=${userData}`],{env,stdout:'pipe',stderr:'pipe'});
 try{
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code).toBe(0);
  const line=stdout.split('\n').find(line=>line.startsWith('CONTEXT_REGEXP_RESULT '));
  if(!line)throw Error(`Missing result: ${stderr.slice(-500)}`);
  const result=JSON.parse(line.slice('CONTEXT_REGEXP_RESULT '.length));
  expect(result.before).toBe('timeout');expect(result.roundTrip).toBe(true);expect(result.afterMs).toBeLessThan(500);
 }finally{
  child.kill();await child.exited;rmSync(userData,{recursive:true,force:true});
 }
},15000);
