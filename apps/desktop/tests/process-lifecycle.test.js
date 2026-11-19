import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const directory = fileURLToPath(new URL('../host/', import.meta.url));
const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

// 进程、窗口、系统设置和计时器均为内存替身，不读写用户数据。
function backendHarness({ answer = true, crashRestarts = false, restoreThenHelloFails = false, appCaptureAvailable = false, failAppEnable = false } = {}) {
    const children = [], module = { exports: {} };
    runInNewContext(fs.readFileSync(path.join(directory, 'backend.cjs'), 'utf8'), {
        module, setTimeout, clearTimeout, process,
        require: name => name === 'node:child_process' ? { spawn(_file, args) {
            const child = new EventEmitter();
            Object.assign(child, { pid: children.length + 100, exitCode: null, killed: false,
                stdout: new PassThrough(), stderr: new PassThrough(), paused: args.includes('--paused'), appsEnabled: false,
                settings: { autoStart: false, notifications: true, language: 'zh-CN', speedUnit: 'auto' } });
            child.stdin = new Writable({ write(chunk, _encoding, done) {
                const request = JSON.parse(chunk.toString());
                child.requests.push(request);
                if (crashRestarts && children.length > 1) {
                    queueMicrotask(() => { child.exitCode = 1; child.emit('exit', 1, null); });
                    done(); return;
                }
                if (!answer) { done(); return; }
                if (request.method === 'setAppCollection' && request.params.enabled && failAppEnable) {
                    child.stdout.write(JSON.stringify({ id: request.id, ok: false, error: { code: 'unavailable', message: 'application helper failed' } }) + '\n');
                    done(); return;
                }
                if (request.method === 'setPaused') child.paused = request.params.paused;
                if (['clearUsage', 'restore'].includes(request.method)) child.paused = true;
                if (request.method === 'setAppCollection') child.appsEnabled = request.params.enabled;
                if (request.method === 'updateSettings') Object.assign(child.settings, request.params.settings);
                if (request.method === 'restore') {
                    Object.assign(child.settings, request.params.backup?.settings);
                    child.failHello = restoreThenHelloFails;
                }
                if (request.method === 'hello' && child.failHello) {
                    child.stdout.write(JSON.stringify({ id: request.id, ok: false, error: { code: 'storageFailure', message: 'restored hello failed' } }) + '\n');
                    done(); return;
                }
                child.stdout.write(JSON.stringify({ id: request.id, ok: true, result: {
                    paused: child.paused, appCollection: { available: appCaptureAvailable, enabled: child.appsEnabled }, settings: child.settings,
                    ...(request.method === 'backup' ? { backup: { backupType: 'wifimeter-backend-backup', version: 1, settings: child.settings, records: [], networks: [], ledgers: [] } } : {})
                } }) + '\n');
                done();
                if (request.method === 'shutdown') queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0, null); });
            } });
            child.requests = [];
            child.kill = () => { child.killed = true; queueMicrotask(() => { child.exitCode = 1; child.emit('exit', 1, 'SIGKILL'); }); };
            children.push(child); return child;
        } } : require(name)
    });
    const { BackendClient } = module.exports;
    const client = new BackendClient({ executable: 'fixture', args: ['--paused'], databasePath: ':memory:' });
    const dispose = () => { for (const child of children) { if (child.exitCode === null) { child.exitCode = 0; child.emit('exit', 0, null); } } };
    return { BackendClient, client, children, dispose };
}

function clock() {
    let id = 0;
    const pending = new Map();
    return { pending,
        setTimeout(callback, delay) { const handle = { id: ++id, unref() {} }; pending.set(handle, { callback, delay }); return handle; },
        clearTimeout(handle) { pending.delete(handle); },
        async next() {
            const entry = [...pending].sort((a, b) => a[1].delay - b[1].delay)[0];
            if (!entry) return false;
            pending.delete(entry[0]); entry[1].callback(); await flush(); return true;
        }
    };
}

