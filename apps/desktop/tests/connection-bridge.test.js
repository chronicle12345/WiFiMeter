import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createNativeAdapter } from '../tauri/native-adapter.cjs';
import { tauriBridge } from './helpers/tauri-bridge.js';

test('connection bridge preserves read queries, exact byte counters and status subscriptions', async () => {
    const status = { enabled: true, hasSecret: true, state: 'connected' };
    const record = { id: 'synthetic', downloadBytes: '9007199254740993', uploadBytes: '7' };
    const fixture = tauriBridge({ invoke: async channel => channel === 'connections:read'
        ? { ...status, records: [record] } : status });
    const api = fixture.api.connections, query = { id: 'synthetic', limit: 1 };
    assert.deepEqual(await api.status(), status);
    const result = await api.read(query);
    assert.equal(result.records[0].downloadBytes, '9007199254740993');
    assert.equal(result.secret, undefined);
    await api.configure({ enabled: true });
    await api.refresh();
    await api.clear();
    assert.deepEqual(fixture.calls.map(([channel]) => channel), [
        'connections:status', 'connections:read', 'connections:configure', 'connections:refresh', 'connections:clear'
    ]);
    assert.deepEqual(fixture.calls[1][1], query);
    const received = [], unsubscribe = api.onStatus(value => received.push(value));
    fixture.send('connections:status', status);
    unsubscribe();
    fixture.send('connections:status', { ...status, state: 'error' });
    assert.deepEqual(received, [status]);
});

test('connection host channels accept the main window and reject mini and unknown windows', async t => {
    const messages = [], inputs = [], channels = ['status', 'read', 'configure', 'refresh', 'clear'];
    const adapter = createNativeAdapter({
        send: message => messages.push(message),
        configuration: { userData: fileURLToPath(new URL('../../../del/connection-bridge/', import.meta.url)), platform: 'win32' },
        execute: () => assert.fail('No system operation belongs in this bridge test.'),
        executeAsync: async () => assert.fail('No system operation belongs in this bridge test.')
    });
    t.after(() => adapter.disconnect());
    const main = new adapter.api.BrowserWindow({ show: false, width: 600, height: 400 });
    new adapter.api.BrowserWindow({ show: false, width: 200, height: 100 });
    for (const action of channels) adapter.api.ipcMain.handle(`connections:${action}`, (event, input) => {
        assert.equal(event.sender, main.webContents);
        inputs.push(input);
        return { enabled: true, hasSecret: true };
    });
    let id = 0;
    for (const action of channels) {
        const channel = `connections:${action}`, query = { id: 'synthetic', limit: 1 };
        await adapter.receive({ type: 'request', id: ++id, window: 'main', channel, args: [query] });
        assert.equal(messages.at(-1).ok, true);
        assert.deepEqual(inputs.at(-1), query);
        const count = inputs.length;
        for (const window of ['mini', 'other']) {
            await adapter.receive({ type: 'request', id: ++id, window, channel, args: [query] });
            assert.equal(messages.at(-1).ok, false);
            assert.equal(inputs.length, count);
        }
    }
    await adapter.receive({ type: 'request', id: ++id, window: 'main', channel: 'connections:read', args: {} });
    assert.equal(messages.at(-1).ok, false);
    assert.equal(inputs.length, channels.length);
    assert.ok(messages.every(message => message.type === 'response'));
});

test('mini page exposes no connection configuration or controller access', () => {
    const fixture = tauriBridge({ mini: true });
    assert.equal(Object.hasOwn(fixture.api, 'connections'), false);
    assert.equal(fixture.window.desktop, undefined);
});
