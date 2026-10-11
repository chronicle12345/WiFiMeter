import { test, expect, _electron as electron } from '@playwright/test';
import { createHarness } from './support/backend-harness.mjs';
let app, page, harness;
test.beforeEach(async () => {
    app = null; page = null;
    harness = await createHarness();
    const env = { ...process.env, ...harness.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: ['.'], env });
    page = await app.firstWindow();
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
});
test.afterEach(async () => {
    try {
        if (app) {
            // Destroy only this test's isolated windows after all draft assertions.
            // Suppress their quit event so app.close() alone starts backend shutdown.
            await app.evaluate(({ app: fixtureApp, BrowserWindow }) => {
                fixtureApp.removeAllListeners('window-all-closed');
                for (const window of BrowserWindow.getAllWindows()) window.destroy();
            });
            await app.close();
        }
    } finally { harness?.cleanup(); }
});
test('update setting persists and available native updates show their automatic download', async () => {
    await page.locator('.nav [data-page="settings"]').click();
    await page.locator('[data-category="about"]').click();
    await expect(page.locator('#pageHead')).toHaveCount(0);
    await expect(page.locator('.nav [data-page="settings"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#checkUpdatesOnStartup')).toBeChecked();
    await page.locator('#checkUpdatesOnStartup').uncheck();
    await expect.poll(() => page.evaluate(async () => (await window.desktop.updates.status()).checkOnStartup)).toBe(false);
    await page.reload();
    await page.locator('[data-category="about"]').click();
    await expect(page.locator('#checkUpdatesOnStartup')).not.toBeChecked();
    await app.evaluate(({ipcMain}) => {
        globalThis.installRequests = 0;
        ipcMain.removeHandler('updates:check');
        ipcMain.handle('updates:check', () => ({state:'available',currentVersion:'1.2.0',latestVersion:'1.3.0',notes:'<script>not executable</script>',canInstall:true,checkOnStartup:false}));
        ipcMain.removeHandler('updates:install');
        ipcMain.handle('updates:install', () => { globalThis.installRequests++;return {state:'cancelled',checkOnStartup:false,currentVersion:'1.2.0'}; });
    });
    await page.locator('[data-action="check-updates"]').click();
    await expect(page.locator('#updatesPanel')).toContainText('1.3.0');
    await expect(page.locator('#updatesPanel script')).toHaveCount(0);
    expect(await app.evaluate(() => globalThis.installRequests)).toBe(0);
    await expect(page.locator('#updatesPanel')).toContainText('即将自动下载并安装更新');
    await expect(page.locator('[data-action="install-update"]')).toHaveCount(0);
    await expect(page.locator('#checkUpdatesOnStartup')).not.toBeChecked();
});
test('hidden windows do not redraw for backend events and catch up when shown', async () => {
    await page.evaluate(() => {
        globalThis.mutations = 0;
        globalThis.observer = new MutationObserver(records => { globalThis.mutations += records.length; });
        observer.observe(document.getElementById('content'), {childList:true,subtree:true,characterData:true});
    });
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].hide());
    await expect.poll(() => app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
    await page.waitForTimeout(100);
    await page.evaluate(() => { globalThis.mutations = 0; });
    await app.evaluate(async ({BrowserWindow}) => {
        const win = BrowserWindow.getAllWindows()[0];
        for(let i=0;i<50;i++)win.webContents.send('backend:event',{event:'live',state:'connected',collector:'running',updatedAt:new Date().toISOString(),connections:[]});
    });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => globalThis.mutations)).toBe(0);
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].showInactive());
    await expect.poll(() => app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    await expect.poll(() => page.evaluate(() => globalThis.mutations)).toBeGreaterThan(0);
});
test('failed update recovers collection despite an unsaved draft and removes the recovery action', async () => {
    await app.evaluate(({ ipcMain }) => {
        globalThis.recoveryRequests = 0;
        ipcMain.removeHandler('updates:check');
        ipcMain.handle('updates:check', () => ({ state: 'error', recoveryRequired: true, error: '恢复失败，请重试。' }));
        ipcMain.removeHandler('updates:install');
        ipcMain.handle('updates:install', () => {
            globalThis.recoveryRequests++;
            return { state: 'recovered', recoveryRequired: false, error: '' };
        });
    });
    await page.locator('.nav [data-page="settings"]').click();
    await page.locator('[data-category="about"]').click();
    await page.locator('[data-action="check-updates"]').click();
    const recover = page.locator('#updatesPanel [data-action="install-update"]');
    await expect(recover).toHaveText('恢复采集');
    await expect(recover).toBeEnabled();
    await page.locator('[data-category="quota"]').click();
    await page.locator('#totalWarn').fill('120');
    await page.locator('[data-category="about"]').click();
    await recover.click();
    await expect.poll(() => app.evaluate(() => globalThis.recoveryRequests)).toBe(1);
    await expect(page.locator('#updatesPanel')).toContainText('已恢复原采集状态。');
    await expect(recover).toHaveCount(0);
    await expect(page.locator('#updatesPanel')).not.toContainText('恢复失败');
    await expect(page.locator('#totalWarn')).toHaveValue('120');
});

