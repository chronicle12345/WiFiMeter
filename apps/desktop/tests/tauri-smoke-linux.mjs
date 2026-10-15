import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// Drive the installed release binary through the native WebKitGTK WebDriver.
// The adapter counters are fixtures; the native host, worker and SQLite backend are real.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
assert.equal(process.platform, 'linux', 'This integration check requires Linux WebKitGTK.');
assert.ok(process.env.DISPLAY && process.env.DBUS_SESSION_BUS_ADDRESS, 'Run this check under xvfb-run and dbus-run-session.');
const executable = path.resolve(process.env.WIFIMETER_TAURI_EXECUTABLE || path.join(root, 'dist/linux/tauri-unpacked/wifimeter'));
const launcher = path.resolve(process.env.WIFIMETER_TAURI_LAUNCHER || executable);
const resources = path.resolve(process.env.WIFIMETER_TAURI_RESOURCES || path.join(path.dirname(executable), 'resources'));
const backend = path.join(resources, 'wifimeter-backend');
assert.ok(existsSync(executable) && existsSync(launcher) && existsSync(backend), 'Build and extract the Tauri Linux package before running this check.');
const outputRoot = path.join(root, 'build/tauri-smoke-linux');
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(path.join(outputRoot, 'run-'));
const profile = path.join(output, 'profile');
process.env.WIFIMETER_BACKEND = backend;
const { createHarness } = await import('./support/backend-harness.mjs');
const fixture = await createHarness();
cpSync(fixture.directory, profile, { recursive: true });
fixture.cleanup();
writeFileSync(path.join(profile, 'update-preferences.json'), JSON.stringify({ checkOnStartup: false }));
// WebDriver needs a visible window, so background-test dialog substitutes are disabled.
// Suppress startup questions in this isolated profile before exercising native collection manually.
writeFileSync(path.join(profile, 'window-preferences.json'), JSON.stringify({ closeAction: 'exit', theme: 'light', promptAppCollection: false }));

async function availablePort() {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

const port = await availablePort();
let nativePort = await availablePort();
while (nativePort === port) nativePort = await availablePort();
const endpoint = `http://127.0.0.1:${port}`;
const env = {
    ...process.env,
    WIFIMETER_USER_DATA: profile, WIFIMETER_TEST_HOME: profile,
    WIFIMETER_TEST_ISOLATION: '1', WIFIMETER_BACKGROUND_TEST: '0',
    WIFIMETER_SOFTWARE_RENDERING: '1', TAURI_WEBVIEW_AUTOMATION: 'true',
    LIBGL_ALWAYS_SOFTWARE: '1', WEBKIT_DISABLE_COMPOSITING_MODE: '1',
    WIFIMETER_FAKE_ADAPTER: path.join(profile, 'adapters.json'),
    WIFIMETER_FAKE_COUNTERS: path.join(profile, 'counters.json'),
    WIFIMETER_FAKE_APPS: path.join(profile, 'apps.json')
};
for (const key of ['ELECTRON_RUN_AS_NODE', 'WIFIMETER_BACKEND', 'WIFIMETER_RESOURCES_PATH', 'WIFIMETER_NODE', 'WIFIMETER_TAURI_TEST_PORT', 'APPDIR', 'APPIMAGE']) delete env[key];
let diagnostic = '', session, driver, windowManager, failure, hostPid;
const checks = [];
const check = message => { checks.push(message); console.log(`PASS ${message}`); };

function start(command, args) {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', error => { failure = error; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostic += chunk; });
    return child;
}

async function poll(callback, { timeout = 30000, message = 'Native integration condition was not met' } = {}) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
        if (failure) throw failure;
        try { if (await callback()) return; }
        catch (error) { lastError = error; }
        await delay(250);
    }
    throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function http(method, route, data, timeout = 35000) {
    const response = await fetch(endpoint + route, {
        method, ...(data ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {}),
        signal: AbortSignal.timeout(timeout)
    });
    const result = await response.json();
    assert.ok(response.ok && !result.value?.error, `WebDriver ${method} ${route}: ${JSON.stringify(result)}`);
    return result.value;
}

