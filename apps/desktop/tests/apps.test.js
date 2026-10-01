import test from 'node:test';
import assert from 'node:assert/strict';
import { appUsageInRange, bytePercent, sortApps } from '../renderer/data/model.js';

const row = (appId, rxBytes, txBytes, date = '2026-09-30', networkId = 'home', name = appId) =>
    ({ appId, name, rxBytes, txBytes, date, networkId });

test('应用用量按网络、日期、稳定应用标识聚合，保留精确字节', () => {
    const records = [row('browser', '9007199254740993', '3'), row('browser', '2', '4', '2026-09-29'),
        row('browser', '100', '0', '2026-09-28'), row('browser', '100', '0', '2026-09-30', 'office')];
    const before = structuredClone(records);
    assert.deepEqual(appUsageInRange(records, 'home', '2026-09-29', '2026-09-30'),
        [{ id: 'browser', name: 'browser', rx: 9007199254740995n, tx: 7n, total: 9007199254741002n }]);
    assert.deepEqual(records, before);
    assert.deepEqual(appUsageInRange(records, 'home', '2026-10-01', '2026-10-01'), []);
});

test('排序和搜索不改变应用总量，占比处理零流量和大整数', () => {
    const apps = appUsageInRange([row('Browser', '100', '0'), row('Sync', '1', '199'), row('Zero', '0', '0')],
        'home', '2026-09-30', '2026-09-30');
    assert.deepEqual(sortApps(apps).map(a => a.id), ['Sync', 'Browser', 'Zero']);
    assert.deepEqual(sortApps(apps, 'rx').map(a => a.id), ['Browser', 'Sync', 'Zero']);
    assert.deepEqual(sortApps(apps, 'tx', '  SYNC ').map(a => a.id), ['Sync']);
    assert.equal(bytePercent(apps[0].total, 300n), 33.3);
    assert.equal(bytePercent(0n, 0n), 0);
    assert.equal(bytePercent(18446744073709551615n, 18446744073709551615n), 100);
    assert.equal(apps.length, 3);
    assert.deepEqual(sortApps(apps, 'total', '不存在'), []);
});
