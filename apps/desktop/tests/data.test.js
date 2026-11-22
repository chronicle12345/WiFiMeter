import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo } from './fixtures/snapshot.js';
import { validateSnapshot, totalOf, quotaFor } from '../renderer/data/model.js';

const fixed = () => new Date(2026, 8, 29, 12);

test('custom millisecond sampling and unavailable interface rates retain their meanings',()=>{
    for(const interval of [0.25,0.333,1,2,5,10,3599.999,3600]){
        const data=generateDemo(fixed());data.settings.interval=interval;
        const connection=data.live.connections[0];
        connection.measurementAvailable=false;connection.rxPerSecond=null;connection.txPerSecond=null;
        const validated=validateSnapshot(data);
        assert.equal(validated.settings.interval,interval);
        assert.equal(validated.live.connections[0].rxPerSecond,null);
    }
    for(const interval of [0,0.249,0.2501,3600.001,'0.25',Infinity,NaN]){
        const data=generateDemo(fixed());data.settings.interval=interval;
        assert.throws(()=>validateSnapshot(data));
    }
    const invalid=generateDemo(fixed());invalid.live.connections[0].measurementAvailable='false';
    assert.throws(()=>validateSnapshot(invalid));
});

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
