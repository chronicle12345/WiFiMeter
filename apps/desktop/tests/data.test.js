import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo } from '../renderer/data/mock.js';
import { DemoStore } from '../renderer/data/mock.js';
import { validateSnapshot, totalOf, quotaFor } from '../renderer/data/model.js';

function memory() {
    const values = new Map();
    return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
}
const fixed = () => new Date(2026, 8, 29, 12);

test('fixtures validate even at month boundaries; hourly totals equal daily totals', () => {
    for (const date of [fixed(), new Date(2026, 9, 1, 0), new Date(2026, 1, 28, 23)]) {
        const data = validateSnapshot(generateDemo(date));
        assert.equal(data.networks.length, 4);
        assert.ok(data.appRecords.some(row => row.name === 'Firefox'));
        for (const row of data.records.filter(r => r.date === data.hourly[0].date)) {
            const hours = totalOf(data.hourly.filter(h => h.networkId === row.networkId));
            assert.equal(hours.rx, BigInt(row.rxBytes));
            assert.equal(hours.tx, BigInt(row.txBytes));
        }
    }
});

test('preferences and network edits survive restart and next day', () => {
    const storage = memory();
    const store = new DemoStore(storage, fixed);
    store.updateSettings({ ...store.snapshot.settings, unit: 'GiB' });
    store.updateNetwork('home', { ...store.snapshot.networks[0], alias: '测试网络', capGb: 50 });
    const records = structuredClone(store.snapshot.records);
    const restarted = new DemoStore(storage, () => new Date(2026, 8, 30, 12));
    assert.equal(restarted.snapshot.settings.unit, 'GiB');
    assert.equal(restarted.snapshot.networks[0].alias, '测试网络');
    assert.deepEqual(restarted.snapshot.records, records);
});

test('pause, offline states and long suspension never accrue traffic', () => {
    const store = new DemoStore(memory(), fixed);
    const before = totalOf(store.snapshot.records).total;
    store.pause(true); store.tick(5);
    store.pause(false);
    for (const state of ['disconnected', 'permission', 'offline']) {
        store.setState(state); store.tick(5);
    }
    store.setState('connected'); store.tick(60);
    assert.equal(totalOf(store.snapshot.records).total, before);
    store.tick(5);
    assert.ok(totalOf(store.snapshot.records).total > before);
    validateSnapshot(store.snapshot);
});

test('daily/monthly ledgers roll over and new day records agree with hourly totals', () => {
    let date = new Date(2026, 8, 30, 23, 59, 59);
    const store = new DemoStore(memory(), () => date);
    date = new Date(2026, 9, 1, 0, 0, 4);
    store.tick(5);
    const day = store.snapshot.records.find(r => r.date === '2026-10-01');
    assert.ok(day);
    assert.equal(totalOf([day]).total, quotaFor(store.snapshot, store.snapshot.networks[0], date).used);
    assert.equal(totalOf([day]).total, totalOf(store.snapshot.hourly.filter(r => r.date === day.date)).total);
    assert.equal(store.snapshot.networks[0].quotaLedger.periodKey, '2026-10');
});

test('backup restores exact bytes and pauses; invalid and partial exports are rejected', () => {
    const store = new DemoStore(memory(), fixed);
    store.snapshot.records[0].rxBytes = '18446744073709551615';
    const backup = JSON.stringify({ ...store.snapshot, backupType: 'wifimeter-ui-demo' });
    store.clearRecords();
    store.restore(store.validateBackup(backup));
    assert.equal(store.snapshot.records[0].rxBytes, '18446744073709551615');
    assert.equal(store.snapshot.live.collector, 'paused');
    assert.throws(() => store.validateBackup('{invalid'));
    assert.throws(() => store.validateBackup('{"type":"usage-export"}'));
    const bad = JSON.parse(backup); bad.records[0].rxBytes = '-1';
    assert.throws(() => store.validateBackup(JSON.stringify(bad)));
});

test('retention pruning preserves quota ledger; clear keeps preferences and networks', () => {
    const store = new DemoStore(memory(), fixed);
    const used = quotaFor(store.snapshot, store.snapshot.networks[0], fixed()).used;
    store.updateSettings({ ...store.snapshot.settings, retention: 30 });
    assert.ok(store.snapshot.records.every(r => r.date >= '2026-08-31'));
    assert.equal(quotaFor(store.snapshot, store.snapshot.networks[0], fixed()).used, used);
    store.clearRecords();
    assert.equal(store.snapshot.records.length, 0);
    assert.equal(store.snapshot.networks.length, 4);
    assert.equal(store.snapshot.settings.retention, 30);
    assert.equal(quotaFor(store.snapshot, store.snapshot.networks[0], fixed()).used, 0n);
});

test('quota disconnect affects only simulated state and fires a demo message', () => {
    const store = new DemoStore(memory(), fixed);
    store.updateNetwork('home', { ...store.snapshot.networks[0], capGb: 1, autoDisconnect: true });
    const messages = store.tick(5);
    assert.equal(store.snapshot.live.state, 'disconnected');
    assert.ok(messages.some(message => message.includes('已模拟超额断开')));
});

test('unavailable local storage still permits demo use', () => {
    const store = new DemoStore({ getItem() { throw Error('denied'); }, setItem() { throw Error('full'); } }, fixed);
    store.tick(5);
    assert.equal(store.storageFailed, true);
    assert.equal(store.snapshot.networks.length, 4);
});

test('累计额度使用独立账本，历史裁剪与日期变化都不重置',()=>{
    const data=generateDemo(fixed());const network=data.networks[0];
    network.quotaPeriod='all';network.quotaLedger={periodKey:'all',usedBytes:'9007199254740993'};
    data.records=[];data.settings.retention=45;data.settings.language='en';
    const validated=validateSnapshot(data);
    assert.equal(quotaFor(validated,validated.networks[0],new Date(2027,0,1)).used,9007199254740993n);
    assert.equal(validated.settings.retention,45);
    assert.equal(validated.settings.language,'en');
});

test('主分支合法大额度导入不被拒绝或改写，并保留一字节下限',()=>{
    for(const capGb of [0,1e-9,100000.01,9000000000]){
        const data=generateDemo(fixed());data.networks[0].capGb=capGb;
        const imported=validateSnapshot(JSON.parse(JSON.stringify(data)));
        assert.equal(imported.networks[0].capGb,capGb);
    }
    for(const capGb of [-1,1e-10,9000000001,Infinity,NaN]){
        const data=generateDemo(fixed());data.networks[0].capGb=capGb;
        assert.throws(()=>validateSnapshot(data));
    }
});

test('有线快照保留类型与身份，不要求无线频段和信号',()=>{
 const data=generateDemo(fixed()),network=data.networks[0];network.type='ethernet';
 const identity=network.ssid,key=network.id;
 for(const connection of data.live.connections.filter(c=>c.networkId===key)){connection.type='ethernet';delete connection.band;delete connection.signal;}
 const result=validateSnapshot(data);
 assert.equal(result.networks[0].type,'ethernet');assert.equal(result.networks[0].ssid,identity);assert.equal(result.networks[0].id,key);
});
