const test = require('node:test');
const assert = require('node:assert/strict');

test('demo data is repeatable, localized and independent of the machine clock', async () => {
    const { createDemoFixture } = await import('../demo/fixture.mjs');
    const zh = createDemoFixture('zh-CN');
    assert.deepEqual(createDemoFixture('zh-CN'), zh);
    assert.equal(zh.snapshot.settings.language, 'zh-CN');
    assert.equal(createDemoFixture('en').snapshot.networks[0].alias, 'Home Wi-Fi');
    assert.throws(() => createDemoFixture('fr'), /language/i);
    assert.ok(zh.snapshot.records.every(row => row.date <= '2026-11-21'));
});

test('demo transport rejects system actions and unknown requests', async () => {
    const { createDemoFixture } = await import('../demo/fixture.mjs');
    const { createDemoTransport } = await import('../demo/transport.mjs');
    const transport = createDemoTransport(createDemoFixture('zh-CN'));
    for (const channel of ['files:open-backup', 'app-control:request', 'updates:download', 'cloud-backup:restore']) {
        assert.throws(() => transport.request(channel, []), /Unsupported demo request/);
    }
    for (const method of ['disconnect', 'restore', 'clearUsage', 'setAppCollection']) {
        assert.throws(() => transport.request('backend:request', [{ method }]), /Unsupported demo request/);
    }
});

test('demo range queries return isolated results and synthetic live frames conserve rates', async () => {
    const { createDemoFixture } = await import('../demo/fixture.mjs');
    const { createDemoTransport } = await import('../demo/transport.mjs');
    const transport = createDemoTransport(createDemoFixture('en'));
    const query = () => transport.request('backend:request', [{ method: 'snapshot', params: { from: '2026-11-10', to: '2026-11-12' } }]);
    const first = query();
    assert.ok(first.result.records.length > 0);
    assert.ok(first.result.records.every(row => row.date >= '2026-11-10' && row.date <= '2026-11-12'));
    first.result.networks[0].ssid = 'changed';
    assert.notEqual(query().result.networks[0].ssid, 'changed');
    for (const frame of [0, 1, 20, 40]) {
        const live = transport.frame(frame);
        for (const field of ['rxPerSecond', 'txPerSecond']) {
            assert.equal(live.appProcesses.reduce((sum, row) => sum + BigInt(row[field]), 0n), BigInt(live.connections[0][field]));
            assert.ok(BigInt(live.connections[0][field]) > 0n);
        }
    }
});