async function mainHarness({ prepare = true, quitChoice = 0, missingConfirmHook = false, exitDecision, legacyFailure = false, crashRestarts = false, restoreThenHelloFails = false,
    appCaptureAvailable = false, failAppEnable = false, preferences = {}, startupChoice = 1, dialogs = {}, realCloud = false, cloudWaitFailure = false, restoreDuringStartupPrompt = false, reserveDuringStartupMutation = false } = {}) {
    const transport = backendHarness({ crashRestarts, restoreThenHelloFails, appCaptureAvailable, failAppEnable }), timers = clock();
    const handlers = new Map(), statuses = [], calls = [], systemSettings = [], miniEvents = [];
    const startupPrompts = [];
    let startupReservation = null, releaseStartupReservation, startupDrainBeforeNative = null;
    let ready, window, backend, miniRequest, hooks, cloudOptions, cloudBackup, disposed = 0, quitCount = 0;
    let logLevel = 'info', logSnapshot = { version: 1, entries: [] }, recordSnapshot = { version: 1, records: [] };
    const cloudFiles = new Map(), cloudLifecycle = [];
    const logModule = require(path.join(directory, 'logs.cjs'));
    const windowModule = require(path.join(directory, 'window-controls.cjs'));
    const app = new EventEmitter();
    Object.assign(app, { isPackaged: false, getVersion: () => '1.3.2', getPath: () => 'fixture', setPath() {},
        whenReady: () => ({ then(callback) { ready = callback(); return ready; } }),
        async prepareUpdateExit() { calls.push('prepare'); return prepare; },
        async confirmExit() { calls.push('confirmExit'); return exitDecision ?? (prepare || quitChoice === 1); },
        quit() { quitCount++; const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; app.emit('before-quit', event); }
    });
    if (missingConfirmHook) delete app.confirmExit;
    class Window extends EventEmitter {
        constructor() {
            super(); window = this; this.webContents = new EventEmitter();
            Object.assign(this.webContents, { mainFrame: { url: '' },
                send(channel, value) { if (channel === 'backend:event') statuses.push(value); } });
        }
        isDestroyed() { return false; }
        isVisible() { return true; }
        isMinimized() { return false; }
        async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    }
    const imports = {
        './desktop-runtime.cjs': { getDesktopRuntime: () => ({ app, BrowserWindow: Window, dialog: { showErrorBox() {}, async showMessageBox(_window, options) {
            startupPrompts.push({ options, loaded: Boolean(window.webContents.mainFrame.url), paused: transport.children[0].paused });
            if (restoreDuringStartupPrompt && !startupReservation) {
                const gate = new Promise(resolve => { releaseStartupReservation = resolve; });
                startupReservation = cloudOptions.withRestore(async () => gate);
                await flush();
            }
            return { response: startupChoice };
        }, ...dialogs },
            ipcMain: { handle: (name, fn) => handlers.set(name, fn) } }) },
        'node:fs': { existsSync: () => true }, 'node:timers': timers,
        './backend.cjs': { BackendClient: class extends transport.BackendClient { constructor(options) { super(options); backend = this; }
            async request(method, ...args) {
                if (reserveDuringStartupMutation && method === 'setAppCollection' && args[0]?.enabled) {
                    let entered = false;
                    startupReservation = cloudOptions.withRestore(async () => { entered = true; });
                    await flush();
                    startupDrainBeforeNative = !entered;
                }
                return super.request(method, ...args);
            } }, resolveExecutable: () => 'fixture' },
        './files.cjs': { createFileActions: () => ({}) },
        './system.cjs': { createSystemIntegration: () => ({ initializeTray() {}, applySettings: async (settings, options) => {
            systemSettings.push({ settings: structuredClone(settings), options }); return { autoStart: settings.autoStart, notifications: settings.notifications };
        }, beginQuit() { calls.push('beginQuit'); }, dispose() { disposed++; } }) },
        './windows-autostart.cjs': { createWindowsAutostart: () => ({}) },
        './product.cjs': { applyProductIdentity: () => ({ productName: 'fixture' }) },
        './legacy.cjs': { legacyDirectory: () => '', importLegacyDirectory: async () => { if (legacyFailure) throw Error('migration failed'); return { found: false }; } },
        './window-controls.cjs': { createWindowControls: options => { miniRequest = options.requestMiniSnapshot; return { read: async () => ({ ...preferences }), validate: windowModule.validateWindowPreferences, update: async patch => Object.assign(preferences, patch), restore: async patch => Object.assign(preferences, patch), publishLive(event) { miniEvents.push(event); }, onMainClose() {}, dispose() {} }; } },
        './app-icons.cjs': { registerAppIcons() {} }, './app-control.cjs': { createAppControl: () => ({ backupRecords: async () => structuredClone(recordSnapshot), validateRecords: snapshot => snapshot, restoreRecords: async snapshot => { recordSnapshot = structuredClone(snapshot); }, waitForIdle: async () => {} }) },
        './cloud-backup.cjs': { createCloudBackup: options => { cloudOptions = options; cloudBackup = realCloud ? require(path.join(directory, 'cloud-backup.cjs')).createCloudBackup({ ...options, io: { mkdir: async () => {}, readFile: async file => { if (!cloudFiles.has(file)) throw Object.assign(Error('ENOENT'), { code: 'ENOENT' }); return cloudFiles.get(file); }, writeFile: async (file, body) => cloudFiles.set(file, body), rename: async (from, to) => { cloudFiles.set(to, cloudFiles.get(from)); cloudFiles.delete(from); }, unlink: async file => cloudFiles.delete(file) } }) : { start() { cloudLifecycle.push('start'); }, stop() { cloudLifecycle.push('stop'); }, waitForIdle: async () => { if (cloudWaitFailure) throw Error('cloud drain failed'); }, status: async () => ({}) }; return cloudBackup; } },
        './logs.cjs': { validateLogLevel: logModule.validateLogLevel, createLogStore: () => ({ write() {}, read: () => ({ entries: [], total: 0, level: logLevel }), text: () => '', snapshot: () => structuredClone(logSnapshot), validate: logModule.validateLogSnapshot, restore: snapshot => { logSnapshot = structuredClone(snapshot); }, setLevel: level => { logLevel = level; return level; }, clear() {}, get level() { return logLevel; } }), captureConsole() {} },
        './update-handoff.cjs': { launchUpdateHandoff: async () => { await handoff; throw Error('fixture handoff failed'); } },
        './updates.cjs': { createUpdateService(options) { hooks = options; return { settings: async () => ({ checkOnStartup: true }), async install() {
            try { await options.beforeInstall(); await options.launchInstaller('fixture.exe', [], { digest: '0'.repeat(64) }); return { state: 'installing' }; }
            catch (error) { return { state: 'error', error: error.message }; }
        } }; } }
    };
    let releaseHandoff;
    const handoff = new Promise(resolve => { releaseHandoff = resolve; });
    runInNewContext(fs.readFileSync(path.join(directory, 'main.cjs'), 'utf8'), {
        require: name => imports[name] || require(name), __dirname: directory, Buffer, console, structuredClone,
        process: { platform: 'win32', arch: 'x64', pid: 42, env: { WIFIMETER_USER_DATA: 'fixture', WIFIMETER_TEST_ISOLATION: '1' }, resourcesPath: 'fixture' }
    });
    await ready; await flush(); calls.length = 0;
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    return { app, backend, timers, statuses, calls, hooks, cloudOptions, cloudBackup, cloudLifecycle, systemSettings, miniEvents, startupPrompts, children: transport.children, releaseHandoff,
        portable: () => ({ windowPreferences: structuredClone(preferences), logLevel, appNetworkRecords: structuredClone(recordSnapshot), logs: structuredClone(logSnapshot) }),
        get startupReservation() { return startupReservation; }, releaseStartupReservation: () => releaseStartupReservation?.(),
        get startupDrainBeforeNative() { return startupDrainBeforeNative; }, get disposed() { return disposed; }, get quitCount() { return quitCount; }, window,
        invoke: (name, payload) => handlers.get(name)(event, payload), miniRequest: () => miniRequest({ includeMinutes: true }),
        crash() { const child = backend.child; child.exitCode = 1; child.emit('exit', 1, null); },
        dispose() { timers.pending.clear(); transport.dispose(); timers.pending.clear(); }
    };
}

