import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationRows, applicationCsv, applicationPath, historyRange } from '../renderer/data/history.js';

const records = [
    { networkId: 'home', date: '2020-01-01', appId: '/apps/browser', name: '=Browser', rxBytes: '9007199254740993', txBytes: '1' },
    { networkId: 'home', date: '2020-01-31', appId: '/apps/browser', name: '=Browser', rxBytes: '7', txBytes: '2' },
    { networkId: 'home', date: '2020-02-01', appId: '/apps/browser', name: '=Browser', rxBytes: '10', txBytes: '3' },
    { networkId: 'office', date: '2020-01-01', appId: '/apps/browser', name: '=Browser', rxBytes: '500', txBytes: '0' },
    { networkId: 'home', date: '2020-01-01', appId: 'different-id', name: '=Browser', rxBytes: '100', txBytes: '0' }
];

test('按月归并稳定应用标识，按日保留明细，过滤与排序决定导出顺序', () => {
    const options = { networkId: 'home', start: '2020-01-01', end: '2020-02-01', grouping: 'month', sort: 'total', direction: 'desc', search: 'browser' };
    const before = structuredClone(records);
    const rows = applicationRows(records, options);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].date, '2020-01');
    assert.equal(rows[0].rx, 9007199254741000n);
    assert.equal(rows[0].total, 9007199254741003n);
    assert.equal(applicationRows(records, { ...options, grouping: 'day' }).length, 4);
    assert.equal(applicationRows(records, { ...options, search: 'missing' }).length, 0);
    assert.equal(applicationRows(records, { ...options, sort: 'date', direction: 'desc' })[0].date, '2020-02');
    const csv = applicationCsv(rows, 'en');
    assert.ok(csv.startsWith('\uFEFF"Date"'));
    assert.ok(csv.includes('"\'=Browser"'));
    assert.ok(csv.includes('"9007199254741000"'));
    assert.ok(csv.indexOf('9007199254741000') < csv.indexOf('"100"'));
    assert.deepEqual(records, before);
});

test('全部历史不依赖已加载记录，路径仅接受明确完整路径', () => {
    assert.deepEqual(historyRange('all', '2026-10-01'), { start: '0001-01-01', end: '2026-10-01' });
    assert.deepEqual(historyRange('month', '2026-10-01'), { start: '2026-10-01', end: '2026-10-01' });
    assert.equal(applicationPath({ appId: 'hash-id', path: 'C:\\Apps\\Browser.exe' }), 'C:\\Apps\\Browser.exe');
    assert.equal(applicationPath({ appId: '/usr/bin/browser' }), '/usr/bin/browser');
    assert.equal(applicationPath({ appId: 'browser.exe' }), '');
});
