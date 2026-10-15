import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { chromium, expect } from '@playwright/test';

// Exercise the release host, bundled worker, SQLite backend and real WebView2.
// Only adapter counters are fixtures. The profile and operating-system settings are isolated.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const executable = path.resolve(process.env.WIFIMETER_TAURI_EXECUTABLE || path.join(root, 'dist/windows/tauri-unpacked/WiFiMeter.exe'));
const resources = path.join(path.dirname(executable), 'resources');
const backend = path.join(resources, 'wifimeter-backend.exe');
assert.equal(process.platform, 'win32', 'This integration check requires Windows WebView2.');
assert.ok(existsSync(executable) && existsSync(backend), 'Build and extract the Tauri installer before running this check.');
const outputRoot = path.join(root, 'build/tauri-smoke');
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(path.join(outputRoot, 'run-'));
const profile = path.join(output, 'profile');
process.env.WIFIMETER_BACKEND = backend;
const { createHarness } = await import('./support/backend-harness.mjs');
const fixture = await createHarness();
cpSync(fixture.directory, profile, { recursive: true });
fixture.cleanup();
writeFileSync(path.join(profile, 'update-preferences.json'), JSON.stringify({ checkOnStartup: false }));
writeFileSync(path.join(profile, 'window-preferences.json'), JSON.stringify({ closeAction: 'exit', theme: 'light', promptAppCollection: false }));

const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const endpoint = `http://127.0.0.1:${port}`;
const env = {
    ...process.env,
    WIFIMETER_USER_DATA: profile,
    WIFIMETER_TEST_HOME: profile,
    WIFIMETER_TEST_ISOLATION: '1',
    WIFIMETER_BACKGROUND_TEST: '1',
    WIFIMETER_SOFTWARE_RENDERING: '1',
    WIFIMETER_TAURI_TEST_PORT: String(port),
    WIFIMETER_FAKE_ADAPTER: path.join(profile, 'adapters.json'),
    WIFIMETER_FAKE_COUNTERS: path.join(profile, 'counters.json'),
    WIFIMETER_FAKE_APPS: path.join(profile, 'apps.json')
};
for (const key of ['ELECTRON_RUN_AS_NODE', 'WIFIMETER_BACKEND', 'WIFIMETER_RESOURCES_PATH', 'WIFIMETER_NODE', 'WEBVIEW2_USER_DATA_FOLDER', 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS']) delete env[key];
const startedAt = new Date().toISOString();
const child = spawn(executable, [], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let diagnostic = '', launchError, browser, exited = false;
let lastCdpRequest = null, cdpRequests = 0;
const readiness = { endpointReadyAt: null, targetsBeforeAttach: null, targetQueryError: null,
    connectedAt: null, pagesAtFailure: [], nativeEvents: [] };
child.on('error', error => { launchError = error; });
child.on('exit', () => { exited = true; });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    diagnostic += chunk;
    for (const line of String(chunk).split(/\r?\n/)) {
        if (line.includes('[startup]')) readiness.nativeEvents.push({ receivedAt: new Date().toISOString(), message: line });
    }
});
const errors = [], checks = [];
const check = message => { checks.push(message); console.log(`PASS ${message}`); };
const watch = page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
};
const request = (page, method, params = {}) => page.evaluate(async ({ method, params }) => {
    const response = await window.desktop.backend.request(method, params);
    if (!response.ok) throw Error(response.error?.message || `${method} failed`);
    return response.result;
}, { method, params });

async function runPowerShell(script) {
    const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const { stdout } = await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 20000, encoding: 'utf8' });
    return stdout;
}

const errorDetails = error => ({
    message: error instanceof Error ? error.message : String(error),
    code: error?.code ?? null,
    causeCode: error?.cause?.code ?? null
});

