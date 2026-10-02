import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutosave } from '../renderer/ui/autosave.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
test('autosave serializes requests and merges queued fields without replacing newer edits', async () => {
 const writes=[]; let release;
 const save=createAutosave({delay:5,write:patch=>{writes.push(patch);return writes.length===1?new Promise(resolve=>release=resolve):Promise.resolve();}});
 save.set('alias','first',true); await tick();
 save.set('alias','new'); save.set('notify',true,true); await tick();
 assert.deepEqual(writes,[{alias:'first'}]); release(); await tick();
 assert.deepEqual(writes,[{alias:'first'},{alias:'new',notify:true}]); assert.equal(save.dirty,false);
});
test('failed writes retain edits for explicit retry and newer values win',async()=>{
 let fail=true; const writes=[];
 const save=createAutosave({write:async patch=>{writes.push(patch);if(fail)throw Error('offline');}});
 save.set('capGb',10,true); await tick(); assert.equal(save.dirty,true); assert.equal(save.state,'error');
 save.set('capGb',20); fail=false; await save.flush();
 assert.deepEqual(writes,[{capGb:10},{capGb:20}]); assert.equal(save.dirty,false);
});
test('invalid unfinished field does not prevent another field from saving',async()=>{
 const writes=[];const save=createAutosave({write:async patch=>writes.push(patch)});
 save.invalid('capGb','Invalid quota');save.set('notify',false,true);await tick();
 assert.deepEqual(writes,[{notify:false}]);assert.equal(save.dirty,true);
 save.set('capGb',3,true);await tick();assert.equal(save.dirty,false);
});
test('blur expedites only an edited field and does not duplicate an in-flight write',async()=>{
 const writes=[];let release;const save=createAutosave({write:patch=>{writes.push(patch);return new Promise(resolve=>release=resolve);}});
 save.expedite('alias');assert.equal(writes.length,0);
 save.set('alias','edited');save.expedite('alias');await tick();save.expedite('alias');
 assert.equal(writes.length,1);assert.equal(save.has('alias'),true);release();await tick();assert.equal(save.has('alias'),false);
});
test('a field debounce does not submit another unfinished field',async()=>{
 const writes=[];const save=createAutosave({delay:100,write:async patch=>writes.push(patch)});
 save.set('alias','still typing');save.set('notify',true,true);await tick();
 assert.deepEqual(writes,[{notify:true}]);assert.equal(save.dirty,true);
 save.expedite('alias');await tick();assert.deepEqual(writes,[{notify:true},{alias:'still typing'}]);
});
test('failure does not resurrect an older value after the same field becomes invalid',async()=>{
 let reject,writes=0;const save=createAutosave({write:()=>{writes++;return new Promise((resolve,fail)=>reject=fail);}});
 save.set('capGb',10,true);await tick();save.invalid('capGb','unfinished');reject(Error('offline'));await tick();
 await save.flush();assert.equal(writes,1);
 assert.equal(save.has('capGb'),true);assert.equal(save.state,'error');
});
