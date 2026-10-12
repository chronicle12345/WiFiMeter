import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { createAppControl } = createRequire(import.meta.url)('../electron/app-control.cjs');
const program = String.raw`C:\Apps\Browser.exe`;
const second = String.raw`C:\Apps\other.exe`;
const active = { Blocked: true, Throttled: true, UploadKbps: 1024, DownloadThrottled: false, DownloadKbps: null };
const clear = { Blocked: false, Throttled: false, DownloadThrottled: false };

function executableIo() {
    const bytes = Buffer.alloc(512);
    bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.write('PE\0\0', 128);
    bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(1, 134);
    bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2, 150); bytes.writeUInt16LE(0x20b, 152);
    return { realpath: async value => value, open: async () => ({
        stat: async () => ({ isFile: () => true, size: bytes.length }),
        read: async (buffer, offset, length, position) => ({ bytesRead: bytes.copy(buffer, offset, position, position + length) }), close: async () => {}
    }) };
}

async function harness(t) {
    const temporaryRoot = fileURLToPath(new URL('../../../del/app-control-tests/', import.meta.url));
    await fs.mkdir(temporaryRoot, { recursive: true });
    const directory = await fs.mkdtemp(path.join(temporaryRoot, 'wifimeter-app-records-'));
    let response = { Status: 'Succeeded', State: active }, calls = 0;
    const makeControl = overrides => createAppControl({ platform: 'win32', userDataDir: directory, io: executableIo(),
        runner: async () => { calls++; return { stdout: JSON.stringify(response) }; }, ...overrides });
    return { directory, makeControl, setResponse: value => { response = value; }, calls: () => calls };
}

test('限制记录持久保存完整路径和最近状态，重启后查询列表无需执行系统命令', async t => {
    const h = await harness(t), control = h.makeControl();
    assert.equal(typeof control.list, 'function');
    assert.deepEqual((await control.list()).records, []);
    await control.request({ action: 'block', path: program });
    const records = (await h.makeControl().list()).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].path, program);
    assert.equal(records[0].name, 'Browser.exe');
    assert.deepEqual(records[0].state, active);
    assert.ok(Number.isFinite(Date.parse(records[0].savedAt)));
    assert.equal(h.calls(), 1);
    records[0].state.Blocked = false;
    assert.equal((await control.list()).records[0].state.Blocked, true);
});

test('主动查询能记录旧版路径专属限制，无限制应用不入列表，路径忽略大小写去重', async t => {
    const h = await harness(t), control = h.makeControl();
    assert.equal(typeof control.list, 'function');
    h.setResponse({ Status: 'Succeeded', State: clear });
    await control.request({ action: 'read', path: program });
    assert.deepEqual((await control.list()).records, []);
    h.setResponse({ Status: 'Succeeded', State: active });
    await control.request({ action: 'read', path: program });
    assert.equal((await h.makeControl().list()).records[0].state.Blocked, true);
    h.setResponse({ Status: 'Succeeded', State: { ...active, UploadKbps: 2048 } });
    await control.request({ action: 'read', path: program.toLowerCase() });
    const records = (await control.list()).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].state.UploadKbps, 2048);
});

