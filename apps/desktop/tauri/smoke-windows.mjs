// 在真正的 Windows WebView2 中检查现有页面 → Tauri IPC → C++ → SQLite。
// 只给测试进程启用 CDP，使用独立配置目录及现有网卡夹具。
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { createHarness } from '../tests/support/backend-harness.mjs';

assert.equal(process.platform, 'win32', 'Run this test with Windows Node.js');
assert.ok(process.env.WIFIMETER_EXECUTABLE, 'Set WIFIMETER_EXECUTABLE to the Tauri executable');
const server = createServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
await new Promise(resolve => server.close(resolve));

const harness = await createHarness();
const child = spawn(process.env.WIFIMETER_EXECUTABLE, [], {
    env: { ...process.env, ...harness.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: ['ignore', 'pipe', 'pipe']
});
const exited = once(child, 'exit');
let log = '', browser, page;
child.stdout.on('data', chunk => { log += chunk; });
child.stderr.on('data', chunk => { log += chunk; });
async function native(action, ...args) {
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./test-window.ps1', import.meta.url)), '-ProcessId', String(child.pid), '-Action', action, ...args], { timeout: 10000, windowsHide: true });
    return stdout.trim() ? JSON.parse(stdout) : null;
}
try {
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 40000;
    while (true) {
        assert.equal(child.exitCode, null, `Tauri exited during startup:\n${log}`);
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch { /* WebView2 is starting. */ }
        assert.ok(Date.now() < deadline, `WebView2 did not expose its test endpoint:\n${log}`);
        await delay(100);
    }
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    page = context.pages()[0] ?? await context.waitForEvent('page');
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('WebView error:', error.message); });
    await page.waitForFunction(() => Boolean(window.desktop));
    console.log('WebView2 bridge ready');
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
    await expect(page.locator('.connection-details')).toContainText('Habitat_5G');
    await expect(page.locator('#collector')).toContainText('正在采集');
    await page.getByRole('button', { name: '暂停统计', exact: true }).click();
    await expect(page.locator('#collector')).toContainText('统计已暂停');
    await page.getByRole('button', { name: '恢复统计', exact: true }).click();
    await expect(page.locator('#collector')).toContainText('正在采集');
    for (const name of ['networks', 'history', 'settings', 'overview']) {
        await page.locator(`.nav [data-page="${name}"]`).click();
        await expect(page.locator('#content')).not.toBeEmpty();
    }
    const snapshot = await page.evaluate(() => window.desktop.backend.request('snapshot'));
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.result.source, 'backend');
    assert.equal(snapshot.result.records[0].rxBytes, '3100000000');
    assert.deepEqual(await page.evaluate(() => window.desktop.legacy.status()), { found: false });
    const changed = await page.evaluate(async () => {
        const event = new Promise(resolve => {
            const off = window.desktop.windowPreferences.onChanged(value => { off(); resolve(value); });
        });
        await window.desktop.windowPreferences.update({ theme: 'dark' });
        return event;
    });
    assert.equal(changed.theme, 'dark');
    console.log('Pages and backend passed; checking floating window');
    await page.evaluate(() => window.desktop.windowPreferences.update({ miniWindow: true, miniAutoHide: false }));
    await expect.poll(() => context.pages().some(page => page.url().endsWith('/electron/mini/index.html'))).toBe(true);
    const mini = context.pages().find(page => page.url().endsWith('/electron/mini/index.html'));
    mini.on('pageerror', error => errors.push(error.message));
    await mini.waitForFunction(() => Boolean(window.miniDesktop));
    await expect(mini.locator('#download .rate-number')).not.toHaveText('—');
    await page.evaluate(() => window.desktop.backend.request('updateSettings', { settings: { speedUnit: 'MB/s' } }));
    await expect(mini.locator('#download .rate-unit')).toHaveText(' MB/s');
    await expect(mini.locator('body')).toHaveAttribute('data-shape', 'bar');
    const initial = await native('bounds', '-Target', 'mini');
    assert.equal(initial.topmost, true);
    assert.equal(initial.noActivate, true);
    assert.equal(initial.visible, true);
    assert.equal(initial.width, Math.round(224 * initial.scale));
    assert.equal(initial.height, Math.round(92 * initial.scale));
    for (const [shape, palette, size] of [['square', 'light', 152], ['circle', 'indigo', 168], ['bar', 'dark', 224]]) {
        await page.evaluate(patch => window.desktop.windowPreferences.update(patch), { miniShape: shape, miniPalette: palette });
        await expect(mini.locator('body')).toHaveAttribute('data-shape', shape);
        await expect(mini.locator('body')).toHaveAttribute('data-palette', palette);
        await expect.poll(() => mini.evaluate(() => innerWidth)).toBe(size);
        if (process.env.WIFIMETER_SCREENSHOT) await mini.screenshot({ path: process.env.WIFIMETER_SCREENSHOT.replace('.png', `-mini-${shape}.png`) });
    }
    // Exercise the real native drag path, then verify snapping/collapse/hover in physical coordinates.
    const x = initial.area.x + Math.round(8 * initial.scale), y = initial.area.y + Math.round(200 * initial.scale);
    await native('drag', '-Target', 'mini', '-X', String(x), '-Y', String(y));
    await expect.poll(async () => (await native('bounds', '-Target', 'mini')).x).toBe(initial.area.x);
    const savedCursor = await native('cursor', '-X', String(initial.area.x + initial.area.width / 2 | 0), '-Y', String(initial.area.y + initial.area.height / 2 | 0));
    try {
        await page.evaluate(() => window.desktop.windowPreferences.update({ miniAutoHide: true }));
        await expect(mini.locator('body')).toHaveAttribute('data-collapsed', 'true');
        const strip = await native('bounds', '-Target', 'mini');
        assert.equal(strip.width, Math.round(6 * strip.scale));
        await native('cursor', '-X', String(strip.x + 2), '-Y', String(strip.y + 20));
        await expect(mini.locator('body')).toHaveAttribute('data-collapsed', 'false');
        await expect.poll(() => mini.evaluate(() => innerWidth)).toBe(224);
        await page.evaluate(() => window.desktop.windowPreferences.update({ miniAutoHide: false }));
    } finally { await native('cursor', '-X', String(savedCursor.x), '-Y', String(savedCursor.y)); }
    // Mini IPC stays restricted; its own close button persists the preference without exiting the app.
    await assert.rejects(() => mini.evaluate(() => window.__TAURI__.core.invoke('desktop_request', { channel: 'backend:request', payload: { method: 'shutdown' } })));
    await mini.locator('#close').click();
    await expect.poll(() => page.evaluate(async () => (await window.desktop.windowPreferences.read()).miniWindow)).toBe(false);
    await expect.poll(() => mini.isClosed()).toBe(true);
    await page.evaluate(() => window.desktop.windowPreferences.update({ miniWindow: true }));
    await expect.poll(() => context.pages().some(page => page.url().endsWith('/electron/mini/index.html'))).toBe(true);
    const reopened = context.pages().find(page => page.url().endsWith('/electron/mini/index.html'));
    await reopened.waitForFunction(() => Boolean(window.miniDesktop));
    await reopened.locator('#open').click();
    await native('close', '-Target', 'mini');
    await expect.poll(() => page.evaluate(async () => (await window.desktop.windowPreferences.read()).miniWindow)).toBe(false);
    await expect.poll(() => reopened.isClosed()).toBe(true);
    console.log('Floating window passed; checking themed close choices');
    await page.evaluate(() => {
        window.testVisibility = [];
        window.desktop.onVisibility(value => window.testVisibility.push(value));
        return window.desktop.windowPreferences.update({ closeAction: 'ask' });
    });
    const dialog = page.locator('dialog.desktop-dialog');
    await native('close');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await expect(dialog).toHaveCSS('background-color', 'rgb(34, 34, 38)');
    if (process.env.WIFIMETER_SCREENSHOT) await page.screenshot({ animations: 'disabled', path: process.env.WIFIMETER_SCREENSHOT.replace('.png', '-dialog-dark.png') });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    assert.equal(child.exitCode, null);
    console.log('Themed cancellation passed');
    await page.evaluate(() => window.desktop.windowPreferences.update({ theme: 'light' }));
    await native('close');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    if (process.env.WIFIMETER_SCREENSHOT) await page.screenshot({ animations: 'disabled', path: process.env.WIFIMETER_SCREENSHOT.replace('.png', '-dialog-light.png') });
    await dialog.getByRole('checkbox', { name: '记住我的选择' }).check();
    await dialog.getByRole('button', { name: '最小化到托盘', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.desktop.windowPreferences.read()).closeAction)).toBe('tray');
    await expect.poll(() => page.evaluate(() => window.testVisibility.at(-1))).toBe(false);
    console.log('Remembered tray choice passed');
    const second = spawn(process.env.WIFIMETER_EXECUTABLE, [], { env: { ...process.env, ...harness.env }, stdio: 'ignore' });
    await once(second, 'exit');
    await expect.poll(() => page.evaluate(() => window.testVisibility.at(-1))).toBe(true);
    console.log('Single-instance activation passed');
    await page.evaluate(() => {
        window.testDirtyHandler = event => event.preventDefault();
        window.addEventListener('beforeunload', window.testDirtyHandler);
        return window.desktop.windowPreferences.update({ closeAction: 'exit' });
    });
    await native('close');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('尚未保存的更改');
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    assert.equal(child.exitCode, null);
    await page.evaluate(() => window.removeEventListener('beforeunload', window.testDirtyHandler));
    // Import/resume share the same UI; verify localization, default focus and keyboard dismissal.
    await page.evaluate(async () => {
        const { setLanguage } = await import('/renderer/i18n.js');
        setLanguage('en');
        const { installDialogs } = await import('/tauri/dialogs.js');
        let receive;
        window.removeTestDialogs = await installDialogs({ listen: async (_, callback) => { receive = callback; return () => {}; }, invoke: async () => {} });
        window.receiveTestDialog = receive;
        receive({ payload: { id: 100000, kind: 'overlap' } });
        receive({ payload: { id: 100001, kind: 'resume' } });
    });
    await expect(dialog).toContainText('Keep existing dates');
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toContainText('Resume collection now?');
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    for (const language of ['zh-CN', 'en']) {
        await page.evaluate(async language => (await import('/renderer/i18n.js')).setLanguage(language), language);
        for (const kind of ['close', 'discard', 'resume', 'overlap']) {
            await page.evaluate(kind => window.receiveTestDialog({ payload: { id: 100002, kind } }), kind);
            await expect(dialog).toBeVisible();
            const text = await dialog.innerText();
            const accessibleClose = await dialog.locator('.desktop-dialog-close').getAttribute('aria-label');
            if (language === 'zh-CN') {
                assert.doesNotMatch(text.replaceAll('WiFiMeter', ''), /[A-Za-z]/);
                assert.equal(accessibleClose, '关闭对话框');
            } else {
                assert.doesNotMatch(text + accessibleClose, /[\u3400-\u9fff]/);
            }
            await page.keyboard.press('Escape');
            await expect(dialog).toHaveCount(0);
        }
    }
    await page.evaluate(() => window.removeTestDialogs());
    assert.deepEqual(errors, []);
    if (process.env.WIFIMETER_SCREENSHOT) await page.screenshot({ animations: 'disabled', path: process.env.WIFIMETER_SCREENSHOT });
    console.log('PASS: Windows WebView2 pages, backend, preferences, floating-window shapes/palettes/rates/drag/snap/auto-hide/close, themed dialogs in both themes, import/resume localization, tray hiding, single-instance activation and unsaved-change cancellation');
} catch (error) {
    console.error('Smoke test failed:', error);
    throw error;
} finally {
    if (child.exitCode === null) {
        await page?.keyboard.press('Escape').catch(() => {});
        await page?.evaluate(() => window.removeEventListener('beforeunload', window.testDirtyHandler)).catch(() => {});
        await page?.evaluate(() => window.desktop?.windowPreferences.update({ closeAction: 'exit' })).catch(() => {});
        await native('close');
        const graceful = await Promise.race([exited.then(() => true), delay(30000, false, { ref: false })]);
        if (!graceful) {
            const cleanup = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            await once(cleanup, 'exit');
            throw Error(`Test application did not close gracefully:\n${log}`);
        }
    }
    await browser?.close();
    // WebView2 的缓存进程在宿主退出后才释放文件句柄。
    await rm(harness.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
assert.equal(child.exitCode, 0, log);
