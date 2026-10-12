import test from 'node:test';
import { updatesView } from '../renderer/ui/updates.js';
import { setLanguage } from '../renderer/i18n.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { createNativeAdapter } = require('../tauri/native-adapter.cjs');
const digest = createHash('sha256').update('verified fixture').digest('hex');
const directory = fileURLToPath(new URL('../electron/', import.meta.url));

async function harness({ failure, paused = false, appsEnabled = false, updateFactory, nativeExitDecisions, prepareUpdateResult = true, missingPrepareHook = false } = {}) {
    let ready, window, backend, hooks, quitCount = 0, releaseReady;
    const handlers = new Map(), calls = [], updates = [], nativeMessages = [];
    const native = nativeExitDecisions ? createNativeAdapter({
        configuration: { userData: 'fixture' },
        send(message) {
            nativeMessages.push(message);
            if (message.type === 'quit') quitCount++;
            else if (message.type === 'native') {
                assert.ok(['app:confirmQuit', 'app:prepareUpdateQuit'].includes(message.method));
                const result = message.method === 'app:prepareUpdateQuit' ? prepareUpdateResult : nativeExitDecisions.shift();
                queueMicrotask(() => native.receive({ type: 'native-result', id: message.id, ok: true, result }));
            }
        }
    }) : null;
    const handoffReady = new Promise(resolve => { releaseReady = resolve; });
    class Window extends EventEmitter {
        constructor() { super(); window = this; this.webContents = new EventEmitter(); Object.assign(this.webContents, { mainFrame: { url: '' }, setWindowOpenHandler() {}, send(channel, value) { if (channel === 'updates:status') updates.push(value); }, session: { setPermissionRequestHandler() {} },
            ...(missingPrepareHook ? {} : { async executeJavaScript(script) { assert.equal(script, 'window.wifimeterPrepareUpdate?.()'); calls.push('prepareUpdate'); return prepareUpdateResult; } }) }); }
        isDestroyed() { return false; }
        async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    }
    class Backend extends EventEmitter {
        constructor() { super(); backend = this; this.running = true; this.paused = paused; this.appsEnabled = appsEnabled; this.shutdownPending = false; }
        start() { calls.push('start'); this.running = true; this.paused = true; this.appsEnabled = false; }
        async request(method, params) {
            if (!this.running) this.start();
            calls.push([method, params]);
            if (method === 'setPaused') this.paused = params.paused;
            if (method === 'setAppCollection') this.appsEnabled = params.enabled;
            return { paused: this.paused, appCollection: { enabled: this.appsEnabled }, settings: {} };
        }
        async stopGracefully() {
            this.shutdownPending = true;
            if (failure === 'shutdown') throw Error('shutdown timeout');
            this.running = false; this.shutdownPending = false;
        }
        async waitForShutdown() { calls.push('waitForShutdown'); if (this.shutdownPending) throw Error('still saving'); }
        async stop() { this.running = false; }
    }
    const app = native?.app || new EventEmitter();
    Object.assign(app, { isPackaged: false, getVersion: () => '1.2.0', getPath: () => 'fixture', setPath() {}, requestSingleInstanceLock: () => true,
        whenReady: () => ({ then(fn) { ready = fn(); return ready; } }) });
    if (!native) app.quit = () => { quitCount++; app.emit('before-quit', { preventDefault() {} }); };
    const imports = {
        electron: { app, BrowserWindow: Window, dialog: {}, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, Menu: { setApplicationMenu() {} } },
        'node:fs': { existsSync: () => true },
        './files.cjs': { createFileActions: () => ({}) },
        './backend.cjs': { BackendClient: Backend, resolveExecutable: () => 'fixture' },
        './system.cjs': { createSystemIntegration: () => ({ initializeTray() { calls.push('tray'); }, applySettings: async () => {}, beginQuit() {}, handleWindowClose() {}, dispose() {} }) },
        './windows-autostart.cjs': { createWindowsAutostart: () => ({}) },
        './product.cjs': { applyProductIdentity: () => ({ productName: 'fixture' }) },
        './legacy.cjs': { legacyDirectory: () => '', importLegacyDirectory: async () => ({ found: false }) },
        './window-controls.cjs': { createWindowControls: () => ({ read: async () => ({miniWindow:false,closeAction:'tray'}), update: async value => value, publishLive() {}, onMainClose() {}, dispose() {} }) },
        './app-icons.cjs': { registerAppIcons() {} },
        './app-control.cjs': { createAppControl: () => ({}) },
        './update-handoff.cjs': { launchUpdateHandoff: async () => { calls.push('handoff'); if (failure === 'handoff') throw Error('helper failed'); await handoffReady; } },
        './updates.cjs': { createUpdateService(options) { hooks = options; if (updateFactory) return updateFactory(options); return { settings: async () => ({ checkOnStartup: true }), check: async () => ({ state: 'available' }), async install() {
            calls.push('install');
            try { await options.beforeInstall(); await options.launchInstaller('verified.exe', [], { digest }); return { state: 'installing' }; }
            catch { return { state: 'error', error: 'generic installation error' }; }
        } }; } },
        'node:child_process': { spawn() { throw Error('unexpected old helper path'); } }
    };
    runInNewContext(fs.readFileSync(path.join(directory, 'main.cjs'), 'utf8'), {
        require: name => imports[name] || require(name), __dirname: directory, Buffer, console,
        process: { platform: 'win32', arch: 'x64', pid: 42, env: { WIFIMETER_USER_DATA: 'fixture' }, resourcesPath: 'fixture' }
    });
    await ready; await new Promise(setImmediate); assert.equal(calls.filter(call => call === 'tray').length, 1); backend.paused = paused; backend.appsEnabled = appsEnabled; calls.length = 0;
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    return { app, backend, calls, hooks, updates, nativeMessages, releaseReady, get quitCount() { return quitCount; }, invoke: (name, payload) => handlers.get(name)(event, payload) };
}

