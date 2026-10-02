import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { legacyDirectory, importLegacyDirectory } from '../electron/legacy.cjs';

const state = '{"SchemaVersion":1,"StartedAt":"2026-01-01T00:00:00Z","UpdatedAt":"2026-01-02T00:00:00Z","Networks":[{"SSID":"Sample","RxBytes":9007199254740993,"TxBytes":0,"FirstSeen":"2026-01-01T00:00:00Z","LastSeen":"2026-01-02T00:00:00Z","Days":[{"Date":"2026-01-01","RxBytes":9007199254740993,"TxBytes":0}]}]}';
async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-migration-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'legacy'), target = path.join(root, 'profile');
    await mkdir(source); await mkdir(target);
    await writeFile(path.join(source, 'state.json'), state);
    await writeFile(path.join(source, 'collector.lock'), '');
    await writeFile(path.join(source, 'settings.json'), '{"Language":"en","RetentionDays":0}');
    return { source, target };
}
test('isolated profiles never discover real legacy data unless explicitly selected', () => {
    assert.equal(legacyDirectory({ platform: 'win32', env: { WIFIMETER_USER_DATA: 'test', LOCALAPPDATA: 'private' } }), null);
    assert.equal(legacyDirectory({ platform: 'linux', env: {} }), null);
    assert.equal(legacyDirectory({ platform: 'win32', env: { WIFIMETER_LEGACY_DIRECTORY: 'chosen' } }), path.resolve('chosen'));
});
test('migration preserves source bytes and sends exact 64-bit JSON only after backup', async t => {
    const { source, target } = await fixture(t), calls = [];
    const request = async (method, params) => {
        calls.push(method);
        if (method === 'migrationStatus') return { imported: false };
        if (method === 'backup') return { backup: { version: 1, backupType: 'wifimeter-backend-backup', records: [{ rxBytes: '7' }] } };
        assert.equal(method, 'importLegacy'); assert.equal(params.stateJson, state);
        assert.match(params.sourceId, /^[a-f0-9]{64}$/);
        const folders = await readdir(path.join(target, 'migration-backups'));
        assert.equal(folders.length, 1);
        const dir = path.join(target, 'migration-backups', folders[0]);
        assert.equal(await readFile(path.join(dir, 'state.json'), 'utf8'), state);
        assert.equal(JSON.parse(await readFile(path.join(dir, 'sqlite-before.json'), 'utf8')).records[0].rxBytes, '7');
        return { imported: true };
    };
    const result = await importLegacyDirectory({ directory: source, userData: target, request });
    assert.equal(result.imported, true); assert.deepEqual(calls, ['migrationStatus', 'backup', 'importLegacy']);
    assert.equal(await readFile(path.join(source, 'state.json'), 'utf8'), state);
});
test('failed backup never imports and failed import retains recovery files', async t => {
    const { source, target } = await fixture(t), calls = [];
    await assert.rejects(importLegacyDirectory({ directory: source, userData: target, request: async method => {
        calls.push(method); if (method === 'migrationStatus') return { imported: false }; throw Error('backup failed');
    } }), /backup failed/);
    assert.deepEqual(calls, ['migrationStatus', 'backup']);
    await assert.rejects(importLegacyDirectory({ directory: source, userData: target, request: async method => {
        if (method === 'migrationStatus') return { imported: false }; if (method === 'backup') return { backup: { records: [] } }; throw Error('overlap');
    } }), /overlap/);
    assert.equal(await readFile(path.join(source, 'state.json'), 'utf8'), state);
});
test('missing source is a no-op and invalid JSON is not silently discarded', async t => {
    const { source, target } = await fixture(t);
    const request = () => { throw Error('must not call backend'); };
    assert.equal((await importLegacyDirectory({ directory: path.join(source, 'missing'), userData: target, request })).found, false);
    await writeFile(path.join(source, 'state.json'), '{broken');
    await assert.rejects(importLegacyDirectory({ directory: source, userData: target, request }), /JSON/);
});