test('系统操作失败或取消保留保存记录，状态未知时仍可查询应用', async t => {
    const h = await harness(t), control = h.makeControl();
    assert.equal(typeof control.list, 'function');
    await control.request({ action: 'block', path: program });
    const before = (await control.list()).records;
    for (const Status of ['Cancelled', 'Failed']) {
        h.setResponse({ Status, ErrorCode: 'notApplied', Error: 'failure', State: null });
        await control.request({ action: 'unblock', path: program });
        assert.deepEqual((await control.list()).records, before);
        await control.request({ action: 'block', path: second });
        assert.deepEqual((await control.list()).records, before);
    }
    h.setResponse({ Status: 'Failed', ErrorCode: 'PartialFailure', Error: 'upload unavailable',
        State: { ...active, Blocked: false, Throttled: null, QosError: 'query failed' } });
    await control.request({ action: 'unblock', path: program });
    const partial = (await control.list()).records;
    assert.equal(partial.length, 1);
    assert.equal(partial[0].state.Blocked, false);
    assert.equal(partial[0].state.Throttled, null);
    h.setResponse({ Status: 'Succeeded', State: { Blocked: false, Throttled: null, QosError: 'access denied', DownloadThrottled: false } });
    await control.request({ action: 'read', path: program });
    assert.equal((await control.list()).records.length, 1);
    h.setResponse({ Status: 'Succeeded', State: clear });
    await control.request({ action: 'read', path: program });
    assert.deepEqual((await h.makeControl().list()).records, []);
});

test('部分解除不会丢失其他方向的限制，全部确认解除后移除记录', async t => {
    const h = await harness(t), control = h.makeControl();
    assert.equal(typeof control.list, 'function');
    await control.request({ action: 'throttle', path: program, uploadKBps: 128 });
    h.setResponse({ Status: 'Succeeded', State: { ...clear, DownloadThrottled: true, DownloadKbps: 512 } });
    await control.request({ action: 'unthrottle', path: program, direction: 'upload' });
    assert.equal((await control.list()).records[0].state.DownloadKbps, 512);
    h.setResponse({ Status: 'Succeeded', State: clear });
    await control.request({ action: 'unthrottle', path: program, direction: 'both' });
    assert.deepEqual((await h.makeControl().list()).records, []);
});

test('主动查询保留单向阻止和尚未移除的防火墙规则，确认全部解除后移除记录', async t => {
    for (const firewall of [
        { InboundBlocked: true, OutboundBlocked: false, FirewallRuleCount: 1 },
        { InboundBlocked: false, OutboundBlocked: true, FirewallRuleCount: 1 },
        { InboundBlocked: false, OutboundBlocked: false, FirewallRuleCount: 2 }
    ]) {
        const h = await harness(t), control = h.makeControl();
        const state = { ...clear, ...firewall };
        h.setResponse({ Status: 'Succeeded', State: state });
        await control.request({ action: 'read', path: program });
        const records = (await h.makeControl().list()).records;
        assert.equal(records.length, 1);
        assert.deepEqual(records[0].state, state);
        h.setResponse({ Status: 'Succeeded', State: {
            ...clear, InboundBlocked: false, OutboundBlocked: false, FirewallRuleCount: 0
        } });
        await control.request({ action: 'read', path: program });
        assert.deepEqual((await h.makeControl().list()).records, []);
    }
});

test('解除操作回读仍有单向阻止或残留规则时保留原应用记录', async t => {
    for (const firewall of [
        { InboundBlocked: true, OutboundBlocked: false, FirewallRuleCount: 1 },
        { InboundBlocked: false, OutboundBlocked: true, FirewallRuleCount: 1 },
        { InboundBlocked: false, OutboundBlocked: false, FirewallRuleCount: 1 }
    ]) {
        const h = await harness(t), control = h.makeControl();
        await control.request({ action: 'block', path: program });
        const state = { ...clear, ...firewall };
        h.setResponse({ Status: 'Succeeded', State: state });
        await control.request({ action: 'unblock', path: program });
        const records = (await h.makeControl().list()).records;
        assert.equal(records.length, 1);
        assert.deepEqual(records[0].state, state);
    }
});

test('防火墙方向或规则数量未知时不移除已有记录，旧版缺失字段仍兼容', async t => {
    for (const field of ['InboundBlocked', 'OutboundBlocked', 'FirewallRuleCount']) {
        const h = await harness(t), control = h.makeControl();
        await control.request({ action: 'block', path: program });
        const state = { ...clear, InboundBlocked: false, OutboundBlocked: false, FirewallRuleCount: 0, [field]: null };
        h.setResponse({ Status: 'Succeeded', State: state });
        await control.request({ action: 'read', path: program });
        const records = (await h.makeControl().list()).records;
        assert.equal(records.length, 1);
        assert.deepEqual(records[0].state, state);
        h.setResponse({ Status: 'Succeeded', State: clear });
        await control.request({ action: 'read', path: program });
        assert.deepEqual((await h.makeControl().list()).records, []);
    }
});

