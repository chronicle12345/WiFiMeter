import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendClient } from '../electron/backend.cjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const binary = process.env.WIFIMETER_BACKEND || path.join(root, process.platform === 'win32' ? 'build/windows/app/wifimeter-backend.exe' : 'build/app/wifimeter-backend');

test('total Wi-Fi quota excludes wired history and survives full backup with exact counters', async t => {
    if (!existsSync(binary)) { t.skip('Build backend first'); return; }
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-total-quota-'));
    const backend = new BackendClient({ executable: binary, databasePath: path.join(directory, 'usage.db'), args: ['--paused'] });
    t.after(async () => { await backend.stop(); await rm(directory, { recursive: true, force: true }); });
    const request = (method, params) => backend.request(method, params);
    const backup = {
        version: 1, backupType: 'wifimeter-backend-backup',
        networks: [{ key: 'wifi', ssid: 'Example Wi-Fi', type: 'wifi' }, { key: 'wired', ssid: 'Example Ethernet', type: 'ethernet' }],
        records: [{ date: '2020-01-01', networkId: 'wifi', rxBytes: '300', txBytes: '20' }, { date: '2020-01-01', networkId: 'wired', rxBytes: '1000', txBytes: '50' }],
        appRecords: [], ledgers: [], settings: { retention: 0 }
    };
    await request('restore', { backup });
    const updated = await request('updateTotalQuota', { capGb: 1, warnPercent: 80, period: 'all', notify: true, autoDisconnect: false });
    assert.equal(updated.totalQuota.usedBytes, '320');
    assert.equal(updated.totalQuota.period, 'all');
    const network = await request('updateNetwork', { key: 'wifi', quotaPeriod: 'all' });
    assert.equal(network.network.quotaLedger.usedBytes, '320');
    const exported = (await request('backup')).backup;
    await request('restore', { backup: exported });
    const snapshot = await request('snapshot');
    assert.equal(snapshot.totalQuota.usedBytes, '320');
    assert.equal(snapshot.totalQuota.capGb, 1);
    const broken = structuredClone(exported);
    broken.totalQuota.ledgers[0].usedBytes = '-1';
    await assert.rejects(request('restore', { backup: broken }));
    assert.equal((await request('snapshot')).totalQuota.usedBytes, '320');
    await assert.rejects(request('updateTotalQuota', { period: 'invalid' }));
    await assert.rejects(request('updateTotalQuota', { capGb: -1 }));
});
