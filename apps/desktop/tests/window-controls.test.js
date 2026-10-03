import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createWindowControls } from '../electron/window-controls.cjs';

const miniDefaults = { miniShape: 'bar', miniPalette: 'dark', miniSnap: true, miniAutoHide: true };

async function fixture(t, extra = {}) {
    const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'wifimeter-window-'));
    t.after(() => fs.rm(userData, { recursive: true, force: true }));
    const windows = [], handlers = new Map();
    class Window extends EventEmitter {
        constructor(options) { super(); this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }; this.destroyed = false; this.sent = []; this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: '' }; this.webContents.send = (...args) => this.sent.push(args); this.webContents.setWindowOpenHandler = () => {}; windows.push(this); }
        isDestroyed() { return this.destroyed; }
        loadFile(file) { this.file = file; return Promise.resolve(); }
        show() { assert.fail('小窗不能抢焦点'); }
        showInactive() { this.shown = true; }
        getBounds() { return { ...this.bounds }; }
        setBounds(bounds) { this.bounds = { ...bounds }; this.emit('move'); this.emit('moved'); }
        destroy() { this.destroyed = true; this.emit('closed'); }
    }
    const state = { quits: 0, hides: 0, dialogs: 0, shows: 0 };
    const sent = [];
    const main = { webContents: { mainFrame: { url: new URL('../renderer/index.html', import.meta.url).href }, isDestroyed: () => false, send: (...args) => sent.push(args) }, isDestroyed: () => false, isMinimized: () => false, show: () => state.shows++, focus() {} };
    const deps = { userData, BrowserWindow: Window, platform: 'win32', backgroundTest: false, screen: { getPrimaryDisplay: () => ({ workArea: { x: -1200, y: 20, width: 1200, height: 760 } }) },
        ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
        dialog: { showMessageBox: async (_window, options) => { state.dialogs++; state.dialogOptions = options; return { response: 0, checkboxChecked: true }; } },
        getWindow: () => main, hideToTray: () => { state.hides++; return true; }, requestQuit: () => { state.quits++; }, ...extra };
    const controls = createWindowControls(deps);
    t.after(() => controls.dispose());
    return { controls, deps, state, windows, handlers, userData, main, sent };
}
const closeEvent = () => ({ prevented: false, preventDefault() { this.prevented = true; } });

test('默认关闭到托盘且关闭小窗；并发偏好更新保留彼此字段并可重新读取', async t => {
    const f = await fixture(t);
    assert.deepEqual(await f.controls.read(), { ...miniDefaults, miniWindow: false, closeAction: 'tray', theme: 'system' });
    await Promise.all([f.controls.update({ miniWindow: true }), f.controls.update({ closeAction: 'tray' })]);
    assert.deepEqual(await f.controls.read(), { ...miniDefaults, miniWindow: true, closeAction: 'tray', theme: 'system' });
    f.controls.dispose();
    const restored = createWindowControls(f.deps); t.after(() => restored.dispose());
    assert.deepEqual(await restored.read(), { ...miniDefaults, miniWindow: true, closeAction: 'tray', theme: 'system' });
    assert.equal((await fs.readdir(f.userData)).length, 1);
    await assert.rejects(restored.update({ closeAction: 'bad' }));
});

test('取消为默认选择，重复关闭共用一次异步对话框', async t => {
    let resolve; const pending = new Promise(r => { resolve = r; }); let calls = 0, options;
    const f = await fixture(t, { dialog: { showMessageBox: (_w, o) => { calls++; options = o; return pending; } } });
    await f.controls.update({ closeAction: 'ask' });
    const a = closeEvent(), b = closeEvent();
    const first = f.controls.onMainClose(a), second = f.controls.onMainClose(b);
    assert.equal(first, second); assert.ok(a.prevented && b.prevented);
    await new Promise(r => setImmediate(r));
    assert.equal(calls, 1); assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
    resolve({ response: 0, checkboxChecked: true }); await first;
    assert.deepEqual(await f.controls.read(), { ...miniDefaults, miniWindow: false, closeAction: 'ask', theme: 'system' });
    assert.equal(f.state.quits, 0); assert.equal(f.state.hides, 0);
});

