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
    assert.match(name, /^wifimeter_My-PC_20261118T040506Z_[a-z0-9]{16}\.json\.gz$/);
    assert.deepEqual(selection.parseBackupFileName('wifimeter_My-PC_20261118T040506Z.json.gz'), { device: 'My-PC', createdAt: '2026-11-18T04:05:06.000Z' });
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
    let clock = new Date(now), failUpload = false, paused = false;
    const service = createCloudBackup({
        userData: '/data', device: 'pc', now: () => clock, logs: () => 'log line',
        logStore: { snapshot: () => 'log line', restore: () => {} },
        request: async (method, params) => {
            if (method === 'hello') return { paused };
            if (method === 'setPaused') { paused = params.paused; return { paused }; }
            assert.equal(method, 'backup'); return { backup: full() };
        },
        restore: async document => { restored.push(document); paused = true; },
        io: { mkdir: async () => {}, readFile: async name => { if (!files.has(base(name))) throw Error('ENOENT'); return files.get(base(name)); }, writeFile: async (name, body) => { files.set(base(name), body); },
            rename: async (from, to) => { files.set(base(to), files.get(base(from))); files.delete(base(from)); }, unlink: async name => files.delete(base(name)) },
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


test('application or minute selection carries recent proxy minute evidence once and old archives clear covered evidence', () => {
    const local = full();
    local.proxyMinuteWeights = [
        { date: '2026-11-01', hour: '3', minute: '1', proxyAppId: 'p', appId: 'old', name: 'Old', connections: '1', rxBytes: '1', txBytes: '1' },
        { date: '2026-11-18', hour: '3', minute: '1', proxyAppId: 'p', appId: 'local', name: 'Local', connections: '1', rxBytes: '3', txBytes: '2' }
    ];
    for (const sections of [['apps'], ['minutes'], ['apps', 'minutes']]) {
        const cloud = selection.selectBackup(local, { sections, days: 7, now });
        assert.deepEqual(cloud.proxyMinuteWeights, [local.proxyMinuteWeights[1]]);
        cloud.proxyMinuteWeights = [{ ...local.proxyMinuteWeights[1], appId: 'remote' }];
        assert.deepEqual(selection.mergeBackup(local, cloud).proxyMinuteWeights.map(row => row.appId), ['old', 'remote']);
        delete cloud.proxyMinuteWeights;
        assert.deepEqual(selection.mergeBackup(local, cloud).proxyMinuteWeights.map(row => row.appId), ['old']);
        cloud.from = '';
        assert.deepEqual(selection.mergeBackup(local, cloud).proxyMinuteWeights, []);
    }
    const daily = selection.selectBackup(local, { sections: ['daily'], days: 7, now });
    assert.equal(daily.proxyMinuteWeights, undefined);
    assert.deepEqual(selection.mergeBackup(local, daily).proxyMinuteWeights, local.proxyMinuteWeights);
});

function recoveryHarness({ failHost = false, failLogs = false, failBackend = false, failRollback = false, maxBackupBytes, writeFailure = false, renameFailure = false,
    initialPaused = false, pauseFailure = false, resumeFailure = false, failBackendBeforeMutation = false, onHostSnapshot } = {}) {
    const files = new Map(), remote = new Map(), calls = [], restored = [];
    const clone = value => JSON.parse(JSON.stringify(value));
    let paused = initialPaused, pendingUsage = 'pending-native-sample';
    let data = full(), host = { windowPreferences: { theme: 'light', promptAppCollection: false }, logLevel: 'warn',
        appNetworkRecords: { version: 1, records: [{ path: 'C:\\Apps\\Local.exe', name: 'Local.exe', savedAt: '2026-11-18T00:00:00.000Z', state: { Blocked: true } }] } };
    let logRows = { version: 1, entries: [{ time: '2026-11-18T00:00:00.000Z', level: 'warn', source: 'app', message: 'local retained log' }] };
    const original = () => ({ data: clone(data), host: clone(host), logs: clone(logRows) });
    const basename = name => name.replace(/^.*[\\/]/, '');
    const io = {
        mkdir: async () => {},
        readFile: async name => { if (!files.has(basename(name))) throw Object.assign(Error('ENOENT'), { code: 'ENOENT' }); return files.get(basename(name)); },
        writeFile: async (name, body) => { if (writeFailure) throw Error('disk full'); files.set(basename(name), body); },
        rename: async (from, to) => { if (renameFailure) throw Error('rename blocked'); files.set(basename(to), files.get(basename(from))); files.delete(basename(from)); },
        unlink: async name => { files.delete(basename(name)); }
    };
    const validateHost = value => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['windowPreferences', 'logLevel', 'appNetworkRecords'].includes(key))) throw Error('云备份桌面设置无效。');
        if (value.windowPreferences && (Object.keys(value.windowPreferences).some(key => !['theme', 'promptAppCollection'].includes(key))
            || (value.windowPreferences.theme !== undefined && !['light', 'dark', 'system'].includes(value.windowPreferences.theme))
            || (value.windowPreferences.promptAppCollection !== undefined && typeof value.windowPreferences.promptAppCollection !== 'boolean'))) throw Error('窗口偏好无效。');
        if (value.logLevel !== undefined && !['debug', 'info', 'warn', 'error'].includes(value.logLevel)) throw Error('Unsupported log level.');
        if (value.appNetworkRecords !== undefined && (value.appNetworkRecords.version !== 1 || !Array.isArray(value.appNetworkRecords.records)
            || value.appNetworkRecords.records.some(row => !/^C:\\Apps\\[A-Za-z]+\.exe$/.test(row.path)))) throw Error('应用限制记录格式无效。');
        return clone(value);
    };
    const { validateLogSnapshot } = require('../host/logs.cjs');
    const service = createCloudBackup({ userData: '/data', device: 'pc', now: () => new Date(now), io, maxBackupBytes,
        secrets: { protect: async value => 'test:' + value, reveal: async value => value.slice(5) },
        request: async (method, params) => {
            calls.push(method);
            if (method === 'hello') return { paused };
            if (method === 'setPaused') {
                if (params.paused && pauseFailure) throw Error('pause failed');
                if (!params.paused && resumeFailure) throw Error('resume failed');
                paused = params.paused; return { paused };
            }
            assert.equal(method, 'backup'); return { backup: clone(data) };
        },
        restore: async document => { calls.push('restore'); restored.push(clone(document));
            if (failBackendBeforeMutation && restored.length === 1) throw Object.assign(Error('invalid backup data'), { code: 'invalidParams' });
            data = clone(document); paused = true; pendingUsage = '';
            if ((failBackend && restored.length === 1) || (failRollback && restored.length > 1)) throw Error('backend restore failed'); },
        hostSettings: { snapshot: async () => { await onHostSnapshot?.(); return clone(host); }, validate: validateHost, restore: async value => { host = { ...host, ...clone(value) };
            if (failHost) { failHost = false; throw Error('host disk full'); } } },
        logStore: { snapshot: () => clone(logRows), validate: value => validateLogSnapshot ? validateLogSnapshot(value, now) : value,
            restore: value => { logRows = clone(value); if (failLogs) { failLogs = false; throw Error('log rename blocked'); } } },
        createClient: () => ({ ensureDirectory: async () => {}, list: async () => [], upload: async (name, bytes) => remote.set(name, bytes),
            download: async name => remote.get(name), remove: async name => remote.delete(name) })
    });
    const put = cloud => { const name = 'wifimeter_remote_20261118T000000Z.json.gz'; remote.set(name, zlib.gzipSync(Buffer.from(JSON.stringify(cloud)))); return name; };
    return { service, files, remote, calls, restored, original, put, get paused() { return paused; }, get pendingUsage() { return pendingUsage; },
        sample: value => { if (paused) return false; data.records[0].rxBytes = value; return true; },
        setWriteFailure: value => { writeFailure = value; }, setRenameFailure: value => { renameFailure = value; } };
}