for (const paused of [false, true]) test(`handoff failure restores original paused=${paused}`, async () => {
    const h = await harness({ failure: 'handoff', paused });
    assert.equal((await h.invoke('updates:install')).state, 'error');
    assert.equal(h.backend.paused, paused);
    assert.equal(h.backend.running, true);
    assert.equal(h.quitCount, 0);
    assert.equal((await h.invoke('backend:request', { method: 'hello' })).ok, true);
});
test('shutdown still pending keeps protection and gives an explicit recovery failure', async () => {
    const h = await harness({ failure: 'shutdown' });
    const result = await h.invoke('updates:install');
    assert.match(result.error, /恢复失败/);
    assert.equal(result.recoveryRequired, true);
    assert.equal(result.busy, false);
    assert.match(updatesView(result), /data-action="install-update"[^>]*>恢复采集<\/button>/);
    assert.equal((await h.invoke('updates:status')).recoveryRequired, true);
    assert.equal((await h.invoke('updates:check')).recoveryRequired, true);
    assert.equal(h.calls.includes('start'), false);
    assert.equal((await h.invoke('backend:request', { method: 'hello' })).ok, false);
    assert.equal(h.quitCount, 0);
    h.backend.shutdownPending = false; h.backend.running = false;
    const recovered = await h.invoke('updates:install'); // Only recover after the actual exit.
    assert.equal(recovered.recoveryRequired, false);
    assert.equal(recovered.state, 'recovered');
    assert.equal(recovered.error, '');
    assert.doesNotMatch(updatesView(recovered), /data-action="install-update"/);
    assert.equal(h.calls.filter(call => call === 'install').length, 1);
    assert.equal(h.calls.includes('handoff'), false);
    assert.equal(h.quitCount, 0);
    assert.equal((await h.invoke('updates:status')).recoveryRequired, false);
    assert.equal(h.backend.paused, false);
    assert.equal((await h.invoke('backend:request', { method: 'hello' })).ok, true);
});
for (const failure of ['handoff', 'shutdown']) test(`Tauri requests a fresh exit confirmation after ${failure} recovery`, async () => {
    const h = await harness({ failure, nativeExitDecisions: [false] });
    let result = await h.invoke('updates:install');
    assert.equal(result.state, 'error');
    assert.equal(h.nativeMessages.filter(message => message.method === 'app:confirmQuit').length, 0);
    assert.equal(h.nativeMessages.filter(message => message.method === 'app:prepareUpdateQuit').length, 1);
    if (failure === 'shutdown') {
        assert.equal(result.recoveryRequired, true);
        h.backend.shutdownPending = false; h.backend.running = false;
        result = await h.invoke('updates:install');
        assert.equal(result.state, 'recovered');
    }
    assert.equal(result.recoveryRequired, false);
    assert.equal((await h.invoke('backend:request', { method: 'hello' })).ok, true);

    h.app.quit();
    await new Promise(setImmediate);
    assert.equal(h.nativeMessages.filter(message => message.method === 'app:confirmQuit').length, 1,
        '恢复使用后退出应再次确认，不能沿用安装更新前的确认结果');
    assert.equal(h.quitCount, 0);
    assert.equal(h.backend.running, true);
});

test('main quits only after handoff READY', async () => {
    const h = await harness();
    const installing = h.invoke('updates:install');
    await new Promise(setImmediate);
    assert.equal(h.quitCount, 0);
    h.releaseReady();
    assert.equal((await installing).state, 'installing');
    assert.equal(h.quitCount, 1);
});