test('release notes render Markdown safely and progress preserves the open notes',async()=>{
 await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('updates:check');ipcMain.handle('updates:check',()=>({state:'available',currentVersion:'1.2.1',latestVersion:'1.2.2',canInstall:true,notes:'# Release\n\n## Changes\n- **Improved** speed\n- `code`\n\n[Details](https://github.com/chronicle12345/WiFiMeter/releases)\n\n<script>window.notesAttack=true</script><img src=x onerror="window.notesAttack=true"><a href="javascript:alert(1)">bad</a>'}));});
 await page.locator('.nav [data-page="settings"]').click();await page.locator('[data-category="about"]').click();await page.locator('[data-action="check-updates"]').click();
 await page.locator('.release-notes summary').click();
 await expect(page.locator('.release-notes-body h1')).toHaveText('Release');await expect(page.locator('.release-notes-body li')).toHaveCount(2);await expect(page.locator('.release-notes-body strong')).toHaveText('Improved');
 await expect(page.locator('.release-notes-body script,.release-notes-body img,.release-notes-body [href^="javascript:"]')).toHaveCount(0);
 expect(await page.evaluate(()=>window.notesAttack)).toBeUndefined();
 await page.evaluate(()=>{window.notesNode=document.querySelector('.release-notes-body');});
 const progress=async(state,receivedBytes,totalBytes,percent)=>app.evaluate(({BrowserWindow},value)=>BrowserWindow.getAllWindows()[0].webContents.send('updates:status',value),{state,progress:{phase:state,receivedBytes,totalBytes,percent},notes:'# Release\n\n## Changes\n- **Improved** speed\n- `code`\n\n[Details](https://github.com/chronicle12345/WiFiMeter/releases)\n\n<script>window.notesAttack=true</script><img src=x onerror="window.notesAttack=true"><a href="javascript:alert(1)">bad</a>'});
 const panel=page.locator('#updatesPanel');
 await progress('downloading',500000,1000000,50);await expect(panel.locator('progress')).toHaveAttribute('value','50');await expect(panel.locator('.update-progress-label')).toContainText('50%');
 await expect(page.locator('.release-notes')).toHaveAttribute('open','');expect(await page.evaluate(()=>window.notesNode===document.querySelector('.release-notes-body'))).toBe(true);
 await progress('downloading',600000,null,null);await expect(panel.locator('progress')).not.toHaveAttribute('value');await expect(panel.locator('.update-progress-label')).toContainText('600.0 KB');
 await progress('verifying',1000000,1000000,null);await expect(panel.locator('.update-progress')).toHaveAttribute('data-phase','verifying');await expect(panel.locator('progress')).not.toHaveAttribute('value');
 await progress('preparing',1000000,1000000,null);await expect(panel.locator('.update-progress')).toHaveAttribute('data-phase','preparing');
 await progress('installing',1000000,1000000,null);await expect(panel.locator('.update-progress-label')).toContainText('静默安装');
});

