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
