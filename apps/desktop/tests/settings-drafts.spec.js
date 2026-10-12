import { test, expect } from '@playwright/test';
import { desktop } from './support/browser-desktop.mjs';
import { createHarness } from './support/backend-harness.mjs';

let app, page, harness;
test.beforeEach(async () => {
    harness = await createHarness();
    const env = { ...process.env, ...harness.env };
    app = await desktop.launch({ env }); page = await app.firstWindow();
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
    await page.locator('.nav [data-page="settings"]').click();
    await page.locator('[data-category="quota"]').click();
});
test.afterEach(async () => {
    if (app) {
        await app.evaluate(({ app: fixtureApp, BrowserWindow }) => {
            fixtureApp.removeAllListeners('window-all-closed');
            for (const win of BrowserWindow.getAllWindows()) win.destroy();
        });
        await app.close();
    }
    harness?.cleanup();
});

test('pausing collection retains an invalid quota draft and its visible validation', async () => {
    await page.locator('#totalWarn').fill('0, 120');
    await expect(page.locator('#totalQuotaForm [role="alert"]')).not.toBeEmpty();
    const form = await page.locator('#totalQuotaForm').elementHandle();
    await page.locator('[data-action="pause"]').click();
    await expect(page.locator('.collector-title')).toHaveText('统计已暂停');
    await expect(page.locator('#totalWarn')).toHaveValue('0, 120');
    expect(await form.evaluate(el => el.isConnected)).toBe(true);
    await expect(page.locator('#totalQuotaForm [role="alert"]')).not.toBeEmpty();
    await page.locator('#totalWarn').fill('50, 90');
    await page.locator('#totalWarn').blur();
    await expect(page.locator('#totalQuotaSaveStatus')).toHaveAttribute('data-state', 'saved');
    expect(await page.evaluate(() => window.wifimeterHasUnsavedChanges())).toBe(false);
});

test('pausing collection retains a failed save and retry on the same form', async () => {
    await app.evaluate(({ ipcMain }) => {
        const original = ipcMain.getHandler('backend:request');
        globalThis.draftFixture = { fail: true };
        ipcMain.removeHandler('backend:request');
        ipcMain.handle('backend:request', (event, input) => input.method === 'updateTotalQuota' && globalThis.draftFixture.fail
            ? { ok: false, error: { message: 'fixture quota save denied' } } : original(event, input));
    });
    await page.locator('#totalCap').fill('42'); await page.locator('#totalCap').blur();
    await expect(page.locator('#totalQuotaSaveStatus')).toHaveAttribute('data-state', 'error');
    await page.locator('[data-action="pause"]').click();
    await expect(page.locator('.collector-title')).toHaveText('统计已暂停');
    await expect(page.locator('#totalCap')).toHaveValue('42');
    const retry = page.locator('#totalQuotaForm [data-action="retry-autosave"]');
    await expect(retry).toBeVisible();
    await app.evaluate(() => { globalThis.draftFixture.fail = false; });
    await retry.click();
    await expect(page.locator('#totalQuotaSaveStatus')).toHaveAttribute('data-state', 'saved');
    expect(await page.evaluate(() => window.wifimeterHasUnsavedChanges())).toBe(false);
    const saved = await page.evaluate(() => window.desktop.backend.request('snapshot'));
    expect(saved.result.totalQuota.capGb).toBe(42);
});

test('clear and restore keep failed drafts visible and do not change backend data', async () => {
    await page.locator('#totalWarn').fill('0, 120');
    await expect(page.locator('#totalQuotaForm [role="alert"]')).not.toBeEmpty();
    await app.evaluate(({ ipcMain }) => {
        globalThis.draftFixture = { calls: [] };
        const original = ipcMain.getHandler('backend:request');
        ipcMain.removeHandler('backend:request'); ipcMain.handle('backend:request', (event, input) => {
            globalThis.draftFixture.calls.push(input.method); return original(event, input);
        });
        ipcMain.removeHandler('files:open-backup'); ipcMain.handle('files:open-backup', () => {
            globalThis.draftFixture.calls.push('files:open-backup'); return { canceled: true };
        });
    });
    await page.locator('[data-category="data"]').click();
    await page.locator('[data-action="clear-records"]').click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await page.locator('[data-action="restore"]').click();
    await expect(page.locator('#totalWarn')).toHaveValue('0, 120');
    const calls = await app.evaluate(() => globalThis.draftFixture.calls);
    expect(calls).not.toContain('clearUsage'); expect(calls).not.toContain('restore'); expect(calls).not.toContain('files:open-backup');
});
