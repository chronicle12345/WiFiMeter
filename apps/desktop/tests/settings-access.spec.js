import { test, expect, _electron as electron } from '@playwright/test';
import { createHarness } from './support/backend-harness.mjs';
let app,page,harness;
async function launch(){const env={...process.env,...harness.env};delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({args:['.'],env});page=await app.firstWindow();await expect(page.locator('.nav [data-page="overview"]')).toBeVisible();}
const snapshot=()=>page.evaluate(async()=>{const r=await window.desktop.backend.request('snapshot');if(!r.ok)throw Error(r.error.message);return r.result;});
const preferences=()=>page.evaluate(()=>window.desktop.windowPreferences.read());
const category=id=>page.locator(`[data-category="${id}"]`).click();
test.beforeEach(async()=>{app=null;page=null;harness=await createHarness();await launch();await page.evaluate(()=>window.desktop.backend.request('updateSettings',{settings:{language:'en'}}));await page.reload();await page.locator('.nav [data-page="settings"]').click();});
test.afterEach(async()=>{if(app){await app.evaluate(({dialog})=>{dialog.showMessageBoxSync=()=>1;});await app.close();}harness?.cleanup();});

test('settings save on change, survive categories and have no manual save buttons',async()=>{
 await expect(page.locator('#pageHead')).toHaveCount(0);
 await expect(page.locator('.breadcrumbs')).toHaveCount(0);
 await expect(page.locator('#settingsForm button[type="submit"]')).toHaveCount(0);
 await expect(page.locator('[data-action="discard-settings"]')).toHaveCount(0);
 await page.locator('[name="interval"]').selectOption('10');
 await category('display');await page.locator('[name="unit"]').selectOption('GiB');
 await category('data');await page.locator('[name="retention"]').selectOption('0');
 await expect.poll(async()=>(await snapshot()).settings).toMatchObject({interval:10,unit:'GiB',retention:0});
 await expect(page.locator('#settingsSaveHint')).toHaveAttribute('data-state','saved');
 await page.reload();await category('general');await expect(page.locator('[name="interval"]')).toHaveValue('10');
});

test('language saves without discarding another field edited during its response',async()=>{
 await page.evaluate(()=>{const language=document.querySelector('#quickLanguage');language.value='zh-CN';language.dispatchEvent(new Event('change',{bubbles:true}));const interval=document.querySelector('[name="interval"]');interval.value='10';interval.dispatchEvent(new Event('change',{bubbles:true}));});
 await expect.poll(async()=>(await snapshot()).settings).toMatchObject({language:'zh-CN',interval:10});
 await expect(page.locator('#quickLanguage')).toHaveValue('zh-CN');
 await page.locator('.nav [data-page="overview"]').click();await expect(page.locator('.modal')).toHaveCount(0);
 await page.reload();await page.locator('.nav [data-page="settings"]').click();await expect(page.locator('[name="interval"]')).toHaveValue('10');
});

test('automatic text saving keeps invalid values local and persists a correction',async()=>{
 await category('quota');const before=(await snapshot()).totalQuota.warnPercents;
 await page.locator('#totalWarn').fill('0, 120');await page.locator('#totalWarn').blur();
 await expect(page.locator('#totalQuotaForm [role="alert"]')).not.toHaveText('');
 expect((await snapshot()).totalQuota.warnPercents).toEqual(before);
 await page.locator('#totalWarn').fill('90, 50, 75, 90');await page.locator('#totalWarn').blur();
 await expect.poll(async()=>(await snapshot()).totalQuota.warnPercents).toEqual([50,75,90]);
 await expect(page.locator('#totalQuotaForm button[type="submit"]')).toHaveCount(0);
});

test('theme applies automatically, persists after restart and follows system changes',async()=>{
 await category('display');await page.locator('[name="theme"]').selectOption('dark');
 await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await expect.poll(preferences).toMatchObject({theme:'dark'});
 await app.close();await launch();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await page.locator('.nav [data-page="settings"]').click();await category('display');
 await page.locator('[name="theme"]').selectOption('system');await expect.poll(preferences).toMatchObject({theme:'system'});
 await page.emulateMedia({colorScheme:'dark'});await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await page.emulateMedia({colorScheme:'light'});await expect(page.locator('html')).toHaveAttribute('data-theme','light');
});

