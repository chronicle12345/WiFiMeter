import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const selection = require('../host/backup-selection.cjs');
const { createWebdavClient, parseListing } = require('../host/webdav.cjs');
const { createCloudBackup } = require('../host/cloud-backup.cjs');

const now = new Date(2026, 10, 18, 12, 0, 0);
const full = () => ({
    backupType: 'wifimeter-backend-backup', version: 1,
    settings: { language: 'zh-CN' }, proxyConfig: [{ id: '1' }],
    networks: [{ key: 'home', ssid: 'Home' }], ledgers: [{ networkId: 'home', usedBytes: '5' }], totalQuota: { capGb: 2 },
    records: [{ networkId: 'home', date: '2026-11-01', rxBytes: '1', txBytes: '1' }, { networkId: 'home', date: '2026-11-18', rxBytes: '2', txBytes: '2' }],
    hourlyRecords: [{ networkId: 'home', date: '2026-11-18', hour: '3', rxBytes: '2', txBytes: '2' }],
    appRecords: [{ networkId: 'home', date: '2026-11-01', appId: 'a' }, { networkId: 'home', date: '2026-11-18', appId: 'a' }],
    minuteRecords: [{ networkId: 'home', date: '2026-11-18', hour: '3', minute: '1' }],
    gaps: [{ id: '1' }]
});

test('selection keeps only the chosen sections and recent days, and usage always brings networks', () => {
    assert.deepEqual(selection.normalizeSections(['hourly', 'bogus']), ['networks', 'hourly']);
    assert.deepEqual(selection.normalizeSections(['settings', 'logs']), ['settings', 'logs']);
    assert.equal(selection.cutoffDay(7, now), '2026-11-12');
    assert.equal(selection.cutoffDay(0, now), '');
    const document = selection.selectBackup(full(), { sections: ['daily'], days: 7, device: 'pc', now });
    assert.deepEqual(document.sections, ['networks', 'daily']);
    assert.equal(document.from, '2026-11-12');
    assert.deepEqual(document.records.map(row => row.date), ['2026-11-18']);
    assert.equal(document.networks.length, 1);
    for (const field of ['settings', 'hourlyRecords', 'appRecords', 'minuteRecords', 'gaps', 'logs']) assert.equal(document[field], undefined);
    assert.equal(selection.selectBackup(full(), { sections: ['settings', 'logs'], logs: 'line', now }).logs, 'line');
    assert.throws(() => selection.selectBackup({ backupType: 'other' }), /完整备份/);
    assert.deepEqual(selection.summarize(document), { device: 'pc', createdAt: now.toISOString(), sections: ['networks', 'daily'], from: '2026-11-12', networks: 1, days: 1, hours: 0, apps: 0 });
});

test('merge replaces only what the cloud backup covers and keeps the rest of the local data', () => {
    const local = full();
    local.networks.push({ key: 'office', ssid: 'Office' });
    local.ledgers.push({ networkId: 'office', usedBytes: '9' });
    const cloud = { backupType: 'wifimeter-cloud-backup', version: 1, sections: ['networks', 'daily'], from: '2026-11-10',
        networks: [{ key: 'home', ssid: 'Home', alias: 'remote' }], ledgers: [{ networkId: 'home', usedBytes: '7' }],
        records: [{ networkId: 'home', date: '2026-11-18', rxBytes: '99', txBytes: '0' }] };
    const merged = selection.mergeBackup(local, cloud);
    assert.deepEqual(merged.records.map(row => [row.date, row.rxBytes]), [['2026-11-01', '1'], ['2026-11-18', '99']]);
    assert.deepEqual(merged.networks.map(network => [network.key, network.alias]), [['home', 'remote'], ['office', undefined]]);
    assert.deepEqual(merged.ledgers.map(ledger => ledger.usedBytes), ['7', '9']);
    assert.deepEqual(merged.settings, local.settings);
    assert.deepEqual(merged.appRecords, local.appRecords);
    assert.deepEqual(merged.gaps, local.gaps);
    assert.equal(merged.backupType, 'wifimeter-backend-backup');
    // Without a day limit the dated section is replaced completely.
    assert.deepEqual(selection.mergeBackup(local, { ...cloud, from: '' }).records.map(row => row.date), ['2026-11-18']);
    for (const bad of [null, { backupType: 'x' }, { ...cloud, version: 2 }, { ...cloud, from: 'yesterday' }, { ...cloud, records: [{}] }, { ...cloud, sections: 'all' }]) {
        assert.throws(() => selection.mergeBackup(local, bad));
    }
});

