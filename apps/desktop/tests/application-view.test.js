import test from 'node:test';
import assert from 'node:assert/strict';
import * as viewModule from '../renderer/data/application-view.js';

const records = [
    { networkId: 'home', date: '2026-10-01', appId: 'browser', name: 'Browser', rxBytes: '100', txBytes: '10' },
    { networkId: 'home', date: '2026-10-02', appId: 'browser', name: 'Browser', rxBytes: '200', txBytes: '20' },
    { networkId: 'home', date: '2026-10-02', appId: 'chat', name: 'Chat', rxBytes: '50', txBytes: '5' },
    { networkId: 'office', date: '2026-10-02', appId: 'other', name: 'Other', rxBytes: '999', txBytes: '1' }
];
const range = { start: '2026-10-01', end: '2026-10-31' };

test('application view preserves the unsearched total while rows follow search and sorting', () => {
    const data = viewModule.applicationViewData({ records, networkId: 'home', range, context: { appGrouping: 'summary', appSearch: 'Browser', appSort: 'total' } });
    assert.equal(data.total, 385n);
    assert.equal(data.hasRecords, true);
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0].total, 330n);
    const empty = viewModule.applicationViewData({ records, networkId: 'home', range, context: { appGrouping: 'summary', appSearch: 'missing' } });
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.total, data.total);
    assert.equal(empty.hasRecords, true);
});

test('grouped application rows respect date, network, direction and zero-byte records', () => {
    const options = { records, networkId: 'home', range, context: { appGrouping: 'day', appSearch: 'Browser', historySort: 'total', historyDirection: 'asc' } };
    const data = viewModule.applicationViewData(options);
    assert.equal(data.total, 385n);
    assert.deepEqual(data.rows.map(row => row.total), [110n, 220n]);
    const zero = viewModule.applicationViewData({ ...options, records: [{ ...records[0], rxBytes: '0', txBytes: '0' }] });
    assert.equal(zero.total, 0n);
    assert.equal(zero.hasRecords, true);
    const absent = viewModule.applicationViewData({ ...options, range: { start: '2026-11-01', end: '2026-11-02' } });
    assert.equal(absent.hasRecords, false);
    assert.deepEqual(absent.rows, []);
});

test('minute view clips only the selected boundaries and each call reflects in-place increments', () => {
    const source = ['08:00', '08:01', '08:02'].map(time => ({ ...records[0], time, rxBytes: '10', txBytes: '1' }));
    const options = { records: source, networkId: 'home', range: { start: '2026-10-01', end: '2026-10-01', startTime: '08:01', endTime: '08:02' }, context: { appGrouping: 'minute', historySort: 'date', historyDirection: 'asc' } };
    assert.equal(viewModule.applicationViewData(options).total, 22n);
    source[1].rxBytes = '30';
    const data = viewModule.applicationViewData(options);
    assert.equal(data.total, 42n);
    assert.deepEqual(data.rows.map(row => row.rx), [30n, 10n]);
});

test('live view uses only current processes and never reads historical records', () => {
    const options = { view: 'live', networkId: 'home', collecting: true, context: { liveSearch: 'Browser', liveSort: 'tx' }, processes: [
        { appId: 'browser', name: 'Browser', processId: 1, networkId: 'home', rxPerSecond: '100', txPerSecond: '5' },
        { appId: 'chat', name: 'Chat', processId: 2, networkId: 'home', rxPerSecond: '200', txPerSecond: '10' }
    ], get records() { throw Error('live view scanned history'); } };
    const data = viewModule.applicationViewData(options);
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0].rxPerSecond, '100');
    options.collecting = false;
    assert.deepEqual(viewModule.applicationViewData(options).rows, []);
});