const remoteHost = () => ({ windowPreferences: { theme: 'dark', promptAppCollection: true }, logLevel: 'debug',
    appNetworkRecords: { version: 1, records: [{ path: 'C:\\Apps\\Remote.exe', name: 'Remote.exe', savedAt: '2026-11-18T01:00:00.000Z', state: { Blocked: true, DownloadThrottled: true, DownloadKbps: 2048 } }] } });
const remoteLogs = () => ({ version: 1, entries: [{ time: '2026-11-18T01:00:00.000Z', level: 'info', source: 'backup', message: 'restored remote log' }] });
const hostCloud = () => ({ ...selection.selectBackup(full(), { sections: ['settings', 'logs'], now }), hostSettings: remoteHost(), logs: remoteLogs() });

test('restore replaces selected logs and portable host settings and saves every local portion before mutation', async () => {
    const h = recoveryHarness(), before = h.original();
    await h.service.configure({ url: 'https://dav.example/x', username: 'local', password: 'local-secret' });
    h.files.set('update-cache.bin', Buffer.from('local installer'));
    await h.service.restore(h.put(hostCloud()));
    assert.deepEqual(h.original().host, remoteHost());
    assert.deepEqual(h.original().logs, remoteLogs());
    const point = JSON.parse(zlib.gunzipSync(h.files.get('before-cloud-restore.json.gz')).toString());
    assert.equal(point.backupType, 'wifimeter-backend-backup');
    assert.deepEqual(point.hostSettings, before.host);
    assert.deepEqual(point.logs, before.logs);
    assert.deepEqual(point.records, before.data.records);
    assert.equal(JSON.parse(h.files.get('cloud-backup.json')).secret, 'test:local-secret');
    assert.equal(h.files.get('update-cache.bin').toString(), 'local installer');
});