test('settings stay in one scrolling panel and category links track the current section',async()=>{
 await page.locator('[data-category="general"]').focus();await page.keyboard.press('ArrowDown');await expect(page.locator('[data-category="display"]')).toBeFocused();
 await expect(page.locator('[data-settings-panel]:visible')).toHaveCount(7);
 await expect(page.locator('.settings-scroll-panel')).toHaveCount(1);
 await expect(page.locator('[data-settings-panel][hidden]')).toHaveCount(0);
 await category('proxy');await expect(page.locator('[data-category="proxy"]')).toHaveAttribute('aria-current','location');
 expect(await page.locator('#settings-proxy').evaluate(el=>Math.abs(el.getBoundingClientRect().top-24))).toBeLessThan(4);
 await page.evaluate(()=>window.scrollTo(0,0));await expect(page.locator('[data-category="general"]')).toHaveAttribute('aria-current','location');
 await page.setViewportSize({width:420,height:740});
 for(const id of ['general','display','quota','proxy','data','about']){await category(id);const overflow=await page.locator('.settings-content').evaluate(root=>[...root.querySelectorAll('button,input,select')].filter(e=>e.getClientRects().length).filter(e=>{const b=e.getBoundingClientRect();return b.left<0||b.right>innerWidth;}).map(e=>e.name||e.id));expect(overflow).toEqual([]);}
});

test('mini appearance saves automatically and is applied to the real window',async()=>{
 await page.locator('[name="miniShape"]').selectOption('circle');await page.locator('[name="miniPalette"]').selectOption('indigo');
 await page.locator('[name="miniSnap"]').check();await page.locator('[name="miniAutoHide"]').check();await page.locator('[name="miniWindow"]').check();
 await expect.poll(preferences).toMatchObject({miniWindow:true,miniShape:'circle',miniPalette:'indigo',miniSnap:true,miniAutoHide:true});
 if(process.platform==='win32'){
  await expect.poll(()=>app.windows().length).toBe(2);const mini=app.windows().find(w=>w!==page);await expect(mini.locator('#download')).toBeVisible();
  const size=await mini.evaluate(()=>({width:innerWidth,height:innerHeight}));expect(size.width).toBe(size.height);
  expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isFocused()&&!w.isFocusable()))).toBe(true);
  await mini.locator('#close').click();await expect.poll(preferences).toMatchObject({miniWindow:false});await expect(page.locator('[name="miniWindow"]')).not.toBeChecked();
 }
 await page.reload();await expect(page.locator('[name="miniShape"]')).toHaveValue('circle');
});

test('remembered close preference updates automatically without reverting saved edits',async()=>{
 await page.locator('[name="closeAction"]').selectOption('ask');await expect.poll(preferences).toMatchObject({closeAction:'ask'});
 await page.locator('[name="interval"]').selectOption('10');await expect.poll(async()=>(await snapshot()).settings.interval).toBe(10);
 await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:true});});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
 await expect.poll(preferences).toMatchObject({closeAction:'tray'});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());
 await expect(page.locator('[name="closeAction"]')).toHaveValue('tray');await expect(page.locator('[name="interval"]')).toHaveValue('10');
});

test('network quota changes save without a button and dangerous enable still confirms',async()=>{
 await page.locator('.nav [data-page="networks"]').click();await page.locator('button.network-name').first().click();await page.getByRole('tab',{name:'Network settings'}).click();
 await page.locator('#warnPercent').fill('95, 50, 80.5');await page.locator('#warnPercent').blur();
 await expect.poll(async()=>(await snapshot()).networks[0].warnPercents).toEqual([50,80.5,95]);
 await expect(page.locator('#networkForm button[type="submit"]')).toHaveCount(0);await expect(page.locator('#networkForm .field-hint')).toHaveCount(0);
 await page.locator('#networkForm [name="autoDisconnect"]').check();await expect(page.locator('.modal')).toBeVisible();await page.locator('[data-action="close-modal"]').last().click();
 await expect(page.locator('[name="autoDisconnect"]')).not.toBeChecked();expect((await snapshot()).networks[0].autoDisconnect).toBe(false);
});

test('auto speed units save and main and mini display the same values',async()=>{
 await category('display');await page.locator('[name="speedUnit"]').selectOption('auto');await expect.poll(async()=>(await snapshot()).settings.speedUnit).toBe('auto');
 await page.evaluate(async()=>{await window.desktop.windowPreferences.update({miniWindow:true});await window.desktop.backend.request('setPaused',{paused:true});});await page.locator('.nav [data-page="overview"]').click();await page.reload();
 await expect(page.locator('.collector-title')).toHaveText('Collection paused');
 await expect(page.locator('[data-live-rx]')).toHaveText('—');
 if(process.platform==='win32'){await expect.poll(()=>app.windows().length).toBe(2);await expect(app.windows().find(w=>w!==page).locator('#download')).toBeVisible();}
 await app.evaluate(({BrowserWindow})=>{const live={event:'live',state:'connected',collector:'running',updatedAt:new Date().toISOString(),speedUnit:'auto',connections:[{networkId:'test',interfaceId:'WLAN',ssid:'Fixture',type:'wifi',band:'5 GHz',signal:80,rxPerSecond:'2500',txPerSecond:'125000'}]};for(const win of BrowserWindow.getAllWindows()){win.webContents.send('mini:live',live);win.webContents.send('backend:event',live);}});
 await expect(page.locator('[data-live-rx]')).toHaveText('2.5');await expect(page.locator('[data-live-rx-unit]')).toHaveText('KB/s');
 if(process.platform==='win32')await expect(app.windows().find(w=>w!==page).locator('#download')).toHaveText('2.5 KB/s');
});