test('download progress is readable while the automatic check is pending and survives reload',async()=>{
 await app.evaluate(({ipcMain})=>{
  globalThis.fixtureUpdate={state:'available',currentVersion:'1.2.1',latestVersion:'1.2.2',canInstall:true,notes:'## Changes\n- Progress'};
  for(const name of ['updates:check','updates:status','updates:install'])ipcMain.removeHandler(name);
  ipcMain.handle('updates:check',()=>new Promise(resolve=>{globalThis.finishCheck=resolve;}));ipcMain.handle('updates:status',()=>globalThis.fixtureUpdate);
  ipcMain.handle('updates:install',()=>{throw Error('Automatic checks must not ask the renderer to install again.');});
 });
 await page.locator('.nav [data-page="settings"]').click();await page.locator('[data-category="about"]').click();await page.locator('#updatesPanel [data-action="check-updates"]').click();
 await app.evaluate(({BrowserWindow})=>{Object.assign(globalThis.fixtureUpdate,{state:'downloading',busy:true,progress:{phase:'downloading',receivedBytes:250000,totalBytes:1000000,percent:25}});BrowserWindow.getAllWindows()[0].webContents.send('updates:status',globalThis.fixtureUpdate);});
 await expect(page.locator('#updatesPanel progress')).toHaveAttribute('value','25');await page.locator('.release-notes summary').click();await expect(page.locator('.release-notes-body h2')).toHaveText('Changes');
 await page.reload();await page.locator('[data-category="about"]').click();await expect(page.locator('#updatesPanel progress')).toHaveAttribute('value','25');await expect(page.locator('#updatesPanel [data-action="check-updates"]')).toBeDisabled();
 await app.evaluate(({BrowserWindow})=>{Object.assign(globalThis.fixtureUpdate,{state:'error',busy:false,progress:null,error:'fixture download failed'});BrowserWindow.getAllWindows()[0].webContents.send('updates:status',globalThis.fixtureUpdate);globalThis.finishCheck(globalThis.fixtureUpdate);});
 await expect(page.locator('progress')).toHaveCount(0);await expect(page.locator('#updateStatusRegion')).toContainText('fixture download failed');await expect(page.locator('[data-action="check-updates"]')).toBeEnabled();
});

test('automatic update progress stays visible across pages and retries inline without a popup',async()=>{
 const send=async value=>app.evaluate(({BrowserWindow},status)=>BrowserWindow.getAllWindows()[0].webContents.send('updates:status',status),value);
 await app.evaluate(({ipcMain})=>{globalThis.retryRequests=0;ipcMain.removeHandler('updates:install');ipcMain.handle('updates:install',()=>{globalThis.retryRequests++;return {state:'cancelled',busy:false};});});
 await send({state:'available',currentVersion:'1.3.1',latestVersion:'1.3.2',canInstall:true});
 const banner=page.locator('#updateBanner');
 await expect(banner).toBeVisible();await expect(banner).toContainText('即将自动下载并安装更新');
 await expect(banner.locator('[data-action="install-update"]')).toHaveCount(0);
 await send({state:'downloading',busy:true,progress:{receivedBytes:250000,totalBytes:1000000,percent:25}});
 await expect(banner.locator('progress')).toHaveAttribute('value','25');await expect(banner).toContainText('250.0 KB / 1.0 MB · 25%');
 await page.locator('.nav [data-page="history"]').click();await expect(banner).toBeVisible();await expect(banner.locator('progress')).toHaveAttribute('value','25');
 for(const state of ['verifying','preparing','installing']){await send({state,progress:null});await expect(banner.locator('.update-progress')).toHaveAttribute('data-phase',state);await expect(banner.locator('progress')).not.toHaveAttribute('value');}
 await expect(banner).toContainText('静默安装');
 await send({state:'error',busy:false,error:'fixture retry required',errorPhase:'downloading',canInstall:true});
 await expect(banner).toContainText('下载更新失败');const retry=banner.locator('[data-action="install-update"]');await expect(retry).toHaveText('重试更新');await retry.click();
 await expect.poll(()=>app.evaluate(()=>globalThis.retryRequests)).toBe(1);await expect(banner).toBeHidden();await expect(page.locator('.modal')).toHaveCount(0);
});

test('unsupported platforms keep the explicit official release page action',async()=>{
 await app.evaluate(({ipcMain})=>{globalThis.manualRequests=0;ipcMain.removeHandler('updates:install');ipcMain.handle('updates:install',()=>{globalThis.manualRequests++;return {state:'manual',busy:false,canInstall:false};});});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('updates:status',{state:'available',canInstall:false,manual:true,latestVersion:'1.3.2'}));
 const open=page.locator('#updateBanner [data-action="install-update"]');await expect(open).toHaveText('打开版本下载页');expect(await app.evaluate(()=>globalThis.manualRequests)).toBe(0);await open.click();await expect.poll(()=>app.evaluate(()=>globalThis.manualRequests)).toBe(1);
});

test('global update progress follows the saved interface language',async()=>{
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('updates:status',{state:'downloading',canInstall:true,progress:{receivedBytes:500000,totalBytes:1000000,percent:50}}));
 await page.locator('.nav [data-page="settings"]').click();await page.locator('#quickLanguage').selectOption('en');
 await expect(page.locator('#updateBanner')).toContainText('Downloading installer');await expect(page.locator('#updateBanner')).toContainText('50%');
 await page.locator('#quickLanguage').selectOption('zh-CN');await expect(page.locator('#updateBanner')).toContainText('正在下载安装包');
});