for (const [response, action] of [[1, 'tray'], [2, 'exit']]) test(`记住 ${action} 并通过指定回调执行`, async t => {
    const f = await fixture(t, { dialog: { showMessageBox: async () => ({ response, checkboxChecked: true }) } });
    await f.controls.update({ closeAction: 'ask' });
    await f.controls.onMainClose(closeEvent());
    assert.equal((await f.controls.read()).closeAction, action);
    assert.deepEqual(f.sent.at(-1), ['window-preferences:changed', { ...miniDefaults, miniWindow: false, closeAction: action, theme: 'system' }]);
    assert.equal(action === 'tray' ? f.state.hides : f.state.quits, 1);
});

test('托盘不可用不隐藏、不记住失败选择；已保存 exit 不询问', async t => {
    const f = await fixture(t, { hideToTray: () => false, dialog: { showMessageBox: async () => ({ response: 1, checkboxChecked: true }) } });
    await f.controls.update({ closeAction: 'ask' });
    await f.controls.onMainClose(closeEvent());
    assert.equal((await f.controls.read()).closeAction, 'ask'); assert.equal(f.state.hides, 0);
    await f.controls.update({ closeAction: 'exit' });
    await f.controls.onMainClose(closeEvent()); assert.equal(f.state.quits, 1);
});

test('Windows 小窗位于工作区右下角，复用 live，关闭仅更新小窗偏好', async t => {
    const f = await fixture(t); await f.controls.update({ miniWindow: true });
    const mini = f.windows[0], o = mini.options;
    assert.equal(o.x + o.width, -12); assert.equal(o.y + o.height, 768);
    assert.equal(o.frame, false); assert.equal(o.webPreferences.sandbox, true);
    const live = { event: 'live', state: 'connected', collector: 'running', connections: [{ rxPerSecond: 300, txPerSecond: 100 }] };
    f.controls.publishLive(live); mini.webContents.emit('did-finish-load');
    assert.deepEqual(mini.sent.at(-1), ['mini:live', live]);
    f.controls.publishLive({ event: 'alert' }); assert.equal(mini.sent.length, 2);
    mini.emit('close', closeEvent()); await f.controls.read();
    assert.deepEqual(f.sent.at(-1), ['window-preferences:changed', { ...miniDefaults, miniWindow: false, closeAction: 'tray', theme: 'system' }]);
    assert.equal((await f.controls.read()).miniWindow, false); assert.ok(mini.destroyed); assert.equal(f.state.quits, 0);
});

test('仅接受小窗主框架 IPC，dispose 清理资源且不改持久偏好', async t => {
    const f = await fixture(t); await f.controls.update({ miniWindow: true });
    const mini = f.windows[0];
    assert.throws(() => f.handlers.get('mini:open-main')({ sender: {} }));
    const { pathToFileURL } = await import('node:url');
    mini.webContents.mainFrame.url = pathToFileURL(mini.file).href;
    f.handlers.get('mini:open-main')({ sender: mini.webContents, senderFrame: mini.webContents.mainFrame });
    assert.equal(f.state.shows, 1);
    f.controls.dispose(); assert.equal(f.handlers.size, 0); assert.ok(mini.destroyed);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.userData, 'window-preferences.json'), 'utf8')).miniWindow, true);
});

test('dispose 后未完成的关闭对话框不再退出；非 Windows 不创建小窗', async t => {
    let finish; const f = await fixture(t, { platform: 'linux', dialog: { showMessageBox: () => new Promise(r => { finish = r; }) } });
    await f.controls.update({ miniWindow: true, closeAction: 'ask' }); assert.equal(f.windows.length, 0);
    const pending = f.controls.onMainClose(closeEvent()); await new Promise(r => setImmediate(r));
    f.controls.dispose(); finish({ response: 2, checkboxChecked: true }); await pending;
    assert.equal(f.state.quits, 0);
});

import { createSystemIntegration } from '../electron/system.cjs';
import { liveRates } from '../renderer/mini/rates.js';

