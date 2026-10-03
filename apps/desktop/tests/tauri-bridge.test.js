import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDesktopBridge } from '../renderer/host/bridge.js';

function electronBridge(file, platform = 'win32') {
    let api;
    const calls = [];
    const events = new Map();
    const electron = {
        contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
        ipcRenderer: {
            invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); },
            on: (channel, listener) => events.set(channel, listener),
            removeListener: channel => events.delete(channel)
        }
    };
    vm.runInNewContext(readFileSync(new URL(file, import.meta.url), 'utf8'), {
        require: name => { assert.equal(name, 'electron'); return electron; }, process: { platform }
    });
    return { api, calls, events };
}

async function tauriBridge(platform = 'win32') {
    const calls = [], removed = [], events = new Map();
    const bridge = await createDesktopBridge({
        platform,
        invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); },
        listen: async (channel, listener) => {
            events.set(channel, listener);
            return () => { removed.push(channel); events.delete(channel); };
        }
    });
    return { ...bridge, calls, removed, events };
}

function shape(value) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
        [key, entry && typeof entry === 'object' ? shape(entry) : typeof entry === 'function' ? 'function' : entry]));
}
const get = (api, name) => name.split('.').reduce((object, key) => object[key], api);

test('Tauri 主窗口和小窗与现有 preload 暴露相同接口', async () => {
    const tauri = await tauriBridge();
    assert.deepEqual(shape(tauri.desktop), shape(electronBridge('../electron/preload.cjs').api));
    assert.deepEqual(shape(tauri.miniDesktop), shape(electronBridge('../electron/mini/preload.cjs').api));
    tauri.dispose();
});

test('Linux Tauri 保留 Linux preload 的平台标识与接口', async () => {
    const tauri = await tauriBridge('linux');
    assert.deepEqual(shape(tauri.desktop), shape(electronBridge('../electron/preload.cjs', 'linux').api));
    tauri.dispose();
});

test('所有桌面操作保留通道、参数和结果，包括 false 与大整数字符串', async () => {
    const tauri = await tauriBridge();
    const electron = electronBridge('../electron/preload.cjs');
    const cases = [
        ['windowPreferences.read', []], ['windowPreferences.update', [{ miniWindow: false }]],
        ['updates.openLink', ['https://github.com/chronicle12345/WiFiMeter/releases']],
        ['updates.status', []], ['updates.setCheckOnStartup', [false]], ['updates.check', []], ['updates.install', []],
        ['appIcons.get', [{ appIds: ['a'] }]], ['appControl.chooseProgram', []],
        ['appControl.request', [{ action: 'block', path: 'C:\\应用\\test.exe' }]],
        ['legacy.status', []], ['legacy.importDirectory', []],
        ['saveFile', [{ content: '9007199254740993' }]], ['openBackup', []],
        ['backend.request', ['hello']], ['backend.request', ['updateSettings', { settings: { interval: 5 } }]]
    ];
    for (const [name, args] of cases) {
        assert.deepEqual(await get(tauri.desktop, name)(...args), await get(electron.api, name)(...args));
        const [channel, payload = null] = electron.calls.at(-1);
        assert.deepEqual(JSON.parse(JSON.stringify(tauri.calls.at(-1))),
            JSON.parse(JSON.stringify(['desktop_request', { channel, payload }])));
    }
    const mini = electronBridge('../electron/mini/preload.cjs');
    for (const name of ['openMain', 'close']) {
        await tauri.miniDesktop[name]();
        await mini.api[name]();
        assert.deepEqual(tauri.calls.at(-1), ['desktop_request', { channel: mini.calls.at(-1)[0], payload: null }]);
    }
    tauri.dispose();
});

test('事件解包并同步返回独立取消函数；dispose 清理全部原生监听', async () => {
    const tauri = await tauriBridge();
    for (const [api, name, channel] of [
        [tauri.desktop, 'windowPreferences.onChanged', 'window-preferences:changed'],
        [tauri.desktop, 'onVisibility', 'window:visibility'], [tauri.desktop, 'updates.onStatus', 'updates:status'],
        [tauri.desktop, 'backend.onEvent', 'backend:event'], [tauri.miniDesktop, 'onLive', 'mini:live'],
        [tauri.miniDesktop, 'onPreferences', 'window-preferences:changed'], [tauri.miniDesktop, 'onState', 'mini:state']
    ]) {
        const values = [], handler = value => values.push(value);
        const first = get(api, name)(handler), second = get(api, name)(handler);
        assert.equal(typeof first, 'function');
        const emit = tauri.events.get(channel);
        emit({ payload: false });
        first(); first();
        emit({ payload: { rxBytes: '9007199254740993' } });
        second();
        emit({ payload: 'ignored' });
        assert.deepEqual(values, [false, false, { rxBytes: '9007199254740993' }]);
    }
    const lateEvent = tauri.events.get('backend:event');
    tauri.desktop.backend.onEvent(() => assert.fail('disposed listener called'));
    tauri.dispose(); tauri.dispose();
    lateEvent({ payload: {} });
    assert.equal(tauri.removed.length, 6);
    assert.equal(tauri.events.size, 0);
});

test('原生订阅全部完成后才返回 bridge；部分注册失败时清理成功项', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    let ready = false, removed = 0;
    const bridge = createDesktopBridge({ invoke: async () => {}, listen: async () => {
        await pending;
        return () => { removed++; };
    } }).then(value => { ready = true; return value; });
    await Promise.resolve();
    assert.equal(ready, false);
    release();
    (await bridge).dispose();
    assert.equal(removed, 6);
    removed = 0;
    await assert.rejects(createDesktopBridge({ invoke: async () => {}, listen: async channel => {
        if (channel === 'backend:event') throw Error('permission denied');
        return () => { removed++; };
    } }), /permission denied/);
    assert.equal(removed, 5);
});

test('后端错误信封不丢错误码，桌面命令拒绝仍可由界面捕获', async () => {
    const result = { ok: false, error: { code: 'LegacyOverlap', message: '重叠日期' } };
    const bridge = await createDesktopBridge({
        listen: async () => () => {},
        invoke: async (_command, { channel }) => {
            if (channel === 'backend:request') return result;
            throw Error('dialog unavailable');
        }
    });
    assert.equal(await bridge.desktop.backend.request('importLegacy', {}), result);
    await assert.rejects(bridge.desktop.openBackup(), /dialog unavailable/);
    bridge.dispose();
});
