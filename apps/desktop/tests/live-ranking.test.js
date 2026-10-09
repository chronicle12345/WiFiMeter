import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationLiveRows } from '../renderer/data/application-live.js';

const process = (id, rx, tx, extra = {}) => ({ appId: id, name: id, networkId: 'home', processId: 1, rxPerSecond: rx, txPerSecond: tx, ...extra });

test('live ranking sorts all measured applications by total, download or upload speed', () => {
    const processes = [process('download', '900', '10'), process('upload', '20', '1000'), process('warming', null, null),
        ...Array.from({ length: 12 }, (_, i) => process(`idle${i}`, '0', '0'))];
    assert.equal(applicationLiveRows(processes).length, 15);
    assert.deepEqual(applicationLiveRows(processes).slice(0, 2).map(row => row.appId), ['upload', 'download']);
    assert.equal(applicationLiveRows(processes).at(-1).appId, 'warming');
    assert.equal(applicationLiveRows(processes, { sort: 'rx' })[0].appId, 'download');
    assert.equal(applicationLiveRows(processes, { sort: 'tx' })[0].appId, 'upload');
    assert.equal(applicationLiveRows(processes)[0].totalPerSecond, '1020');
});

test('live ranking compares large byte rates without losing precision and filters the selected network', () => {
    const rows = [process('lower', '9007199254740992', '0'), process('higher', '9007199254740993', '0'),
        process('other', '9999999999999999999', '0', { networkId: 'office' })];
    assert.deepEqual(applicationLiveRows(rows, { networkId: 'home' }).map(row => row.appId), ['higher', 'lower']);
});