test('hideToTray 确认托盘可用后才隐藏，不访问登录启动项', () => {
    for (const failure of ['none', 'constructor', 'menu']) {
        let hidden = 0, destroyed = 0;
        const system = createSystemIntegration({
            app: { setLoginItemSettings() { assert.fail('不得修改注册表'); } }, platform: 'win32',
            Tray: class { constructor() { if (failure === 'constructor') throw Error('failed'); } setToolTip() {} setContextMenu() { if (failure === 'menu') throw Error('failed'); } on() {} destroy() { destroyed++; } },
            Menu: { buildFromTemplate: value => value }, nativeImage: { createFromPath: () => ({}) },
            getWindow: () => ({ isDestroyed: () => false, hide: () => hidden++ })
        });
        assert.equal(system.hideToTray(), failure === 'none');
        assert.equal(hidden, failure === 'none' ? 1 : 0);
        if (failure === 'menu') assert.equal(destroyed, 1);
        system.dispose();
    }
});

test('原子替换失败保留原偏好，清除临时文件且后续更新仍可执行', async t => {
    let fail = false;
    const f = await fixture(t, { fileSystem: { ...fs, rename: async (...args) => { if (fail) throw Error('disk unavailable'); return fs.rename(...args); } } });
    await f.controls.update({ closeAction: 'tray' }); fail = true;
    const count = f.sent.length;
    await assert.rejects(f.controls.update({ closeAction: 'exit' }), /disk unavailable/);
    assert.equal(f.sent.length, count);
    assert.equal((await f.controls.read()).closeAction, 'tray');
    assert.equal(JSON.parse(await fs.readFile(path.join(f.userData, 'window-preferences.json'), 'utf8')).closeAction, 'tray');
    assert.equal((await fs.readdir(f.userData)).length, 1);
    fail = false; await f.controls.update({ closeAction: 'ask' });
    assert.equal((await f.controls.read()).closeAction, 'ask');
});

test('速率汇总多网卡；暂停、离线或无有效计数时显示缺失值', () => {
    const live = { state: 'connected', collector: 'running', connections: [{ rxPerSecond: 1200, txPerSecond: 500 }, { rxPerSecond: 800, txPerSecond: 500 }] };
    assert.deepEqual(liveRates(live), { download: '2.0 KB/s', upload: '1.0 KB/s' });
    for (const patch of [{ collector: 'paused' }, { state: 'offline' }, { connections: [] }, { connections: [{}] }]) {
        assert.deepEqual(liveRates({ ...live, ...patch }), { download: '—', upload: '—' });
    }
});

test('小窗读取后端协议中的字符串速率，缺失值不转换成零', () => {
    const live = { state: 'connected', collector: 'running', connections: [
        { rxPerSecond: '1200', txPerSecond: '500' }, { rxPerSecond: '800', txPerSecond: '500' }
    ] };
    assert.deepEqual(liveRates(live), { download: '2.0 KB/s', upload: '1.0 KB/s' });
    assert.deepEqual(liveRates({ ...live, connections: [{ rxPerSecond: '0', txPerSecond: '0' }] }), { download: '0 B/s', upload: '0 B/s' });
    for (const invalid of ['', ' ', null, undefined, false, '-1', 'Infinity', 'NaN']) {
        assert.deepEqual(liveRates({ ...live, connections: [{ rxPerSecond: invalid, txPerSecond: invalid }] }), { download: '—', upload: '—' });
    }
});

test('应用退出时小窗不拦截关闭，也不清除已保存的启用偏好', async t => {
    let quitting = false;
    const f = await fixture(t, { isQuitting: () => quitting });
    await f.controls.update({ miniWindow: true });
    quitting = true;
    const event = closeEvent();
    f.windows[0].emit('close', event);
    assert.equal(event.prevented, false);
    assert.equal((await f.controls.read()).miniWindow, true);
});

