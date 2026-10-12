import test from 'node:test';
import assert from 'node:assert/strict';
import { miniRange, miniApplicationRows } from '../host/mini-usage.cjs';

const minute = (date, time, patch = {}) => ({ networkId: 'home', appId: 'browser', name: 'Browser', date, time,
    hour: Number(time.slice(0, 2)), minute: Number(time.slice(3)), rxBytes: '10', txBytes: '1', ...patch });
const live = processes => ({ state: 'connected', collector: 'running', appCollection: { enabled: true, state: 'running' }, appProcesses: processes });

test('最近时段按本地分钟包含当前分钟，跨日和自定义时长保留正确起点', () => {
    const now = new Date(2026, 9, 1, 0, 1, 45, 750).getTime();
    const expected = {
        '1m': ['2026-10-01', '00:01', 1],
        '5m': ['2026-09-30', '23:57', 5],
        '1h': ['2026-09-30', '23:02', 60],
        custom: ['2026-09-30', '23:45', 17]
    };
    for (const [miniRangeKey, [from, fromTime, minutes]] of Object.entries(expected)) {
        assert.deepEqual(miniRange({ miniRange: miniRangeKey, miniCustomMinutes: 17 }, now),
            { from, fromTime, to: '2026-10-01', toTime: '00:01', minutes });
    }
});

test('分钟用量跨网络精确归并，速度按全部应用排序且回环流量不重复计入', () => {
    const range = miniRange({ miniRange: '5m' }, new Date(2026, 9, 1, 0, 1, 45).getTime());
    const snapshot = { appMinuteRecords: [minute('2026-09-30', '23:56', { rxBytes: '99999' }),
        minute('2026-09-30', '23:57', { rxBytes: '9007199254740993' }),
        minute('2026-10-01', '00:01', { networkId: 'office', rxBytes: '7', txBytes: '2' }),
        minute('2026-10-01', '00:02', { rxBytes: '99999' })] };
    const processes = [{ appId: 'browser', name: 'Browser', rxPerSecond: '10', txPerSecond: '1' },
        { appId: 'browser', name: 'Browser', rxPerSecond: '2', txPerSecond: '3' },
        { appId: 'browser', name: 'Browser', scope: 'loopback', rxPerSecond: '10000', txPerSecond: '10000' },
        { appId: 'upload', name: 'Uploader', rxPerSecond: '1', txPerSecond: '1000' },
        ...Array.from({ length: 12 }, (_, i) => ({ appId: `idle${i}`, rxPerSecond: '0', txPerSecond: '0' }))];
    const saved = structuredClone(snapshot);
    const result = miniApplicationRows(snapshot, live(processes), range);
    assert.equal(result.rows.length, 14); assert.equal(result.rows[0].appId, 'upload');
    assert.deepEqual(result.rows[1], { appId: 'browser', name: 'Browser', rxBytes: '9007199254741000', txBytes: '3',
        rxPerSecond: '12', txPerSecond: '4', measurementAvailable: true });
    assert.deepEqual(snapshot, saved);
});

test('缺失的分钟用量和不可测速度保留缺失值，旧每日与小时记录不补造分钟用量', () => {
    const range = miniRange({ miniRange: '1m' }, new Date(2026, 9, 1, 8, 15).getTime());
    const legacy = { appRecords: [{ date: range.from, appId: 'browser', name: 'Browser', rxBytes: '500', txBytes: '5' }],
        hourly: [{ date: range.from, hour: 8, rxBytes: '500', txBytes: '5' }] };
    const processes = [{ appId: 'browser', name: 'Browser', rxPerSecond: '100', txPerSecond: '10' },
        { appId: 'browser', name: 'Browser', measurementAvailable: false, rxPerSecond: '0', txPerSecond: '0' }];
    assert.deepEqual(miniApplicationRows(legacy, live(processes), range).rows, [{ appId: 'browser', name: 'Browser',
        rxBytes: null, txBytes: null, rxPerSecond: null, txPerSecond: null, measurementAvailable: false }]);
    assert.deepEqual(miniApplicationRows(legacy, live([]), range).rows, []);
});

test('停止或暂停采集后保留真实分钟用量，速度不沿用旧采样', () => {
    const range = miniRange({ miniRange: '1m' }, new Date(2026, 9, 1, 8, 15).getTime());
    const snapshot = { appMinuteRecords: [minute(range.from, '08:15')] };
    const processes = [{ appId: 'browser', name: 'Browser', rxPerSecond: '100', txPerSecond: '10' }];
    for (const status of [
        { ...live(processes), collector: 'paused' },
        { ...live(processes), state: 'disconnected' },
        { ...live(processes), appCollection: { enabled: false, state: 'disabled' } },
        { ...live(processes), appCollection: { enabled: true, state: 'unavailable' } }
    ]) {
        assert.deepEqual(miniApplicationRows(snapshot, status, range).rows, [{ appId: 'browser', name: 'Browser',
            rxBytes: '10', txBytes: '1', rxPerSecond: null, txPerSecond: null, measurementAvailable: false }]);
    }
});