test('omitted host portions and legacy archives without host data preserve local settings and logs', async () => {
    const h = recoveryHarness(), before = h.original();
    await h.service.configure({ url: 'https://dav.example/x' });
    for (const sections of [['daily'], ['settings'], ['logs']]) {
        const cloud = selection.selectBackup(full(), { sections, now });
        delete cloud.logs;
        await h.service.restore(h.put(cloud));
        assert.deepEqual(h.original().host, before.host);
        assert.deepEqual(h.original().logs, before.logs);
    }
});

test('backup includes structured logs and selected host settings without local credentials or update caches', async () => {
    const h = recoveryHarness();
    await h.service.configure({ url: 'https://dav.example/x', password: 'local-secret', sections: ['settings', 'logs'] });
    const result = await h.service.backup();
    const cloud = JSON.parse(zlib.gunzipSync(h.remote.get(result.name)).toString());
    assert.deepEqual(cloud.hostSettings, h.original().host);
    assert.deepEqual(cloud.logs, h.original().logs);
    assert.ok(!JSON.stringify(cloud).includes('local-secret'));
});

test('invalid host settings or logs are rejected before requesting or replacing backend data', async () => {
    const variants = [
        { hostSettings: { ...remoteHost(), windowPreferences: { theme: 'malicious' } } },
        { hostSettings: { ...remoteHost(), logLevel: 'trace' } },
        { hostSettings: { ...remoteHost(), appNetworkRecords: { version: 1, records: [{ ...remoteHost().appNetworkRecords.records[0], path: '../../policy.exe' }] } } },
        { hostSettings: { ...remoteHost(), cloudBackup: { secret: 'remote-secret' } } },
        { logs: { version: 1, entries: [{ ...remoteLogs().entries[0], level: 'trace' }] } },
        { logs: { version: 1, entries: [{ ...remoteLogs().entries[0], message: 'x'.repeat(2001) }] } },
        { logs: 'x'.repeat(2 * 1024 * 1024 + 1) }
    ];
    for (const patch of variants) {
        const h = recoveryHarness(), before = h.original();
        await h.service.configure({ url: 'https://dav.example/x' });
        await assert.rejects(h.service.restore(h.put({ ...hostCloud(), ...patch })));
        assert.deepEqual(h.calls, []);
        assert.deepEqual(h.original(), before);
        assert.ok(!h.files.has('before-cloud-restore.json.gz'));
    }
});

test('a failed backend or host replacement restores original data and reports the saved recovery point', async () => {
    for (const failure of [{ failBackend: true }, { failHost: true }, { failLogs: true }]) {
        const h = recoveryHarness(failure), before = h.original();
        await h.service.configure({ url: 'https://dav.example/x' });
        await assert.rejects(h.service.restore(h.put(hostCloud())), /已恢复原数据/);
        assert.deepEqual(h.original(), before);
        assert.ok(h.files.has('before-cloud-restore.json.gz'));
        assert.match((await h.service.status()).lastError, /恢复失败/);
    }
});