const command = (method, route, data) => http(method, `/session/${session}${route}`, data);
const evaluate = async (fn, ...args) => {
    const reply = await command('POST', '/execute/async', {
        script: `const done = arguments[arguments.length - 1];
Promise.resolve().then(() => (${fn.toString()})(...Array.from(arguments).slice(0, -1)))
    .then(value => done({ ok: true, value: value === undefined ? null : value }),
        error => done({ ok: false, error: error.message || String(error) }));`, args
    });
    assert.ok(reply?.ok, `WebKitGTK page evaluation failed: ${reply?.error}`);
    return reply.value;
};
const request = (method, params = {}) => evaluate(async (method, params) => {
    const response = await window.desktop.backend.request(method, params);
    if (!response.ok) throw new Error(response.error?.message || `${method} failed`);
    return response.result;
}, method, params);

async function selectWindow(page) {
    const handles = await command('GET', '/window/handles');
    for (const handle of handles) {
        await command('POST', '/window', { handle });
        if (await evaluate(page => location.pathname.endsWith(`/${page}/index.html`), page)) return handle;
    }
    return null;
}

async function screenshot(name) {
    writeFileSync(path.join(output, name), Buffer.from(await command('GET', '/screenshot'), 'base64'));
}

function processes() {
    return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
        try {
            const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            return [{ pid: Number(name), parent: Number(fields[1]), state: fields[0], executable: readlinkSync(`/proc/${name}/exe`) }];
        } catch (error) { if (['ENOENT', 'EACCES', 'ESRCH'].includes(error.code)) return []; throw error; }
    });
}

function descendants(records, parent) {
    const selected = new Set([parent]);
    let previous = 0;
    while (previous !== selected.size) {
        previous = selected.size;
        for (const record of records) if (selected.has(record.parent)) selected.add(record.pid);
    }
    return records.filter(record => record.pid !== parent && selected.has(record.pid));
}

function alive(pid) {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return false; throw error; }
}

async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const deadline = Date.now() + 3000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

const totalReceived = rows => rows.reduce((sum, row) => sum + BigInt(row.rxBytes), 0n);

