import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveTrafficHistory } from '../renderer/data/live-traffic.js';

const origin = Date.parse('2026-11-22T00:00:00.000Z');
const connection = (networkId = 'home', values = {}) => ({ networkId, interfaceId: networkId, since: '2026-11-21T23:00:00Z', rxPerSecond: '1000', txPerSecond: '200', ...values });
const live = (offset, connections = [connection()], values = {}) => ({ updatedAt: new Date(origin + offset).toISOString(), state: 'connected', collector: 'running', skippedIntervals: 0, connections, ...values });
const query = offset => ({ now: origin + offset, intervalSeconds: 1 });

test('live traffic integrates independent samples using their actual elapsed milliseconds', () => {
    const history = createLiveTrafficHistory();
    history.observe(live(0), { intervalSeconds: 1 });
    history.observe(live(1500), { intervalSeconds: 1 });
    assert.equal(history.observe(live(1500), { intervalSeconds: 1 }), false);
    history.observe(live(2500, [connection('home', { rxPerSecond: '2000' })]), { intervalSeconds: 1 });
    assert.deepEqual(history.summary(query(2500)), { rx: 3500n, tx: 500n, total: 4000n, observedMs: 2500, estimated: true });
    assert.equal(history.rows(query(2500))[0].missing, true);
});

test('network filtering sums interfaces while preserving bytes beyond Number precision', () => {
    const history = createLiveTrafficHistory();
    const connections = [connection('home', { rxPerSecond: '9007199254740993' }), connection('work', { rxPerSecond: '7', txPerSecond: '2' })];
    history.observe(live(0, connections));
    history.observe(live(1000, connections));
    assert.equal(history.rows({ ...query(1000), networkId: 'home' }).at(-1).rx, 9007199254740993n);
    assert.equal(history.summary({ ...query(1000), networkId: 'home' }).rx, 9007199254740993n);
    assert.equal(history.summary(query(1000)).rx, 9007199254741000n);
});

test('pause, missing measurements and network changes establish a new baseline without invented zeros', () => {
    const history = createLiveTrafficHistory();
    history.observe(live(0));
    history.observe(live(1000));
    history.observe(live(2000, [], { collector: 'paused' }));
    history.observe(live(3000));
    history.observe(live(4000, [connection('home', { rxPerSecond: null })]));
    history.observe(live(5000));
    history.observe(live(6000, [connection('home', { since: '2026-11-22T00:00:06Z' })]));
    history.observe(live(7000, [connection('home', { since: '2026-11-22T00:00:06Z' })]));
    assert.deepEqual(history.rows(query(7000)).map(row => row.missing), [true, false, true, true, true, true, true, false]);
    assert.equal(history.summary(query(7000)).rx, 2000n);
});

test('lost samples, long gaps and out-of-order events do not add traffic', () => {
    const history = createLiveTrafficHistory();
    history.observe(live(0), { intervalSeconds: 1 });
    history.observe(live(1000), { intervalSeconds: 1 });
    history.observe(live(2000, [connection()], { skippedIntervals: 1 }), { intervalSeconds: 1 });
    history.observe(live(9000, [connection()], { skippedIntervals: 1 }), { intervalSeconds: 1 });
    assert.equal(history.observe(live(8000), { intervalSeconds: 1 }), false);
    assert.equal(history.summary(query(9000)).rx, 1000n);
    assert.equal(history.rows(query(15000)).at(-1).missing, true);
});

test('a rolling window clips the boundary interval and has bounded storage', () => {
    const history = createLiveTrafficHistory({ windowMs: 5000, maxSamples: 20 });
    for (let offset = 0; offset <= 12000; offset += 1000) history.observe(live(offset), { intervalSeconds: 1 });
    assert.equal(history.summary(query(12500)).rx, 4500n);
    assert.equal(history.summary(query(12500)).observedMs, 4500);
    assert.ok(history.rows(query(12500)).length <= 8);
    const bounded = createLiveTrafficHistory({ maxSamples: 5 });
    for (let offset = 0; offset <= 12000; offset += 1000) bounded.observe(live(offset));
    assert.ok(bounded.rows(query(12000)).length <= 5);
    bounded.clear();
    assert.deepEqual(bounded.rows(query(12000)), []);
});

