import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataClient } from '../renderer/data/backend-client.js';

test('清空真实后端记录后，同步移除页面的应用历史', async t => {
    const original = globalThis.window;
    t.after(() => { if (original === undefined) delete globalThis.window; else globalThis.window = original; });
    const methods = [];
    globalThis.window = { desktop: { backend: {
        request: async method => {
            methods.push(method);
            return { ok: true, result: method === 'snapshot' ? {
                records: [{ date: '2026-09-30', networkId: 'home', rxBytes: '100', txBytes: '10' }],
                appRecords: [{ date: '2026-09-30', networkId: 'home', appId: 'browser', name: '浏览器', rxBytes: '80', txBytes: '5' }]
            } : {} };
        },
        onEvent: () => () => {}
    } } };
    const client = createDataClient();
    await client.start();
    assert.equal(client.snapshot.appRecords.length, 1);
    await client.clearRecords();
    assert.deepEqual(client.snapshot.appRecords, []);
    assert.deepEqual(client.snapshot.records, []);
    assert.equal(client.snapshot.live.collector, 'paused');
    assert.deepEqual(methods, ['hello', 'snapshot', 'clearUsage']);
});