test('completed imports do not create repeated backups', async t => {
    const { source, target } = await fixture(t);
    const result = await importLegacyDirectory({ directory: source, userData: target, request: async method => {
        if (method === 'migrationStatus') return { status: 'completed' }; assert.equal(method, 'importLegacy'); return { alreadyImported: true };
    } });
    assert.equal(result.alreadyImported, true);
    await assert.rejects(readdir(path.join(target, 'migration-backups')), { code: 'ENOENT' });
});

// Exercise the actual JSON Lines and SQLite boundary, not just a stubbed importer.
test('legacy files survive a real SQLite import and restart without duplicate bytes', async t => {
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { BackendClient } = await import('../electron/backend.cjs');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const executable = process.env.WIFIMETER_BACKEND || path.join(root, process.platform === 'win32' ? 'build/windows/app/wifimeter-backend.exe' : 'build/app/wifimeter-backend');
    if (!existsSync(executable)) { t.skip('Build the real backend to verify migration.'); return; }
    let backend;
    t.after(async () => backend?.stop());
    const { source, target } = await fixture(t);
    const databasePath = path.join(target, 'migration.db');
    backend = new BackendClient({ executable, databasePath, args: ['--paused'] });
    let request = (method, params) => backend.request(method, params);
    const first = await importLegacyDirectory({ directory: source, userData: target, request, allowInitialSettings: true });
    assert.equal(first.status, 'completed');
    await backend.stop();
    backend = new BackendClient({ executable, databasePath, args: ['--paused'] });
    request = (method, params) => backend.request(method, params);
    const again = await importLegacyDirectory({ directory: source, userData: target, request });
    assert.equal(again.alreadyImported, true);
    assert.equal((await readdir(path.join(target, 'migration-backups'))).length, 1);
    const { backup } = await request('backup');
    assert.equal(backup.settings.retention, 0);
    assert.equal(backup.settings.language, 'en');
    assert.equal(backup.records.length, 1);
    assert.equal(backup.records[0].rxBytes, '9007199254740993');
    assert.equal(await readFile(path.join(source, 'state.json'), 'utf8'), state);
    await writeFile(path.join(source, 'state.json'), state.replaceAll('9007199254740993', '9007199254740994'));
    await assert.rejects(importLegacyDirectory({ directory: source, userData: target, request }), /变化|changed/);
    assert.equal((await request('backup')).backup.records[0].rxBytes, '9007199254740993');
});

test('missing or syntactically broken primary uses bak without modifying either file', async t => {
    for (const broken of [null, '{broken']) {
        const { source, target } = await fixture(t);
        if (broken === null) await rm(path.join(source, 'state.json')); else await writeFile(path.join(source, 'state.json'), broken);
        await writeFile(path.join(source, 'state.json.bak'), state);
        const report = await importLegacyDirectory({ directory: source, userData: target, request: async (method, params) => {
            if (method === 'migrationStatus') return { status: 'notImported', canInitializeSettings: true };
            if (method === 'backup') return { backup: {} };
            assert.equal(params.stateJson, state); assert.equal(params.allowInitialSettings, true);
            return { status: 'completed', alreadyImported: false, warnings: ['retained warning'] };
        } });
        assert.equal(report.imported, true); assert.equal(report.sourceFile, 'state.json.bak');
        assert.deepEqual(report.warnings, ['retained warning']);
        assert.equal(await readFile(path.join(source, 'state.json.bak'), 'utf8'), state);
        assert.equal(await readFile(path.join(report.backupDirectory, 'state.json.bak'), 'utf8'), state);
        if (broken !== null) assert.equal(await readFile(path.join(report.backupDirectory, 'state.json'), 'utf8'), broken);
    }
});