test('startup asks after migration and page load, then enables application collection only on acceptance', async t => {
    const h = await mainHarness({ appCaptureAvailable: true, preferences: { promptAppCollection: true }, startupChoice: 0 }); t.after(h.dispose);
    assert.equal(h.startupPrompts.length, 1);
    assert.equal(h.startupPrompts[0].loaded, true);
    assert.equal(h.startupPrompts[0].paused, false);
    assert.equal(h.children[0].appsEnabled, true);
    assert.equal(h.children[0].requests.filter(request => request.method === 'setAppCollection').length, 1);
    await h.invoke('backend:request', { method: 'hello' });
    assert.equal(h.startupPrompts.length, 1, 'ordinary requests must not repeat the startup question');
});

for (const startupChoice of [1, undefined]) test(`declining or closing the startup question leaves application collection disabled (${startupChoice})`, async t => {
    // The native dialog maps closing to cancelId; an absent response also cannot authorize collection.
    const h = await mainHarness({ appCaptureAvailable: true, startupChoice, dialogs: startupChoice === undefined ? { showMessageBox: async () => ({}) } : {} }); t.after(h.dispose);
    if (startupChoice !== undefined) assert.equal(h.startupPrompts.length, 1);
    assert.equal(h.children[0].appsEnabled, false);
    assert.equal(h.children[0].paused, false);
    assert.equal(h.children[0].requests.some(request => request.method === 'setAppCollection'), false);
});