test('a failed rollback reports the incomplete recovery and retains the complete local restore point', async () => {
    const h = recoveryHarness({ failHost: true, failRollback: true });
    await h.service.configure({ url: 'https://dav.example/x' });
    await assert.rejects(h.service.restore(h.put(hostCloud())), error => /回滚未完成/.test(error.message) && /before-cloud-restore/.test(error.message));
    assert.ok(h.files.has('before-cloud-restore.json.gz'));
});

test('restore point rename failure preserves the previous point and performs no replacement', async () => {
    const h = recoveryHarness(), before = h.original(), old = Buffer.from('existing restore point');
    await h.service.configure({ url: 'https://dav.example/x' });
    h.files.set('before-cloud-restore.json.gz', old);
    h.setRenameFailure(true);
    await assert.rejects(h.service.restore(h.put(hostCloud())), /rename blocked/);
    assert.deepEqual(h.original(), before);
    assert.deepEqual(h.calls, ['hello', 'setPaused', 'backup', 'setPaused']);
    assert.equal(h.paused, false);
    assert.equal(h.files.get('before-cloud-restore.json.gz'), old);
});

test('configuration write failure preserves the last persisted state and does not change memory', async () => {
    const h = recoveryHarness();
    await h.service.configure({ url: 'https://dav.example/x', username: 'saved' });
    const disk = h.files.get('cloud-backup.json');
    h.setWriteFailure(true);
    await assert.rejects(h.service.configure({ username: 'unsaved' }), /disk full/);
    assert.equal((await h.service.status()).username, 'saved');
    assert.equal(h.files.get('cloud-backup.json'), disk);
});

test('decompression is bounded before backend or host data can be touched', async () => {
    const h = recoveryHarness({ maxBackupBytes: 1024 }), before = h.original();
    await h.service.configure({ url: 'https://dav.example/x' });
    const cloud = { ...hostCloud(), padding: 'a'.repeat(10000) };
    await assert.rejects(h.service.restore(h.put(cloud)), /解压后/);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.original(), before);
});

test('restore rejects path-bearing and noncanonical device file names', async () => {
    const h = recoveryHarness();
    await h.service.configure({ url: 'https://dav.example/x' });
    const name = 'wifimeter_../remote_20261118T000000Z.json.gz';
    h.remote.set(name, zlib.gzipSync(Buffer.from(JSON.stringify(hostCloud()))));
    await assert.rejects(h.service.restore(name), /不是 WiFiMeter 的备份文件/);
    assert.deepEqual(h.calls, []);
});


test('concurrent configuration saves wait in order and preserve a password and independent fields', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const files = new Map(), requests = [], uploads = [];
    const base = name => name.replace(/^.*[\\/]/, '');
    const service = createCloudBackup({ userData: '/data',
        io: { mkdir: async () => {}, readFile: async () => { throw Error('ENOENT'); }, writeFile: async (name, body) => files.set(base(name), body),
            rename: async (from, to) => { files.set(base(to), files.get(base(from))); files.delete(base(from)); }, unlink: async name => files.delete(base(name)) },
        secrets: { protect: async value => { await pending; return 'test:' + value; }, reveal: async value => value.slice(5) },
        request: async () => { requests.push('backup'); return { backup: full() }; },
        createClient: options => ({ ensureDirectory: async () => {}, list: async () => [], upload: async () => uploads.push(options) }) });
    await service.status();
    const first = service.configure({ url: 'https://dav.example/original', password: 'saved-password' });
    await new Promise(setImmediate);
    let settled = false;
    const second = service.configure({ username: 'other' }).then(value => { settled = true; return value; });
    second.catch(() => {});
    const backup = service.backup(); backup.catch(() => {});
    await new Promise(setImmediate);
    assert.equal(settled, false);
    assert.deepEqual(requests, []);
    release(); await first; await second; await backup;
    assert.equal(uploads[0].username, 'other');
    assert.equal(uploads[0].password, 'saved-password');
    const state = await service.status();
    assert.equal(state.url, 'https://dav.example/original');
    assert.equal(state.username, 'other');
    assert.equal(state.hasPassword, true);
});