test('file names carry a safe device name and time, and only this device\'s older backups expire', () => {
    const name = selection.backupFileName('My PC/一号', new Date('2026-11-18T04:05:06Z'));
    assert.equal(name, 'wifimeter_My-PC_20261118T040506Z.json.gz');
    assert.deepEqual(selection.parseBackupFileName(name), { device: 'My-PC', createdAt: '2026-11-18T04:05:06.000Z' });
    for (const other of ['notes.txt', 'wifimeter_x_20261118.json.gz', 'wifimeter_x_20261340T000000Z.json.gz']) assert.equal(selection.parseBackupFileName(other), null);
    const files = ['wifimeter_pc_20261101T000000Z.json.gz', 'wifimeter_pc_20261103T000000Z.json.gz', 'wifimeter_pc_20261102T000000Z.json.gz',
        'wifimeter_laptop_20261001T000000Z.json.gz', 'readme.md'].map(name => ({ name }));
    assert.deepEqual(selection.expiredBackups(files, 'pc', 1), ['wifimeter_pc_20261101T000000Z.json.gz', 'wifimeter_pc_20261102T000000Z.json.gz']);
    assert.deepEqual(selection.expiredBackups(files, 'pc', 5), []);
    assert.deepEqual(selection.expiredBackups(files, 'pc', 0), []);
});

test('WebDAV client validates the address, sends Basic credentials and explains failures', async () => {
    for (const url of ['not a url', 'ftp://host/dav', 'https://user:pass@host/dav']) assert.throws(() => createWebdavClient({ url }));
    const calls = [];
    let reply = () => new Response('', { status: 201 });
    const client = createWebdavClient({ url: 'https://dav.example/backup', username: 'me', password: 'p@ss', fetch: async (target, options) => { calls.push({ url: String(target), ...options }); return reply(); } });
    await client.upload('wifimeter a.json.gz', Buffer.from('x'));
    assert.equal(calls[0].url, 'https://dav.example/backup/wifimeter%20a.json.gz');
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].headers.Authorization, 'Basic ' + Buffer.from('me:p@ss').toString('base64'));
    assert.equal(calls[0].redirect, 'error');
    reply = () => new Response('', { status: 405 });
    await client.ensureDirectory();
    await assert.rejects(client.upload('a', Buffer.from('x')), /返回 405/);
    for (const [status, message] of [[401, /用户名或密码/], [404, /找不到/], [507, /空间不足/]]) {
        reply = () => new Response('', { status });
        await assert.rejects(client.list(), message);
    }
    reply = () => new Response('', { status: 404 });
    await client.remove('gone');
    reply = () => new Response('123456', { status: 200 });
    await assert.rejects(client.download('big', 3), /过大/);
    assert.equal((await client.download('ok', 10)).toString(), '123456');
    reply = () => { throw Object.assign(Error('fetch failed'), { cause: Error('ENOTFOUND') }); };
    await assert.rejects(client.list(), /无法连接 WebDAV 服务器：ENOTFOUND/);
});

