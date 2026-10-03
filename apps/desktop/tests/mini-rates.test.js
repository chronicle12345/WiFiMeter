import test from 'node:test';
import assert from 'node:assert/strict';
import { liveRates } from '../renderer/mini/rates.js';

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