test('backend validation or overlap never falls back to a different dataset', async t => {
    const { source, target } = await fixture(t);
    const invalid = state.replace('"SchemaVersion":1', '"SchemaVersion":2');
    await writeFile(path.join(source, 'state.json'), invalid);
    await writeFile(path.join(source, 'state.json.bak'), state);
    const seen = [];
    await assert.rejects(importLegacyDirectory({ directory: source, userData: target, request: async (method, params) => {
        if (method === 'migrationStatus') return { status: 'notImported', canInitializeSettings: true };
        if (method === 'backup') return { backup: {} };
        seen.push(params.stateJson); throw Object.assign(Error('backend semantic failure'), { code: 'LegacyInvalid' });
    } }), /backend semantic failure/);
    assert.deepEqual(seen, [invalid]);
});

test('eligibility query restores initial settings after a failed first attempt', async t => {
    const { source, target } = await fixture(t);
    const cache = '{"SchemaVersion":1,"Records":[],"kept":9007199254740993}';
    await writeFile(path.join(source, 'app-usage.json'), cache);
    let fail = true;
    const request = async (method, params) => {
        if (method === 'migrationStatus') return { status: 'notImported', canInitializeSettings: true };
        if (method === 'backup') { if (fail) throw Error('first backup failed'); return { backup: {} }; }
        assert.equal(params.allowInitialSettings, true); assert.equal(params.appUsageJson, cache);
        return { status: 'completed', settingsApplied: true, warnings: ['cache retained'] };
    };
    await assert.rejects(importLegacyDirectory({ directory: source, userData: target, request }), /first backup failed/);
    fail = false;
    const result = await importLegacyDirectory({ directory: source, userData: target, request, allowInitialSettings: false });
    assert.equal(result.imported, true); assert.deepEqual(result.warnings, ['cache retained']);
    assert.equal(await readFile(path.join(result.backupDirectory, 'app-usage.json'), 'utf8'), cache);
});

test('real retry eligibility and legacy total quota survive pruning and backup restore', async t => {
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { BackendClient } = await import('../electron/backend.cjs');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const executable = process.env.WIFIMETER_BACKEND || path.join(root, process.platform === 'win32' ? 'build/windows/app/wifimeter-backend.exe' : 'build/app/wifimeter-backend');
    if (!existsSync(executable)) { t.skip('Build backend first.'); return; }
    let backend;
    t.after(async () => backend?.stop());
    const { source, target } = await fixture(t);
    await writeFile(path.join(source, 'settings.json'), '{"Language":"zh-CN","RetentionDays":1,"TotalLimit":{"LimitGB":50.0,"WarnPercent":77.0,"Period":"All","DisconnectAtLimit":true}}');
    const totalState = state.slice(0, -1) + ',"QuotaLedger":{"Version":1,"Networks":[],"Total":{"PeriodKey":"All","UsedBytes":9007199254741993.0}}}';
    await writeFile(path.join(source, 'state.json'), totalState);
    backend = new BackendClient({ executable, databasePath: path.join(target, 'retry.db'), args: ['--paused'] });
    const request = (method, params) => backend.request(method, params);
    assert.equal((await request('migrationStatus', { sourceId: 'read-only-probe' })).canInitializeSettings, true);
    await assert.rejects(importLegacyDirectory({ directory: source, userData: target, request: (method, params) => {
        if (method === 'backup') throw Error('interrupted backup'); return request(method, params);
    } }), /interrupted backup/);
    assert.equal((await request('migrationStatus', { sourceId: 'read-only-probe' })).canInitializeSettings, true);
    const result = await importLegacyDirectory({ directory: source, userData: target, request });
    assert.equal(result.imported, true); assert.equal(result.settingsApplied, true);
    assert.equal(result.totalQuotaApplied, true); assert.equal(result.totalLedgerApplied, true);
    assert.equal((await request('migrationStatus', { sourceId: result.sourceId })).canInitializeSettings, false);
    await request('pruneUsage');
    const { backup } = await request('backup');
    assert.equal(backup.records.length, 0);
    assert.equal(backup.totalQuota.settings.capGb, 50);
    assert.equal(backup.totalQuota.settings.period, 'all');
    assert.equal(backup.totalQuota.settings.warnPercent, 77);
    assert.equal(backup.totalQuota.settings.autoDisconnect, true);
    assert.equal(backup.totalQuota.ledgers.find(row => row.period === 'all').usedBytes, '9007199254741993');
    await request('restore', { backup });
    assert.deepEqual((await request('backup')).backup, backup);
    assert.equal((await importLegacyDirectory({ directory: source, userData: target, request })).alreadyImported, true);
});