test('the saved startup preference suppresses the question without enabling application collection', async t => {
    const h = await mainHarness({ appCaptureAvailable: true, preferences: { promptAppCollection: false }, startupChoice: 0 }); t.after(h.dispose);
    assert.equal(h.startupPrompts.length, 0);
    assert.equal(h.children[0].appsEnabled, false);
});

test('each desktop launch asks by default while a build without a collector skips the question', async t => {
    for (let launch = 0; launch < 2; launch++) {
        const h = await mainHarness({ appCaptureAvailable: true }); t.after(h.dispose);
        assert.equal(h.startupPrompts.length, 1);
        assert.equal(h.startupPrompts[0].options.cancelId, 1);
    }
    const unsupported = await mainHarness({ startupChoice: 0 }); t.after(unsupported.dispose);
    assert.equal(unsupported.startupPrompts.length, 0);
    assert.equal(unsupported.children[0].appsEnabled, false);
});

test('migration failure skips the startup question and keeps collection paused', async t => {
    const h = await mainHarness({ appCaptureAvailable: true, legacyFailure: true, startupChoice: 0 }); t.after(h.dispose);
    assert.equal(h.startupPrompts.length, 0);
    assert.equal(h.children[0].appsEnabled, false);
    assert.equal(h.children[0].paused, true);
});

test('a failed application collection request does not block startup or retry automatically', async t => {
    const h = await mainHarness({ appCaptureAvailable: true, failAppEnable: true, startupChoice: 0 }); t.after(h.dispose);
    assert.equal(h.startupPrompts.length, 1);
    assert.equal(h.children[0].appsEnabled, false);
    assert.equal((await h.invoke('backend:request', { method: 'hello' })).ok, true);
    assert.equal(h.children[0].requests.filter(request => request.method === 'setAppCollection').length, 1);
});

test('collector recovery does not retry application collection after permission was refused', async t => {
    const h = await mainHarness({ appCaptureAvailable: true }); t.after(h.dispose);
    await h.invoke('backend:request', { method: 'setAppCollection', params: { enabled: true } });
    const child = h.children[0];
    child.appsEnabled = false;
    child.stdout.write(JSON.stringify({ event: 'live', collector: 'running', appCollection: { available: true, enabled: false, state: 'permission', detail: 'permission refused' } }) + '\n');
    h.crash();
    assert.equal(await h.timers.next(), true);
    assert.equal(h.children.length, 2);
    assert.equal(h.children[1].paused, false);
    assert.equal(h.children[1].appsEnabled, false);
    assert.equal(h.startupPrompts.length, 1);
});

test('backend pipe errors reject pending requests without an uncaught EventEmitter error', async t => {
    const h = backendHarness({ answer: false }); t.after(h.dispose);
    const request = h.client.request('hello'); request.catch(() => {});
    assert.doesNotThrow(() => h.children[0].stdin.emit('error', Object.assign(Error('broken pipe'), { code: 'EPIPE' })));
    await assert.rejects(request, /broken pipe|管道/);
    assert.equal(h.client.pending.size, 0);
});

test('late exit, output and stream errors from an old child do not change the new child', async t => {
    const h = backendHarness({ answer: false }); t.after(h.dispose);
    h.client.start(); const old = h.client.child; old.killed = true;
    h.client.start(); const current = h.client.child;
    const request = h.client.request('hello'); request.catch(() => {});
    old.stdout.write('{"id":1,"ok":true,"result":{"old":true}}\n');
    old.exitCode = 1; old.emit('exit', 1, null);
    assert.equal(h.client.child, current);
    assert.equal(h.client.pending.size, 1);
    assert.doesNotThrow(() => old.stdin.emit('error', Error('old broken pipe')));
    current.stdout.write('{"id":1,"ok":true,"result":{"current":true}}\n');
    assert.equal((await request).current, true);
});