function handoffHarness({ appPid = process.pid } = {}) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    let spawned;
    const module = { exports: {} };
    runInNewContext(fs.readFileSync(path.join(directory, 'update-handoff.cjs'), 'utf8'), {
        module, __dirname: directory, Buffer, process: { pid: process.pid, execPath: process.execPath,
            env: { ...process.env, WIFIMETER_APP_PID: String(appPid) } }, setTimeout, clearTimeout,
        require: name => name === 'node:child_process' ? { spawn(...args) { spawned = args; return child; } }
            : name === 'node:fs' ? { createReadStream: () => Readable.from([Buffer.from('verified '), Buffer.from('fixture')]), readFileSync: fs.readFileSync }
            : name === 'node:fs/promises' ? { readFile: async () => { assert.fail('Installer hashing must stream, not read the full file'); } } : require(name)
    });
    return { child, get spawned() { return spawned; }, launch: options => module.exports.launchUpdateHandoff('C:\\profile\\updates\\verified.exe', { userData: 'C:\\profile', digest, ...options }) };
}
test('helper spawn alone is insufficient; early exit rejects without GO', async () => {
    const h = handoffHarness(); const p = h.launch({ timeout: 1000 });
    await new Promise(setImmediate); h.child.emit('spawn'); h.child.emit('exit', 1);
    await assert.rejects(p, /helper|辅助进程/i);
    assert.equal(h.child.stdin.read()?.toString().includes('GO'), undefined);
});
test('READY is framed across chunks and only then authorizes the fixed installer script', async () => {
    const h = handoffHarness(); let ready = false;
    const p = h.launch({ timeout: 1000 }).then(() => { ready = true; });
    await new Promise(setImmediate); h.child.emit('spawn'); h.child.stdout.write('REA');
    await new Promise(setImmediate); assert.equal(ready, false);
    h.child.stdout.write('DY\r\n'); await p;
    assert.equal(h.child.stdin.read().toString(), 'GO\n');
    const [host, args, options] = h.spawned;
    assert.equal(host, process.execPath);
    assert.equal(args[0], '-e');
    assert.match(args[1], /WindowsPowerShell/);
    assert.equal(options.detached, true);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(options.windowsHide, true); assert.notEqual(options.shell, true);
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /FileShare\]::Read/); assert.match(script, /SHA256/);
    assert.match(script, /WaitForExit\(60000\)/);
    assert.match(script, /Start-Process -FilePath \$target -ArgumentList @\('\/S', '\/R'\) -WindowStyle Hidden/);
});
test('timeout closes input without authorizing a late READY', async () => {
    const h = handoffHarness(); const p = h.launch({ timeout: 15 });
    await assert.rejects(p, /timed out|超时/i);
    h.child.stdout.emit('data', Buffer.from('READY\n'));
    assert.equal(h.child.stdin.read()?.toString().includes('GO'), undefined);
});

test('helper failures retain a bounded local diagnostic and an actionable code', async () => {
    const h = handoffHarness(); const pending = h.launch({ timeout: 1000 });
    await new Promise(setImmediate);
    h.child.stderr.write('PowerShell refused the file. ' + 'x'.repeat(5000));
    h.child.emit('exit', 1);
    await assert.rejects(pending, error => {
        assert.equal(error.code, 'HANDOFF_EXITED_BEFORE_READY');
        assert.match(error.message, /PowerShell refused/);
        assert.ok(error.message.length < 600);
        return true;
    });
});

test('bridge keeps PowerShell attached to its surviving host and removes Electron Node mode', () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const fakeProcess = { argv: ['runtime', 'Zml4dHVyZQ=='], env: { SystemRoot: 'C:\\Windows',
        ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1', FIXTURE: 'preserved' },
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
    let spawned;
    runInNewContext(fs.readFileSync(path.join(directory, 'update-bridge.cjs'), 'utf8'), {
        process: fakeProcess, require: name => name === 'node:child_process' ? { spawn(...args) { spawned = args; return child; } } : require(name)
    });
    const [host, args, options] = spawned;
    assert.match(host, /WindowsPowerShell.*powershell.exe$/);
    assert.equal(args.at(-1), 'Zml4dHVyZQ==');
    assert.notEqual(options.detached, true);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.FIXTURE, 'preserved');
    assert.equal(Object.keys(options.env).some(name => name.toUpperCase() === 'ELECTRON_RUN_AS_NODE'), false);
    assert.equal(fakeProcess.env.ELECTRON_RUN_AS_NODE, '1');
    child.emit('exit', 0);
    assert.equal(fakeProcess.exitCode, 0);
});

