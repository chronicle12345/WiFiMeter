// 在真正的 Windows WebView2 中检查现有页面 → Tauri IPC → C++ → SQLite。
// 只给测试进程启用 CDP，使用独立配置目录及现有网卡夹具。
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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

const iconExecutable = `${process.env.SystemRoot}\\explorer.exe`;
const harness = await createHarness({ appId: iconExecutable });
// Requires a debug build with --features custom-protocol,test-fixture.
const updateFixture = join(harness.directory, 'update-fixture');
await mkdir(updateFixture);
const installer = Buffer.from('smoke installer fixture; never execute');
const updateName = 'WiFiMeter-1.3.0-windows-x64-Setup.exe';
const updateRelease = { tag_name: 'v1.3.0', body: 'Fixture release notes', assets: [{ name: updateName,
    digest: `sha256:${createHash('sha256').update(installer).digest('hex')}`,
    browser_download_url: `https://github.com/chronicle12345/WiFiMeter/releases/download/v1.3.0/${updateName}` }] };
await writeFile(join(updateFixture, 'release.json'), JSON.stringify(updateRelease));
await writeFile(join(updateFixture, 'installer.exe'), installer);
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
    // A real local PE icon passes through collector lookup, native extraction and the original loader.
    await page.locator('.nav [data-page="apps"]').click();
    await page.getByRole('button', { name: '启用应用采集', exact: true }).click();
    await page.evaluate(() => window.desktop.backend.request('collectNow'));
    harness.appCounters(80000000, 20000000);
    await page.evaluate(() => window.desktop.backend.request('collectNow'));
    const icon = await page.evaluate(appId => window.desktop.appIcons.get({ appId }), iconExecutable);
    assert.match(icon, /^data:image\/png;base64,/);
    assert.equal(await page.evaluate(() => window.desktop.appIcons.get({ appId: 'C:\\unknown-wifimeter-app.exe' })), null);
    for (const grouping of ['summary', 'live']) {
        await page.locator('#appGrouping').selectOption(grouping);
        await expect(page.locator('#appListRegion .app-avatar img')).toBeVisible();
        assert.equal(await page.locator('#appListRegion .app-avatar img').evaluate(image => image.naturalWidth), 32);
    }
    console.log('Native application icons passed in summary and live views');
    const control = await page.evaluate(path => window.desktop.appControl.request({ action: 'read', path }), iconExecutable);
    assert.equal(control.ok, true, JSON.stringify(control));
    assert.equal(control.result.state.Scope, 'LocalConfiguredPolicy');
    assert.equal((await page.evaluate(path => window.desktop.appControl.request({ action: 'throttle', path, uploadKBps: 0.01 }), iconExecutable)).error.code, 'invalidRequest');
    for (const [language, title] of [['zh-CN', '选择需要控制联网的程序'], ['en', 'Choose an application to control']]) {
        await page.evaluate(language => window.desktop.backend.request('updateSettings', { settings: { language } }), language);
        await page.evaluate(() => { window.testChooseResult = null; window.desktop.appControl.chooseProgram().then(result => { window.testChooseResult = result; }); });
        await expect.poll(async () => (await native('dialog')).title, { timeout: 15000 }).toBe(title);
        await native('cancel-dialog');
        await expect.poll(() => page.evaluate(() => window.testChooseResult)).toEqual({ ok: false, canceled: true });
    }
    await page.evaluate(() => window.desktop.backend.request('updateSettings', { settings: { language: 'zh-CN' } }));
    console.log('Application control read, validation and bilingual picker cancellation passed');
    await page.locator('.nav [data-page="overview"]').click();
    const changed = await page.evaluate(async () => {
        const event = new Promise(resolve => {
            const off = window.desktop.windowPreferences.onChanged(value => { off(); resolve(value); });
        });
        await window.desktop.windowPreferences.update({ theme: 'dark' });
        return event;
    });
    assert.equal(changed.theme, 'dark');
    for (const enabled of [true, false]) {
        const applied = await page.evaluate(autoStart => window.desktop.backend.request('updateSettings', { settings: { autoStart } }), enabled);
        assert.equal(applied.ok, true);
        assert.equal(applied.result.settings.autoStart, enabled);
        assert.equal(applied.result.system.autoStart, enabled);
    }
    const notifications = () => log.split(/\r?\n/).filter(line => line.startsWith('[notification:test] ')).map(line => JSON.parse(line.slice('[notification:test] '.length)));
    for (const [language, capGb, expected] of [
        ['zh-CN', 3, ['Wi-Fi 总额度 已使用额度的 120%。', 'Wi-Fi 总额度 已达到额度上限。']],
        ['en', 2, ['Total Wi-Fi has used 180% of its quota.', 'Total Wi-Fi has reached its quota.']]
    ]) {
        await page.evaluate(settings => window.desktop.backend.request('updateSettings', { settings }), { language, notifications: true });
        const start = notifications().length;
        const result = await page.evaluate(capGb => window.desktop.backend.request('updateTotalQuota', { capGb, warnPercent: 80, period: 'all', notify: true, autoDisconnect: false }), capGb);
        assert.equal(result.ok, true);
        assert.equal((await page.evaluate(() => window.desktop.backend.request('collectNow'))).ok, true);
        await expect.poll(() => notifications().slice(start)).toEqual(expected.map(body => ({ title: 'WiFiMeter', body })));
    }
    await page.evaluate(() => window.desktop.backend.request('updateSettings', { settings: { notifications: false } }));
    const beforeDisabled = notifications().length;
    await page.evaluate(() => window.desktop.backend.request('updateTotalQuota', { capGb: 1, warnPercent: 80, period: 'all', notify: true, autoDisconnect: false }));
    assert.equal((await page.evaluate(() => window.desktop.backend.request('collectNow'))).ok, true);
    await delay(1500);
    assert.equal(notifications().length, beforeDisabled);
    await page.evaluate(() => window.desktop.backend.request('updateTotalQuota', { capGb: 0, warnPercent: 80, period: 'all', notify: true, autoDisconnect: false }));
    await page.evaluate(() => window.desktop.backend.request('updateSettings', { settings: { language: 'zh-CN', notifications: true } }));
    console.log('Pages, backend, isolated autostart and bilingual quota notification dispatch passed; checking floating window');
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
        for (const kind of ['close', 'discard', 'resume', 'overlap', 'update-install', 'update-manual']) {
            await page.evaluate(kind => window.receiveTestDialog({ payload: { id: 100002, kind, version: '1.3.0' } }), kind);
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
    await page.evaluate(() => {
        window.updateEvents = [];
        window.desktop.updates.onStatus(status => window.updateEvents.push(status));
    });
    const updateState = () => page.evaluate(async () => (await window.desktop.updates.status()).state);
    for (const language of ['zh-CN', 'en']) {
        await page.evaluate(async language => {
            await window.desktop.backend.request('updateSettings', { settings: { language } });
            (await import('/renderer/i18n.js')).setLanguage(language);
        }, language);
        await page.locator('.nav [data-page="settings"]').click();
        await page.locator('[data-action="settings-category"][data-category="about"]').click();
        const check = page.locator('[data-action="check-updates"]');
        const install = page.locator('[data-action="install-update"]');
        await page.locator('#checkUpdatesOnStartup').uncheck();
        await expect.poll(async () => {
            try { return JSON.parse(await readFile(join(harness.directory, 'update-preferences.json'), 'utf8')).checkOnStartup; }
            catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
        }).toBe(false);
        await page.locator('#checkUpdatesOnStartup').check();
        await check.click();
        await expect.poll(updateState).toBe('available');
        await install.click();
        await expect(dialog).toHaveAttribute('data-kind', 'update-install');
        await expect(dialog).toContainText('1.3.0');
        await expect(dialog.locator('footer button').nth(1)).toBeFocused();
        await page.keyboard.press('Escape');
        await expect.poll(updateState).toBe('cancelled');
        await check.click();
        await expect.poll(updateState).toBe('available');
        const paused = language === 'en';
        await page.evaluate(async paused => {
            await window.desktop.backend.request('setPaused', { paused });
            await window.desktop.backend.request('setAppCollection', { enabled: true });
        }, paused);
        await install.click();
        await expect(dialog).toHaveAttribute('data-kind', 'update-install');
        await dialog.locator('footer button').first().click();
        await expect.poll(updateState, { timeout: 20000 }).toBe('error');
        const recovered = await page.evaluate(() => window.desktop.backend.request('hello'));
        assert.equal(recovered.ok, true);
        assert.equal(recovered.result.paused, paused);
        assert.equal(recovered.result.appCollection.enabled, true);
        const failed = await page.evaluate(() => window.desktop.updates.status());
        assert.equal(failed.busy, false);
        assert.equal(failed.recoveryRequired, false);
        assert.equal(failed.progress, null);
        if (language === 'zh-CN') assert.doesNotMatch(failed.error, /[A-Za-z]/);
        else assert.doesNotMatch(failed.error, /[\u3400-\u9fff]/);
        assert.deepEqual(await readdir(join(harness.directory, 'updates')), []);
        await check.click();
        await expect.poll(updateState).toBe('available');
        await expect(page.locator('#updateStatusRegion')).not.toContainText(failed.error);
    }
    assert.equal((log.match(/\[updates:test\] handoff rejected/g) || []).length, 2);
    const phases = await page.evaluate(() => [...new Set(window.updateEvents.map(event => event.state))]);
    for (const phase of ['checking', 'downloading', 'verifying', 'preparing', 'installing', 'error']) assert.ok(phases.includes(phase), phase);
    // An unsaved-change cancellation after download must not stop collection or authorize handoff.
    await page.evaluate(async () => {
        await window.desktop.backend.request('updateSettings', { settings: { language: 'zh-CN' } });
        await window.desktop.backend.request('setPaused', { paused: false });
        (await import('/renderer/i18n.js')).setLanguage('zh-CN');
        window.testDirtyHandler = event => event.preventDefault();
        window.addEventListener('beforeunload', window.testDirtyHandler);
    });
    await page.locator('[data-action="install-update"]').click();
    await expect(dialog).toHaveAttribute('data-kind', 'update-install');
    await dialog.locator('footer button').first().click();
    await expect(dialog).toHaveAttribute('data-kind', 'discard');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect.poll(updateState).toBe('cancelled');
    await page.evaluate(() => window.removeEventListener('beforeunload', window.testDirtyHandler));
    assert.equal((await page.evaluate(() => window.desktop.backend.request('hello'))).result.paused, false);
    assert.equal((log.match(/\[updates:test\] handoff rejected/g) || []).length, 2);
    assert.deepEqual(await readdir(join(harness.directory, 'updates')), []);
    await writeFile(join(updateFixture, 'release.json'), JSON.stringify({ ...updateRelease, assets: [] }));
    await page.locator('[data-action="check-updates"]').click();
    await expect.poll(updateState).toBe('available');
    await page.locator('[data-action="install-update"]').click();
    await expect(dialog).toHaveAttribute('data-kind', 'update-manual');
    await dialog.locator('footer button').first().click();
    await expect.poll(updateState).toBe('manual');
    assert.ok(log.includes('[updates:test] open-link https://github.com/chronicle12345/WiFiMeter/releases/tag/v1.3.0'));
    assert.equal(await page.evaluate(async () => { try { await window.desktop.updates.openLink('javascript:alert(1)'); return false; } catch { return true; } }), true);
    console.log('Update UI, bilingual confirmation, preferences, verified download, handoff failure recovery, unsaved cancellation and manual fallback passed');
    assert.deepEqual(errors, []);
    if (process.env.WIFIMETER_SCREENSHOT) await page.screenshot({ animations: 'disabled', path: process.env.WIFIMETER_SCREENSHOT });
    console.log('PASS: Windows WebView2 pages, backend, preferences, isolated autostart, bilingual quota notification dispatch and off switch, floating-window shapes/palettes/rates/drag/snap/auto-hide/close, themed dialogs in both themes, import/resume localization, tray hiding, single-instance activation and unsaved-change cancellation');
} catch (error) {
    console.error('Smoke test failed:', error);
    try { console.error('Mini diagnostics:', await native('bounds', '-Target', 'mini')); } catch { /* The mini may not exist yet. */ }
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