test('主进程更新退出分支在后端已停止后仍释放小窗', async () => {
    const { createRequire } = await import('node:module');
    const { createContext, runInContext } = await import('node:vm');
    const { fileURLToPath } = await import('node:url');
    const filename = fileURLToPath(new URL('../electron/main.cjs', import.meta.url));
    const require = createRequire(import.meta.url);
    const app = new EventEmitter();
    Object.assign(app, { getPath: () => 'fixture', requestSingleInstanceLock: () => false, quit() {} });
    const calls = [];
    const context = createContext({
        require: name => name === 'electron' ? { app } : name === './product.cjs'
            ? { applyProductIdentity: () => ({ productName: 'fixture' }) } : require(name.startsWith('.') ? path.join(path.dirname(filename), name) : name),
        __dirname: path.dirname(filename), process: { platform: 'win32', env: {} }, console,
        fixtureControls: { dispose: () => calls.push('mini') },
        fixtureSystem: { beginQuit() {}, dispose: () => calls.push('tray') }
    });
    runInContext(await fs.readFile(filename, 'utf8'), context);
    runInContext('windowControls = fixtureControls; system = fixtureSystem; backend = null; quitting = true; installingUpdate = true;', context);
    const event = closeEvent();
    app.emit('before-quit', event);
    assert.equal(event.prevented, false);
    assert.deepEqual(calls, ['mini']);
});

 test('首次关闭直接进入托盘，不显示选择对话框', async t => {
    const f = await fixture(t);
    const event = closeEvent();
    assert.equal(await f.controls.onMainClose(event), true);
    assert.equal(event.prevented, true);
    assert.equal(f.state.hides, 1);
    assert.equal(f.state.dialogs, 0);
    assert.equal(f.state.quits, 0);
});

for (const action of ['ask', 'exit']) test(`重新启动保留已保存的 ${action} 偏好`, async t => {
    const f = await fixture(t);
    await f.controls.update({ closeAction: action });
    f.controls.dispose();
    const restored = createWindowControls(f.deps);
    t.after(() => restored.dispose());
    assert.equal((await restored.read()).closeAction, action);
    await restored.onMainClose(closeEvent());
    assert.equal(f.state.dialogs, action === 'ask' ? 1 : 0);
    assert.equal(f.state.quits, action === 'exit' ? 1 : 0);
    assert.equal(f.state.hides, 0);
});

for (const theme of ['light', 'dark', 'system']) test(`theme ${theme} 持久化并发送独立偏好快照`, async t => {
    const f = await fixture(t);
    await Promise.all([f.controls.update({ theme }), f.controls.update({ closeAction: 'ask' })]);
    const expected = { ...miniDefaults, miniWindow: false, closeAction: 'ask', theme };
    assert.deepEqual(await f.controls.read(), expected);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.userData, 'window-preferences.json'), 'utf8')), expected);
    assert.deepEqual(f.sent, [
        ['window-preferences:changed', { ...expected, closeAction: 'tray' }],
        ['window-preferences:changed', expected]
    ]);
    f.sent[1][1].theme = 'invalid';
    assert.deepEqual(await f.controls.read(), expected);
    f.controls.dispose();
    const restored = createWindowControls(f.deps); t.after(() => restored.dispose());
    assert.deepEqual(await restored.read(), expected);
});

test('旧文件和无效 theme 默认跟随系统，非法更新不保存或通知', async t => {
    for (const saved of [{ closeAction: 'exit' }, { closeAction: 'exit', theme: 'invalid' }]) {
        const f = await fixture(t, { fileSystem: { ...fs, readFile: async () => JSON.stringify(saved) } });
        assert.deepEqual(await f.controls.read(), { ...miniDefaults, miniWindow: false, closeAction: 'exit', theme: 'system' });
        for (const theme of ['invalid', '', null, 1, true, {}, undefined]) {
            await assert.rejects(f.controls.update({ theme }), TypeError);
        }
        assert.equal(f.sent.length, 0);
        assert.deepEqual(await fs.readdir(f.userData), []);
    }
});