test('real total quota rejects lossy values with archived warnings and protects existing policy', async t => {
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { BackendClient } = await import('../electron/backend.cjs');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const executable = process.env.WIFIMETER_BACKEND || path.join(root, process.platform === 'win32' ? 'build/windows/app/wifimeter-backend.exe' : 'build/app/wifimeter-backend');
    if (!existsSync(executable)) { t.skip('Build backend first.'); return; }
    let backend; t.after(async () => backend?.stop());
    const { source, target } = await fixture(t);
    for (const [index, token] of ['9223372036854775808.0', '1.5', '9007199254741993'].entries()) {
        backend = new BackendClient({ executable, databasePath: path.join(target, `policy-${index}.db`), args: ['--paused'] });
        const request = (method, params) => backend.request(method, params);
        const original = state.slice(0, -1) + ',"QuotaLedger":{"Version":1,"Networks":[],"Total":{"PeriodKey":"All","UsedBytes":' + token + '}}}';
        await writeFile(path.join(source, 'state.json'), original);
        await writeFile(path.join(source, 'settings.json'), '{"RetentionDays":0,"TotalLimit":{"LimitGB":50,"WarnPercent":80,"Period":"All"}}');
        if (index === 2) {
            await request('updateTotalQuota', { capGb: 7, period: 'all', warnPercent: 65 });
            assert.equal((await request('migrationStatus', { sourceId: 'probe' })).canInitializeSettings, false);
        }
        const result = await importLegacyDirectory({ directory: source, userData: target, request });
        assert.equal(result.totalQuotaApplied, false); assert.equal(result.totalLedgerApplied, false);
        assert.ok(result.warnings.length);
        const { backup } = await request('backup');
        assert.equal(backup.totalQuota.settings.capGb, index === 2 ? 7 : 0);
        assert.equal(backup.legacyImports[0].stateJson, original);
        await backend.stop(); backend = null;
    }
});