test('a collector crash publishes offline status and restores the last successful collection settings', async t => {
    const h = await mainHarness(); t.after(h.dispose);
    await h.invoke('backend:request', { method: 'setAppCollection', params: { enabled: true } });
    h.crash();
    assert.equal(h.statuses.at(-1).event, 'collectorStatus');
    assert.equal(h.statuses.at(-1).collector, 'offline');
    assert.equal(h.statuses.at(-1).appCollection.enabled, true);
    assert.equal(await h.timers.next(), true);
    assert.equal(h.children.length, 2);
    assert.equal(h.children[1].paused, false);
    assert.equal(h.children[1].appsEnabled, true);
    assert.equal(h.statuses.at(-1).collector, 'running');
});

test('crash recovery keeps an explicitly paused collector paused', async t => {
    const h = await mainHarness(); t.after(h.dispose);
    await h.invoke('backend:request', { method: 'setPaused', params: { paused: true } });
    h.crash(); await h.timers.next();
    assert.equal(h.children.length, 2);
    assert.equal(h.children[1].paused, true);
    assert.equal(h.statuses.at(-1).collector, 'paused');
});

test('restoring a backup synchronizes settings without depending on a later hello request', async t => {
    const h = await mainHarness({ restoreThenHelloFails: true }); t.after(h.dispose);
    const settings = { autoStart: true, notifications: false, language: 'en', speedUnit: 'Mbps' };
    const child = h.children.at(-1), previousRequests = child.requests.length;
    const response = await h.invoke('backend:request', { method: 'restore', params: { backup: { settings } } });
    assert.equal(response.ok, true);
    assert.deepEqual(structuredClone(response.result.settings), settings);
    assert.deepEqual(Array.from(child.requests.slice(previousRequests), request => request.method), ['restore']);
    assert.deepEqual(h.systemSettings.at(-1).settings, settings);
    assert.equal(h.systemSettings.at(-1).options.enableAutostart, true);
    assert.equal(response.result.system.autoStart, true);
    assert.equal(response.result.system.notifications, false);
    h.backend.emit('event', { event: 'live', collector: 'paused', connections: [] });
    assert.equal(h.miniEvents.at(-1).speedUnit, 'Mbps');
    assert.equal(h.backend.collectionState.paused, true);
    await assert.rejects(h.backend.request('hello'), /restored hello failed/);
});

for (const method of ['clearUsage', 'restore']) test(`crash recovery preserves the pause required by ${method}`, async t => {
    const h = await mainHarness(); t.after(h.dispose);
    await h.invoke('backend:request', { method });
    h.crash(); await h.timers.next();
    assert.equal(h.children.length, 2);
    assert.equal(h.children[1].paused, true);
    assert.equal(h.statuses.at(-1).collector, 'paused');
});

test('concurrent page requests share one collector recovery before reading data', async t => {
    const h = await mainHarness(); t.after(h.dispose);
    h.crash();
    const results = await Promise.all(['hello', 'snapshot'].map(method => h.invoke('backend:request', { method })));
    assert.equal(h.children.length, 2);
    assert.equal(h.children[1].paused, false);
    assert.equal(h.children[1].requests.filter(request => request.method === 'setPaused').length, 1);
    assert.ok(results.every(result => result.ok));
});

test('repeated crashes stop after three recovery attempts', async t => {
    const h = await mainHarness({ crashRestarts: true }); t.after(h.dispose);
    h.crash();
    for (let attempt = 0; attempt < 5; attempt++) await h.timers.next();
    assert.equal(h.children.length, 4);
    assert.equal(h.timers.pending.size, 0);
    assert.equal(h.statuses.at(-1).collector, 'offline');
    assert.match(h.statuses.at(-1).message, /重试|重新打开/);
});

test('startup migration failure never schedules automatic collector recovery', async t => {
    const h = await mainHarness({ legacyFailure: true }); t.after(h.dispose);
    h.crash(); await h.timers.next();
    assert.equal(h.children.length, 1);
    assert.equal(h.timers.pending.size, 0);
});