function testProcessTreeScript() {
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, 'Test host PID is unavailable.');
    return `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$hostProcessId = ${child.pid}
$processRecords = New-Object 'Collections.Generic.List[object]'
$collectionErrors = New-Object 'Collections.Generic.List[object]'
$pending = New-Object 'Collections.Generic.Queue[uint32]'
$visited = New-Object 'Collections.Generic.HashSet[uint32]'
$properties = @('ProcessId', 'ParentProcessId', 'Name', 'CommandLine', 'SessionId')
try {
    foreach ($record in @(Get-CimInstance Win32_Process -Filter "ProcessId = $hostProcessId" -Property $properties)) { $processRecords.Add($record) }
} catch { $collectionErrors.Add([pscustomobject]@{ stage='hostProcess'; processId=$hostProcessId; message=$_.Exception.Message }) }
$null = $visited.Add($hostProcessId)
$pending.Enqueue($hostProcessId)
while ($pending.Count -gt 0) {
    $parentProcessId = $pending.Dequeue()
    try {
        foreach ($record in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentProcessId" -Property $properties)) {
            if ($visited.Add($record.ProcessId)) { $processRecords.Add($record); $pending.Enqueue($record.ProcessId) }
        }
    } catch { $collectionErrors.Add([pscustomobject]@{ stage='descendants'; processId=$parentProcessId; message=$_.Exception.Message }) }
}
$testProcesses = @($processRecords | Select-Object ProcessId, ParentProcessId, Name, CommandLine, SessionId)`;
}

async function workerProcesses() {
    const result = await runPowerShell(`${testProcessTreeScript()}
if ($collectionErrors.Count) { throw ($collectionErrors | ConvertTo-Json -Compress) }
ConvertTo-Json -InputObject @($testProcesses | Where-Object { $_.Name -in @('node.exe', 'wifimeter-backend.exe') } | Select-Object ProcessId, Name) -Compress`);
    return JSON.parse(result);
}

async function writeStartupDiagnostics(error) {
    readiness.pagesAtFailure = browser?.contexts().flatMap(context => context.pages()).map(page => ({ url: page.url(), closed: page.isClosed() })) ?? [];
    const environmentValue = name => {
        const key = Object.keys(env).find(key => key.toUpperCase() === name);
        return key === undefined ? null : env[key] ?? null;
    };
    const details = {
        startedAt, capturedAt: new Date().toISOString(), executable,
        failure: errorDetails(error),
        host: { pid: child.pid ?? null, exited, exitCode: child.exitCode, signalCode: child.signalCode },
        cdp: { endpoint, requests: cdpRequests, lastRequest: lastCdpRequest, readiness },
        webview2Environment: Object.fromEntries([
            'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', 'WEBVIEW2_BROWSER_EXECUTABLE_FOLDER',
            'WEBVIEW2_RELEASE_CHANNEL_PREFERENCE', 'WEBVIEW2_USER_DATA_FOLDER'
        ].map(name => [name, environmentValue(name)])),
        proxyEnvironmentSet: Object.fromEntries(['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']
            .map(name => [name, environmentValue(name) !== null]))
    };
    try {
        const result = await runPowerShell(`${testProcessTreeScript()}
$diagnosticContext = $null
try {
    $diagnosticProcess = [Diagnostics.Process]::GetCurrentProcess()
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        try {
            $principal = [Security.Principal.WindowsPrincipal]::new($identity)
            $diagnosticContext = [pscustomobject]@{ ProcessId=$diagnosticProcess.Id; SessionId=$diagnosticProcess.SessionId;
                IsAdministrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
        } finally { $identity.Dispose() }
    } finally { $diagnosticProcess.Dispose() }
} catch { $collectionErrors.Add([pscustomobject]@{ stage='diagnosticContext'; message=$_.Exception.Message }) }
$cdpListeners = @()
$descendantListeners = @()
try {
    $cdpListeners = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter 'State = 2 AND LocalPort = ${port}' |
        Select-Object LocalAddress, LocalPort, OwningProcess, State)
} catch { $collectionErrors.Add([pscustomobject]@{ stage='cdpListeners'; message=$_.Exception.Message }) }
$descendantIds = @($testProcesses | Where-Object { $_.ProcessId -ne $hostProcessId } | ForEach-Object { $_.ProcessId })
if ($descendantIds.Count -gt 0) {
    $ownerFilter = ($descendantIds | ForEach-Object { "OwningProcess = $_" }) -join ' OR '
    try {
        $descendantListeners = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter "State = 2 AND ($ownerFilter)" |
            Select-Object LocalAddress, LocalPort, OwningProcess, State)
    } catch { $collectionErrors.Add([pscustomobject]@{ stage='descendantListeners'; message=$_.Exception.Message }) }
}
$hostWindow = $null
try {
    $nativeHost = Get-Process -Id $hostProcessId
    try {
        $nativeHost.Refresh()
        $hostWindow = [pscustomobject]@{ ProcessId=$nativeHost.Id; MainWindowHandle=$nativeHost.MainWindowHandle.ToInt64(); Responding=$nativeHost.Responding }
    } finally { $nativeHost.Dispose() }
} catch { $collectionErrors.Add([pscustomobject]@{ stage='hostWindow'; message=$_.Exception.Message }) }
[pscustomobject]@{ processes=@($testProcesses); cdpListeners=@($cdpListeners); descendantListeners=@($descendantListeners);
    hostWindow=$hostWindow; diagnosticContext=$diagnosticContext; errors=@($collectionErrors.ToArray()) } | ConvertTo-Json -Depth 6 -Compress`);
        details.windows = JSON.parse(result);
    } catch (diagnosticError) {
        details.collectionError = errorDetails(diagnosticError);
    }
    writeFileSync(path.join(output, 'startup-diagnostics.json'), JSON.stringify(details, null, 2));
}

