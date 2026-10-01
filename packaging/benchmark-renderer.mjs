// Synthetic benchmark of the same renderer against identical large history.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const file='apps/desktop/renderer/data/backend-client.js';
const revision=process.argv[2]||'926cefc';
let old=execFileSync('git',['show',`${revision}:${file}`],{cwd:root,encoding:'utf8'});
old=old.replace("'./coverage.js'",JSON.stringify(pathToFileURL(path.join(root,'apps/desktop/renderer/data/coverage.js')).href)).replace("'../i18n.js'",JSON.stringify(pathToFileURL(path.join(root,'apps/desktop/renderer/i18n.js')).href));
const before=await import('data:text/javascript;base64,'+Buffer.from(old).toString('base64'));
const after=await import(pathToFileURL(path.join(root,file)));
function history(){return Array.from({length:50000},(_,i)=>({date:'2026-10-01',networkId:'fixture',appId:`app-${i}`,name:`Fixture ${i}`,rxBytes:'100',txBytes:'0'}));}
async function measure(create){
 let receive;globalThis.window={desktop:{backend:{request:async method=>({ok:true,result:method==='snapshot'?{appRecords:history()}: {}}),onEvent:fn=>{receive=fn;return()=>{};}}}};
 const client=create();await client.start();
 const records=Array.from({length:100},(_,i)=>({date:'2026-10-01',networkId:'fixture',appId:`app-${49900+i}`,name:`Fixture ${i}`,rxBytes:'1',txBytes:'1'}));
 receive({event:'appUsage',records}); // One warmup builds only the active-row lookup.
 globalThis.gc?.();const heap=process.memoryUsage().heapUsed,start=performance.now();
 for(let i=0;i<100;i++)receive({event:'appUsage',records});
 const milliseconds=performance.now()-start,heapDeltaBytes=process.memoryUsage().heapUsed-heap;
 assert.equal(client.snapshot.appRecords[49999].rxBytes,'201');
 client.stop();return{milliseconds,heapDeltaBytes};
}
console.log(JSON.stringify({fixture:{historyRows:50000,activeApps:100,eventBatches:100},before:await measure(before.createDataClient),after:await measure(after.createDataClient)},null,2));
