'use strict';

// 后端客户端的单元测试。用一个假的“后端”脚本验证传输与配对逻辑，
// 真实后端可用时再跑一遍同样的用例（WIFIMETER_BACKEND 指向可执行文件）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { BackendClient, resolveExecutable } from '../electron/backend.cjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// 假后端：认识 hello / echo / slow / emit / shutdown，并记录收到的请求。
const FAKE_BACKEND = `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let counter = 0;
rl.on('line', line => {
    if (!line.trim()) return;
    const request = JSON.parse(line);
    const reply = payload => process.stdout.write(JSON.stringify(payload) + '\\n');
    if (request.method === 'hello') {
        reply({ id: request.id, ok: true, result: { protocol: 1, application: 'fake-backend' } });
    } else if (request.method === 'echo') {
        reply({ id: request.id, ok: true, result: { params: request.params } });
    } else if (request.method === 'fail') {
        reply({ id: request.id, ok: false, error: { code: 'badRequest', message: '故意失败' } });
    } else if (request.method === 'slow') {
        setTimeout(() => reply({ id: request.id, ok: true, result: {} }), 2000);
    } else if (request.method === 'emit') {
        counter += 1;
        reply({ id: request.id, ok: true, result: { sent: counter } });
        process.stdout.write(JSON.stringify({ event: 'live', state: 'connected', n: counter }) + '\\n');
    } else if (request.method === 'noise') {
        process.stdout.write('这不是 JSON\\n');
        reply({ id: request.id, ok: true, result: {} });
    } else if (request.method === 'shutdown') {
        reply({ id: request.id, ok: true, result: {} });
        process.exit(0);
    } else {
        reply({ id: request.id, ok: false, error: { code: 'unknownMethod', message: request.method } });
    }
});
`;

function temporaryDirectory(tag) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `wifimeter-${tag}-`));
}

function fakeBackendPath(directory) {
    const file = path.join(directory, 'fake-backend');
    fs.writeFileSync(file, FAKE_BACKEND, { mode: 0o755 });
    return file;
}

function clientFor(executable, directory, options = {}) {
    return new BackendClient({
        executable,
        databasePath: path.join(directory, 'meter.db'),
        requestTimeout: 5000,
        ...options,
    });
}

test('解析可执行文件位置：环境变量优先', () => {
    const previous = process.env.WIFIMETER_BACKEND;
    process.env.WIFIMETER_BACKEND = '/tmp/自定义后端';
    try {
        assert.equal(resolveExecutable({ repositoryRoot: '/repo', resourcesPath: '/res' }), '/tmp/自定义后端');
    } finally {
        if (previous === undefined) delete process.env.WIFIMETER_BACKEND;
        else process.env.WIFIMETER_BACKEND = previous;
    }
});

test('请求与响应按 id 配对，事件单独回调', async () => {
    const directory = temporaryDirectory('backend-client');
    const client = clientFor(fakeBackendPath(directory), directory);
    const events = [];
    client.on('event', event => events.push(event));
    client.start();

    const hello = await client.request('hello');
    assert.equal(hello.application, 'fake-backend');

    // 并发请求也必须各回各的。
    const [first, second] = await Promise.all([client.request('echo', { n: 1 }), client.request('echo', { n: 2 })]);
    assert.equal(first.params.n, 1);
    assert.equal(second.params.n, 2);

    const emitted = await client.request('emit');
    assert.equal(emitted.sent, 1);
    // 事件可能在响应之后到达，等一下事件循环。
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'live');
    assert.equal(events[0].n, 1);

    // 无法解析的输出被忽略，不影响后续请求。
    await client.request('noise');
    assert.equal((await client.request('hello')).application, 'fake-backend');

    await client.stop();
    fs.rmSync(directory, { recursive: true, force: true });
});

test('后端返回失败时抛出带错误码的异常', async () => {
    const directory = temporaryDirectory('backend-client');
    const client = clientFor(fakeBackendPath(directory), directory);
    client.start();

    await assert.rejects(() => client.request('fail'), error => {
        assert.equal(error.code, 'badRequest');
        assert.match(error.message, /故意失败/);
        return true;
    });
    // 失败之后连接仍然可用。
    assert.equal((await client.request('hello')).protocol, 1);

    await client.stop();
    fs.rmSync(directory, { recursive: true, force: true });
});