test('保存后才通知，仅向仍在可信页面的主窗口发送', async t => {
    let f;
    f = await fixture(t, { fileSystem: { ...fs, rename: async (...args) => {
        assert.equal(f.sent.length, 0);
        return fs.rename(...args);
    } } });
    await f.controls.update({ theme: 'dark' });
    assert.equal(f.sent.length, 1);
    f.sent.length = 0;
    f.main.webContents.mainFrame.url = 'https://example.com/';
    await f.controls.update({ theme: 'light' });
    assert.equal(f.sent.length, 0);
    f.main.webContents.mainFrame.url = new URL('../renderer/index.html', import.meta.url).href + '#settings';
    await f.controls.update({ theme: 'system' });
    assert.equal(f.sent.length, 1);
    f.sent.length = 0;
    f.main.isDestroyed = () => true;
    await f.controls.update({ theme: 'dark' });
    assert.equal(f.sent.length, 0);
    f.main.isDestroyed = () => false;
    f.main.webContents.isDestroyed = () => true;
    await f.controls.update({ theme: 'light' });
    assert.equal(f.sent.length, 0);
});

test('小窗关闭 IPC 保存偏好并通知主窗口', async t => {
    const f = await fixture(t);
    await f.controls.update({ miniWindow: true, theme: 'dark' });
    const mini = f.windows[0];
    mini.webContents.mainFrame.url = pathToFileURL(mini.file).href;
    await f.handlers.get('mini:close')({ sender: mini.webContents, senderFrame: mini.webContents.mainFrame });
    assert.deepEqual(f.sent.at(-1), ['window-preferences:changed', { ...miniDefaults, miniWindow: false, closeAction: 'tray', theme: 'dark' }]);
});

test('preload 偏好订阅只传递数据，取消订阅不影响其他监听', async () => {
    const ipcRenderer = new EventEmitter(), calls = [];
    ipcRenderer.invoke = (...args) => { calls.push(args); return Promise.resolve(); };
    let desktop;
    const filename = fileURLToPath(new URL('../electron/preload.cjs', import.meta.url));
    runInNewContext(await fs.readFile(filename, 'utf8'), {
        require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, api) => { desktop = api; } } }),
        process: { platform: 'win32' }
    });
    await desktop.windowPreferences.read();
    await desktop.windowPreferences.update({ theme: 'dark' });
    assert.deepEqual(calls, [['window-preferences:read'], ['window-preferences:update', { theme: 'dark' }]]);
    const received = [], other = [];
    const unsubscribe = desktop.windowPreferences.onChanged((...args) => received.push(args));
    const unsubscribeOther = desktop.windowPreferences.onChanged(value => other.push(value));
    const value = { ...miniDefaults, miniWindow: false, closeAction: 'tray', theme: 'dark' };
    ipcRenderer.emit('window-preferences:changed', { sender: 'private' }, value);
    assert.deepEqual(received, [[value]]);
    unsubscribe(); unsubscribe();
    ipcRenderer.emit('window-preferences:changed', {}, value);
    assert.equal(received.length, 1);
    assert.equal(other.length, 2);
    unsubscribeOther();
    assert.equal(ipcRenderer.listenerCount('window-preferences:changed'), 0);
});


test('小窗新偏好校验、持久化、透明形状与实时通知', async t => {
    const f = await fixture(t);
    for (const patch of [{ miniShape: 'triangle' }, { miniPalette: 'red' }, { miniSnap: 1 }, { miniAutoHide: null }]) {
        await assert.rejects(f.controls.update(patch), TypeError);
    }
    await f.controls.update({ miniWindow: true, miniShape: 'circle', miniPalette: 'light' });
    const mini = f.windows[0];
    assert.equal(mini.options.transparent, true);
    assert.equal(mini.options.focusable, false);
    assert.equal(mini.options.width, mini.options.height);
    mini.webContents.emit('did-finish-load');
    assert.equal(mini.sent[0][0], 'window-preferences:changed');
    assert.equal(mini.sent[0][1].miniShape, 'circle');
    await f.controls.update({ miniShape: 'square', miniPalette: 'indigo' });
    assert.equal(f.windows.length, 1);
    assert.equal(mini.sent.at(-1)[1].miniPalette, 'indigo');
    f.controls.dispose();
    const restored = createWindowControls(f.deps); t.after(() => restored.dispose());
    assert.equal((await restored.read()).miniShape, 'square');
    assert.equal((await restored.read()).miniPalette, 'indigo');
});