test('首次设置部分失败仍保存已生效的下载限制和错误，取消不新增记录', async t => {
    const h = await harness(t), control = h.makeControl();
    h.setResponse({ Status: 'Failed', ErrorCode: 'QosUnsupported', Error: 'upload unavailable', State: {
        Blocked: false, Throttled: null, QosError: 'upload unavailable', DownloadThrottled: true, DownloadKbps: 2048
    } });
    const result = await control.request({ action: 'throttle', path: program, uploadKBps: 128, downloadKBps: 256 });
    assert.equal(result.ok, false);
    const records = (await h.makeControl().list()).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].state.DownloadKbps, 2048);
    assert.equal(records[0].state.Throttled, null);
    assert.deepEqual(records[0].operationError, { code: 'QosUnsupported', message: 'upload unavailable' });
    h.setResponse({ Status: 'Cancelled', ErrorCode: 'UacCancelled', Error: 'cancelled', State: active });
    await control.request({ action: 'block', path: second });
    assert.deepEqual((await control.list()).records, records);
});

test('失败响应状态格式错误不会破坏已有可读取的记录', async t => {
    const h = await harness(t), control = h.makeControl();
    await control.request({ action: 'block', path: program });
    const before = (await control.list()).records;
    for (const State of ['invalid state', ['invalid state'], 1]) {
        h.setResponse({ Status: 'Failed', ErrorCode: 'OperationFailed', Error: 'failure', State });
        assert.equal((await control.request({ action: 'block', path: program })).error.code, 'invalidResponse');
        assert.deepEqual((await h.makeControl().list()).records, before);
    }
});

test('并行保存多个应用不会覆盖先前记录', async t => {
    const h = await harness(t), control = h.makeControl();
    assert.equal(typeof control.list, 'function');
    await Promise.all([control.request({ action: 'block', path: program }), control.request({ action: 'block', path: second })]);
    assert.deepEqual((await h.makeControl().list()).records.map(record => record.path).sort(), [program, second].sort());
});

test('记录文件损坏明确报告错误，成功策略操作不会覆盖损坏文件', async t => {
    const h = await harness(t), control = h.makeControl();
    assert.equal(typeof control.list, 'function');
    const file = path.join(h.directory, 'app-network-records.json');
    await fs.writeFile(file, '{broken');
    assert.equal((await control.list()).ok, false);
    const result = await control.request({ action: 'block', path: program });
    assert.equal(result.ok, true);
    assert.equal(result.recordsError.code, 'recordsSaveFailed');
    assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

test('写入失败保留原记录并向界面返回保存错误，重试后可以持久保存', async t => {
    const h = await harness(t);
    await h.makeControl().request({ action: 'block', path: program });
    let failWrite = true;
    const control = h.makeControl({ recordsIo: { ...fs, writeFile: async (...args) => {
        if (failWrite) throw Object.assign(Error('disk full'), { code: 'ENOSPC' });
        return fs.writeFile(...args);
    } } });
    h.setResponse({ Status: 'Succeeded', State: { ...active, UploadKbps: 2048 } });
    const result = await control.request({ action: 'throttle', path: program, uploadKBps: 256 });
    assert.equal(result.ok, true);
    assert.equal(result.recordsError.code, 'recordsSaveFailed');
    assert.equal((await h.makeControl().list()).records[0].state.UploadKbps, 1024);
    failWrite = false;
    await control.request({ action: 'read', path: program });
    assert.equal((await h.makeControl().list()).records[0].state.UploadKbps, 2048);
});