test('请求超时会拒绝并且不留下悬挂状态', async () => {
    const directory = temporaryDirectory('backend-client');
    const client = clientFor(fakeBackendPath(directory), directory);
    client.start();

    await assert.rejects(() => client.request('slow', {}, { timeout: 300 }), error => {
        assert.equal(error.code, 'timeout');
        return true;
    });
    assert.equal(client.pending.size, 0);

    await client.stop();
    fs.rmSync(directory, { recursive: true, force: true });
});

test('后端意外退出时等待中的请求被拒绝，并广播退出事件', async () => {
    const directory = temporaryDirectory('backend-client');
    const dying = path.join(directory, 'dying-backend');
    fs.writeFileSync(dying, "#!/bin/sh\nread line\nkill -9 $$\n", { mode: 0o755 });

    const client = clientFor(dying, directory);
    const exits = [];
    client.on('exit', info => exits.push(info));
    client.start();

    await assert.rejects(() => client.request('hello'), /后端进程已退出/);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(exits.length, 1);
    assert.equal(exits[0].unexpected, true);

    fs.rmSync(directory, { recursive: true, force: true });
});

test('正常停止不会标记为意外退出', async () => {
    const directory = temporaryDirectory('backend-client');
    const client = clientFor(fakeBackendPath(directory), directory);
    const exits = [];
    client.on('exit', info => exits.push(info));
    client.start();
    await client.request('hello');

    await client.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(exits.length, 1);
    assert.equal(exits[0].unexpected, false);

    fs.rmSync(directory, { recursive: true, force: true });
});

test('真实后端可用时协议一致', async t => {
    const executable = resolveExecutable({ repositoryRoot });
    if (!fs.existsSync(executable)) {
        t.skip(`未构建后端（${executable}），跳过真实后端用例`);
        return;
    }

    const directory = temporaryDirectory('backend-real');
    const client = clientFor(executable, directory, { requestTimeout: 20000 });
    client.start();

    const hello = await client.request('hello');
    assert.equal(hello.protocol, 1);
    assert.equal(hello.application, 'wifimeter-backend');

    const snapshot = await client.request('snapshot');
    assert.equal(snapshot.source, 'backend');
    assert.ok(Array.isArray(snapshot.records));
    assert.ok(Array.isArray(snapshot.networks));
    assert.equal(typeof snapshot.live.state, 'string');

    const updated = await client.request('updateSettings', { settings: { unit: 'GiB' } });
    assert.equal(updated.settings.unit, 'GiB');

    const failed = await client.request('noSuchMethod').catch(error => error);
    assert.equal(failed.code, 'unknownMethod');

    await client.stop();
    fs.rmSync(directory, { recursive: true, force: true });
});

test('数据库确实由后端写入', async t => {
    const executable = resolveExecutable({ repositoryRoot });
    if (!fs.existsSync(executable)) {
        t.skip('未构建后端，跳过');
        return;
    }

    const directory = temporaryDirectory('backend-db');
    const databasePath = path.join(directory, 'meter.db');
    const client = new BackendClient({ executable, databasePath, requestTimeout: 20000 });
    client.start();
    await client.request('updateSettings', { settings: { unit: 'GiB', retention: 30 } });
    await client.stop();

    assert.ok(fs.existsSync(databasePath), '后端应当创建数据库文件');
    // 用 sqlite3 命令行独立核对，而不是只信后端自己的返回。
    let schema = '';
    try {
        schema = execFileSync('sqlite3', [databasePath, 'SELECT unit || "|" || retention_days FROM settings;'], { encoding: 'utf8' }).trim();
    } catch {
        t.skip('环境缺少 sqlite3 命令行，跳过核对');
        return;
    }
    assert.equal(schema, 'GiB|30');

    fs.rmSync(directory, { recursive: true, force: true });
});