test('failed automatic saves retain the typed value, and retry persists it',async()=>{
 const current=await snapshot();
 await app.evaluate(({ipcMain},snapshot)=>{
  globalThis.autosaveTest={snapshot,fail:true,calls:[]};
  ipcMain.removeHandler('backend:request');ipcMain.handle('backend:request',(_event,{method,params={}})=>{
   const f=globalThis.autosaveTest;
   if(method==='snapshot')return {ok:true,result:f.snapshot};
   if(method==='updateTotalQuota'){
    f.calls.push(params);if(f.fail)return {ok:false,error:{message:'fixture save failed'}};
    Object.assign(f.snapshot.totalQuota,params);return {ok:true,result:{totalQuota:f.snapshot.totalQuota}};
   }
   return {ok:true,result:{}};
  });
 },current);
 await category('quota');await page.locator('#totalCap').fill('42');await page.locator('#totalCap').blur();
 await expect(page.locator('#totalQuotaForm [role="alert"]')).toContainText('fixture save failed');
 await expect(page.locator('#totalCap')).toHaveValue('42');
 expect((await snapshot()).totalQuota.capGb).toBe(current.totalQuota.capGb);
 await app.evaluate(()=>{globalThis.autosaveTest.fail=false;});
 await page.locator('#totalQuotaForm [data-action="retry-autosave"]').click();
 await expect.poll(async()=>(await snapshot()).totalQuota.capGb).toBe(42);
 await expect(page.locator('#totalQuotaForm [role="alert"]')).toBeEmpty();
});

test('typing into a second field during an in-flight save keeps and saves the latest input',async()=>{
 const current=await snapshot();
 await app.evaluate(({ipcMain},snapshot)=>{
  globalThis.autosaveTest={snapshot,delay:true,calls:[]};
  ipcMain.removeHandler('backend:request');ipcMain.handle('backend:request',async(_event,{method,params={}})=>{
   const f=globalThis.autosaveTest;if(method==='snapshot')return {ok:true,result:f.snapshot};
   if(method==='updateTotalQuota'){
    f.calls.push(params);if(f.delay){f.delay=false;await new Promise(resolve=>{f.release=resolve;});}
    Object.assign(f.snapshot.totalQuota,params);return {ok:true,result:{totalQuota:f.snapshot.totalQuota}};
   }return {ok:true,result:{}};
  });
 },current);
 await category('quota');await page.locator('#totalCap').fill('20');await page.locator('#totalCap').blur();
 await expect.poll(()=>app.evaluate(()=>globalThis.autosaveTest.calls.length)).toBe(1);
 await page.locator('#totalCap').fill('30');await page.locator('#totalWarn').fill('50, 90');await page.locator('#totalWarn').blur();
 await app.evaluate(()=>globalThis.autosaveTest.release());
 await expect.poll(async()=>(await snapshot()).totalQuota).toMatchObject({capGb:30,warnPercents:[50,90]});
 await expect(page.locator('#totalCap')).toHaveValue('30');await expect(page.locator('#totalWarn')).toHaveValue('50, 90');
});

test('status section shows live data and preserves expanded diagnostics during updates',async()=>{
 await category('status');
 await expect(page.locator('[data-status="network"] .status-value')).toHaveText('Connected');
 await page.locator('.status-guide summary').click();
 await app.evaluate(({BrowserWindow})=>{for(const win of BrowserWindow.getAllWindows())win.webContents.send('backend:event',{event:'live',state:'unreadable',collector:'running',connections:[],updatedAt:new Date().toISOString(),message:'fixture diagnostic',appCollection:{available:true,enabled:true,state:'permission',detail:'permission fixture'},proxy:{available:true,status:'ready',clients:[],ports:[7897]}});});
 await expect(page.locator('[data-status="network"] .status-value')).toHaveText('Network unreadable');
 await expect(page.locator('[data-status="apps"] .status-value')).toHaveText('Permission required');
 await expect(page.locator('.status-guide')).toHaveAttribute('open','');
 await page.locator('[data-status="apps"] summary').click();await expect(page.locator('[data-status="apps"] pre')).toHaveText('permission fixture');
});
