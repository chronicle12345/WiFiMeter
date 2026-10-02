import { t } from '../i18n.js';
// Each field has its own debounce; only ready patches enter the serialized writer.
export function createAutosave({ write, delay = 400, onState = () => {} }) {
 const pending=new Map(), errors=new Map(); let running=null, failure=null, writing=new Set();
 const api={
  has(key){return pending.has(key)||errors.has(key)||writing.has(key);},
  get dirty(){return !!(running||pending.size||errors.size);},
  get state(){return failure||errors.size?'error':running?'saving':pending.size?'pending':'saved';},
  set(key,value,immediate=false){errors.delete(key);const old=pending.get(key);clearTimeout(old?.timer);const entry={value,ready:immediate};pending.set(key,entry);if(!immediate)entry.timer=setTimeout(()=>{entry.ready=true;drain();},delay);notify();if(immediate)drain();},
  expedite(key){const entry=pending.get(key);if(entry){clearTimeout(entry.timer);entry.ready=true;drain();}},
  invalid(key,message){clearTimeout(pending.get(key)?.timer);pending.delete(key);errors.set(key,message);notify();},
  async flush(){failure=null;for(const entry of pending.values()){clearTimeout(entry.timer);entry.ready=true;}await drain();if(running)await running;if(pending.size&&!failure)await drain();},
  discard(){for(const entry of pending.values())clearTimeout(entry.timer);pending.clear();errors.clear();failure=null;notify();}
 };
 function notify(){onState({state:api.state,dirty:api.dirty,error:failure?.message||errors.values().next().value||''});}
 function drain(){
  if(running||failure)return running;
  const batch=[...pending].filter(([,entry])=>entry.ready);if(!batch.length){notify();return Promise.resolve();}
  for(const [key] of batch)pending.delete(key);
  writing=new Set(batch.map(([key])=>key));
  running=Promise.resolve().then(()=>write(Object.fromEntries(batch.map(([key,entry])=>[key,entry.value])))).catch(error=>{
   failure=error;for(const [key,entry] of batch)if(!pending.has(key)&&!errors.has(key))pending.set(key,entry);
  }).finally(()=>{running=null;writing.clear();notify();if(!failure)drain();});notify();return running;
 }
 return api;
}
export function autosaveStatus(id){return `<div class="autosave-feedback"><span id="${id}" role="status" aria-live="polite"></span><button type="button" class="btn small-btn" data-action="retry-autosave" hidden>${t('重试')}</button></div>`;}
