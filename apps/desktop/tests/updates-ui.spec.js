import { test, expect, _electron as electron } from '@playwright/test';
import { createHarness } from './support/backend-harness.mjs';
let app, page, harness;
test.beforeEach(async () => {
    harness = await createHarness();
    const env = { ...process.env, ...harness.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: ['.'], env });
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
test('failed update offers recovery through the install action and removes it after success', async () => {
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
    await recover.click();
    await expect.poll(() => app.evaluate(() => globalThis.recoveryRequests)).toBe(1);
    await expect(page.locator('#updatesPanel')).toContainText('已恢复原采集状态。');
    await expect(recover).toHaveCount(0);
    await expect(page.locator('#updatesPanel')).not.toContainText('恢复失败');
});