// 执行真实 main.cjs 的启动和 IPC 注册；Electron、平台集成和后端都使用内存替身。
async function mainHarness({ legacy, env = { WIFIMETER_USER_DATA: 'isolated' }, login = false, paused = false, confirmResponse = 1 } = {}) {
    const { runInNewContext } = await import('node:vm');
    const { EventEmitter } = await import('node:events');
    const { fileURLToPath, pathToFileURL } = await import('node:url');
    const filename = fileURLToPath(new URL('../electron/main.cjs', import.meta.url));
    const handlers = new Map(), calls = [], systemCalls = [], loginReads = [], confirmations = [];
    let trayInitializations = 0;
    let ready, window;
    class Window extends EventEmitter {
        constructor() { super(); window = this; this.webContents = { mainFrame: { url: '' }, setWindowOpenHandler() {}, on() {}, send() {}, session: { setPermissionRequestHandler() {} } }; }
        async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
        isDestroyed() { return false; }
    }
    let settings = { autoStart: false };
    class Backend extends EventEmitter {
        start() {} async stop() {}
        async request(method, params) {
            calls.push({ method, params });
            if (method === 'hello') return { settings, paused };
            if (method === 'setPaused') paused = params.paused;
            if (method === 'updateSettings') settings = { ...settings, ...params.settings };
            return { settings };
        }
    }
    const app = { isPackaged: true, getVersion: () => '1.2.0', getPath: () => 'isolated', setPath() {}, setName() {}, setAppUserModelId() {}, disableHardwareAcceleration() {}, requestSingleInstanceLock: () => true,
        whenReady: () => ({ then(fn) { ready = fn(); return ready; } }), on() {}, quit() {},
        getLoginItemSettings(options) { loginReads.push(options); return { openAtLogin: login }; } };
    const dialog = { showMessageBox: async (_window, options) => { confirmations.push(options); return { response: confirmResponse }; }, showOpenDialog: async () => ({ filePaths: ['fictional-legacy'] }), showErrorBox() {} };
    const imports = {
        electron: { app, BrowserWindow: Window, dialog, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, Menu: { setApplicationMenu() {} } },
        'node:path': path, 'node:fs': { existsSync: () => true }, 'node:url': { pathToFileURL },
        './files.cjs': { createFileActions: () => ({ saveFile() {}, openBackup() {} }) },
        './backend.cjs': { BackendClient: Backend, resolveExecutable: () => 'fake' },
        './system.cjs': { createSystemIntegration: () => ({ initializeTray() { trayInitializations++; }, applySettings: async value => { systemCalls.push(value); return {}; }, handleWindowClose() {} }) },
        './product.cjs': { applyProductIdentity: () => ({ productName: 'Fixture' }) },
        './legacy.cjs': { legacyDirectory: () => 'fictional-legacy', importLegacyDirectory: legacy || (async () => ({ found: false })) },
        './window-controls.cjs': { createWindowControls: () => ({ read: async () => ({miniWindow:false,closeAction:'tray'}), update: async value => value, publishLive() {}, onMainClose() {}, dispose() {} }) },
        './app-icons.cjs': { registerAppIcons() {} },
        './app-control.cjs': { createAppControl: () => ({ chooseProgram() {}, request() {} }) },
        './updates.cjs': { createUpdateService: () => ({
            settings: async () => ({ checkOnStartup: false }),
            check: async () => ({ state: 'unchecked', checkOnStartup: false }),
            setCheckOnStartup: async checkOnStartup => ({ checkOnStartup }),
            install: async () => { throw Error('Migration tests must not install updates.'); }
        }) },
        './update-handoff.cjs': { launchUpdateHandoff: () => { throw Error('Migration tests must not launch installers.'); } }
    };
    runInNewContext(await readFile(filename, 'utf8'), { require(name) { assert.ok(name in imports, name); return imports[name]; }, __dirname: path.dirname(filename), console,
        process: { platform: 'win32', env, execPath: 'C:/fictional/WiFiMeter.exe', resourcesPath: 'fictional' } }, { filename });
    await ready; await new Promise(resolve => setImmediate(resolve));
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    return { calls, systemCalls, loginReads, confirmations, trayInitializations, invoke: (name, payload) => handlers.get(name)(event, payload) };
}

test('main prevents writes during manual migration, permits reads, and re-pauses after failure', async () => {
    let started, rejectImport, count = 0;
    const running = new Promise(resolve => { started = resolve; });
    const pending = new Promise((_, reject) => { rejectImport = reject; });
    const harness = await mainHarness({ legacy: async () => { if (++count === 1) return { found: false }; started(); return pending; } });
    const importing = harness.invoke('legacy:import'); await running;
    for (const method of ['setPaused', 'collectNow', 'updateSettings', 'updateNetwork', 'updateTotalQuota', 'clearUsage', 'restore', 'importLegacy', 'pruneUsage']) {
        const before = harness.calls.length;
        const result = await harness.invoke('backend:request', { method, params: { paused: false } });
        assert.equal(result.ok, false, method); assert.equal(harness.calls.length, before);
    }
    for (const method of ['hello', 'snapshot', 'migrationStatus', 'backup', 'exportUsage']) assert.equal((await harness.invoke('backend:request', { method })).ok, true);
    rejectImport(Error('fixture import failed')); assert.match((await importing).error, /fixture import failed/);
    assert.equal(harness.calls.at(-1).method, 'setPaused'); assert.equal(harness.calls.at(-1).params.paused, true);
    assert.equal((await harness.invoke('backend:request', { method: 'setPaused', params: { paused: false } })).ok, false);
});