test('canceling an import resumes recovery of a collector that crashed during directory selection', async t => {
    let cancelImport;
    const h = await mainHarness({ dialogs: {
        showOpenDialog: () => new Promise(resolve => { cancelImport = resolve; })
    } });
    t.after(h.dispose);
    const importing = h.invoke('legacy:import');
    await flush();
    h.crash();
    assert.equal(h.timers.pending.size, 0, 'directory selection must keep collector recovery paused');
    cancelImport({ canceled: true, filePaths: [] });
    assert.equal((await importing).canceled, true);
    assert.equal(await h.timers.next(), true, 'closing the canceled import must schedule recovery without a page request');
    assert.equal(h.children.length, 2);
    assert.equal(h.children[1].paused, false);
    assert.equal(h.statuses.at(-1).collector, 'running');
});

test('mini requests cannot restart a stopped collector during update handoff', async t => {
    const h = await mainHarness(); t.after(h.dispose);
    const installation = h.invoke('updates:install');
    await flush(); assert.equal(h.backend.running, false);
    await assert.rejects(h.miniRequest(), /update|更新|unavailable/i);
    assert.equal(h.children.length, 1);
    assert.equal(h.timers.pending.size, 0);
    h.releaseHandoff(); await installation;
});

test('canceling an exit with unsaved settings preserves the collector and tray', async t => {
    const h = await mainHarness({ prepare: false, quitChoice: 0 }); t.after(h.dispose);
    const original = h.backend.child;
    h.app.quit(); await flush();
    assert.equal(h.backend.child, original);
    assert.equal(h.backend.running, true);
    assert.equal(h.disposed, 0);
    assert.deepEqual(h.calls, ['confirmExit']);
    assert.equal((await h.invoke('backend:request', { method: 'hello' })).ok, true);
});

test('confirmed exit stops the collector only after checking saved settings', async t => {
    const h = await mainHarness({ prepare: false, quitChoice: 1 }); t.after(h.dispose);
    h.app.quit(); await flush();
    assert.equal(h.backend.running, false);
    assert.equal(h.disposed, 1);
    assert.deepEqual(h.calls.slice(0, 2), ['confirmExit', 'beginQuit']);
    assert.equal(h.calls.filter(call => call === 'confirmExit').length, 1);
});

test('exiting after the isolated window is destroyed does not ask for drafts', async t => {
    const h = await mainHarness({ prepare: false }); t.after(h.dispose);
    h.window.isDestroyed = () => true;
    h.app.quit(); await flush();
    assert.equal(h.backend.running, false);
    assert.equal(h.disposed, 1);
    assert.equal(h.calls.includes('confirmExit'), false);
});

for (const options of [{ missingConfirmHook: true }, { exitDecision: 'accepted' }]) {
    test(`missing or invalid native exit confirmation preserves the collector (${Object.keys(options)[0]})`, async t => {
        const h = await mainHarness({ prepare: false, quitChoice: 1, ...options }); t.after(h.dispose);
        const original = h.backend.child;
        h.app.quit(); await flush();
        assert.equal(h.backend.child, original);
        assert.equal(h.backend.running, true);
        assert.equal(h.disposed, 0);
        assert.equal(h.calls.includes('beginQuit'), false);
        assert.equal((await h.invoke('backend:request', { method: 'hello' })).ok, true);
    });
}

test('mini collector status clears rates and application activity without a backend query', async t => {
    const { createWindowControls } = require('../host/window-controls.cjs');
    const windows = [], handlers = new Map();
    let queries = 0;
    class Window extends EventEmitter {
        constructor(options) {
            super(); this.bounds = options; this.sent = [];
            this.webContents = new EventEmitter();
            Object.assign(this.webContents, { mainFrame: { url: '' },
                send: (channel, value) => this.sent.push([channel, value]) });
            windows.push(this);
        }
        isDestroyed() { return false; }
        getBounds() { return this.bounds; }
        showInactive() {}
        destroy() {}
        async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    }
    const screen = new EventEmitter();
    screen.getPrimaryDisplay = () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
    const controls = createWindowControls({ BrowserWindow: Window, screen,
        ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
        dialog: {}, userData: 'fixture', getWindow: () => null, hideToTray() {}, requestQuit() {},
        platform: 'win32', backgroundTest: true,
        fileSystem: { readFile: async () => JSON.stringify({ miniWindow: true, miniExpanded: true }) },
        requestMiniSnapshot: async () => { queries++; return { appMinuteRecords: [], live: {} }; }
    });
    t.after(() => controls.dispose());
    await controls.read(); const mini = windows[0];
    controls.publishLive({ event: 'live', state: 'connected', collector: 'running',
        connections: [{ rxPerSecond: 500, txPerSecond: 100 }],
        appCollection: { enabled: true, state: 'running' }, appProcesses: [{ appId: 'browser', rxPerSecond: '500', txPerSecond: '100' }] });
    mini.webContents.emit('did-finish-load'); await flush();
    assert.equal(queries, 1);
    controls.publishLive({ event: 'collectorStatus', collector: 'offline', updatedAt: new Date().toISOString(),
        appCollection: { enabled: true, state: 'unavailable' } });
    const live = mini.sent.findLast(([channel]) => channel === 'mini:live')[1];
    assert.equal(live.connections[0].rxPerSecond, 0);
    assert.deepEqual(live.appProcesses, []);
    const applications = await handlers.get('mini:applications')({ sender: mini.webContents, senderFrame: mini.webContents.mainFrame });
    assert.equal(applications.status, 'unavailable');
    assert.deepEqual(applications.rows, []);
    assert.equal(queries, 1);
});


