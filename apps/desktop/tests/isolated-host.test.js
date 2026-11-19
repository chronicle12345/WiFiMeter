import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIsolatedHost } from './support/isolated-host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('isolated host waits for process close when termination was already requested', async () => {
    const isolated = createIsolatedHost({ root, env: process.env });
    const { BackendClient } = isolated.load(path.join(root, 'apps/desktop/host/backend.cjs'));
    const client = new BackendClient({ executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)', '--'], databasePath: ':memory:' });
    client.start();
    const child = client.child;
    const closed = once(child, 'close');
    let closeReceived = false;
    child.once('close', () => { closeReceived = true; });
    try {
        await once(child, 'spawn');
        assert.equal(child.kill(), true);
        // Windows can reject a repeated kill while the first termination is pending.
        child.kill = () => false;
        await isolated.dispose();
        assert.equal(closeReceived, true, 'dispose must wait for close before database cleanup');
        assert.equal(isolated.children.size, 0);
    } finally {
        await closed;
        await isolated.dispose();
    }
});


test('browser isolate injects the application-control runner while retaining the real validation and record module', async () => {
    const original = childProcess.execFile;
    let nativeCalls = 0, substitutedCalls = 0;
    // A sentinel prevents real OS queries in the red test and proves whether the factory used its injection.
    childProcess.execFile = (...args) => {
        nativeCalls++;
        const callback = args.at(-1);
        queueMicrotask(() => callback(null, { stdout: JSON.stringify({ Status: 'Succeeded', State: { Blocked: false, Throttled: false, DownloadThrottled: false, Scope: 'UnisolatedSentinel' } }) }));
    };
    const state = { Blocked: false, InboundBlocked: false, OutboundBlocked: false, FirewallRuleCount: 0,
        Throttled: false, DownloadThrottled: false, Scope: 'BrowserFixture' };
    const isolated = createIsolatedHost({ root, env: { WIFIMETER_TEST_ISOLATION: '1' }, appControlRunner: async (_file, _args, options) => {
        substitutedCalls++; assert.equal(options.windowsHide, true);
        return { stdout: JSON.stringify({ Status: 'Succeeded', State: state }) };
    } });
    const bytes = Buffer.alloc(512);
    bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.write('PE\0\0', 128);
    bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(1, 134); bytes.writeUInt16LE(240, 148);
    bytes.writeUInt16LE(2, 150); bytes.writeUInt16LE(0x20b, 152);
    const io = { realpath: async value => value, open: async () => ({ stat: async () => ({ isFile: () => true, size: bytes.length }),
        read: async (buffer, offset, length, position) => ({ bytesRead: bytes.copy(buffer, offset, position, position + length) }), close: async () => {} }) };
    try {
        const { createAppControl } = isolated.load(path.join(root, 'apps/desktop/host/app-control.cjs'));
        const controls = createAppControl({ platform: 'win32', io });
        const result = await controls.request({ action: 'read', path: String.raw`C:\Apps\Fixture.exe` });
        assert.equal(nativeCalls, 0);
        assert.equal(substitutedCalls, 1);
        assert.equal(result.ok, true);
        assert.deepEqual(JSON.parse(JSON.stringify(result.result.state)), state);
        assert.equal((await controls.request({ action: 'read', path: '../../outside.exe' })).error.code, 'invalidRequest');
        assert.equal(substitutedCalls, 1, 'invalid paths must still be rejected by the real owner before the fixture runner');
    } finally { childProcess.execFile = original; await isolated.dispose(); }
});