function backendHarness() {
    const children = [], module = { exports: {} };
    runInNewContext(fs.readFileSync(path.join(directory, 'backend.cjs'), 'utf8'), {
        module, setTimeout, clearTimeout, process,
        require: name => name === 'node:child_process' ? { spawn() {
            const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.killed = false;
            child.stdin = new Writable({ write(chunk, encoding, done) {
                const request = JSON.parse(chunk.toString());
                child.stdout.write(JSON.stringify({ id: request.id, ok: true, result: {} }) + '\n'); done();
            } });
            child.kill = () => { throw Error('must not kill a collector'); };
            children.push(child); return child;
        } } : require(name)
    });
    return { children, client: new module.exports.BackendClient({ executable: 'fixture', databasePath: 'memory' }) };
}
test('timed-out shutdown blocks restarts until the original child actually emits exit', async () => {
    const { client, children } = backendHarness();
    await client.request('hello');
    await assert.rejects(client.stopGracefully({ timeout: 15 }), /not finished saving/);
    await assert.rejects(client.request('hello'), /shutdown|退出/i);
    assert.throws(() => client.start(), /shutdown|退出/i);
    await assert.rejects(client.waitForShutdown({ timeout: 15 }), /退出|saving/);
    assert.equal(children.length, 1); assert.equal(children[0].killed, false);
    const waiting = client.waitForShutdown({ timeout: 1000 });
    children[0].exitCode = 0; children[0].emit('exit', 0, null); await waiting;
    await client.request('hello'); assert.equal(children.length, 2);
});


test('a replaced verified download is rejected before any helper starts', async () => {
    const h = handoffHarness();
    await assert.rejects(h.launch({ digest: '0'.repeat(64) }), /changed|摘要|校验/i);
    assert.equal(h.spawned, undefined);
});
test('untrusted paths and script extensions cannot reach the process host', async () => {
    const module = { exports: {} };
    runInNewContext(fs.readFileSync(path.join(directory, 'update-handoff.cjs'), 'utf8'), {
        module, Buffer, process, setTimeout, clearTimeout,
        require: name => name === 'node:child_process' ? { spawn() { assert.fail('must not spawn'); } } : require(name)
    });
    for (const file of ['C:\\elsewhere\\installer.exe', 'C:\\profile\\updates\\script.ps1']) {
        await assert.rejects(module.exports.launchUpdateHandoff(file, { userData: 'C:\\profile', digest }), /update directory/);
    }
});
test('helper spawn error rejects without GO', async () => {
    const h = handoffHarness(); const pending = h.launch();
    await new Promise(setImmediate);
    h.child.emit('error', Object.assign(Error('ENOENT'), { code: 'ENOENT' }));
    await assert.rejects(pending, /ENOENT/);
    assert.equal(h.child.stdin.read()?.toString().includes('GO'), undefined);
});

function fixtureUpdateService(options, { runtime = 'electron', downloadFails = false } = {}) {
    const module = { exports: {} };
    runInNewContext(fs.readFileSync(path.join(directory, 'updates.cjs'), 'utf8'), {
        module, AbortSignal, globalThis, process: { env: { WIFIMETER_DESKTOP_RUNTIME: runtime } },
        require: name => name === 'node:fs/promises' ? {
            readFile: async () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); },
            lstat: async () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); },
            mkdir: async () => {}, rename: async () => {}, unlink: async () => {}
        } : name === 'node:fs' ? { createWriteStream: () => new Writable({ write(chunk, encoding, done) { done(); } }) } : require(name)
    });
    const assetName = runtime === 'tauri' ? 'WiFiMeter-1.3.0-windows-x64-Tauri-Setup.exe' : 'WiFiMeter-1.3.0-x64-Setup.exe';
    return module.exports.createUpdateService({
        ...options,
        currentVersion: '1.2.0', platform: 'win32', arch: 'x64', userData: 'fixture',
        fetch: async url => {
            if (url.includes('api.github.com')) return Response.json({ tag_name: 'v1.3.0', assets: [{
                name: assetName, size: Buffer.byteLength('verified fixture'), digest: `sha256:${digest}`,
                browser_download_url: `https://github.com/chronicle12345/WiFiMeter/releases/download/v1.3.0/${assetName}`
            }] });
            if (downloadFails) throw Error('injected download failure');
            return new Response('verified fixture');
        }
    });
}

for (const runtime of ['electron', 'tauri']) test(`${runtime} download passes its verified release digest to the handoff hook`, async () => {
    let metadata;
    const service = fixtureUpdateService({
        confirm: async () => true, beforeInstall: async () => {},
        launchInstaller: async (file, argv, verified) => {
            assert.ok(file.endsWith(runtime === 'tauri' ? 'WiFiMeter-1.3.0-windows-x64-Tauri-Setup.exe' : 'WiFiMeter-1.3.0-x64-Setup.exe'));
            assert.deepEqual(Array.from(argv), ['/S', '/R']); metadata = verified;
        }
    }, { runtime });
    assert.equal((await service.install()).state, 'installing');
    assert.equal(metadata.digest, digest);
});