test('拖动结束在所在屏幕吸附，闲置收起，靠近展开，关闭设置与 dispose 清理定时器', async t => {
    let now = 0, cursor = { x: 700, y: 500 };
    const tasks = new Map(); let id = 0;
    const screen = new EventEmitter();
    const area = { x: -1600, y: -200, width: 1600, height: 1000 };
    screen.getPrimaryDisplay = screen.getDisplayMatching = () => ({ workArea: area });
    screen.getCursorScreenPoint = () => cursor;
    const f = await fixture(t, { screen, backgroundTest: false, timers: {
        setInterval: fn => { tasks.set(++id, fn); return id; }, clearInterval: key => tasks.delete(key), now: () => now
    } });
    assert.equal(tasks.size, 0);
    await f.controls.update({ miniWindow: true });
    const mini = f.windows[0]; mini.webContents.emit('did-finish-load');
    assert.equal(tasks.size, 1);
    mini.bounds.x = -1592; mini.bounds.y = 100;
    mini.emit('will-move'); mini.emit('moved');
    assert.equal(mini.bounds.x, -1600);
    now = 2000; for (const tick of tasks.values()) tick();
    assert.equal(mini.bounds.width, 6);
    assert.equal(mini.bounds.x, -1600);
    cursor = { x: -1590, y: 130 }; for (const tick of tasks.values()) tick();
    assert.equal(mini.bounds.width, 224);
    cursor = { x: 700, y: 500 }; now = 4000; for (const tick of tasks.values()) tick();
    assert.equal(mini.bounds.width, 6);
    await f.controls.update({ miniAutoHide: false });
    assert.equal(tasks.size, 0); assert.equal(mini.bounds.width, 224);
    await f.controls.update({ miniAutoHide: true }); assert.equal(tasks.size, 1);
    await f.controls.update({ miniSnap: false }); assert.equal(tasks.size, 0);
    await f.controls.update({ miniSnap: true });
    f.controls.dispose(); assert.equal(tasks.size, 0);
    assert.equal(screen.listenerCount('display-removed'), 0);
});

test('后台测试小窗不因屏幕变化或定时器返回前台', async t => {
    let starts = 0;
    const f = await fixture(t, { backgroundTest: true, timers: { setInterval: () => starts++, clearInterval() {}, now: () => 0 } });
    await f.controls.update({ miniWindow: true });
    const mini = f.windows[0]; mini.webContents.emit('did-finish-load');
    await f.controls.update({ miniShape: 'circle' });
    mini.emit('moved');
    assert.equal(mini.bounds.x, -32000); assert.equal(mini.bounds.y, -32000);
    assert.equal(starts, 0);
});
import { miniSize, snapBounds, collapsedBounds, isNear } from '../electron/mini-geometry.cjs';

test('负坐标工作区四边吸附，边条始终留在同一屏幕内', () => {
    const area = { x: -1920, y: -100, width: 1920, height: 1040 };
    const cases = [
        [{ x: -1911, y: 100, width: 224, height: 92 }, 'left', { x: -1920, y: 100, width: 6, height: 92 }],
        [{ x: -229, y: 100, width: 224, height: 92 }, 'right', { x: -6, y: 100, width: 6, height: 92 }],
        [{ x: -900, y: -94, width: 224, height: 92 }, 'top', { x: -900, y: -100, width: 224, height: 6 }],
        [{ x: -900, y: 840, width: 224, height: 92 }, 'bottom', { x: -900, y: 934, width: 224, height: 6 }]
    ];
    for (const [bounds, edge, strip] of cases) {
        const result = snapBounds(bounds, area);
        assert.equal(result.edge, edge);
        assert.deepEqual(collapsedBounds(result.bounds, edge), strip);
        assert.equal(isNear({ x: strip.x, y: strip.y }, strip), true);
        assert.equal(isNear({ x: strip.x - 13, y: strip.y }, strip), false);
    }
    assert.equal(snapBounds({ x: -900, y: 100, ...miniSize('bar') }, area).edge, null);
    assert.equal(snapBounds(cases[0][0], area, false).edge, null);
    assert.deepEqual(snapBounds({ x: 500, y: 800, width: 224, height: 92 }, { x: -300, y: 20, width: 180, height: 80 }, false).bounds,
        { x: -300, y: 20, width: 180, height: 80 });
});