test('fractional samples do not lose bytes through repeated integer rounding', () => {
    const history = createLiveTrafficHistory();
    for (let offset = 0; offset <= 1000; offset += 100) history.observe(live(offset, [connection('home', { rxPerSecond: '1', txPerSecond: '0' })]), { intervalSeconds: 0.1 });
    assert.equal(history.summary(query(1000)).rx, 1n);
});

test('subsecond timestamps retain every observation and a repeated-timestamp pause breaks the next interval', () => {
    const history = createLiveTrafficHistory();
    for (let offset = 0; offset <= 750; offset += 250) history.observe(live(offset), { intervalSeconds: 0.25 });
    assert.equal(history.rows({ now: origin + 750, intervalSeconds: 0.25 }).length, 4);
    assert.equal(history.summary(query(750)).rx, 750n);
    history.observe(live(750, [], { collector: 'paused' }), { intervalSeconds: 0.25 });
    assert.equal(history.rows({ now: origin + 800, intervalSeconds: 0.25 }).at(-1).missing, true);
    history.observe(live(1000), { intervalSeconds: 0.25 });
    assert.equal(history.rows(query(1000)).at(-1).missing, true);
    history.observe(live(1250), { intervalSeconds: 0.25 });
    assert.equal(history.summary(query(1250)).rx, 1000n);
});

test('an old paused event cannot interrupt newer measured samples', () => {
    const history = createLiveTrafficHistory();
    history.observe(live(0));
    history.observe(live(1000));
    assert.equal(history.observe(live(500, [], { collector: 'paused' })), false);
    history.observe(live(2000));
    assert.equal(history.rows(query(2000)).at(-1).missing, false);
    assert.equal(history.summary(query(2000)).rx, 2000n);
});

test('all-network totals mark a disappearing network as missing while an unchanged network stays measurable', () => {
    const history = createLiveTrafficHistory();
    const both = [connection('home'), connection('work', { rxPerSecond: '9000' })];
    history.observe(live(0, both)); history.observe(live(1000, both));
    history.observe(live(2000, [connection('home')]));
    assert.equal(history.rows(query(2000)).at(-1).missing, true);
    assert.equal(history.rows({ ...query(2000), networkId: 'home' }).at(-1).missing, false);
    assert.equal(history.summary(query(2000)).rx, 10000n);
    assert.equal(history.summary({ ...query(2000), networkId: 'home' }).rx, 2000n);
});

test('interface removal inside one network breaks that network and aggregate totals without affecting other networks', () => {
    const history = createLiveTrafficHistory();
    const home1 = connection('home', { interfaceId: 'wifi-one' }), home2 = connection('home', { interfaceId: 'wifi-two', rxPerSecond: '9000' });
    const work = connection('work');
    history.observe(live(0, [home1, home2, work])); history.observe(live(1000, [home1, home2, work]));
    history.observe(live(2000, [home1, work]));
    assert.equal(history.rows(query(2000)).at(-1).missing, true);
    assert.equal(history.rows({ ...query(2000), networkId: 'home' }).at(-1).missing, true);
    assert.equal(history.rows({ ...query(2000), networkId: 'work' }).at(-1).missing, false);
    assert.equal(history.summary({ ...query(2000), networkId: 'work' }).rx, 2000n);
});

test('an explicit unavailable measurement overrides old numeric rate fields', () => {
    const history = createLiveTrafficHistory();
    history.observe(live(0)); history.observe(live(1000));
    history.observe(live(2000, [connection('home', { measurementAvailable: false })]));
    assert.equal(history.rows(query(2000)).at(-1).missing, true);
    assert.equal(history.summary(query(2000)).rx, 1000n);
});