test('listing parser handles namespace prefixes, encoded names and skips collections', () => {
    const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
        <D:response><D:href>/dav/backup/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
        <D:response><D:href>/dav/backup/wifimeter_pc_20261118T000000Z.json.gz</D:href><D:propstat><D:prop><D:getcontentlength>42</D:getcontentlength><D:getlastmodified>Wed, 18 Nov 2026 00:00:00 GMT</D:getlastmodified></D:prop></D:propstat></D:response>
        <response xmlns="DAV:"><href>https://dav.example/dav/backup/a%20b.txt</href></response>
        <D:response><D:href>/elsewhere/x.gz</D:href></D:response></D:multistatus>`;
    assert.deepEqual(parseListing(xml, '/dav/backup/'), [
        { name: 'wifimeter_pc_20261118T000000Z.json.gz', size: 42, modifiedAt: '2026-11-18T00:00:00.000Z' },
        { name: 'a b.txt', size: 0, modifiedAt: '' }]);
});

// An in-memory WebDAV collection and file system for the service.
function harness({ config } = {}) {
    const remote = new Map(), files = new Map(), restored = [], changes = [];
    if (config) files.set('cloud-backup.json', JSON.stringify(config));
    const base = name => name.replace(/^.*[\\/]/, '');
    let clock = new Date(now), failUpload = false;
    const service = createCloudBackup({
        userData: '/data', device: 'pc', now: () => clock, logs: () => 'log line',
        request: async method => { assert.equal(method, 'backup'); return { backup: full() }; },
        restore: async document => { restored.push(document); },
        io: { readFile: async name => { if (!files.has(base(name))) throw Error('ENOENT'); return files.get(base(name)); }, writeFile: async (name, body) => { files.set(base(name), body); } },
        secrets: { protect: async text => 'test:' + text.split('').reverse().join(''), reveal: async stored => stored.slice(5).split('').reverse().join('') },
        createClient: options => {
            if (!/^https?:/.test(options.url)) throw Error('WebDAV 地址无效。');
            return { options, ensureDirectory: async () => {}, list: async () => [...remote].map(([name, bytes]) => ({ name, size: bytes.length, modifiedAt: '' })),
                upload: async (name, bytes) => { if (failUpload) throw Error('WebDAV 存储空间不足。'); remote.set(name, bytes); },
                download: async name => { if (!remote.has(name)) throw Error('WebDAV 上找不到这个目录或文件。'); return remote.get(name); },
                remove: async name => { remote.delete(name); } };
        },
        onChange: state => changes.push(state.busy)
    });
    return { service, remote, files, restored, changes, tick: ms => { clock = new Date(clock.getTime() + ms); }, failUploads: value => { failUpload = value; } };
}

test('settings never expose the password and invalid values leave the saved configuration unchanged', async () => {
    const { service, files } = harness();
    assert.deepEqual((await service.status()).sections, ['settings', 'networks', 'daily', 'apps']);
    const saved = await service.configure({ url: ' https://dav.example/x ', username: 'me', password: 'secret', sections: ['hourly', 'logs'], days: 30, keep: 2, auto: true, interval: 'hourly' });
    assert.deepEqual([saved.url, saved.hasPassword, saved.sections, saved.days, saved.auto, saved.device], ['https://dav.example/x', true, ['networks', 'hourly', 'logs'], 30, true, 'pc']);
    assert.equal(saved.secret, undefined);
    assert.equal(JSON.parse(files.get('cloud-backup.json')).secret, 'test:terces');
    assert.ok(!files.get('cloud-backup.json').includes('"secret":"secret"'));
    for (const patch of [{ days: -1 }, { days: 1.5 }, { keep: 0 }, { interval: 'yearly' }, { sections: [] }, { url: 'nonsense' }]) await assert.rejects(service.configure(patch));
    assert.equal((await service.status()).days, 30);
    assert.equal((await service.configure({ username: 'other' })).hasPassword, true);
    assert.equal((await service.configure({ password: '' })).hasPassword, false);
});

test('backup uploads the chosen content, prunes this device\'s old files and restore keeps a local restore point', async () => {
    const { service, remote, files, restored, changes, tick } = harness();
    await assert.rejects(service.backup(), /请先填写 WebDAV 地址/);
    await service.configure({ url: 'https://dav.example/x', sections: ['daily', 'logs'], days: 7, keep: 2 });
    remote.set('wifimeter_laptop_20260101T000000Z.json.gz', Buffer.from('other device'));
    const first = await service.backup();
    assert.deepEqual([first.days, first.networks, first.from], [1, 1, '2026-11-12']);
    const uploaded = JSON.parse(zlib.gunzipSync(remote.get(first.name)).toString());
    assert.deepEqual([uploaded.backupType, uploaded.device, uploaded.logs, uploaded.settings], ['wifimeter-cloud-backup', 'pc', 'log line', undefined]);
    tick(1000); await service.backup(); tick(1000); const third = await service.backup();
    assert.equal(remote.size, 3);
    assert.ok(!remote.has(first.name) && remote.has('wifimeter_laptop_20260101T000000Z.json.gz'));
    assert.deepEqual((await service.list()).map(entry => [entry.device, entry.own]), [['pc', true], ['pc', true], ['laptop', false]]);
    assert.ok((await service.status()).lastBackupAt);
    assert.deepEqual(changes.slice(-2), ['list', '']);

    const result = await service.restore(third.name);
    assert.equal(result.days, 1);
    assert.equal(restored.length, 1);
    assert.deepEqual(restored[0].records.map(row => row.date), ['2026-11-01', '2026-11-18']);
    assert.equal(restored[0].backupType, 'wifimeter-backend-backup');
    assert.equal(JSON.parse(zlib.gunzipSync(files.get('before-cloud-restore.json.gz')).toString()).backupType, 'wifimeter-backend-backup');
    await assert.rejects(service.restore('../../etc/passwd'), /不是 WiFiMeter 的备份文件/);
    await assert.rejects(service.restore('wifimeter_laptop_20260101T000000Z.json.gz'));
    assert.equal(restored.length, 1);
    await service.remove(third.name);
    assert.ok(!remote.has(third.name));
    await assert.rejects(service.remove('readme.md'), /不是 WiFiMeter 的备份文件/);
});

test('automatic backup runs only when enabled and due, and records a failure without throwing', async () => {
    const { service, remote, tick, failUploads } = harness();
    await service.configure({ url: 'https://dav.example/x', interval: 'hourly' });
    await service.autoBackup();
    assert.equal(remote.size, 0);
    await service.configure({ auto: true });
    await service.autoBackup();
    assert.equal(remote.size, 1);
    tick(30 * 60e3); await service.autoBackup();
    assert.equal(remote.size, 1);
    tick(31 * 60e3); failUploads(true); await service.autoBackup();
    assert.equal(remote.size, 1);
    assert.match((await service.status()).lastError, /空间不足/);
    failUploads(false); await service.autoBackup();
    assert.equal(remote.size, 2);
    assert.equal((await service.status()).lastError, '');
    const estimate = await service.estimate();
    assert.ok(estimate.size > 0 && estimate.days === 2);
});