test('the backend restore IPC also restores the portable parts of a complete local recovery point', async t => {
    const h = await mainHarness({ realCloud: true }); t.after(h.dispose);
    const logs = { version: 1, entries: [{ time: '2026-11-18T00:00:00.000Z', level: 'warn', source: 'app', message: 'recovered local log' }] };
    const hostSettings = { windowPreferences: { theme: 'dark', promptAppCollection: false }, logLevel: 'warn', appNetworkRecords: { version: 1, records: [] } };
    const response = await h.invoke('backend:request', { method: 'restore', params: { backup: { backupType: 'wifimeter-backend-backup', version: 1,
        settings: { autoStart: false, notifications: false, language: 'en', speedUnit: 'Mbps' }, records: [], networks: [], ledgers: [], hostSettings, logs } } });
    assert.equal(response.ok, true);
    assert.deepEqual(h.portable(), { ...hostSettings, logs });
    assert.equal(h.children[0].paused, true);
    assert.equal(h.systemSettings.at(-1).settings.language, 'en');
});

test('an invalid desktop portion of a local recovery point cannot reach the backend restore', async t => {
    const h = await mainHarness({ realCloud: true }); t.after(h.dispose);
    const previous = h.children[0].requests.length;
    const response = await h.invoke('backend:request', { method: 'restore', params: { backup: { backupType: 'wifimeter-backend-backup', version: 1,
        settings: { language: 'en' }, hostSettings: { windowPreferences: { theme: '../invalid' } }, logs: { version: 1, entries: [] } } } });
    assert.equal(response.ok, false);
    assert.deepEqual(h.children[0].requests.slice(previous), []);
    assert.equal(h.children[0].settings.language, 'zh-CN');
});

