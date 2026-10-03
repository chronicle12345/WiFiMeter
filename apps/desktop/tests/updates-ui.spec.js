import { test, expect } from '@playwright/test';
import { launchRenderer } from './support/renderer-harness.mjs';
import { createHarness } from './support/backend-harness.mjs';
let app, page, harness;
test.beforeEach(async () => {
    harness = await createHarness();
    const env = { ...process.env, ...harness.env }; app = await launchRenderer({ args: ['.'], env });
    page = await app.firstWindow();
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
});
test.afterEach(async () => { if(app) await app.close(); harness?.cleanup(); });
test('update setting persists and release checks never install before user action', async () => {
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
    await app.evaluate(({requests}) => {
        globalThis.installRequests = 0;
        requests.removeHandler('updates:check');
        requests.handle('updates:check', () => ({state:'available',currentVersion:'1.2.0',latestVersion:'1.3.0',notes:'<script>not executable</script>',canInstall:true,checkOnStartup:false}));
        requests.removeHandler('updates:install');
        requests.handle('updates:install', () => { globalThis.installRequests++;return {state:'cancelled',checkOnStartup:false,currentVersion:'1.2.0'}; });
    });
    await page.locator('[data-action="check-updates"]').click();
    await expect(page.locator('#updatesPanel')).toContainText('1.3.0');
    await expect(page.locator('#updatesPanel script')).toHaveCount(0);
    expect(await app.evaluate(() => globalThis.installRequests)).toBe(0);
    await page.locator('[data-action="install-update"]').click();
    await expect.poll(() => app.evaluate(() => globalThis.installRequests)).toBe(1);
    await expect(page.locator('#checkUpdatesOnStartup')).not.toBeChecked();
});
test('hidden windows do not redraw for backend events and catch up when shown', async () => {
    await page.evaluate(() => {
        globalThis.mutations = 0;
        globalThis.observer = new MutationObserver(records => { globalThis.mutations += records.length; });
        observer.observe(document.getElementById('content'), {childList:true,subtree:true,characterData:true});
    });
    await app.evaluate(({events}) => events.emit('window:visibility', false));
    await page.waitForTimeout(100);
    await page.evaluate(() => { globalThis.mutations = 0; });
    await app.evaluate(async ({events}) => {
        for(let i=0;i<50;i++)await events.emit('backend:event',{event:'live',state:'connected',collector:'running',updatedAt:new Date().toISOString(),connections:[]});
    });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => globalThis.mutations)).toBe(0);
    await app.evaluate(({events}) => events.emit('window:visibility', true));
    await expect.poll(() => page.evaluate(() => globalThis.mutations)).toBeGreaterThan(0);
});
test('failed update offers recovery through the install action and removes it after success', async () => {
    await app.evaluate(({ requests }) => {
        globalThis.recoveryRequests = 0;
        requests.removeHandler('updates:check');
        requests.handle('updates:check', () => ({ state: 'error', recoveryRequired: true, error: '恢复失败，请重试。' }));
        requests.removeHandler('updates:install');
        requests.handle('updates:install', () => {
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
    await recover.click();
    await expect.poll(() => app.evaluate(() => globalThis.recoveryRequests)).toBe(1);
    await expect(page.locator('#updatesPanel')).toContainText('已恢复原采集状态。');
    await expect(recover).toHaveCount(0);
    await expect(page.locator('#updatesPanel')).not.toContainText('恢复失败');
});

test('release notes render Markdown safely and progress preserves the open notes',async()=>{
 await app.evaluate(({requests})=>{requests.removeHandler('updates:check');requests.handle('updates:check',()=>({state:'available',currentVersion:'1.2.1',latestVersion:'1.2.2',canInstall:true,notes:'# Release\n\n## Changes\n- **Improved** speed\n- `code`\n\n[Details](https://github.com/chronicle12345/WiFiMeter/releases)\n\n<script>window.notesAttack=true</script><img src=x onerror="window.notesAttack=true"><a href="javascript:alert(1)">bad</a>'}));});
 await page.locator('.nav [data-page="settings"]').click();await page.locator('[data-category="about"]').click();await page.locator('[data-action="check-updates"]').click();
 await page.locator('.release-notes summary').click();
 await expect(page.locator('.release-notes-body h1')).toHaveText('Release');await expect(page.locator('.release-notes-body li')).toHaveCount(2);await expect(page.locator('.release-notes-body strong')).toHaveText('Improved');
 await expect(page.locator('.release-notes-body script,.release-notes-body img,.release-notes-body [href^="javascript:"]')).toHaveCount(0);
 expect(await page.evaluate(()=>window.notesAttack)).toBeUndefined();
 await page.evaluate(()=>{window.notesNode=document.querySelector('.release-notes-body');});
 const progress=async(state,receivedBytes,totalBytes,percent)=>app.evaluate(({events},value)=>events.emit('updates:status',value),{state,progress:{phase:state,receivedBytes,totalBytes,percent},notes:'# Release\n\n## Changes\n- **Improved** speed\n- `code`\n\n[Details](https://github.com/chronicle12345/WiFiMeter/releases)\n\n<script>window.notesAttack=true</script><img src=x onerror="window.notesAttack=true"><a href="javascript:alert(1)">bad</a>'});
 await progress('downloading',500000,1000000,50);await expect(page.locator('progress')).toHaveAttribute('value','50');await expect(page.locator('.update-progress-label')).toContainText('50%');
 await expect(page.locator('.release-notes')).toHaveAttribute('open','');expect(await page.evaluate(()=>window.notesNode===document.querySelector('.release-notes-body'))).toBe(true);
 await progress('downloading',600000,null,null);await expect(page.locator('progress')).not.toHaveAttribute('value');await expect(page.locator('.update-progress-label')).toContainText('600.0 KB');
 await progress('verifying',1000000,1000000,null);await expect(page.locator('.update-progress')).toHaveAttribute('data-phase','verifying');await expect(page.locator('progress')).not.toHaveAttribute('value');
 await progress('preparing',1000000,1000000,null);await expect(page.locator('.update-progress')).toHaveAttribute('data-phase','preparing');
 await progress('installing',1000000,1000000,null);await expect(page.locator('.update-progress-label')).toContainText('安装程序');
});

test('download progress is readable while install is pending and survives reload',async()=>{
 await app.evaluate(({requests})=>{
  globalThis.fixtureUpdate={state:'available',currentVersion:'1.2.1',latestVersion:'1.2.2',canInstall:true,notes:'## Changes\n- Progress'};
  for(const name of ['updates:check','updates:status','updates:install'])requests.removeHandler(name);
  requests.handle('updates:check',()=>globalThis.fixtureUpdate);requests.handle('updates:status',()=>globalThis.fixtureUpdate);
  requests.handle('updates:install',()=>new Promise(resolve=>{globalThis.finishInstall=resolve;}));
 });
 await page.locator('.nav [data-page="settings"]').click();await page.locator('[data-category="about"]').click();await page.locator('[data-action="check-updates"]').click();await page.locator('[data-action="install-update"]').click();
 await app.evaluate(({events})=>{Object.assign(globalThis.fixtureUpdate,{state:'downloading',busy:true,progress:{phase:'downloading',receivedBytes:250000,totalBytes:1000000,percent:25}});events.emit('updates:status',globalThis.fixtureUpdate);});
 await expect(page.locator('progress')).toHaveAttribute('value','25');await page.locator('.release-notes summary').click();await expect(page.locator('.release-notes-body h2')).toHaveText('Changes');
 await page.reload();await page.locator('[data-category="about"]').click();await expect(page.locator('progress')).toHaveAttribute('value','25');await expect(page.locator('[data-action="check-updates"]')).toBeDisabled();
 await app.evaluate(({events})=>{Object.assign(globalThis.fixtureUpdate,{state:'error',busy:false,progress:null,error:'fixture download failed'});events.emit('updates:status',globalThis.fixtureUpdate);globalThis.finishInstall(globalThis.fixtureUpdate);});
 await expect(page.locator('progress')).toHaveCount(0);await expect(page.locator('#updateStatusRegion')).toContainText('fixture download failed');await expect(page.locator('[data-action="check-updates"]')).toBeEnabled();
});