test('first migration inherits only the same executable login item and leaves unmatched entries alone', async () => {
    const legacy = async () => ({ found: true, status: 'completed', settingsApplied: true, alreadyImported: false, warnings: [] });
    const matched = await mainHarness({ legacy, env: {}, login: true });
    assert.equal(matched.loginReads.length, 1);
    assert.equal(matched.loginReads[0].path, 'C:/fictional/WiFiMeter.exe');
    assert.ok(matched.calls.some(call => call.method === 'updateSettings' && call.params.settings.autoStart === true));
    assert.equal(matched.systemCalls.at(-1).autoStart, true);
    const unmatched = await mainHarness({ legacy, env: {}, login: false });
    assert.equal(unmatched.systemCalls.length, 0);
    assert.match((await unmatched.invoke('legacy:status')).warnings.join(' '), /启动项|login/i);
    await unmatched.invoke('backend:request', { method: 'updateSettings', params: { settings: { language: 'en' } } });
    assert.equal(unmatched.systemCalls.length, 0);
    await unmatched.invoke('backend:request', { method: 'updateSettings', params: { settings: { autoStart: true } } });
    assert.equal(unmatched.systemCalls.length, 1);
    const isolated = await mainHarness({ legacy, login: true });
    assert.equal(isolated.loginReads.length, 0); assert.equal(isolated.systemCalls.length, 0);
});


test('overlap policy defaults to reject and explicit keep-existing reaches both import paths', async t => {
    for (const completed of [false, true]) for (const overlapPolicy of [undefined, 'reject', 'keep-existing']) {
        const { source, target } = await fixture(t);
        const result = await importLegacyDirectory({ directory: source, userData: target, overlapPolicy, request: async (method, params) => {
            if (method === 'migrationStatus') return { status: completed ? 'completed' : 'notImported' };
            if (method === 'backup') return { backup: {} };
            assert.equal(params.overlapPolicy, overlapPolicy ?? 'reject');
            return { status: 'completed', skippedDayCount: 2, warnings: ['existing days retained'] };
        } });
        assert.equal(result.skippedDayCount, 2);
        assert.deepEqual(result.warnings, ['existing days retained']);
    }
});

test('invalid overlap policies fail before reading files or calling backend', async () => {
    for (const overlapPolicy of [null, '', 'merge', 'keepexisting', true, 1, {}, []]) {
        await assert.rejects(importLegacyDirectory({ overlapPolicy, request: () => assert.fail('unexpected backend call') }), /overlapPolicy/);
    }
});