test('automatic update preparation flushes pending edits and refuses invalid unsaved fields',async()=>{
 await page.locator('.nav [data-page="settings"]').click();await page.locator('[data-category="quota"]').click();
 expect(await page.evaluate(async()=>{const field=document.querySelector('#totalWarn');field.value='50, 87';field.dispatchEvent(new Event('input',{bubbles:true}));const saving=window.wifimeterPrepareUpdate(),locked=document.querySelector('#main').inert;const saved=await saving;return {locked,saved,stillLocked:document.querySelector('#main').inert};})).toEqual({locked:true,saved:true,stillLocked:true});
 await expect.poll(()=>page.evaluate(async()=>(await window.desktop.backend.request('snapshot')).result.totalQuota.warnPercents)).toEqual([50,87]);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('updates:status',{state:'error',busy:false,error:'fixture handoff failed'}));await expect(page.locator('#main')).toHaveJSProperty('inert',false);
 expect(await page.evaluate(async()=>{const field=document.querySelector('#totalWarn');field.value='120';field.dispatchEvent(new Event('input',{bubbles:true}));return window.wifimeterPrepareUpdate();})).toBe(false);
 await expect(page.locator('#totalWarn')).toHaveValue('120');await expect(page.locator('.modal')).toHaveCount(0);
});

test('automatic preparation keeps confirmation-required edits pending without opening a dialog',async()=>{
 await page.evaluate(()=>window.desktop.backend.request('updateSettings',{settings:{retention:0}}));await page.reload();
 await page.locator('.nav [data-page="settings"]').click();await page.locator('[data-category="data"]').click();
 expect(await page.evaluate(async()=>{const field=document.querySelector('[name="retention"]');field.value='30';field.dispatchEvent(new Event('change',{bubbles:true}));return window.wifimeterPrepareUpdate();})).toBe(false);
 await expect(page.locator('[name="retention"]')).toHaveValue('30');await expect(page.locator('.modal')).toHaveCount(0);await expect(page.locator('#settingsSaveHint')).toContainText('请先保存设置并重试更新');
 expect(await page.evaluate(async()=>(await window.desktop.backend.request('snapshot')).result.settings.retention)).toBe(0);
});

test('preparing locks settings and the drawer, while errors restore editing and keep drafts',async()=>{
 const send=async state=>app.evaluate(({BrowserWindow},state)=>BrowserWindow.getAllWindows()[0].webContents.send('updates:status',{state,busy:!['error','recovered'].includes(state),canInstall:true,error:state==='error'?'fixture preparation failed':'',progress:null}),state);
 await page.locator('.nav [data-page="settings"]').click();await page.locator('[data-category="quota"]').click();
 await send('downloading');await page.locator('#totalWarn').fill('120');
 await expect(page.locator('#main')).toHaveJSProperty('inert',false);
 await send('preparing');await expect(page.locator('#main')).toHaveJSProperty('inert',true);await expect(page.locator('.sidebar')).toHaveJSProperty('inert',true);
 await expect(page.locator('#updateBanner')).toBeVisible();await page.locator('#totalWarn').evaluate(field=>field.focus());await expect(page.locator('#totalWarn')).not.toBeFocused();
 await send('error');await expect(page.locator('#main')).toHaveJSProperty('inert',false);await expect(page.locator('#totalWarn')).toHaveValue('120');
 await page.locator('#totalWarn').fill('50, 90');await expect.poll(()=>page.evaluate(async()=>(await window.desktop.backend.request('snapshot')).result.totalQuota.warnPercents)).toEqual([50,90]);
 await page.locator('.nav [data-page="networks"]').click();await page.locator('button.network-name').first().click();await page.locator('[data-tab="settings"]').click();
 await page.locator('#warnPercent').fill('120');await send('preparing');await expect(page.locator('.drawer')).toHaveJSProperty('inert',true);
 await page.locator('#warnPercent').evaluate(field=>field.focus());await expect(page.locator('#warnPercent')).not.toBeFocused();
 await send('error');await expect(page.locator('.drawer')).toHaveJSProperty('inert',false);await expect(page.locator('#warnPercent')).toHaveValue('120');
 await page.locator('#warnPercent').fill('50, 80');await expect(page.locator('.modal')).toHaveCount(0);
});