for (const runtime of ['electron', 'tauri']) test(`${runtime} automatic check refuses an unsaved draft before pausing, handoff, or quitting`, async () => {
    const h = await harness({ paused: true, appsEnabled: true, prepareUpdateResult: false,
        nativeExitDecisions: runtime === 'tauri' ? [] : undefined,
        updateFactory: options => fixtureUpdateService(options, { runtime }) });
    const result = await h.invoke('updates:check');
    assert.equal(result.state, 'error');
    assert.equal(result.errorPhase, 'preparing');
    assert.match(result.error, /尚未保存.*保存后重试更新/);
    assert.equal(result.busy, false);
    assert.equal(Boolean(result.recoveryRequired), false);
    assert.equal(h.backend.running, true);
    assert.equal(h.backend.paused, true);
    assert.equal(h.backend.appsEnabled, true);
    assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'setPaused'), false);
    assert.equal(h.calls.includes('handoff'), false);
    assert.equal(h.calls.includes('waitForShutdown'), false);
    assert.equal(h.quitCount, 0);
    if (runtime === 'tauri') {
        assert.deepEqual(h.nativeMessages.map(message => message.method), ['app:prepareUpdateQuit']);
    } else assert.equal(h.calls.filter(call => call === 'prepareUpdate').length, 1);
    assert.equal((await h.invoke('backend:request', { method: 'hello' })).ok, true);
});

for (const paused of [false, true]) test(`automatic check handoff failure restores original paused=${paused} and application collection`, async () => {
    const h = await harness({ failure: 'handoff', paused, appsEnabled: true,
        updateFactory: options => fixtureUpdateService(options) });
    const result = await h.invoke('updates:check');
    assert.equal(result.state, 'error');
    assert.equal(result.errorPhase, 'installing');
    assert.equal(result.busy, false);
    assert.equal(result.recoveryRequired, false);
    assert.equal(h.backend.running, true);
    assert.equal(h.backend.paused, paused);
    assert.equal(h.backend.appsEnabled, true);
    assert.equal(h.calls.filter(call => call === 'handoff').length, 1);
    assert.equal(h.quitCount, 0);
    assert.equal((await h.invoke('backend:request', { method: 'hello' })).ok, true);
});

test('automatic check download failure leaves the running collector unchanged', async () => {
    const h = await harness({ appsEnabled: true,
        updateFactory: options => fixtureUpdateService(options, { downloadFails: true }) });
    const result = await h.invoke('updates:check');
    assert.equal(result.state, 'error');
    assert.equal(result.errorPhase, 'downloading');
    assert.equal(result.busy, false);
    assert.equal(h.backend.running, true);
    assert.equal(h.backend.paused, false);
    assert.equal(h.backend.appsEnabled, true);
    assert.equal(h.calls.includes('prepareUpdate'), false);
    assert.equal(h.calls.includes('handoff'), false);
    assert.equal(h.calls.includes('waitForShutdown'), false);
    assert.equal(h.quitCount, 0);
});

test('automatic check refuses installation when the page save hook is unavailable', async () => {
    const h = await harness({ missingPrepareHook: true,
        updateFactory: options => fixtureUpdateService(options) });
    const result = await h.invoke('updates:check');
    assert.equal(result.state, 'error');
    assert.equal(result.errorPhase, 'preparing');
    assert.equal(h.backend.running, true);
    assert.equal(h.backend.paused, false);
    assert.equal(h.calls.includes('handoff'), false);
    assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'setPaused'), false);
    assert.equal(h.quitCount, 0);
});

test('automatic check keeps data protected until a timed-out collector shutdown really finishes', async () => {
    const h = await harness({ failure: 'shutdown', appsEnabled: true,
        updateFactory: options => fixtureUpdateService(options) });
    const failed = await h.invoke('updates:check');
    assert.equal(failed.state, 'error');
    assert.equal(failed.recoveryRequired, true);
    assert.equal(h.backend.paused, true);
    assert.equal(h.calls.includes('handoff'), false);
    assert.equal(h.calls.includes('start'), false);
    assert.equal((await h.invoke('updates:check')).recoveryRequired, true);
    assert.equal((await h.invoke('backend:request', { method: 'hello' })).ok, false);
    h.backend.shutdownPending = false; h.backend.running = false;
    const recovered = await h.invoke('updates:install');
    assert.equal(recovered.state, 'recovered');
    assert.equal(recovered.recoveryRequired, false);
    assert.equal(h.backend.running, true);
    assert.equal(h.backend.paused, false);
    assert.equal(h.backend.appsEnabled, true);
    assert.equal(h.quitCount, 0);
});