function processIsAlive(id) {
    try { process.kill(id, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

const totalReceived = rows => rows.reduce((sum, row) => sum + BigInt(row.rxBytes), 0n);

async function closeNativeWindow() {
    // Send the ordinary close event only to the captioned window owned by this test process.
    // This validates save-before-exit through the same path as the title-bar close button.
    const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MeterSmokeWindow {
  public delegate bool Callback(IntPtr handle, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint id);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr handle, int index);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wparam, IntPtr lparam);
  public static bool Close(uint expected) {
    bool found = false;
    EnumWindows((handle, data) => {
      uint owner; GetWindowThreadProcessId(handle, out owner);
      if (owner != expected || (GetWindowLong(handle, -16) & 0x00C00000) == 0) return true;
      found = PostMessage(handle, 0x0010, IntPtr.Zero, IntPtr.Zero);
      return !found;
    }, IntPtr.Zero);
    return found;
  }
}
'@
if (-not [MeterSmokeWindow]::Close(${child.pid})) { throw 'No test main window found' }`;
    await runPowerShell(script);
}

try {
    await expect.poll(async () => {
        if (launchError) throw launchError;
        if (exited) throw Error(`Tauri exited during startup: ${diagnostic}`);
        const attemptedAt = new Date().toISOString();
        cdpRequests++;
        try {
            const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(3000) });
            lastCdpRequest = { attemptedAt, status: response.status, statusText: response.statusText };
            if (response.ok) readiness.endpointReadyAt = new Date().toISOString();
            return response.ok;
        } catch (error) {
            lastCdpRequest = { attemptedAt, error: errorDetails(error) };
            return false;
        }
    }, { timeout: 45000, message: 'WebView2 debugging endpoint must start' }).toBe(true);
    // Preserve the initial targets before Playwright attaches, so a failed native
    // window creation can be distinguished from a page that never navigated.
    try {
        const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(3000) });
        assert.ok(response.ok, `WebView2 target discovery returned ${response.status}`);
        readiness.targetsBeforeAttach = (await response.json()).map(({ id, type, url }) => ({ id, type, url }));
    } catch (error) { readiness.targetQueryError = errorDetails(error); }
    browser = await chromium.connectOverCDP(endpoint);
    readiness.connectedAt = new Date().toISOString();
    const context = browser.contexts()[0];
    context.pages().forEach(watch);
    context.on('page', watch);
    await expect.poll(() => context.pages().some(page => page.url().endsWith('/main/index.html')), { timeout: 30000 }).toBe(true);
    const page = context.pages().find(page => page.url().endsWith('/main/index.html'));
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi', { timeout: 30000 });
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => window.desktop.platform), 'win32');
    const startupSnapshot = await request(page, 'snapshot');
    assert.ok(startupSnapshot.networks.length);
    assert.equal(startupSnapshot.appCollection.enabled, false);
    assert.equal((await page.evaluate(() => window.desktop.windowPreferences.read())).promptAppCollection, false);
    check('Packaged Tauri page and bundled backend connect without a backend path override');

    const rejection = await page.evaluate(() => window.__TAURI__.core.invoke('desktop_request', { channel: 'shell:open', args: [] }).then(() => false, () => true));
    assert.equal(rejection, true);
    for (const name of ['networks', 'apps', 'history', 'settings', 'overview']) {
        await page.locator(`.nav [data-page="${name}"]`).click();
        await expect(page.locator('html')).toHaveAttribute('data-page', name);
    }
    check('All five pages load and unrecognized native channels are rejected');

    await request(page, 'setAppCollection', { enabled: true });
    await request(page, 'collectNow');
    const applicationFixture = JSON.parse(readFileSync(env.WIFIMETER_FAKE_APPS, 'utf8'));
    applicationFixture.samples[0].rxBytes = '64000';
    applicationFixture.samples[0].txBytes = '16000';
    writeFileSync(env.WIFIMETER_FAKE_APPS, JSON.stringify(applicationFixture));
    await request(page, 'collectNow');
    await page.evaluate(() => window.desktop.windowPreferences.update({ miniWindow: true, miniExpanded: true, miniRange: '5m', miniAutoHide: false, miniSnap: false }));
    await expect.poll(() => context.pages().some(item => item.url().endsWith('/mini/index.html')), { timeout: 30000 }).toBe(true);
    let mini = context.pages().find(item => item.url().endsWith('/mini/index.html'));
    await expect(mini.locator('#appsPanel')).toBeVisible();
    await expect(mini.locator('#appRows')).toContainText('浏览器', { timeout: 15000 });
    await expect(mini.locator('#appRows tr')).toHaveCount(1);
    const applicationState = await mini.evaluate(() => window.miniDesktop.applications());
    assert.equal(applicationState.rows[0].rxBytes, '64000');
    assert.equal(applicationState.rows[0].txBytes, '16000');
    assert.equal(await mini.evaluate(() => window.__TAURI__.core.invoke('desktop_request', { channel: 'backend:request', args: [{ method: 'snapshot' }] }).then(() => false, () => true)), true);
    check('Floating application list uses actual minute records and cannot invoke main-window channels');

    for (const [value, minutes] of [['1m', 1], ['5m', 5], ['1h', 60]]) {
        await mini.locator('#range').selectOption(value);
        await expect.poll(async () => (await mini.evaluate(() => window.miniDesktop.applications())).range.minutes).toBe(minutes);
    }
    await mini.locator('#range').selectOption('custom');
    await mini.locator('#customMinutes').fill('17');
    await mini.locator('#customMinutes').press('Tab');
    await expect.poll(async () => (await mini.evaluate(() => window.miniDesktop.preferences.read())).miniCustomMinutes).toBe(17);
    await mini.locator('#customMinutes').fill('0');
    await mini.locator('#customMinutes').press('Tab');
    assert.equal(await mini.locator('#customMinutes').evaluate(element => element.checkValidity()), false);
    assert.equal((await mini.evaluate(() => window.miniDesktop.preferences.read())).miniCustomMinutes, 17);
    await mini.locator('#customMinutes').fill('17');
    await mini.locator('#customMinutes').press('Tab');
    await mini.locator('#apps').click();
    await expect(mini.locator('#appsPanel')).toBeHidden();
    await mini.locator('#apps').click();
    await expect(mini.locator('#appsPanel')).toBeVisible();
    assert.equal(await mini.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await mini.screenshot({ path: path.join(output, 'floating-applications.png') });
    check('Floating periods, validation, collapse and reopen work in WebView2');

    await mini.locator('#close').click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop.windowPreferences.read())).miniWindow).toBe(false);
    await page.evaluate(() => window.desktop.windowPreferences.update({ miniWindow: true }));
    await expect.poll(() => context.pages().some(item => !item.isClosed() && item.url().endsWith('/mini/index.html'))).toBe(true);
    mini = context.pages().find(item => !item.isClosed() && item.url().endsWith('/mini/index.html'));
    await expect(mini.locator('#range')).toHaveValue('custom');
    await expect(mini.locator('#customMinutes')).toHaveValue('17');
    await page.evaluate(() => window.desktop.windowPreferences.update({ miniWindow: false }));
    check('Floating preferences persist across native window destruction and recreation');

    await request(page, 'setPaused', { paused: true });
    const { backup } = await request(page, 'backup');
    assert.ok(backup.minuteRecords.length > 0 && backup.appMinuteRecords.length > 0);
    await request(page, 'clearUsage');
    const cleared = await request(page, 'snapshot', { includeMinutes: true });
    assert.equal(cleared.minuteRecords.length, 0);
    assert.equal(cleared.appMinuteRecords.length, 0);
    await request(page, 'restore', { backup });
    const restored = await request(page, 'snapshot', { includeMinutes: true });
    assert.equal(totalReceived(restored.minuteRecords), BigInt(fixture.seedRx));
    assert.equal(totalReceived(restored.appMinuteRecords), 64000n);
    await page.reload();
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
    await page.screenshot({ path: path.join(output, 'overview-light.png'), fullPage: true });
    await page.evaluate(() => window.desktop.windowPreferences.update({ theme: 'dark' }));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: path.join(output, 'overview-dark.png'), fullPage: true });
    check('Minute backup and restore, page reload and theme changes preserve the data');

    await request(page, 'setPaused', { paused: false });
    await request(page, 'collectNow');
    applicationFixture.samples[0].rxBytes = '96000';
    applicationFixture.samples[0].txBytes = '24000';
    writeFileSync(env.WIFIMETER_FAKE_APPS, JSON.stringify(applicationFixture));
    await request(page, 'collectNow');
    assert.equal(totalReceived((await request(page, 'snapshot', { includeMinutes: true })).appMinuteRecords), 96000n);
    const workers = await workerProcesses();
    assert.deepEqual(workers.map(worker => worker.Name).sort(), ['node.exe', 'wifimeter-backend.exe']);
    await page.evaluate(() => window.desktop.windowPreferences.update({ closeAction: 'exit' }));
    await closeNativeWindow();
    await expect.poll(() => exited, { timeout: 20000, message: 'Native close must flush the backend and stop the desktop host' }).toBe(true);
    assert.equal(child.exitCode, 0, diagnostic);
    await expect.poll(() => workers.filter(worker => processIsAlive(worker.ProcessId)), { timeout: 15000, message: 'Bundled worker and backend must exit with the native host' }).toEqual([]);
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(path.join(profile, 'wifimeter.db'), { readOnly: true });
    try { assert.equal(database.prepare('SELECT SUM(rx_bytes) AS bytes FROM app_minute_usage').get().bytes, 96000); }
    finally { database.close(); }
    check('Ordinary native close stops the active worker and backend and preserves the latest minute data');
    assert.deepEqual(errors, [], `WebView errors: ${errors.join('\n')}`);
    writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, executable, checks }, null, 2));
    console.log(`Tauri integration passed: ${checks.length} checks. Evidence: ${output}`);
} catch (error) {
    let diagnosticError = null;
    try { await writeStartupDiagnostics(error); }
    catch (failure) { diagnosticError = errorDetails(failure); }
    const details = [
        error instanceof Error ? error.message : String(error),
        `Host process: ${JSON.stringify({ pid: child.pid ?? null, exited, exitCode: child.exitCode, signalCode: child.signalCode })}`,
        `Last CDP request: ${JSON.stringify(lastCdpRequest)}`,
        `Startup diagnostics: ${path.join(output, 'startup-diagnostics.json')}`,
        ...(diagnosticError ? [`Startup diagnostics could not be saved: ${JSON.stringify(diagnosticError)}`] : []),
        `Host log: ${path.join(output, 'host.log')}`,
        `Host output (last 16384 characters):\n${diagnostic.slice(-16384) || '(no host output)'}`
    ].join('\n');
    throw new Error(details, { cause: error });
} finally {
    try { writeFileSync(path.join(output, 'host.log'), diagnostic); }
    catch (error) { console.error(`Host log could not be saved: ${JSON.stringify(errorDetails(error))}`); }
    if (browser) await browser.close().catch(() => {});
    if (!exited && child.pid) child.kill();
}