try {
    windowManager = start('openbox', []);
    await poll(() => execFileSync('wmctrl', ['-m'], { env, encoding: 'utf8' }).includes('Openbox'), { message: 'Openbox must manage the Xvfb display' });
    driver = start(process.env.WIFIMETER_TAURI_DRIVER || 'tauri-driver', ['--port', String(port), '--native-port', String(nativePort)]);
    await poll(() => http('GET', '/status', undefined, 3000).then(status => status.ready), { message: 'Tauri WebDriver must start' });
    const created = await http('POST', '/session', { capabilities: {
        alwaysMatch: { browserName: 'wry', 'tauri:options': { application: launcher } }, firstMatch: [{}]
    } }, 60000);
    session = created.sessionId;
    assert.ok(session, 'Tauri WebDriver did not create a native browser session.');
    await command('POST', '/timeouts', { script: 30000, pageLoad: 30000, implicit: 0 });
    await poll(() => selectWindow('main'), { message: 'Packaged native main page must load' });
    await poll(() => evaluate(() => document.querySelector('.connection-title')?.textContent.includes('家里的 Wi-Fi')), { message: 'Packaged backend and page must display the seeded network' });
    await evaluate(() => {
        window.__smokeErrors = [];
        window.addEventListener('error', event => window.__smokeErrors.push(event.message));
        window.addEventListener('unhandledrejection', event => window.__smokeErrors.push(String(event.reason)));
    });
    assert.equal(await evaluate(() => typeof window.require), 'undefined');
    assert.equal(await evaluate(() => window.desktop.platform), 'linux');
    const startupSnapshot = await request('snapshot');
    assert.ok(startupSnapshot.networks.length);
    assert.equal(startupSnapshot.appCollection.enabled, false);
    assert.equal((await evaluate(() => window.desktop.windowPreferences.read())).promptAppCollection, false);
    await poll(() => {
        const records = descendants(processes(), driver.pid);
        hostPid = records.find(record => record.executable === realpathSync(executable))?.pid;
        return hostPid;
    }, { message: 'The WebDriver must launch the extracted package executable' });
    check('Packaged WebKitGTK page and bundled backend connect without a backend or resource path override');

    assert.equal(await evaluate(() => window.__TAURI__.core.invoke('desktop_request', { channel: 'shell:open', args: [] }).then(() => false, () => true)), true);
    for (const name of ['networks', 'apps', 'history', 'settings', 'overview']) {
        await evaluate(name => document.querySelector(`.nav [data-page="${name}"]`).click(), name);
        await poll(() => evaluate(name => document.documentElement.dataset.page === name, name));
    }
    check('All five native pages load and unrecognized native channels are rejected');

    await request('setAppCollection', { enabled: true });
    await request('collectNow');
    const applicationFixture = JSON.parse(readFileSync(env.WIFIMETER_FAKE_APPS, 'utf8'));
    applicationFixture.samples[0].rxBytes = '64000';
    applicationFixture.samples[0].txBytes = '16000';
    writeFileSync(env.WIFIMETER_FAKE_APPS, JSON.stringify(applicationFixture));
    await request('collectNow');
    const applicationState = await request('snapshot', { includeMinutes: true });
    const applicationRows = applicationState.appMinuteRecords.filter(row => row.appId === applicationFixture.samples[0].appId);
    assert.ok(applicationRows.length && applicationRows.every(row => row.name === '浏览器'));
    assert.equal(totalReceived(applicationRows), 64000n);
    assert.equal(applicationRows.reduce((sum, row) => sum + BigInt(row.txBytes), 0n), 16000n);
    const applicationQuery = await request('snapshot', { includeMinutes: true,
        networkKey: applicationRows[0].networkId, from: applicationRows[0].date, to: applicationRows.at(-1).date });
    assert.equal(totalReceived(applicationQuery.appMinuteRecords), 64000n);
    check('Independent application minute queries return the collected upload and download data');

    // Floating windows are a Windows product feature. Linux must preserve preferences
    // without creating an unsupported native window, including after page reload.
    const windowPreferences = await evaluate(() => window.desktop.windowPreferences.update({
        miniWindow: true, miniExpanded: true, miniRange: 'custom', miniCustomMinutes: 17,
        miniAutoHide: false, miniSnap: false
    }));
    assert.equal(windowPreferences.miniWindow, true);
    assert.deepEqual(JSON.parse(readFileSync(path.join(profile, 'window-preferences.json'), 'utf8')), windowPreferences);
    await delay(500);
    assert.equal(await selectWindow('mini'), null, 'Linux must not create the Windows-only floating window');
    assert.equal((await command('GET', '/window/handles')).length, 1);
    assert.equal(execFileSync('wmctrl', ['-lp'], { env, encoding: 'utf8' }).trim().split('\n')
        .filter(line => Number(line.trim().split(/\s+/)[2]) === hostPid).length, 1);
    await selectWindow('main');

    await request('setPaused', { paused: true });
    const { backup } = await request('backup');
    assert.ok(backup.minuteRecords.length > 0 && backup.appMinuteRecords.length > 0);
    await request('clearUsage');
    const cleared = await request('snapshot', { includeMinutes: true });
    assert.equal(cleared.minuteRecords.length, 0);
    assert.equal(cleared.appMinuteRecords.length, 0);
    await request('restore', { backup });
    const restored = await request('snapshot', { includeMinutes: true });
    assert.equal(totalReceived(restored.minuteRecords), BigInt(fixture.seedRx));
    assert.equal(totalReceived(restored.appMinuteRecords), 64000n);
    assert.deepEqual(await evaluate(() => window.__smokeErrors), []);
    await command('POST', '/refresh', {});
    await poll(() => evaluate(() => document.querySelector('.connection-title')?.textContent.includes('家里的 Wi-Fi')));
    assert.deepEqual(await evaluate(() => window.desktop.windowPreferences.read()), windowPreferences);
    assert.equal(await selectWindow('mini'), null);
    await selectWindow('main');
    await evaluate(() => window.desktop.windowPreferences.update({ miniWindow: false }));
    check('Linux preserves window preferences across reload without creating a Windows-only floating window');
    await screenshot('overview-light.png');
    await evaluate(() => window.desktop.windowPreferences.update({ theme: 'dark' }));
    await poll(() => evaluate(() => document.documentElement.dataset.theme === 'dark'));
    await screenshot('overview-dark.png');
    check('Native backup, restore, reload and theme changes preserve the minute data');

    await request('setPaused', { paused: false });
    await request('collectNow');
    applicationFixture.samples[0].rxBytes = '96000';
    applicationFixture.samples[0].txBytes = '24000';
    writeFileSync(env.WIFIMETER_FAKE_APPS, JSON.stringify(applicationFixture));
    await request('collectNow');
    assert.equal(totalReceived((await request('snapshot', { includeMinutes: true })).appMinuteRecords), 96000n);
    const workers = descendants(processes(), hostPid).filter(record => [realpathSync(path.join(resources, 'runtime/node')), realpathSync(backend)].includes(record.executable));
    assert.deepEqual(workers.map(record => path.basename(record.executable)).sort(), ['node', 'wifimeter-backend']);
    await evaluate(() => window.desktop.windowPreferences.update({ closeAction: 'exit' }));
    const windows = execFileSync('wmctrl', ['-lp'], { env, encoding: 'utf8' }).trim().split('\n');
    const nativeWindow = windows.map(line => line.trim().split(/\s+/)).find(fields => Number(fields[2]) === hostPid);
    assert.ok(nativeWindow, 'No captioned native test window was found.');
    execFileSync('wmctrl', ['-ic', nativeWindow[0]], { env });
    await poll(() => !alive(hostPid), { timeout: 20000, message: 'Ordinary native close must flush and stop the Tauri host' });
    await poll(() => workers.every(worker => !alive(worker.pid)), { timeout: 15000, message: 'Bundled worker and backend must exit with the native host' });
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(path.join(profile, 'wifimeter.db'), { readOnly: true });
    try { assert.equal(database.prepare('SELECT SUM(rx_bytes) AS bytes FROM app_minute_usage').get().bytes, 96000); }
    finally { database.close(); }
    check('Ordinary native close stops both workers and preserves the latest SQLite minute data');
    writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, executable, launcher, checks }, null, 2));
    console.log(`Linux Tauri integration passed: ${checks.length} checks. Evidence: ${output}`);
} catch (error) {
    writeFileSync(path.join(output, 'startup-diagnostics.json'), JSON.stringify({ executable, launcher, endpoint,
        driver: { pid: driver?.pid, exitCode: driver?.exitCode, signalCode: driver?.signalCode }, hostPid,
        error: { message: error.message, code: error.code }, processes: processes() }, null, 2));
    throw new Error(`${error.message}\nEvidence: ${output}\nHost output (last 16384 characters):\n${diagnostic.slice(-16384)}`, { cause: error });
} finally {
    writeFileSync(path.join(output, 'host.log'), diagnostic);
    const cleanupProcesses = driver?.pid ? descendants(processes(), driver.pid) : [];
    if (session && driver?.exitCode === null) await command('DELETE', '').catch(() => {});
    // A failed assertion must not leave a native host or its worker processes behind.
    for (const record of cleanupProcesses.reverse()) {
        try { process.kill(record.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') console.error(error); }
    }
    await stop(driver);
    await stop(windowManager);
}
