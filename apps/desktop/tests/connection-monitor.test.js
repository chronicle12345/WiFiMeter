import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { createConnectionMonitor, normalizeControllerUrl, parseControllerJson, normalizeConnection, requestController } = require('../host/connection-monitor.cjs');

function scheduler() {
    let sequence = 0;
    const timers = new Map();
    return { timers, setTimer(work, delay) { const id = ++sequence; timers.set(id, { work, delay }); return id; }, clearTimer(id) { timers.delete(id); } };
}

function fixture(options = {}) {
    let time = 1000;
    const timer = scheduler();
    let response = { connections: [] };
    const calls = [];
    const monitor = createConnectionMonitor({ now: () => time, ...timer, request: async input => { calls.push(input); return response; }, ...options });
    return { monitor, timer, calls, time(value) { time = value; }, response(value) { response = value; } };
}

const connection = (changes = {}) => ({ id: 'one', start: '2026-11-22T01:00:00Z', metadata: { host: 'example.test', destinationIP: '203.0.113.4', destinationPort: '443', sourceIP: '127.0.0.1', sourcePort: '50100', network: 'tcp', type: 'HTTP', process: 'browser.exe', processPath: 'C:/Apps/browser.exe' }, chains: ['DIRECT'], rule: 'DomainSuffix', rulePayload: 'example.test', upload: 50, download: 100, ...changes });

