const {app,BrowserWindow}=require('electron');
const {source,flags}=require('./chatgpt-link-regexp.json');
const original=JSON.stringify([{type:'input_text',text:'```a``` '.repeat(12)}]);
const fixed=process.env.CHATGPT_LINK_TEST_INPUT;
(async()=>{
 await app.whenReady();
 const window=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
 const run=input=>window.webContents.executeJavaScript(`(()=>{const t=performance.now();new RegExp(${JSON.stringify(source)},${JSON.stringify(flags)}).exec(${JSON.stringify(input)});return {elapsed:performance.now()-t,decoded:JSON.parse(${JSON.stringify(input)})};})()`);
 await window.loadURL('data:text/html,<title>isolated-regexp-regression</title>');
 const before=await Promise.race([run(original).then(()=> 'returned',()=> 'rejected'),new Promise(r=>setTimeout(()=>r('timeout'),500))]);
 if(before!=='timeout')throw Error('Original regex did not reproduce the renderer stall');
 window.webContents.forcefullyCrashRenderer();
 await window.loadURL('data:text/html,<title>isolated-regexp-regression-fixed</title>');
 const after=await Promise.race([run(fixed),new Promise((_,j)=>setTimeout(()=>j(Error('fixed regex stalled')),2000))]);
 if(JSON.stringify(after.decoded)!==original)throw Error('Context changed after Unicode decoding');
 console.log('CONTEXT_REGEXP_RESULT '+JSON.stringify({before,afterMs:after.elapsed,roundTrip:true}));
 window.destroy();app.quit();
})().catch(error=>{console.error(error.message);app.exit(1);});
