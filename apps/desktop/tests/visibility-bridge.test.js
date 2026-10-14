import test from 'node:test';
import assert from 'node:assert/strict';
import { tauriBridge } from './helpers/tauri-bridge.js';

function bridge() {
    const fixture = tauriBridge();
    return { desktop: fixture.api, send: state => fixture.send('window:visibility', state) };
}

test('Tauri visibility bridge preserves background state and accepts legacy booleans', () => {
    const fixture = bridge(), received = [];
    fixture.desktop.onVisibility((visible, backgroundTest) => received.push([visible, backgroundTest]));
    fixture.send({ visible: true, backgroundTest: true });
    fixture.send({ visible: false, backgroundTest: true });
    fixture.send({ visible: true, backgroundTest: false });
    fixture.send(false);
    fixture.send(true);
    assert.deepEqual(received, [[true, true], [false, true], [true, false], [false, false], [true, false]]);
});

test('Tauri replays the latest visibility state after delayed page initialization', () => {
    const fixture = bridge(), received = [];
    fixture.send({ visible: true, backgroundTest: true });
    fixture.send({ visible: false, backgroundTest: true });
    const stop = fixture.desktop.onVisibility((visible, backgroundTest) => received.push([visible, backgroundTest]));
    assert.deepEqual(received, [[false, true]], '初始化期间只保留最新可见状态');
    stop();
    fixture.send({ visible: true, backgroundTest: true });
    assert.deepEqual(received, [[false, true]], '取消订阅后不再发送状态');
});

test('mini bridge retains a newer pin event when an older preference read arrives late', async () => {
    let finishRead;
    const fixture = tauriBridge({ mini: true, invoke: channel => channel === 'mini:preferences-read'
        ? new Promise(resolve => { finishRead = resolve; }) : null });
    const pending = fixture.api.preferences.read();
    await new Promise(resolve => setImmediate(resolve));
    fixture.send('window-preferences:changed', { miniPinned: false });
    finishRead({ miniPinned: true });
    assert.equal((await pending).miniPinned, false, '旧响应不能覆盖最新固定状态');
    fixture.pointerDown();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.calls.at(-1)[0], 'mini:drag');
    fixture.send('window-preferences:changed', { miniPinned: true });
    fixture.pointerDown();
    assert.equal(fixture.calls.filter(([channel]) => channel === 'mini:drag').length, 1);
});
