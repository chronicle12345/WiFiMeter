import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';

function bridge(runtime) {
    let desktop, receive;
    if (runtime === 'Electron') {
        const ipcRenderer = {
            invoke: async () => {}, on: (channel, listener) => { if (channel === 'window:visibility') receive = listener; },
            removeListener: () => {}
        };
        runInNewContext(fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8'), {
            process: { platform: 'win32' }, require: () => ({ ipcRenderer,
                contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'desktop') desktop = value; } } })
        });
        return { desktop, send: state => receive({}, state) };
    }
    const window = { __TAURI__: { core: { invoke: async () => {} }, event: {
        listen: async (_channel, listener) => { receive = listener; }
    } } };
    runInNewContext(fs.readFileSync(new URL('../tauri/bridge.js', import.meta.url), 'utf8'), {
        window, location: { pathname: '/index.html' }, navigator: { userAgent: 'Windows' }, console
    });
    return { desktop: window.desktop, send: state => receive({ payload: { channel: 'window:visibility', payload: state } }) };
}

for (const runtime of ['Electron', 'Tauri']) test(`${runtime} visibility bridge preserves background state and accepts legacy booleans`, () => {
    const fixture = bridge(runtime), received = [];
    fixture.desktop.onVisibility((visible, backgroundTest) => received.push([visible, backgroundTest]));
    fixture.send({ visible: true, backgroundTest: true });
    fixture.send({ visible: false, backgroundTest: true });
    fixture.send({ visible: true, backgroundTest: false });
    fixture.send(false);
    fixture.send(true);
    assert.deepEqual(received, [[true, true], [false, true], [true, false], [false, false], [true, false]]);
});