test('stopping automatic backup during its snapshot prevents a later upload', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const uploads = [];
    const service = createCloudBackup({ userData: '/data', now: () => new Date(now),
        io: { mkdir: async () => {}, readFile: async () => { throw Error('ENOENT'); }, writeFile: async () => {}, rename: async () => {}, unlink: async () => {} },
        request: async () => { await pending; return { backup: full() }; },
        createClient: () => ({ ensureDirectory: async () => {}, list: async () => [], upload: async (...args) => uploads.push(args) }) });
    await service.configure({ url: 'https://dav.example/x', auto: true });
    const operation = service.autoBackup();
    await new Promise(setImmediate);
    service.stop(); release(); await operation;
    assert.deepEqual(uploads, []);
});


test('the complete local restore point restores desktop settings and logs again through the full-backup path', async () => {
    const h = recoveryHarness(), original = h.original();
    await h.service.configure({ url: 'https://dav.example/x' });
    await h.service.restore(h.put(hostCloud()));
    const point = JSON.parse(zlib.gunzipSync(h.files.get('before-cloud-restore.json.gz')).toString());
    assert.equal(typeof h.service.restoreDocument, 'function');
    await h.service.restoreDocument(point);
    assert.deepEqual(h.original(), original);
    const secondPoint = JSON.parse(zlib.gunzipSync(h.files.get('before-cloud-restore.json.gz')).toString());
    assert.deepEqual(secondPoint.hostSettings, remoteHost());
    assert.deepEqual(secondPoint.logs, remoteLogs());
});

test('a malformed full restore point is rejected before mutation and old full backups keep omitted desktop data', async () => {
    const h = recoveryHarness(), original = h.original();
    await h.service.configure({ url: 'https://dav.example/x' });
    assert.equal(typeof h.service.restoreDocument, 'function');
    await assert.rejects(h.service.restoreDocument({ ...full(), hostSettings: { ...remoteHost(), logLevel: 'trace' }, logs: remoteLogs() }));
    assert.deepEqual(h.calls, []);
    await h.service.restoreDocument(full());
    assert.deepEqual(h.original().host, original.host);
    assert.deepEqual(h.original().logs, original.logs);
});


test('a completed configuration response is idle and cannot leave cloud controls permanently busy', async () => {
    const h = recoveryHarness();
    const response = await h.service.configure({ url: 'https://dav.example/x' });
    assert.equal(response.busy, '');
    assert.equal((await h.service.status()).busy, '');
});


test('successive backups in the same second keep separate files and retention resolves time ties consistently', async () => {
    const h = harness();
    await h.service.configure({ url: 'https://dav.example/x', sections: ['daily'], keep: 5 });
    const first = await h.service.backup(), second = await h.service.backup();
    assert.notEqual(first.name, second.name);
    assert.equal(h.remote.size, 2);
    assert.equal(selection.parseBackupFileName(first.name).createdAt, selection.parseBackupFileName(second.name).createdAt);
    assert.deepEqual((await h.service.list()).map(row => row.name), [second.name, first.name]);
    const third = await h.service.backup();
    const files = [first, second, third].map(row => ({ name: row.name }));
    assert.deepEqual(selection.expiredBackups(files, 'pc', 1), [first.name, second.name]);
    assert.deepEqual(selection.expiredBackups([...files].reverse(), 'pc', 1), [first.name, second.name]);
});

test('disabling automatic backup in an already queued configuration prevents the pending automatic upload', async () => {
    const h = recoveryHarness();
    await h.service.configure({ url: 'https://dav.example/x', auto: true });
    const configure = h.service.configure({ auto: false });
    const automatic = h.service.autoBackup();
    await Promise.all([configure, automatic]);
    assert.equal(h.remote.size, 0);
    assert.deepEqual(h.calls, []);
});