// Exercise the generated PowerShell, replacing both process operations with
// functions. The .exe fixture is plain text and can never be executed here.
for (const mode of ['GO', 'EOF', 'changed', 'start-failure', 'parent-timeout', 'gui-timeout', 'gui-already-exited']) test(`PowerShell handshake: ${mode}, installer execution stubbed`, { skip: process.platform !== 'win32' }, async t => {
    const os = require('node:os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-handoff-'));
    const updates = path.join(root, 'updates'); fs.mkdirSync(updates);
    const file = path.join(updates, "fixture';ignored.exe");
    fs.writeFileSync(file, mode === 'changed' ? 'replaced fixture' : 'verified fixture');
    t.after(() => { fs.unlinkSync(file); fs.rmdirSync(updates); fs.rmdirSync(root); });
    const guiPid = process.pid + 1;
    const h = handoffHarness({ appPid: guiPid });
    const capture = h.launch(); await new Promise(setImmediate); h.child.stdout.write('READY\n'); await capture;
    // Only the base64 data changes; the production script body stays intact.
    let script = Buffer.from(h.spawned[1].at(-1), 'base64').toString('utf16le');
    script = script.replace(Buffer.from('C:\\profile\\updates\\verified.exe').toString('base64'), Buffer.from(file).toString('base64'));
    script = script.replaceAll('[System.Windows.Forms.MessageBox]', '[TestMessageBox]');
    const stubs = `
Add-Type -TypeDefinition 'public class TestMessageBox { public static void Show(string message, string title) { System.Console.WriteLine("MESSAGE-STUB"); } }'
function Get-Process {
    param($Id)
    ${mode === 'gui-already-exited' ? `if($Id -eq ${guiPid}){return $null}` : ''}
    $fake=[pscustomobject]@{Handle=1;FixtureId=$Id}
    $fake | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {param($timeout) ${mode === 'gui-timeout' ? `if($this.FixtureId -eq ${guiPid}){return $false}` : ''} return ${mode === 'parent-timeout' ? '$false' : '$true'}}
    return $fake
}
function Start-Process {
    param($FilePath,$ArgumentList,$WindowStyle)
    ${mode === 'start-failure' ? "throw 'Injected installer start failure'" : ''}
    if($WindowStyle -ne 'Hidden'){throw 'Wrong window style'}
    if(($ArgumentList -join ' ') -ne '/S /R'){throw 'Installer must be silent and restart the app'}
    $blocked=$false
    try {$writer=[IO.File]::Open($FilePath,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite); $writer.Dispose()} catch {$blocked=$true}
    if(-not $blocked){throw 'Installer was not locked'}
    [Console]::Out.WriteLine('LAUNCH-STUB')
}
`;
    const child = require('node:child_process').spawn(h.spawned[0], ['-e', h.spawned[1][1], Buffer.from(stubs + script, 'utf16le').toString('base64')], {
        detached: true, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {}); child.stdin.end(['GO', 'start-failure', 'parent-timeout', 'gui-timeout', 'gui-already-exited'].includes(mode) ? 'GO\n' : '');
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (['GO', 'gui-already-exited'].includes(mode)) { assert.equal(code, 0, stderr); assert.match(stdout, /READY[\r\n]+LAUNCH-STUB/); }
    else { assert.notEqual(code, 0); assert.doesNotMatch(stdout, /LAUNCH-STUB/); }
    if (mode === 'changed') assert.doesNotMatch(stdout, /READY/);
    if (['start-failure', 'parent-timeout', 'gui-timeout'].includes(mode)) {
        assert.match(stdout, /READY/);
        assert.equal((stdout.match(/MESSAGE-STUB/g) || []).length, 1, stderr);
    } else assert.doesNotMatch(stdout, /MESSAGE-STUB/);
    if (mode === 'parent-timeout') assert.match(stderr, /WiFiMeter did not exit/);
    if (mode === 'gui-timeout') assert.match(stderr, /WiFiMeter window did not exit/);
});


test('recovery action takes priority over installation, is disabled while busy, and is translated', () => {
    const status = { state: 'available', canInstall: true, recoveryRequired: true };
    const html = updatesView(status, true);
    assert.match(html, /data-action="install-update" disabled>恢复采集<\/button>/);
    assert.doesNotMatch(html, /data-action="install-update"[^>]*>下载并安装<\/button>/);
    setLanguage('en');
    try {
        assert.match(updatesView({ state: 'error', recoveryRequired: true }), />Resume collection<\/button>/);
        assert.match(updatesView({ state: 'recovered', recoveryRequired: false }), /Previous collection state restored/);
    } finally { setLanguage('zh-CN'); }
});

