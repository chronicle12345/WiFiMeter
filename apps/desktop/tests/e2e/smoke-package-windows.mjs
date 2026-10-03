// 在 Windows 上启动实际发布目录，清除后端路径覆盖，验证随包资源与 Release 前端。
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { rm, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createHarness } from '../support/backend-harness.mjs';

assert.equal(process.platform, 'win32');
assert.ok(process.env.WIFIMETER_EXECUTABLE, 'Set WIFIMETER_EXECUTABLE to the packaged executable');
const harness = await createHarness();
const server = createServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const env = { ...process.env, ...harness.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` };
delete env.WIFIMETER_BACKEND;
const child = spawn(process.env.WIFIMETER_EXECUTABLE, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = once(child, 'exit');
let browser, page, log = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; });
const execute = promisify(execFile);
async function metrics() {
    const script = `
        $all = @(Get-CimInstance Win32_Process)
        $byId = @{}
        foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
        $ids = @(${child.pid})
        do {
            $before = $ids.Count
            $ids += @($all | Where-Object {
                $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId -and
                $_.CreationDate -ge $byId[[int]$_.ParentProcessId].CreationDate
            } | ForEach-Object { [int]$_.ProcessId })
        } while ($ids.Count -gt $before)
        @($all | Where-Object { $ids -contains $_.ProcessId } | ForEach-Object {
            $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            if ($p) { @{ name=$_.Name; pid=$_.ProcessId; parent=$_.ParentProcessId; executable=$_.ExecutablePath; workingSetBytes=$p.WorkingSet64; privateBytes=$p.PrivateMemorySize64 } }
        }) | ConvertTo-Json -Depth 3 -Compress
    `;
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    const processes = JSON.parse(stdout);
    assert.ok(processes.some(process => process.name === 'wifimeter-backend.exe'), '随包后端必须仍在运行');
    return {
        scope: 'Tauri Release + WebView2 + bundled collector; visible window, synthetic data, CDP enabled',
        workingSetMiB: processes.reduce((total, process) => total + process.workingSetBytes, 0) / 1048576,
        privateCommitMiB: processes.reduce((total, process) => total + process.privateBytes, 0) / 1048576,
        processes
    };
}

try {
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 40000;
    while (true) {
        assert.equal(child.exitCode, null, log);
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch { /* WebView2 is starting. */ }
        assert.ok(Date.now() < deadline, log || 'WebView2 startup timed out');
        await delay(100);
    }
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    page = context.pages()[0] ?? await context.waitForEvent('page');
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
    await expect(page.locator('#collector')).toContainText('正在采集');
    assert.equal((await page.evaluate(() => window.desktop.backend.request('snapshot'))).result.records[0].rxBytes, '3100000000');
    for (const name of ['networks', 'history', 'settings', 'overview']) {
        await page.locator(`.nav [data-page="${name}"]`).click();
        await expect(page.locator('#content')).not.toBeEmpty();
    }
    const notes = await page.evaluate(async () => (await import('./ui/release-notes.js')).releaseNotes('**release**<script>bad()</script>'));
    assert.match(notes, /<strong>release<\/strong>/);
    assert.ok(!notes.includes('<script>'));
    await page.getByRole('button', { name: '暂停统计', exact: true }).click();
    await expect(page.locator('#collector')).toContainText('统计已暂停');
    await page.getByRole('button', { name: '恢复统计', exact: true }).click();
    await expect(page.locator('#collector')).toContainText('正在采集');
    await delay(5000);
    const result = await metrics();
    if (process.env.WIFIMETER_METRICS) await writeFile(process.env.WIFIMETER_METRICS, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
    assert.deepEqual(errors, []);
    console.log('PASS: packaged Windows Release, bundled backend, pages, sanitized Markdown, pause/resume');
} finally {
    if (child.exitCode === null) {
        await page?.evaluate(() => window.desktop.windowPreferences.update({ closeAction: 'exit' })).catch(() => {});
        await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./test-window.ps1', import.meta.url)), '-ProcessId', String(child.pid), '-Action', 'close'], { windowsHide: true });
        if (!await Promise.race([exited.then(() => true), delay(30000, false, { ref: false })])) {
            await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']);
            throw Error(`Release application did not close gracefully: ${log}`);
        }
    }
    await browser?.close();
    await rm(harness.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
assert.equal(child.exitCode, 0, log);