test('controller URLs stay on literal loopback and cannot carry credentials or paths', () => {
    assert.equal(normalizeControllerUrl('http://localhost:9090/'), 'http://127.0.0.1:9090');
    assert.equal(normalizeControllerUrl('https://[::1]:9090'), 'https://[::1]:9090');
    for (const url of ['http://192.168.0.1:9090', 'http://example.test', 'http://127.0.0.1.evil.test', 'file:///tmp/test', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/private', 'http://127.0.0.1/?token=x', 'http://127.0.0.1/#token']) {
        assert.throws(() => normalizeControllerUrl(url), /controller|控制器/i);
    }
});

test('controller JSON keeps exact large integers without changing numbers embedded in strings', () => {
    const value = parseControllerJson('{"downloadTotal":9223372036854775807,"connections":[{"download":9007199254740993,"upload":10,"metadata":{"host":"number-9007199254740993.test"}}],"note":' + JSON.stringify('escaped " 9223372036854775807') + '}');
    assert.equal(value.downloadTotal, '9223372036854775807');
    assert.equal(value.connections[0].download, '9007199254740993');
    assert.equal(value.connections[0].upload, 10);
    assert.equal(value.connections[0].metadata.host, 'number-9007199254740993.test');
    assert.equal(value.note, 'escaped " 9223372036854775807');
    assert.throws(() => parseControllerJson('{"x":1,}'));
});

test('unsafe numeric property names remain invalid controller JSON', () => {
    for (const body of ['{9007199254740993:1}', '{"connections":[], 9007199254740993 : 1}', '{-9007199254740993:1}']) {
        assert.throws(() => parseControllerJson(body), { code: 'RESPONSE_INVALID' });
    }
    assert.equal(parseControllerJson('{"9007199254740993":9007199254740993}')['9007199254740993'], '9007199254740993');
});

test('connection normalization distinguishes direct, proxy, blocked and missing evidence', () => {
    assert.equal(normalizeConnection(connection()).route, 'direct');
    const types = new Map([['node-a', 'Shadowsocks'], ['custom-direct', 'Direct']]);
    assert.equal(normalizeConnection(connection({ chains: ['node-a', 'group-a'] }), types).route, 'proxy');
    assert.equal(normalizeConnection(connection({ chains: ['REJECT', 'group-a'] })).route, 'blocked');
    assert.equal(normalizeConnection(connection({ chains: [] })).route, 'unknown');
    assert.equal(normalizeConnection(connection({ chains: ['node-a', 'DIRECT'] }), types).route, 'proxy');
    assert.equal(normalizeConnection(connection({ chains: ['node-a', 'DIRECT'] })).route, 'unknown');
    assert.equal(normalizeConnection(connection({ chains: ['custom-direct', 'group'] }), types).route, 'direct');
    assert.equal(normalizeConnection(connection({ download: '9007199254740993' })).downloadBytes, '9007199254740993');
    assert.equal(normalizeConnection(connection({ download: 9007199254740992 })).downloadBytes, null);
    assert.equal(normalizeConnection(connection({ metadata: { destinationIP: '203.0.113.1' } })).host, '');
});

test('a missing terminal chain entry never borrows the route of an outer group', () => {
    const types = new Map([['DIRECT', 'Direct'], ['REJECT', 'Reject'], ['\u0000', 'Shadowsocks']]);
    for (const chains of [['', 'DIRECT'], [null, 'REJECT'], ['\u0000', 'DIRECT'], [{}, 'DIRECT'], [123, 'REJECT']]) {
        assert.equal(normalizeConnection(connection({ chains }), types).route, 'unknown');
    }
});

test('route classification uses the raw terminal name despite cleaned control characters', () => {
    const types = new Map([['DIRECT', 'Direct'], ['DIRECT\n', 'Shadowsocks'], ['REJECT', 'Reject'], ['REJECT\u0000', 'Shadowsocks']]);
    for (const terminal of ['DIRECT\n', 'REJECT\u0000']) {
        const record = normalizeConnection(connection({ chains: [terminal, 'DIRECT'] }), types);
        assert.equal(record.route, 'proxy');
        assert.equal(record.chains[0], terminal.replace(/[\x00-\x1f\x7f]/g, ''));
    }
});

test('route classification keeps overlong terminal identities separate from their display prefix', async () => {
    const prefix = 'node'.repeat(64), terminal = prefix + '-proxy';
    let defined = true;
    const { monitor, time } = fixture({ request: async input => {
        if (input.resource === 'proxies') return { proxies: { [prefix]: { type: 'Direct' }, ...(defined ? { [terminal]: { type: 'Shadowsocks' } } : {}) } };
        return { connections: [connection({ chains: [terminal, 'DIRECT'] })] };
    } });
    try {
        await monitor.configure({ enabled: true });
        const result = await monitor.refresh();
        assert.equal(result.records[0].route, 'proxy');
        assert.equal(result.records[0].chains[0], prefix);
        defined = false; time(2000);
        assert.equal((await monitor.refresh()).records[0].route, 'unknown');
    } finally { monitor.dispose(); }
});

test('monitor starts disabled, persists redacted configuration, and never exposes the secret', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-connections-'));
    const timer = scheduler();
    const monitor = createConnectionMonitor({ userDataDir: directory, ...timer });
    try {
        assert.equal((await monitor.status()).state, 'disabled');
        assert.equal(timer.timers.size, 0);
        const configured = await monitor.configure({ enabled: true, controllerUrl: 'http://localhost:9090', secret: 'private-token', intervalMs: 500 });
        assert.equal(configured.hasSecret, true);
        assert.equal(configured.state, 'connecting');
        assert.equal(JSON.stringify(configured).includes('private-token'), false);
        assert.equal(JSON.parse(await readFile(path.join(directory, 'connection-monitor.json'), 'utf8')).secret, 'private-token');
        assert.equal(timer.timers.size, 1);
        await assert.rejects(monitor.configure({ intervalMs: 1 }));
        assert.equal((await monitor.status()).intervalMs, 500);
        await monitor.configure({ enabled: false });
        assert.equal(timer.timers.size, 0);
    } finally { monitor.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('polling derives rates from elapsed time and closes only connections missing from a successful snapshot', async () => {
    const { monitor, response, time } = fixture();
    try {
        await monitor.configure({ enabled: true });
        response({ connections: [connection()] });
        let result = await monitor.refresh();
        assert.equal(result.active, 1);
        assert.equal(result.records[0].measurementAvailable, false);
        assert.equal(result.records[0].downloadRate, null);
        time(3000);
        response({ connections: [connection({ download: 500, upload: 150 })] });
        result = await monitor.refresh();
        assert.equal(result.records[0].downloadRate, 200);
        assert.equal(result.records[0].uploadRate, 50);
        assert.equal(result.records[0].measurementAvailable, true);
        time(4000); response({ connections: [] });
        result = await monitor.refresh();
        assert.equal(result.active, 0);
        assert.equal(result.records[0].active, false);
        assert.equal(result.records[0].endReason, 'closed');
        assert.equal(result.records[0].downloadRate, null);
        assert.equal((await monitor.read({ state: 'active' })).records.length, 0);
        assert.equal((await monitor.read({ search: 'BROWSER', state: 'closed', route: 'direct' })).records.length, 1);
    } finally { monitor.dispose(); }
});

test('counter resets and invalid measurements do not turn into false zero rates', async () => {
    const { monitor, response, time } = fixture();
    try {
        await monitor.configure({ enabled: true }); response({ connections: [connection()] }); await monitor.refresh();
        time(2000); response({ connections: [connection({ download: 2, upload: 1 })] });
        const result = await monitor.refresh();
        assert.equal(result.records[0].measurementAvailable, false);
        assert.equal(result.records[0].uploadRate, null);
        assert.equal(result.records[0].downloadRate, null);
    } finally { monitor.dispose(); }
});

test('request errors leave explicit unobserved history, clear live rates and redact arbitrary errors', async () => {
    let fail = false;
    const { monitor, time } = fixture({ request: async () => { if (fail) throw Error('Bearer private-token secret payload'); return { connections: [connection()] }; } });
    try {
        await monitor.configure({ enabled: true, secret: 'private-token' }); await monitor.refresh();
        fail = true; time(3000);
        const result = await monitor.refresh();
        assert.equal(result.state, 'error');
        assert.equal(result.active, 0);
        assert.equal(result.records[0].endReason, 'disconnected');
        assert.equal(result.records[0].downloadRate, null);
        assert.equal(JSON.stringify(result).includes('private-token'), false);
        fail = false; time(4000);
        const restored = await monitor.refresh();
        assert.equal(restored.records[0].measurementAvailable, false);
        assert.equal(restored.records[0].active, true);
    } finally { monitor.dispose(); }
});

test('concurrent refresh shares a request and a disabled monitor rejects late observations', async () => {
    let finish, count = 0;
    const { monitor, timer } = fixture({ request: input => { if (input.resource === 'proxies') return Promise.resolve({ proxies: {} }); count++; return new Promise(resolve => { finish = resolve; }); } });
    try {
        await monitor.configure({ enabled: true });
        const first = monitor.refresh(), second = monitor.refresh();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(count, 1);
        await monitor.configure({ enabled: false });
        finish({ connections: [connection()] });
        const results = await Promise.all([first, second]);
        for (const result of results) { assert.equal(result.state, 'disabled'); assert.equal(result.records.length, 0); }
        assert.equal(timer.timers.size, 0);
    } finally { monitor.dispose(); monitor.dispose(); }
});

test('session history and read limits are bounded, and clear resets rate baselines', async () => {
    const { monitor, response, time } = fixture({ maxRecords: 3 });
    try {
        await monitor.configure({ enabled: true });
        for (let index = 0; index < 5; index++) { time(1000 + index * 1000); response({ connections: [connection({ id: String(index) })] }); await monitor.refresh(); }
        assert.equal((await monitor.read()).total, 3);
        assert.equal((await monitor.read({ limit: 1 })).records.length, 1);
        assert.equal((await monitor.read({ search: '203.0.113.4' })).records.length, 3);
        await monitor.clear();
        assert.equal((await monitor.read()).total, 0);
        time(7000);
        const result = await monitor.refresh();
        assert.equal(result.records[0].measurementAvailable, false);
    } finally { monitor.dispose(); }
});

test('application choices preserve full executable paths and filter independently from free text', async () => {
    const { monitor, response } = fixture();
    try {
        await monitor.configure({ enabled: true });
        response({ connections: [connection(), connection({ id: 'two', metadata: { host: 'second.test', process: 'browser.exe', processPath: 'D:/Apps/browser.exe' } }), connection({ id: 'three', metadata: {} })] });
        await monitor.refresh();
        const result = await monitor.read({ application: 'c:/apps/browser.exe', search: 'example', limit: 1 });
        assert.equal(result.total, 3); assert.equal(result.active, 3); assert.equal(result.matched, 1);
        assert.equal(result.records.length, 1);
        assert.equal(result.applications.length, 3);
        assert.equal(result.applications.find(app => app.key === '__unknown__').name, '');
        assert.equal((await monitor.read({ application: '__unknown__' })).records[0].id, 'three');
        assert.equal(Object.hasOwn(result.records[0], 'sampledAt'), false);
        assert.equal(Object.hasOwn(result.records[0], 'observation'), false);
    } finally { monitor.dispose(); }
});

test('UNC application identities ignore Windows case and separators while Unix paths retain case', async () => {
    const { monitor, response } = fixture();
    try {
        await monitor.configure({ enabled: true });
        response({ connections: [
            connection({ id: 'unc-a', metadata: { processPath: '\\\\SERVER\\Apps\\Browser.exe' } }),
            connection({ id: 'unc-b', metadata: { processPath: '//server/apps/browser.exe' } }),
            connection({ id: 'unix-a', metadata: { processPath: '/usr/Browser' } }),
            connection({ id: 'unix-b', metadata: { processPath: '/usr/browser' } }),
        ] });
        await monitor.refresh();
        const result = await monitor.read({ application: '//SERVER/APPS/Browser.exe' });
        assert.equal(result.matched, 2);
        assert.equal(result.applications.length, 3);
        assert.equal(result.applications.filter(app => app.key === '\\\\server\\apps\\browser.exe').length, 1);
        assert.equal((await monitor.read({ application: '/usr/Browser' })).records[0].id, 'unix-a');
    } finally { monitor.dispose(); }
});

test('record lookup returns closed observations independently from the active application filter', async () => {
    const { monitor, response, time } = fixture();
    try {
        await monitor.configure({ enabled: true });
        response({ connections: [connection()] }); await monitor.refresh();
        time(2000);
        response({ connections: [connection({ id: 'updater', metadata: { processPath: 'D:/Apps/updater.exe' } })] });
        await monitor.refresh();
        const visible = await monitor.read({ state: 'active', application: 'D:/Apps/updater.exe' });
        assert.deepEqual(visible.records.map(row => row.id), ['updater']);
        const detail = await monitor.read({ id: 'one', limit: 1 });
        assert.equal(detail.matched, 1);
        assert.equal(detail.records[0].id, 'one');
        assert.equal(detail.records[0].active, false);
        assert.equal(detail.records[0].endReason, 'closed');
        assert.equal(detail.records[0].downloadBytes, '100');
        assert.equal((await monitor.read({ id: 'missing', limit: 1 })).records.length, 0);
        for (const id of ['', 1, 'x'.repeat(257)]) await assert.rejects(monitor.read({ id, limit: 1 }));
    } finally { monitor.dispose(); }
});

test('proxy types are reread for each snapshot so controller reloads cannot reuse stale classifications', async () => {
    const calls = [];
    let directType = 'Direct';
    const { monitor, time } = fixture({ request: async input => {
        calls.push(input.resource);
        if (input.resource === 'proxies') return { proxies: { local: { type: directType }, blocked: { type: 'Reject' }, tunnel: { type: 'WireGuard' } } };
        return { connections: [connection({ id: 'direct', chains: ['local', 'group'] }), connection({ id: 'blocked', chains: ['blocked', 'group'] }), connection({ id: 'tunnel', chains: ['tunnel', 'group'] }), connection({ id: 'unknown', chains: ['unlisted', 'group'] })] };
    } });
    try {
        await monitor.configure({ enabled: true });
        let result = await monitor.refresh();
        assert.equal(result.records.find(row => row.id === 'direct').route, 'direct');
        assert.equal(result.records.find(row => row.id === 'blocked').route, 'blocked');
        assert.equal(result.records.find(row => row.id === 'tunnel').route, 'proxy');
        assert.equal(result.records.find(row => row.id === 'unknown').route, 'unknown');
        directType = 'Shadowsocks'; time(2000);
        result = await monitor.refresh();
        assert.equal(result.records.find(row => row.id === 'direct').route, 'proxy');
        assert.equal(calls.filter(resource => resource === 'proxies').length, 2);
        time(32000); await monitor.refresh();
        assert.equal(calls.filter(resource => resource === 'proxies').length, 3);
    } finally { monitor.dispose(); }
});

test('a failed or unsupported proxy type lookup leaves the connection feed usable', async () => {
    const { monitor } = fixture({ request: async input => {
        if (input.resource === 'proxies') throw Error('unsupported');
        return { connections: [connection(), connection({ id: 'unknown', chains: ['custom'] })] };
    } });
    try {
        await monitor.configure({ enabled: true });
        const result = await monitor.refresh();
        assert.equal(result.state, 'connected');
        assert.equal(result.records.find(row => row.id === 'one').route, 'direct');
        assert.equal(result.records.find(row => row.id === 'unknown').route, 'unknown');
    } finally { monitor.dispose(); }
});

test('restarting restores controller configuration but does not persist observed destinations', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-connections-'));
    const first = fixture({ userDataDir: directory });
    let second;
    try {
        await first.monitor.configure({ enabled: true, secret: 'private-token' });
        first.response({ connections: [connection()] }); await first.monitor.refresh(); first.monitor.dispose();
        second = fixture({ userDataDir: directory });
        const result = await second.monitor.read();
        assert.equal(result.total, 0); assert.equal(result.hasSecret, true); assert.equal(result.enabled, true);
        assert.equal(result.state, 'connecting');
        assert.equal((await readFile(path.join(directory, 'connection-monitor.json'), 'utf8')).includes('example.test'), false);
        await second.monitor.configure({ secret: '' });
        assert.equal((await second.monitor.status()).hasSecret, false);
    } finally { first.monitor.dispose(); second?.monitor.dispose(); await rm(directory, { recursive: true, force: true }); }
});

async function withController(handler, work) {
    const server = http.createServer(handler);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try { await work('http://127.0.0.1:' + server.address().port); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('native HTTP transport reads exact counters and sends the secret only as a bearer header', async () => {
    await withController((request, response) => {
        assert.equal(request.url, '/connections');
        assert.equal(request.headers.authorization, 'Bearer private-token');
        response.end('{"connections":[],"downloadTotal":9007199254740993}');
    }, async url => {
        const result = await requestController({ url, secret: 'private-token' });
        assert.equal(result.downloadTotal, '9007199254740993');
    });
});

test('native HTTP transport rejects authentication failures, redirects and oversized responses', async () => {
    for (const [status, expected] of [[401, 'AUTHENTICATION'], [302, 'REDIRECT'], [500, 'HTTP_STATUS']]) {
        await withController((request, response) => { response.writeHead(status, { Location: 'http://example.test' }); response.end('private-token'); }, async url => {
            await assert.rejects(requestController({ url, secret: 'private-token' }), error => error.code === expected && !error.message.includes('private-token'));
        });
    }
    await withController((request, response) => { response.end('x'.repeat(2048)); }, async url => {
        await assert.rejects(requestController({ url, maxBytes: 1024 }), error => error.code === 'RESPONSE_SIZE');
    });
});

test('native HTTP transport has an absolute timeout and accepts cancellation', async () => {
    await withController(() => {}, async url => {
        await assert.rejects(requestController({ url, timeoutMs: 25 }), error => error.code === 'TIMEOUT');
        const abort = new AbortController();
        const pending = requestController({ url, signal: abort.signal }); abort.abort();
        await assert.rejects(pending, error => error.code === 'ABORTED');
    });
});

test('disabled startup and reads perform no network requests', async () => {
    const { monitor, calls, timer } = fixture();
    try {
        await monitor.status(); await monitor.read(); await monitor.refresh(); await monitor.clear();
        assert.equal(calls.length, 0); assert.equal(timer.timers.size, 0);
    } finally { monitor.dispose(); }
});

test('a failed configuration write preserves the prior settings, observations and timer', async () => {
    let fail = false;
    const io = {
        readFile: async () => { const error = Error('missing'); error.code = 'ENOENT'; throw error; },
        mkdir: async () => {}, writeFile: async () => { if (fail) throw Error('disk failure private-token'); },
        rename: async () => {}, unlink: async () => {},
    };
    const { monitor, response, timer } = fixture({ userDataDir: 'isolated-fixture', io });
    try {
        await monitor.configure({ enabled: true, secret: 'private-token', intervalMs: 500 });
        response({ connections: [connection()] }); await monitor.refresh();
        fail = true;
        await assert.rejects(monitor.configure({ enabled: false, controllerUrl: 'http://127.0.0.1:9091', secret: 'different-token' }), failure => !failure.message.includes('private-token'));
        const result = await monitor.read();
        assert.equal(result.enabled, true); assert.equal(result.state, 'connected'); assert.equal(result.active, 1);
        assert.equal(result.controllerUrl, 'http://127.0.0.1:9090'); assert.equal(result.intervalMs, 500);
        assert.equal(timer.timers.size, 1); assert.equal(result.hasSecret, true);
    } finally { monitor.dispose(); }
});

test('dispose cancels in-flight work, drops retained credentials and ignores a late response', async () => {
    let finish, signal;
    const { monitor, timer } = fixture({ request: async input => {
        if (input.resource === 'proxies') return { proxies: {} };
        signal = input.signal; return new Promise(resolve => { finish = resolve; });
    } });
    await monitor.configure({ enabled: true, secret: 'private-token' });
    const pending = monitor.refresh(); await new Promise(resolve => setImmediate(resolve));
    monitor.dispose(); monitor.dispose();
    assert.equal(signal.aborted, true);
    finish({ connections: [connection()] }); await pending;
    const result = await monitor.read();
    assert.equal(result.state, 'disabled'); assert.equal(result.enabled, false); assert.equal(result.hasSecret, false);
    assert.equal(result.total, 0); assert.equal(timer.timers.size, 0);
});

test('dispose during configuration persistence cannot restart polling or retain credentials', async () => {
    let finish;
    const io = {
        readFile: async () => { const error = Error('missing'); error.code = 'ENOENT'; throw error; },
        mkdir: async () => {}, writeFile: () => new Promise(resolve => { finish = resolve; }),
        rename: async () => {}, unlink: async () => {},
    };
    const { monitor, timer } = fixture({ userDataDir: 'isolated-fixture', io });
    const pending = monitor.configure({ enabled: true, secret: 'private-token' });
    await new Promise(resolve => setImmediate(resolve));
    monitor.dispose(); finish();
    await assert.rejects(pending, /已停止/);
    const status = await monitor.status();
    assert.equal(status.enabled, false); assert.equal(status.hasSecret, false); assert.equal(timer.timers.size, 0);
});

test('an unreadable configuration starts safely and can be repaired by saving fresh settings', async () => {
    const io = { readFile: async () => '{"secret":"private-token",invalid}', mkdir: async () => {}, writeFile: async () => {}, rename: async () => {}, unlink: async () => {} };
    const { monitor, calls, timer } = fixture({ userDataDir: 'isolated-fixture', io });
    try {
        const status = await monitor.status();
        assert.equal(status.enabled, false); assert.equal(status.state, 'error');
        assert.equal(JSON.stringify(status).includes('private-token'), false);
        assert.equal(calls.length, 0); assert.equal(timer.timers.size, 0);
        await monitor.configure({ enabled: true, secret: 'replacement-token' });
        assert.equal((await monitor.status()).state, 'connecting');
        assert.equal(timer.timers.size, 1);
    } finally { monitor.dispose(); }
});

test('a malformed snapshot cannot falsely establish that a connection closed', async () => {
    const { monitor, response } = fixture();
    try {
        await monitor.configure({ enabled: true }); response({ connections: [connection()] }); await monitor.refresh();
        response({ connections: [{}] });
        const result = await monitor.refresh();
        assert.equal(result.state, 'error');
        assert.equal(result.records[0].endReason, 'disconnected');
        assert.equal(result.records[0].downloadBytes, '100');
    } finally { monitor.dispose(); }
});