test('吸附屏幕移除后恢复可见位置，变更形状保留右边缘，关闭小窗清理轮询', async t => {
    const screen = new EventEmitter();
    let area = { x: -1600, y: 0, width: 1600, height: 900 };
    screen.getPrimaryDisplay = screen.getDisplayMatching = () => ({ workArea: area });
    screen.getCursorScreenPoint = () => ({ x: 9999, y: 9999 });
    const tasks = new Map(); let id = 0, now = 0;
    const f = await fixture(t, { screen, backgroundTest: false, timers: {
        setInterval: fn => { tasks.set(++id, fn); return id; }, clearInterval: key => tasks.delete(key), now: () => now
    } });
    await f.controls.update({ miniWindow: true });
    const mini = f.windows[0]; mini.webContents.emit('did-finish-load');
    mini.bounds.x = -226; mini.emit('will-move'); mini.emit('moved');
    await f.controls.update({ miniShape: 'circle' });
    assert.equal(mini.bounds.x + mini.bounds.width, 0);
    now = 2000; for (const tick of tasks.values()) tick();
    assert.equal(mini.bounds.width, 6);
    area = { x: 0, y: 30, width: 1280, height: 690 };
    screen.emit('display-removed');
    assert.equal(mini.bounds.width, 168);
    assert.ok(mini.bounds.x >= 0 && mini.bounds.x + mini.bounds.width <= 1280);
    assert.ok(mini.bounds.y >= 30 && mini.bounds.y + mini.bounds.height <= 720);
    await f.controls.update({ miniWindow: false });
    assert.equal(tasks.size, 0);
});

test('小窗 preload 订阅偏好与收起状态不泄露 Electron 事件，取消订阅清理监听', async () => {
    const ipcRenderer = new EventEmitter(); let api;
    const filename = fileURLToPath(new URL('../electron/mini/preload.cjs', import.meta.url));
    runInNewContext(await fs.readFile(filename, 'utf8'), {
        require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } } })
    });
    for (const [method, channel] of [['onPreferences', 'window-preferences:changed'], ['onState', 'mini:state']]) {
        const values = [], payload = { collapsed: true, miniShape: 'circle' };
        const unsubscribe = api[method]((...args) => values.push(args));
        ipcRenderer.emit(channel, { sender: 'private' }, payload);
        assert.deepEqual(values, [[payload]]);
        unsubscribe(); unsubscribe();
        assert.equal(ipcRenderer.listenerCount(channel), 0);
    }
});

test('首次加载近边吸附，拖动期间不收起，工作区变化重新开始闲置计时', async t => {
    const screen = new EventEmitter();
    let area = { x: 0, y: 20, width: 1280, height: 700 }, now = 0;
    screen.getPrimaryDisplay = screen.getDisplayMatching = () => ({ workArea: area });
    screen.getCursorScreenPoint = () => ({ x: 2000, y: 2000 });
    const tasks = new Map(); let id = 0;
    const f = await fixture(t, { screen, timers: {
        setInterval: fn => { tasks.set(++id, fn); return id; }, clearInterval: key => tasks.delete(key), now: () => now
    } });
    await f.controls.update({ miniWindow: true });
    const mini = f.windows[0]; mini.webContents.emit('did-finish-load');
    assert.equal(mini.bounds.x + mini.bounds.width, 1280);
    mini.emit('will-move');
    now = 2000; for (const tick of tasks.values()) tick();
    assert.equal(mini.bounds.width, 224);
    mini.bounds.y = 100; mini.emit('moved');
    now = 2500; for (const tick of tasks.values()) tick();
    assert.equal(mini.bounds.width, 224);
    now = 4000; for (const tick of tasks.values()) tick();
    assert.equal(mini.bounds.width, 6);
    area = { x: 0, y: 60, width: 1200, height: 600 };
    screen.emit('display-metrics-changed');
    assert.equal(mini.bounds.width, 224);
    assert.equal(mini.bounds.x + mini.bounds.width, 1200);
    now = 4500; for (const tick of tasks.values()) tick();
    assert.equal(mini.bounds.width, 224);
    now = 5300; for (const tick of tasks.values()) tick();
    assert.equal(mini.bounds.width, 6);
});
