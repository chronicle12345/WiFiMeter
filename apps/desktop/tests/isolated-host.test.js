import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
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
