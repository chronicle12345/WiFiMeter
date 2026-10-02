import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppIcons, registerAppIcons } from '../electron/app-icons.cjs';

const id = 'C:\\Apps\\Browser.exe';
const png = 'data:image/png;base64,aWNvbg==';
function setup(options = {}) {
    const calls = [];
    const service = createAppIcons({ platform: 'win32', request: async () => ({ appRecords: [{ appId: id }] }),
        getFileIcon: async file => { calls.push(file); return { isEmpty: () => false, toDataURL: () => png }; }, ...options });
    return { service, calls };
}
test('known executable icons are returned as data URLs and concurrent requests share the cache', async () => {
    const { service, calls } = setup();
    assert.deepEqual(await Promise.all([service.get({ appId: id }), service.get({ appId: id })]), [png, png]);
    assert.deepEqual(calls, [id]);
});
test('unknown IDs, malformed input and non-executable paths never reach the filesystem', async () => {
    const { service, calls } = setup();
    for (const input of [null, {}, { path: id }, { appId: 'C:\\secret.exe' }, { appId: '../a.exe' }, { appId: '\\\\server\\a.exe' }, { appId: 'C:\\a.txt' }, { appId: id, date: '2026-02-31' }]) {
        assert.equal(await service.get(input), null);
    }
    assert.deepEqual(calls, []);
});
test('historical date is used for backend lookup; no renderer path is accepted', async () => {
    const queries = [];
    const { service, calls } = setup({ request: async (method, params) => { queries.push({ method, params }); return { appRecords: [{ appId: id }] }; } });
    assert.equal(await service.get({ appId: id, date: '2020-01-01', path: 'C:\\secret.exe' }), png);
    assert.deepEqual(queries, [{ method: 'snapshot', params: { from: '2020-01-01', to: '2020-01-31' } }]);
    assert.deepEqual(calls, [id]);
});
test('empty images and OS failures fall back without rejecting', async () => {
    for (const getFileIcon of [async () => { throw Error('missing'); }, async () => ({ isEmpty: () => true })]) {
        const { service } = setup({ getFileIcon });
        assert.equal(await service.get({ appId: id }), null);
    }
});
test('bounded cache evicts old icons', async () => {
    const ids = [id, 'C:\\Apps\\Other.exe'];
    const { service, calls } = setup({ maxEntries: 1, request: async () => ({ appRecords: ids.map(appId => ({ appId })) }) });
    for (const appId of [id, ids[1], id]) await service.get({ appId });
    assert.deepEqual(calls, [id, ids[1], id]);
});
test('IPC rejects untrusted frames before querying the backend', async () => {
    let handler, queried = false;
    registerAppIcons({ ipcMain: { handle: (_name, fn) => { handler = fn; } }, trusted: event => event.main === true,
        app: { getFileIcon() {} }, request: async () => { queried = true; } });
    await assert.rejects(async () => handler({ main: false }, { appId: id }), /Unsupported/);
    assert.equal(queried, false);
});
import { applicationAvatar } from '../renderer/ui/applications.js';
import { createAppIconLoader } from '../renderer/ui/app-icons.js';

test('one backend snapshot serves a batch of different applications', async () => {
    let queries = 0;
    const ids = [id, 'C:\\Apps\\Other.exe'];
    const { service } = setup({ request: async () => { queries++; return { appRecords: ids.map(appId => ({ appId })) }; } });
    assert.deepEqual(await Promise.all(ids.map(appId => service.get({ appId, date: '2020-01-01' }))), [png, png]);
    assert.equal(queries, 1);
});
test('malformed backend paths cannot bypass path validation', async () => {
    for (const file of ['C:\\Apps\\..\\secret.exe', '\\\\server\\app.exe', 'C:\\app.exe:stream.exe', 'C:\\app.txt', 'app.exe']) {
        const { service, calls } = setup({ request: async () => ({ appRecords: [{ appId: id, path: file }] }) });
        assert.equal(await service.get({ appId: id }), null); assert.deepEqual(calls, []);
    }
});
test('compact avatar uses CSS classes and unknown apps do not request guessed paths', () => {
    const esc = text => String(text).replaceAll('"', '&quot;');
    assert.match(applicationAvatar({ id, path: id, name: 'Browser' }, esc, true), /app-avatar--compact/);
    assert.doesNotMatch(applicationAvatar({ id, path: id, name: 'Browser' }, esc, true), /style=/);
    assert.doesNotMatch(applicationAvatar({ id: 'browser', name: 'Browser' }, esc), /data-app-icon=/);
});
test('renderer queues a large avatar batch instead of overloading IPC', async () => {
    let active = 0, peak = 0, count = 0;
    const loader = createAppIconLoader({ request: async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; count++; return null; } });
    const nodes = Array.from({ length: 20 }, (_, i) => ({ dataset: { appIcon: String(i) }, querySelector: () => null, isConnected: true }));
    loader.hydrate({ querySelectorAll: () => nodes });
    for (let i = 0; i < 30 && count < 20; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(count, 20); assert.ok(peak <= 4); loader.stop();
});