test('failed update restores application collection after restarting the stopped backend', async () => {
    const h = await harness({ failure: 'handoff', appsEnabled: true });
    const result = await h.invoke('updates:install');
    assert.equal(result.state, 'error');
    assert.equal(h.backend.appsEnabled, true);
    assert.equal(h.backend.paused, false);
    assert.equal(h.quitCount, 0);
});


test('progress wiring is initialized before service construction and survives status reads', async () => {
    let finish;
    let checks = 0, installs = 0;
    const h = await harness({ updateFactory(options) {
        options.onProgress({ state: 'unchecked', status: 'unchecked', progress: null });
        return {
            settings: async () => ({ checkOnStartup: true }),
            check: async () => { checks++; return { state: 'available' }; },
            install: async () => {
                installs++;
                options.onProgress({ state: 'downloading', status: 'downloading', currentVersion: '1.2.0',
                    latestVersion: '1.3.0', progress: { receivedBytes: 4, totalBytes: 10, percent: 40, phase: 'downloading' } });
                await new Promise(resolve => { finish = resolve; });
                return { state: 'error', status: 'error', error: 'download failed' };
            }
        };
    } });
    const pending = h.invoke('updates:install');
    await new Promise(setImmediate);
    const status = await h.invoke('updates:status');
    assert.equal(status.state, 'downloading');
    assert.equal(status.progress.receivedBytes, 4);
    assert.equal(status.busy, true);
    assert.equal(h.updates.at(-1).progress.percent, 40);
    assert.equal((await h.invoke('updates:check')).state, 'busy');
    assert.equal((await h.invoke('updates:install')).state, 'busy');
    assert.equal(checks, 0); assert.equal(installs, 1);
    finish();
    const failed = await pending;
    assert.equal(failed.progress, null);
    assert.equal(failed.busy, false);
    assert.equal((await h.invoke('updates:status')).progress, null);
    await h.invoke('updates:check');
    assert.equal((await h.invoke('updates:status')).error, undefined);
});


test('in-flight checking rejects repeat actions without replacing the saved phase', async () => {
    let finish;
    let checks = 0;
    const h = await harness({ updateFactory(options) { return {
        settings: async () => ({ checkOnStartup: true }),
        check: async () => {
            checks++;
            options.onProgress({ state: 'checking', status: 'checking', progress: { receivedBytes: 0, totalBytes: null, percent: null, phase: 'checking' } });
            await new Promise(resolve => { finish = resolve; });
            return { state: 'available', status: 'available', progress: null };
        },
        install: async () => assert.fail('must not install during a check')
    }; } });
    const pending = h.invoke('updates:check');
    await new Promise(setImmediate);
    assert.equal((await h.invoke('updates:status')).state, 'checking');
    assert.equal((await h.invoke('updates:install')).state, 'busy');
    assert.equal((await h.invoke('updates:check')).state, 'busy');
    assert.equal((await h.invoke('updates:status')).state, 'checking');
    assert.equal(checks, 1);
    finish();
    assert.equal((await pending).busy, false);
});