test('real overlap import retains SQLite days, imports remaining days and retries safely after rollback', async t => {
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { BackendClient } = await import('../electron/backend.cjs');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const executable = process.env.WIFIMETER_BACKEND || path.join(root, process.platform === 'win32' ? 'build/windows/app/wifimeter-backend.exe' : 'build/app/wifimeter-backend');
    if (!existsSync(executable)) { t.skip('Build backend first.'); return; }
    let backend;
    t.after(async () => backend?.stop());
    const { source, target } = await fixture(t);
    backend = new BackendClient({ executable, databasePath: path.join(target, 'overlap.db'), args: ['--paused'] });
    const request = (method, params) => backend.request(method, params);
    const existing = state.replaceAll('9007199254740993', '17');
    await request('importLegacy', { sourceId: 'seed', stateJson: existing });
    const before = (await request('backup')).backup;
    const original = state.replace('"Days":[', '"Days":[{"Date":"2026-01-02","RxBytes":0,"TxBytes":0},');
    await writeFile(path.join(source, 'state.json'), original);
    await assert.rejects(importLegacyDirectory({ directory: source, userData: target, request }), /相同网络日期|overlap/i);
    assert.deepEqual((await request('backup')).backup, before);
    await writeFile(path.join(source, 'state.json'), original.replace('9007199254740993', '9007199254740994'));
    await assert.rejects(importLegacyDirectory({ directory: source, userData: target, request, overlapPolicy: 'keep-existing' }), /累计总额|total/i);
    assert.deepEqual((await request('backup')).backup, before);
    await writeFile(path.join(source, 'state.json'), original);
    const result = await importLegacyDirectory({ directory: source, userData: target, request, overlapPolicy: 'keep-existing' });
    assert.equal(result.dailyCount, 1); assert.equal(result.skippedDayCount, 1);
    assert.match(result.warnings.join(' '), /2026-01-01/);
    const after = (await request('backup')).backup;
    assert.equal(after.records.length, 2);
    assert.equal(after.records.find(row => row.date === '2026-01-01').rxBytes, '17');
    assert.equal(after.records.find(row => row.date === '2026-01-02').rxBytes, '0');
    assert.equal(after.legacyImports.find(row => row.sourceId === result.sourceId).stateJson, original);
    const again = await importLegacyDirectory({ directory: source, userData: target, request, overlapPolicy: 'keep-existing' });
    assert.equal(again.alreadyImported, true); assert.equal(again.skippedDayCount, 1);
    assert.deepEqual((await request('backup')).backup, after);
    assert.equal(await readFile(path.join(source, 'state.json'), 'utf8'), original);
});

for (const confirmResponse of [0, 1]) test(`manual overlap import requires explicit confirmation: response ${confirmResponse}`, async () => {
    const policies = [];
    let count = 0;
    const harness = await mainHarness({ confirmResponse, legacy: async options => {
        if (++count === 1) return { found: false };
        policies.push(options.overlapPolicy);
        if (options.overlapPolicy === 'reject') throw Object.assign(Error('overlap'), { code: 'LegacyOverlap' });
        return { found: true, status: 'completed', skippedDayCount: 1 };
    } });
    const result = await harness.invoke('legacy:import');
    assert.equal(harness.confirmations.length, 1);
    assert.equal(harness.confirmations[0].cancelId, 1);
    assert.deepEqual(policies, confirmResponse === 0 ? ['reject', 'keep-existing'] : ['reject']);
    assert.equal(harness.calls.at(-1).params.paused, confirmResponse !== 0);
    if (confirmResponse === 0) assert.equal(result.skippedDayCount, 1);
    else assert.equal(result.error, 'overlap');
});

for (const confirmResponse of [0, 1]) test(`resuming after failed migration requires confirmation: response ${confirmResponse}`, async () => {
    const harness = await mainHarness({ confirmResponse, legacy: async () => { throw Error('import failed'); } });
    const result = await harness.invoke('backend:request', { method: 'setPaused', params: { paused: false } });
    assert.equal(harness.confirmations.length, 1);
    assert.equal(result.ok, confirmResponse === 0);
    const status = await harness.invoke('legacy:status');
    if (confirmResponse === 0) {
        assert.equal(status.error, '');
        assert.equal(status.importWarning, 'import failed');
    } else assert.equal(status.error, 'import failed');
});

test('默认托盘在隔离启动和迁移失败跳过设置同步时仍初始化', async () => {
    for (const options of [{}, { env: {}, legacy: async () => { throw Error('migration failed'); } }]) {
        const h = await mainHarness(options);
        assert.equal(h.trayInitializations, 1);
        assert.equal(h.systemCalls.length, 0);
    }
});

test('automatic overlapping legacy history does not pause an existing database', async () => {
    const h = await mainHarness({ legacy: async () => { throw Object.assign(Error('existing dates overlap'), { code: 'LegacyOverlap' }); } });
    assert.ok(h.calls.some(call => call.method === 'setPaused' && call.params.paused === false));
    const status = await h.invoke('legacy:status');
    assert.equal(status.error, undefined);
    assert.equal(status.importWarning, 'existing dates overlap');
    assert.equal(status.imported, false);
    assert.equal(h.confirmations.length, 0);
});