test('logs-only restore freezes native sampling before its complete restore point so omitted usage cannot go backward', async () => {
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const h = recoveryHarness({ onHostSnapshot: async () => { entered(); await gate; } });
    h.sample('100');
    await h.service.configure({ url: 'https://dav.example/x' });
    const cloud = { ...selection.selectBackup(full(), { sections: ['logs'], now }), logs: remoteLogs() };
    const restoration = h.service.restore(h.put(cloud));
    await ready;
    const frozen = h.paused, sampled = h.sample('200');
    release(); await restoration;
    assert.equal(frozen, true);
    assert.equal(sampled, false);
    assert.equal(h.original().data.records[0].rxBytes, '100');
    assert.equal(h.paused, true);
    assert.deepEqual(h.calls.slice(0, 3), ['hello', 'setPaused', 'backup']);
});

test('failure to pause collection aborts before any restore point or dataset replacement and preserves the original state', async () => {
    const h = recoveryHarness({ pauseFailure: true }), before = h.original();
    await h.service.configure({ url: 'https://dav.example/x' });
    await assert.rejects(h.service.restore(h.put(hostCloud())), /pause failed/);
    assert.deepEqual(h.original(), before);
    assert.equal(h.paused, false);
    assert.equal(h.calls.includes('backup'), false);
    assert.equal(h.calls.includes('restore'), false);
    assert.equal(h.files.has('before-cloud-restore.json.gz'), false);
});

test('invalid backend input or complete host rollback resumes the original running collection state', async () => {
    for (const fault of [{ failBackendBeforeMutation: true }, { failHost: true }]) {
        const h = recoveryHarness(fault), before = h.original();
        await h.service.configure({ url: 'https://dav.example/x' });
        await assert.rejects(h.service.restore(h.put(hostCloud())), fault.failBackendBeforeMutation ? /原数据已保留/ : /已恢复原数据/);
        assert.deepEqual(h.original(), before);
        assert.equal(h.paused, false);
        assert.equal(h.calls.at(-1), 'setPaused');
    }
    const h = recoveryHarness({ failHost: true, failRollback: true });
    await h.service.configure({ url: 'https://dav.example/x' });
    await assert.rejects(h.service.restore(h.put(hostCloud())), /回滚未完成/);
    assert.equal(h.paused, true);
});

test('failure to recover the original sampling state is reported with the preserved local restore point', async () => {
    const h = recoveryHarness({ failHost: true, resumeFailure: true });
    await h.service.configure({ url: 'https://dav.example/x' });
    await assert.rejects(h.service.restore(h.put(hostCloud())), error => /原采集状态未能恢复/.test(error.message) && /resume failed/.test(error.message));
    assert.equal(h.paused, true);
    assert.ok(h.files.has('before-cloud-restore.json.gz'));
});


test('an explicit invalidParams rejection never re-restores the original database or discards its pending native sample', async () => {
    const h = recoveryHarness({ failBackendBeforeMutation: true }), before = h.original(), pending = h.pendingUsage;
    await h.service.configure({ url: 'https://dav.example/x' });
    await assert.rejects(h.service.restore(h.put(hostCloud())));
    assert.equal(h.restored.length, 1);
    assert.deepEqual(h.original(), before);
    assert.equal(h.pendingUsage, pending);
    assert.equal(h.paused, false);
});


test('proxy minute evidence produced from valid backend rows round-trips long identifiers and names without an arbitrary field cap', () => {
    const source = full();
    const row = { date: '2026-11-18', hour: '3', minute: '1', proxyAppId: 'p'.repeat(4097), appId: 'a'.repeat(4097),
        name: 'x'.repeat(4097), connections: '1', rxBytes: '9223372036854775807', txBytes: '0' };
    source.proxyMinuteWeights = [row];
    const cloud = selection.selectBackup(source, { sections: ['apps', 'minutes'], days: 7, now });
    assert.doesNotThrow(() => selection.validateCloudBackup(cloud));
    assert.deepEqual(selection.mergeBackup(full(), cloud).proxyMinuteWeights, [row]);
    for (const value of ['unknown', 'proxy/unattributed', 'bad\0identity']) {
        for (const key of ['proxyAppId', 'appId']) assert.throws(() => selection.validateCloudBackup({ ...cloud, proxyMinuteWeights: [{ ...row, [key]: value }] }));
    }
    // The backend producer exports canonical integer strings, preserving exact byte values.
    assert.equal(cloud.proxyMinuteWeights[0].rxBytes, '9223372036854775807');
});