// Exercise the real runtime and helper script. Only Start-Process is replaced;
// the .exe contains text and cannot be executed by this test.
for (const runtime of ['Node', 'Electron', 'Electron ASAR', 'Node with separate GUI process']) test(`Windows ${runtime} handoff survives its parent and keeps the installer locked`, { skip: process.platform !== 'win32' }, async t => {
    const os = require('node:os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-handoff-survival-'));
    const updates = path.join(root, 'updates'); fs.mkdirSync(updates);
    const installer = path.join(updates, "verified';fixture.exe");
    const marker = path.join(root, 'launch-stub.txt');
    const packageRoot = path.join(root, 'package');
    const packageDirectory = path.join(packageRoot, 'electron');
    const archive = path.join(root, 'app.asar');
    let guiProcess, guiExit;
    fs.writeFileSync(installer, 'verified fixture');
    t.after(async () => {
        if (guiProcess) { guiProcess.stdin.end(); await guiExit; }
        const removeFile = async file => {
            const deadline = Date.now() + 5000;
            while (true) {
                try { await fs.promises.rm(file, { force: true }); return; }
                catch (error) {
                    if (!['EBUSY', 'EPERM'].includes(error.code) || Date.now() >= deadline) throw error;
                    // The launch marker is written before the detached helper releases its file lock.
                    await delay(50);
                }
            }
        };
        for (const file of [marker, installer, path.join(root, 'parent.cjs'), archive]) await removeFile(file);
        if (fs.existsSync(packageDirectory)) {
            for (const file of ['update-handoff.cjs', 'update-bridge.cjs']) await removeFile(path.join(packageDirectory, file));
            await fs.promises.rmdir(packageDirectory); await fs.promises.rmdir(packageRoot);
        }
        await fs.promises.rmdir(updates); await fs.promises.rmdir(root);
    });
    const source = fs.readFileSync(path.join(directory, 'update-handoff.cjs'), 'utf8');
    let bundleDirectory = directory;
    if (runtime === 'Electron ASAR') {
        fs.mkdirSync(packageDirectory, { recursive: true });
        for (const file of ['update-handoff.cjs', 'update-bridge.cjs']) fs.copyFileSync(path.join(directory, file), path.join(packageDirectory, file));
        await require('@electron/asar').createPackage(packageRoot, archive);
        bundleDirectory = path.join(archive, 'electron');
    }
    const encodedMarker = Buffer.from(marker, 'utf8').toString('base64');
    const fixture = path.join(root, 'parent.cjs');
    const stub = `
$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition 'public class TestMessageBox { public static void Show(string message, string title) { System.Console.Error.WriteLine("MESSAGE-STUB: " + message); } }'
function Start-Process {
    param($FilePath, $ArgumentList, $WindowStyle)
    if($env:ELECTRON_RUN_AS_NODE){throw 'Installer inherited Electron Node mode'}
    if($WindowStyle -ne 'Hidden'){throw 'Wrong window style'}
    if(($ArgumentList -join ' ') -ne '/S /R'){throw 'Installer must be silent and restart the app'}
    $blocked=$false
    try {$writer=[IO.File]::Open($FilePath,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite); $writer.Dispose()} catch {$blocked=$true}
    if(-not $blocked){throw 'Installer was not locked'}
    $marker=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedMarker}'))
    [IO.File]::WriteAllText($marker,'PARENT-EXITED;INSTALLER-LOCKED')
}
`;
    fs.writeFileSync(fixture, `
const cp = require('node:child_process'), fs = require('node:fs');
const { runInNewContext } = require('node:vm');
const moduleFixture = { exports: {} };
runInNewContext(${runtime === 'Electron ASAR' ? `fs.readFileSync(${JSON.stringify(path.join(bundleDirectory, 'update-handoff.cjs'))}, 'utf8')` : JSON.stringify(source)}, {
    module: moduleFixture, __dirname: ${JSON.stringify(bundleDirectory)}, Buffer, process, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { spawn(host, args, options) {
        const script = Buffer.from(args.at(-1), 'base64').toString('utf16le').replaceAll('[System.Windows.Forms.MessageBox]', '[TestMessageBox]');
        const fixed = [...args.slice(0, -1), Buffer.from(${JSON.stringify(stub)} + script, 'utf16le').toString('base64')];
        return cp.spawn(host, fixed, options);
    } } : require(name)
});
moduleFixture.exports.launchUpdateHandoff(${JSON.stringify(installer)}, {
    userData: ${JSON.stringify(root)}, digest: ${JSON.stringify(digest)}, timeout: 30000
}).then(() => { console.log('HANDOFF-ACCEPTED'); }, error => { console.error(error.message); process.exitCode = 1; });
`);
    if (runtime === 'Node with separate GUI process') {
        // A separate headless PID exercises the Tauri GUI lifetime without opening a window.
        guiProcess = require('node:child_process').spawn(process.execPath, ['-e',
            "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); console.log('GUI-STAND-IN-READY');"],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        guiProcess.stdin.on('error', () => {});
        guiExit = new Promise(resolve => guiProcess.once('close', resolve));
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(Error('headless GUI fixture did not start')), 10000);
            const finish = error => { clearTimeout(timeout); error ? reject(error) : resolve(); };
            guiProcess.once('error', finish);
            let output = '';
            guiProcess.stdout.on('data', chunk => { output += chunk; if (output.includes('GUI-STAND-IN-READY')) finish(); });
        });
    }
    const executable = runtime.startsWith('Node') ? process.execPath : require('electron');
    const child = require('node:child_process').spawn(executable, [fixture], {
        windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1',
            ...(guiProcess ? { WIFIMETER_APP_PID: String(guiProcess.pid) } : {}) }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /HANDOFF-ACCEPTED/);
    if (guiProcess) {
        await delay(300);
        assert.equal(guiProcess.exitCode, null);
        assert.equal(fs.existsSync(marker), false, 'installer must wait for the distinct GUI PID after Node exits');
        guiProcess.stdin.end();
        assert.equal(await guiExit, 0);
    }
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.readFileSync(marker, 'utf8'), 'PARENT-EXITED;INSTALLER-LOCKED');
});
