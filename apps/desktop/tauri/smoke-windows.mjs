// 在真正的 Windows WebView2 中检查现有页面 → Tauri IPC → C++ → SQLite。
// 只给测试进程启用 CDP，使用独立配置目录及现有网卡夹具。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
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
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => Boolean(window.desktop));
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
    assert.deepEqual(errors, []);
    if (process.env.WIFIMETER_SCREENSHOT) await page.screenshot({ path: process.env.WIFIMETER_SCREENSHOT });
    console.log('PASS: Windows WebView2 pages, collection pause/resume, exact counters, legacy status and preference events');
} finally {
    if (child.exitCode === null) {
        await page?.evaluate(() => window.desktop?.windowPreferences.update({ closeAction: 'exit' })).catch(() => {});
        const close = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${child.pid}).CloseMainWindow() | Out-Null`], { stdio: 'ignore' });
        await once(close, 'exit');
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