test('a recovery reservation blocks concurrent edits and update/import, and exit waits for the replacement', async t => {
    const h = await mainHarness({ realCloud: true }); t.after(h.dispose);
    assert.equal(typeof h.cloudOptions.withRestore, 'function');
    let ready, release;
    const entered = new Promise(resolve => { ready = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const restoration = h.cloudOptions.withRestore(async () => { ready(); await pending; });
    await entered;
    const response = await h.invoke('backend:request', { method: 'updateSettings', params: { settings: { language: 'en' } } });
    assert.equal(response.ok, false);
    assert.match(response.error.message, /恢复.*备份/);
    await assert.rejects(async () => h.invoke('window-preferences:update', { theme: 'dark' }), /恢复.*备份/);
    await assert.rejects(async () => h.invoke('logs:level', 'debug'), /恢复.*备份/);
    await assert.rejects(async () => h.invoke('app-control:request', { action: 'block', path: 'C:\\Apps\\test.exe' }), /恢复.*备份/);
    await assert.rejects(h.hooks.beforeInstall(), /备份.*恢复|恢复.*备份/);
    assert.match((await h.invoke('legacy:import')).error, /备份.*恢复|恢复.*备份/);
    h.app.quit(); await flush();
    assert.equal(h.children[0].requests.some(request => request.method === 'shutdown'), false);
    release(); await restoration; await flush();
    assert.equal(h.children[0].requests.some(request => request.method === 'shutdown'), true);
});


test('canceling exit before shutdown leaves automatic backup active', async t => {
    const h = await mainHarness({ prepare: false, quitChoice: 0 }); t.after(h.dispose);
    const before = [...h.cloudLifecycle];
    h.app.quit(); await flush();
    assert.deepEqual(h.cloudLifecycle, before);
    assert.equal(h.backend.running, true);
});

test('an exit canceled after stopping cloud work resumes automatic backup', async t => {
    const h = await mainHarness({ cloudWaitFailure: true }); t.after(h.dispose);
    h.app.quit(); await flush();
    assert.deepEqual(h.cloudLifecycle.slice(-2), ['stop', 'start']);
    assert.equal(h.backend.running, true);
    assert.equal(h.children[0].requests.some(request => request.method === 'shutdown'), false);
});

test('update shutdown stops automatic backup and failed handoff resumes its timer after recovery', async t => {
    const h = await mainHarness(); t.after(h.dispose);
    const installation = h.invoke('updates:install');
    await flush();
    assert.equal(h.cloudLifecycle.at(-1), 'stop');
    assert.equal(h.backend.running, false);
    h.releaseHandoff();
    const result = await installation;
    assert.equal(result.state, 'error');
    assert.equal(result.recoveryRequired, false);
    assert.deepEqual(h.cloudLifecycle.slice(-2), ['stop', 'start']);
    assert.equal(h.backend.running, true);
});


test('confirmed exit rejects new writes while previously admitted cloud work is still draining', async t => {
    const h = await mainHarness({ realCloud: true }); t.after(h.dispose);
    const request = h.backend.request.bind(h.backend);
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    h.backend.request = async (method, ...args) => { if (method === 'backup') { entered(); await gate; } return request(method, ...args); };
    const estimate = h.cloudBackup.estimate(); await ready;
    h.app.quit(); await flush();
    const update = await h.invoke('backend:request', { method: 'updateSettings', params: { settings: { language: 'en' } } });
    let windowAccepted = true;
    try { await h.invoke('window-preferences:update', { theme: 'dark' }); } catch { windowAccepted = false; }
    const earlyShutdown = h.children[0].requests.some(message => message.method === 'shutdown');
    release(); await estimate; await flush();
    assert.equal(update.ok, false);
    assert.equal(windowAccepted, false);
    assert.equal(earlyShutdown, false);
    assert.equal(h.children[0].requests.some(message => message.method === 'shutdown'), true);
});


test('a delayed migration resume confirmation is checked again during restore and confirmed exit', async t => {
    for (const blocker of ['restore', 'exit']) {
        let enterDialog, releaseDialog, enterWork, releaseWork;
        const dialogReady = new Promise(resolve => { enterDialog = resolve; }), dialogGate = new Promise(resolve => { releaseDialog = resolve; });
        const workReady = new Promise(resolve => { enterWork = resolve; }), workGate = new Promise(resolve => { releaseWork = resolve; });
        const h = await mainHarness({ realCloud: true, legacyFailure: true, dialogs: { showMessageBox: async () => { enterDialog(); return dialogGate; } } });
        t.after(h.dispose);
        const resume = h.invoke('backend:request', { method: 'setPaused', params: { paused: false } });
        await dialogReady;
        let work;
        if (blocker === 'restore') {
            work = h.cloudOptions.withRestore(async () => { enterWork(); await workGate; });
            await workReady;
        } else {
            const request = h.backend.request.bind(h.backend);
            h.backend.request = async (method, ...args) => { if (method === 'backup') { enterWork(); await workGate; } return request(method, ...args); };
            work = h.cloudBackup.estimate(); await workReady;
            h.app.quit(); await flush();
        }
        releaseDialog({ response: 0 });
        const response = await resume, wasPaused = h.children[0].paused;
        releaseWork(); await work; await flush();
        assert.equal(response.ok, false);
        assert.equal(wasPaused, true);
    }
});

test('startup collection approval cannot enable capture while restore owns the data', async t => {
    const h = await mainHarness({ realCloud: true, appCaptureAvailable: true, startupChoice: 0, restoreDuringStartupPrompt: true });
    t.after(h.dispose);
    const enabled = h.children[0].appsEnabled;
    h.releaseStartupReservation(); await h.startupReservation;
    assert.equal(enabled, false);
    assert.equal(h.children[0].requests.some(request => request.method === 'setAppCollection'), false);
});

test('an already approved startup collection request is drained before a restore reservation can run', async t => {
    const h = await mainHarness({ realCloud: true, appCaptureAvailable: true, startupChoice: 0, reserveDuringStartupMutation: true });
    t.after(h.dispose);
    await h.startupReservation;
    assert.equal(h.startupDrainBeforeNative, true);
    assert.equal(h.children[0].appsEnabled, true);
});
