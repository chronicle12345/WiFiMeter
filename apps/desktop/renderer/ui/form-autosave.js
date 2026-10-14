import { createAutosave } from './autosave.js';
import { t, tr } from '../i18n.js';
import { parseWarnPercents } from '../data/quota-thresholds.js';
import { validQuotaGb } from '../data/model.js';
import { proxyConfigPatch } from '../data/proxy.js';

export const autosaveFormIds = new Set(['settingsForm','networkForm','totalQuotaForm','proxyConfigForm']);
const windowFields = new Set(['miniWindow','closeAction','theme','miniShape','miniPalette','miniSnap','miniAutoHide','miniPinned','miniExcludeProxy']);

// 表单保存负责校验与写入；页面负责导航、确认弹窗和重新渲染。
export function createFormAutosave({ store, desktop, getData, getWindowPreferences, receiveWindowPreferences,
 confirm, networkName, onState = () => {}, onLanguage = () => {}, onSettingsSaved = () => {} }) {
 const formSaves=new WeakMap(), activeSaves=new Set(), fieldEdits=new WeakMap(), statusTimers=new WeakMap();
 let retentionFollowups=new WeakMap(), pendingRetentionFollowup=null;
 const getNetwork=id=>getData().networks.find(network=>network.id===id);
 const api={
  saveFor,
  has(form,key){return formSaves.get(form)?.has(key)||false;},
  dirty(id){cleanFinishedForms();return [...activeSaves].some(entry=>entry.form.id===id&&entry.save.dirty);},
  drafts(ids){return [...activeSaves].filter(({form,save})=>form.isConnected&&save.dirty&&ids.includes(form.id)).map(({form})=>form);},
  async flush(ids){await Promise.all([...activeSaves].filter(entry=>ids.includes(entry.form.id)).map(entry=>entry.save.flush()));},
  discard(ids){
   for(const entry of activeSaves)if(ids.includes(entry.form.id)){entry.save.discard();activeSaves.delete(entry);}
   if(ids.includes('settingsForm')){retentionFollowups=new WeakMap();pendingRetentionFollowup=null;}
   onState();
  },
  expedite(input){if(input.name)formSaves.get(input.form)?.expedite(input.name);},
  edit
 };

 function cleanFinishedForms(){
  for(const entry of activeSaves)if(!entry.form.isConnected&&!entry.save.dirty)activeSaves.delete(entry);
 }

 function saveFor(form){
  if(formSaves.has(form))return formSaves.get(form);
  const save=createAutosave({write:fields=>write(form,fields),onState:status=>{
   cleanFinishedForms();
   const feedback=form.querySelector('.autosave-feedback'),label=feedback?.querySelector('[role="status"]'),retry=feedback?.querySelector('button');
   clearTimeout(statusTimers.get(form));
   if(status.state==='saved'&&label)statusTimers.set(form,setTimeout(()=>{label.textContent='';},1800));
   if(label){label.dataset.state=status.state;label.textContent=status.state==='error'?t('保存失败，请重试。')+' '+status.error:status.state==='saving'?t('正在保存…'):status.state==='pending'?t('等待保存…'):t('已自动保存');}
   if(retry){retry.hidden=status.state!=='error';retry.textContent=t('重试');}
   const error=form.querySelector('.form-error');if(error)error.textContent=status.error;
   onState();
  }});
  formSaves.set(form,save);activeSaves.add({form,save});return save;
 }

 function fieldPatch(input){
  const key=input.name,value=input.type==='checkbox'?input.checked:input.value;
  if(key==='warnPercents'){const values=parseWarnPercents(value);return {warnPercents:values,warnPercent:values[0]};}
  if(key==='capGb'){if(value===''&&input.form.id==='totalQuotaForm'||input.validity.badInput||!validQuotaGb(Number(value)))throw Error(t('额度须为 0 或 0.000000001 到 9000000000 GB。'));return {capGb:Number(value)};}
  if(key==='ports'||key==='processNames')return {[key]:proxyConfigPatch(new Map([[key,value]]))[key]};
  if(key==='alias')return {alias:String(value).trim()};
  return {[key]:['interval','retention'].includes(key)?Number(value):value};
 }

 function edit(input,immediate){
  if(!input.name)return;
  const save=saveFor(input.form),raw=input.type==='checkbox'?input.checked:input.value;
  const previous=fieldEdits.get(input);
  if(previous?.raw===raw){if(immediate)save.expedite(input.name);return;}
  try{
   const patch=fieldPatch(input),data=getData();fieldEdits.set(input,{raw,patch});
   const current=input.form.id==='settingsForm'?(windowFields.has(input.name)?getWindowPreferences():data.settings):input.form.id==='networkForm'?getNetwork(input.form.dataset.id):input.form.id==='totalQuotaForm'?data.totalQuota:data.proxy;
   if(!save.has(input.name)&&Object.entries(patch).every(([key,value])=>JSON.stringify(current?.[key])===JSON.stringify(value)))return;
   save.set(input.name,patch,immediate);
  }catch(error){fieldEdits.set(input,{raw});save.invalid(input.name,error.message);}
 }

 function restoreField(form,key,value,expected){
  const input=form.elements.namedItem(key);if(!input||fieldEdits.get(input)?.patch!==expected)return;
  fieldEdits.delete(input);if(input.type==='checkbox')input.checked=!!value;else input.value=value;
 }

 async function writeSettings(form,fields,patch){
  const data=getData(),retentionField=fields.retention;
  if(pendingRetentionFollowup&&data.settings.retention!==pendingRetentionFollowup.value)pendingRetentionFollowup=null;
  let retentionTask=retentionField&&(retentionFollowups.get(retentionField)||(retentionField.retention===pendingRetentionFollowup?.value?pendingRetentionFollowup:null));
  // 已提交的保留期只补齐清理与刷新，避免失败重试漏掉后续步骤。
  if(retentionTask&&retentionTask.stage!=='settings'){
   delete patch.retention;
   if(data.settings.retention!==retentionTask.value){retentionFollowups.delete(retentionField);retentionTask=null;}
  }
  if(Object.hasOwn(patch,'retention')){
   const previous=data.settings.retention,shortening=patch.retention>0&&(previous===0||patch.retention<previous);
   if(shortening&&!retentionTask){
    if(!await confirm(t('应用新的保留时长？'),t('缩短保留期将删除范围外的历史记录，建议先备份。'))){restoreField(form,'retention',previous,fields.retention);delete patch.retention;}
    else {retentionTask={value:patch.retention,stage:'settings'};retentionFollowups.set(retentionField,retentionTask);}
   }
  }
  const prefs=Object.fromEntries(Object.entries(patch).filter(([key])=>windowFields.has(key)));
  const settings=Object.fromEntries(Object.entries(patch).filter(([key])=>!windowFields.has(key)));
  if(Object.keys(prefs).length){receiveWindowPreferences(await desktop.windowPreferences.update(prefs));if(Object.hasOwn(prefs,'closeAction'))settings.minimizeToTray=prefs.closeAction==='tray';}
  if(Object.keys(settings).length){
   const result=await store.updateSettings(settings);
   if(Object.hasOwn(settings,'retention')){
    if(retentionTask?.stage==='settings'&&data.settings.retention===retentionTask.value){retentionTask.stage='prune';pendingRetentionFollowup=retentionTask;}
    else if(pendingRetentionFollowup&&data.settings.retention!==pendingRetentionFollowup.value)pendingRetentionFollowup=null;
   }
   if(Object.hasOwn(settings,'autoStart')&&result.system){
    const error=result.system.autoStartError;
    if(error||result.system.autoStart!==Boolean(settings.autoStart)){
     const message=t(settings.autoStart?'偏好已保存，但开启开机启动失败。':'偏好已保存，但关闭开机启动失败。');
     throw Error(error?`${message} ${error}`:message);
    }
   }
  }
  if(retentionTask&&data.settings.retention===retentionTask.value){
   if(retentionTask.stage==='prune'){await store.pruneUsage();retentionTask.stage='reload';}
   if(retentionTask.stage==='reload'){await store.reload();retentionFollowups.delete(retentionField);if(pendingRetentionFollowup===retentionTask)pendingRetentionFollowup=null;}
  }
  if(Object.hasOwn(settings,'language'))onLanguage(settings.language);
  onSettingsSaved();
 }

 async function write(form,fields){
  const patch=Object.assign({},...Object.values(fields)),data=getData();
  if(form.id==='settingsForm')return writeSettings(form,fields,patch);
  if(form.id==='proxyConfigForm'){
   // 代理端点替换整份配置，未编辑的字段须取已经提交的值。
   await store.updateProxyConfig({ports:data.proxy?.ports||[],processNames:data.proxy?.processNames||[],...patch});return;
  }
  const current=form.id==='networkForm'?getNetwork(form.dataset.id):data.totalQuota;
  if(patch.autoDisconnect&&!current.autoDisconnect){
   const accepted=await confirm(t('启用自动断开规则？'),form.id==='networkForm'?tr`达到所设额度后，应用会断开当前连接的网络：${networkName(current)}。断开只在确认连的正是这个网络时执行。`:t('总额度达到上限时将断开全部 Wi-Fi。'));
   if(!accepted){restoreField(form,'autoDisconnect',current.autoDisconnect,fields.autoDisconnect);delete patch.autoDisconnect;}
  }
  if(!Object.keys(patch).length)return;
  if(form.id==='networkForm'){
   if((patch.autoDisconnect||patch.notify)&&!(patch.capGb??current.capGb))throw Error(t('请先设置大于 0 的额度，或关闭该网络的提醒与自动断网。'));
   await store.updateNetwork(form.dataset.id,patch);
  }else await store.updateTotalQuota(patch);
 }
 return api;
}
