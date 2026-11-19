import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationProxyDetails } from '../renderer/data/application-proxy.js';
import * as proxyDetailsModule from '../renderer/data/application-proxy.js';
import { applicationDetails } from '../renderer/ui/applications.js';
import { setLanguage } from '../renderer/i18n.js';

const clientId = 'C:\\Apps\\Browser.exe', proxyId = 'C:\\Proxy\\Proxy.exe';
const native = (networkId, date, rxBytes = '100', txBytes = '40') => ({ networkId, date, appId: proxyId, name: 'Proxy', rxBytes, txBytes });
const estimate = (networkId, date, extra = {}) => ({ networkId, date, appId: clientId, name: 'Browser', proxyAppId: proxyId, proxyName: 'Proxy', source: 'connections', estimated: true, rxBytes: '100', txBytes: '40', ...extra });
const range = { start: '2026-10-01', end: '2026-10-31' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

test('application proxy details match client and proxy paths without changing source records', () => {
    const clients = [{ appId: clientId, proxyAppId: proxyId, name: 'Browser', proxyName: 'Proxy', connections: 2 }, { appId: 'other', proxyAppId: 'other-proxy', connections: 1 }];
    const options = { proxy: { clients }, nativeRecords: [native('home', '2026-10-02')], estimatedRecords: [estimate('home', '2026-10-02')], range, networkId: 'home' };
    const before = structuredClone(options);
    assert.deepEqual(applicationProxyDetails({ id: clientId.toUpperCase() }, options).clients, [clients[0]]);
    assert.deepEqual(applicationProxyDetails({ path: proxyId.toLowerCase() }, options).clients, [clients[0]]);
    const rows = applicationProxyDetails({ appId: clientId }, options).estimates;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].proxyAppId, proxyId);
    assert.equal(rows[0].source, 'connections');
    assert.deepEqual(options, before);
});

test('proxy estimates require matching download and upload totals and keep unattributed records for the proxy', () => {
    const row = estimate('home', '2026-10-02', { rxBytes: '60', txBytes: '20' });
    const unattributed = estimate('home', '2026-10-02', { appId: 'proxy/unattributed', name: 'Unattributed', rxBytes: '40', txBytes: '20', unattributed: true });
    const options = { nativeRecords: [native('home', '2026-10-02')], estimatedRecords: [row, unattributed], range };
    assert.deepEqual(applicationProxyDetails({ appId: proxyId }, options).estimates, [row, unattributed]);
    assert.deepEqual(applicationProxyDetails({ id: clientId }, options).estimates, [row]);
    for (const patch of [{ rxBytes: '39' }, { txBytes: '19' }, { networkId: 'other' }, { date: '2026-10-03' }]) {
        assert.equal(applicationProxyDetails({ appId: proxyId }, { ...options, estimatedRecords: [row, { ...unattributed, ...patch }] }).estimates.length, 0);
    }
});

test('unknown proxy names use the exact saved path and client names never infer proxy identity', () => {
    const row = estimate('home', '2026-10-02', { proxyName: '' });
    const options = { nativeRecords: [native('home', '2026-10-02')], estimatedRecords: [row], range,
        proxy: { clients: [{ appId: clientId, name: 'Browser', proxyName: 'Proxy', connections: 2 }] } };
    const result = applicationProxyDetails({ appId: proxyId, name: 'Proxy' }, options);
    assert.deepEqual(result.clients, []);
    assert.equal(result.estimates[0].proxyName, proxyId);
    assert.equal(row.proxyName, '');
});

test('estimated details respect network, range, selected day and month and cannot use partial minute ranges', () => {
    const dates = ['2026-09-30', '2026-10-02', '2026-10-03', '2026-11-01'];
    const nativeRecords = [...dates.map(date => native('home', date)), native('office', '2026-10-02')];
    const estimatedRecords = [...dates.map(date => estimate('home', date)), estimate('office', '2026-10-02')];
    const options = { nativeRecords, estimatedRecords, range, networkId: 'home' };
    assert.equal(applicationProxyDetails({ id: clientId }, options).estimates.length, 2);
    assert.deepEqual(applicationProxyDetails({ id: clientId, date: '2026-10-02' }, options).estimates.map(row => row.date), ['2026-10-02']);
    assert.equal(applicationProxyDetails({ id: clientId, date: '2026-10' }, options).estimates.length, 2);
    assert.equal(applicationProxyDetails({ id: clientId, date: '2026-09' }, options).estimates.length, 0);
    for (const extra of [{ allowEstimates: false }, { range: { ...range, startTime: '10:00' } }, { range: { ...range, endTime: '18:00' } }]) {
        assert.deepEqual(applicationProxyDetails({ id: clientId }, { ...options, ...extra }).estimates, []);
    }
    assert.deepEqual(applicationProxyDetails({}, options), { clients: [], estimates: [] });
});

test('application details show live measured connections separately from historical estimates and escape metadata', () => {
    const html = applicationDetails({ name: 'Browser', appId: clientId, processId: 42, processIds: [42], rxPerSecond: '50', txPerSecond: '10' }, {
        esc, fmtWithUnit: value => `${value} B`, appRate: value => value == null ? '—' : `${value} B/s`, estimateLabel: row => row.unattributed ? '估算 · 未归属' : '估算', rangeLabel: '2026-10 <all>',
        proxyDetails: { clients: [{ appId: clientId, name: 'Browser', proxyName: '<Proxy>', connections: 2, measurementAvailable: true, rxPerSecond: '50', txPerSecond: '10' }, { appId: clientId, name: 'Browser', proxyName: 'Unknown', connections: 1, measurementAvailable: false, rxPerSecond: '900', txPerSecond: '800' }], estimates: [estimate('home', '2026-10-02', { proxyName: '<Proxy>', unattributed: true })] }
    });
    assert.equal((html.match(/class="application-proxy-details /g) || []).length, 2);
    assert.match(html, /实时本地 TCP 连接/);
    assert.match(html, /历史代理估算/);
    assert.match(html, /实测/);
    assert.match(html, /不可测/);
    assert.match(html, /估算 · 未归属/);
    assert.match(html, /50 B\/s/);
    assert.match(html, /100 B/);
    assert.match(html, /2026-10 &lt;all&gt;/);
    assert.match(html, /&lt;Proxy&gt;/);
    assert.doesNotMatch(html, /900 B\/s|800 B\/s|<Proxy>|<form/);
    assert.match(html, /历史下载和上传分别按客户端与代理之间的字节比例估算；缺少字节记录的方向按连接数分配。/);
    assert.match(html, /本地 TCP 实时速度不计入 Wi-Fi 用量。/);
});

test('details without candidate estimates never traverse unrelated native history', () => {
    const nativeRecords = { [Symbol.iterator]() { throw Error('Unrelated native history was traversed'); } };
    for (const estimatedRecords of [[], [estimate('office', '2026-10-02')], [estimate('home', '2026-09-30')],
        [estimate('home', '2026-10-02', { appId: 'other-client', proxyAppId: 'other-proxy' })]]) {
        assert.deepEqual(applicationProxyDetails({ id: clientId }, { nativeRecords, estimatedRecords, range, networkId: 'home' }).estimates, []);
    }
});

test('details validate the full candidate proxy group while ignoring unrelated byte values', () => {
    const unrelated = { networkId: 'home', date: '2026-10-02', appId: 'unrelated',
        get rxBytes() { throw Error('Unrelated download bytes were read'); },
        get txBytes() { throw Error('Unrelated upload bytes were read'); } };
    const selected = estimate('home', '2026-10-02', { rxBytes: '60', txBytes: '20' });
    const sibling = estimate('home', '2026-10-02', { appId: 'other-client', rxBytes: '40', txBytes: '20' });
    const unrelatedEstimate = { networkId: 'home', date: '2026-10-02', appId: 'other-client', proxyAppId: 'other-proxy', estimated: true };
    Object.defineProperties(unrelatedEstimate, { rxBytes: { get: () => { throw Error('Unrelated estimate bytes were read'); } },
        txBytes: { get: () => { throw Error('Unrelated estimate bytes were read'); } } });
    const options = { nativeRecords: [unrelated, native('home', '2026-10-02')], estimatedRecords: [selected, sibling, unrelatedEstimate], range };
    assert.deepEqual(applicationProxyDetails({ id: clientId }, options).estimates, [selected]);
    sibling.rxBytes = '39';
    assert.deepEqual(applicationProxyDetails({ id: clientId }, options).estimates, []);
    sibling.rxBytes = '40';
    options.nativeRecords[1].txBytes = '41';
    assert.deepEqual(applicationProxyDetails({ id: clientId }, options).estimates, []);
});

function resolverFixture() {
    let reads = 0;
    const nativeRecords = ['2026-10-02', '2026-10-03'].map(date => {
        const row = native('home', date);
        Object.defineProperty(row, 'rxBytes', { enumerable: true, get() { reads++; return '100'; } });
        return row;
    });
    const estimatedRecords = nativeRecords.map(row => estimate('home', row.date));
    return { options: { revision: 1, nativeRecords, estimatedRecords, range, networkId: 'home' }, reads: () => reads };
}

test('revision resolver reuses history while reading current live client measurements on every call', () => {
    const resolve = proxyDetailsModule.createApplicationProxyResolver(), fixture = resolverFixture();
    const options = { ...fixture.options, proxy: { clients: [{ appId: clientId, proxyAppId: proxyId, measurementAvailable: true, rxPerSecond: '10' }] } };
    const first = resolve({ id: clientId }, options);
    assert.equal(fixture.reads(), 2);
    options.proxy.clients = [{ appId: clientId, proxyAppId: proxyId, measurementAvailable: false, rxPerSecond: null }];
    const second = resolve({ id: clientId }, options);
    assert.deepEqual(second.clients, options.proxy.clients);
    assert.equal(second.clients[0].measurementAvailable, false);
    assert.equal(second.estimates, first.estimates);
    assert.equal(fixture.reads(), 2);
    options.proxy.clients = [];
    assert.deepEqual(resolve({ id: clientId }, options).clients, []);
    assert.equal(fixture.reads(), 2);
});

test('revision resolver invalidates changed range, selected date, source references and estimate availability', () => {
    const cases = [
        { patch: { revision: 2 }, mutate: fixture => { fixture.options.nativeRecords[0].txBytes = '41'; }, dates: ['2026-10-03'] },
        { patch: { range: { start: '2026-10-03', end: '2026-10-31' } }, dates: ['2026-10-03'] },
        { patch: { range: { start: '2026-10-01', end: '2026-10-02' } }, dates: ['2026-10-02'] },
        { patch: { range: { ...range, startTime: '10:00' } }, dates: [] },
        { patch: { range: { ...range, endTime: '18:00' } }, dates: [] },
        { patch: { networkId: 'office' }, dates: [] },
        { patch: { allowEstimates: false }, dates: [] },
        { app: { id: clientId, date: '2026-10-02' }, dates: ['2026-10-02'] },
        { app: { id: clientId, date: '2026-09' }, dates: [] },
        { patchFor: fixture => ({ nativeRecords: fixture.options.nativeRecords.map(row => ({ ...row, txBytes: '99' })) }), dates: [] },
        { patchFor: fixture => ({ estimatedRecords: fixture.options.estimatedRecords.map(row => ({ ...row, rxBytes: '99' })) }), dates: [] }
    ];
    for (const scenario of cases) {
        const resolve = proxyDetailsModule.createApplicationProxyResolver(), fixture = resolverFixture();
        assert.equal(resolve({ id: clientId }, fixture.options).estimates.length, 2);
        scenario.mutate?.(fixture);
        const result = resolve(scenario.app || { id: clientId }, { ...fixture.options, ...scenario.patch, ...scenario.patchFor?.(fixture) });
        assert.deepEqual(result.estimates.map(row => row.date), scenario.dates);
    }
    for (const field of ['appId', 'id', 'path', 'appPath', 'executablePath']) {
        const resolve = proxyDetailsModule.createApplicationProxyResolver(), fixture = resolverFixture();
        assert.equal(resolve({ [field]: clientId }, fixture.options).estimates.length, 2);
        assert.deepEqual(resolve({ [field]: 'C:\\Apps\\Other.exe' }, fixture.options).estimates, []);
    }
});

test('resolver without a revision observes in-place changes on every call', () => {
    for (const revision of [undefined, null]) {
        const resolve = proxyDetailsModule.createApplicationProxyResolver(), fixture = resolverFixture();
        const options = { ...fixture.options, revision };
        assert.equal(resolve({ id: clientId }, options).estimates.length, 2);
        fixture.options.nativeRecords[0].txBytes = '41';
        assert.deepEqual(resolve({ id: clientId }, options).estimates.map(row => row.date), ['2026-10-03']);
        fixture.options.nativeRecords[0].txBytes = '40';
        assert.equal(resolve({ id: clientId }, options).estimates.length, 2);
        assert.equal(fixture.reads(), 6);
    }
});


const minuteNative = (networkId, date, time, extra = {}) => ({ ...native(networkId, date), time, hour: Number(time.slice(0, 2)), minute: Number(time.slice(3)), ...extra });
const minuteEstimate = (networkId, date, time, extra = {}) => ({ ...estimate(networkId, date), time, hour: Number(time.slice(0, 2)), minute: Number(time.slice(3)), ...extra });

test('selected minute details use exactly that minute while keeping live measurements independent', () => {
    const times = ['10:00', '10:01', '10:02'];
    const nativeRecords = times.map(time => minuteNative('home', '2026-10-02', time));
    const estimatedRecords = times.map(time => minuteEstimate('home', '2026-10-02', time));
    const clients = [{ appId: clientId, proxyAppId: proxyId, measurementAvailable: true, rxPerSecond: '9000', txPerSecond: '8000' }];
    const options = { nativeRecords, estimatedRecords, proxy: { clients }, range, networkId: 'home', grouping: 'minute' };
    const before = structuredClone(options);
    const details = applicationProxyDetails({ id: clientId.toUpperCase().replaceAll('\\', '/'), date: '2026-10-02 10:01' }, options);
    assert.deepEqual(details.estimates, [estimatedRecords[1]]);
    assert.deepEqual(details.clients, clients);
    assert.deepEqual(options, before);
});

test('selected hour details include its minute estimates and exclude neighboring hours and dates', () => {
    const slots = [['2026-10-02', '09:59'], ['2026-10-02', '10:00'], ['2026-10-02', '10:01'], ['2026-10-02', '10:59'], ['2026-10-02', '11:00'], ['2026-10-03', '10:01']];
    const nativeRecords = slots.map(([date, time]) => minuteNative('home', date, time));
    const estimatedRecords = slots.map(([date, time]) => minuteEstimate('home', date, time));
    const details = applicationProxyDetails({ id: clientId, date: '2026-10-02 10:00' }, { nativeRecords, estimatedRecords, range, grouping: 'hour' });
    assert.deepEqual(details.estimates, estimatedRecords.slice(1, 4));
});

test('partial cross-day details include the ending minute and reject daily estimates on interior days', () => {
    const slots = [['2026-10-02', '23:57'], ['2026-10-02', '23:58'], ['2026-10-02', '23:59'], ['2026-10-03', '12:00'], ['2026-10-04', '00:00'], ['2026-10-04', '00:01'], ['2026-10-04', '00:02']];
    const minutes = slots.map(([date, time]) => minuteEstimate('home', date, time));
    const options = {
        nativeRecords: [...slots.map(([date, time]) => minuteNative('home', date, time)), native('home', '2026-10-03')],
        estimatedRecords: [...minutes, estimate('home', '2026-10-03')],
        range: { start: '2026-10-02', startTime: '23:58', end: '2026-10-04', endTime: '00:01' }, networkId: 'home', grouping: 'summary'
    };
    assert.deepEqual(applicationProxyDetails({ id: clientId }, options).estimates, minutes.slice(1, 6));
    assert.deepEqual(applicationProxyDetails({ id: clientId, date: '2026-10-03' }, { ...options, grouping: 'day' }).estimates, [minutes[3]]);
    assert.deepEqual(applicationProxyDetails({ id: clientId, date: '2026-10' }, { ...options, grouping: 'month' }).estimates, minutes.slice(1, 6));
});

test('minute estimates validate both directions for the full proxy group without mixing minutes', () => {
    const nativeRecords = ['10:01', '10:02'].map(time => minuteNative('home', '2026-10-02', time));
    nativeRecords.push(minuteNative('home', '2026-10-02', '10:01', { appId: clientId, rxBytes: '7', txBytes: '3' }));
    const selected = minuteEstimate('home', '2026-10-02', '10:01', { rxBytes: '60', txBytes: '30' });
    const sibling = minuteEstimate('home', '2026-10-02', '10:01', { appId: 'other-client', rxBytes: '40', txBytes: '10' });
    const next = minuteEstimate('home', '2026-10-02', '10:02');
    const options = { nativeRecords, estimatedRecords: [selected, sibling, next], range: { start: '2026-10-02', end: '2026-10-02', startTime: '10:01', endTime: '10:02' } };
    assert.deepEqual(applicationProxyDetails({ id: clientId }, options).estimates, [selected, next]);
    for (const patch of [{ rxBytes: '39' }, { txBytes: '9' }, { time: '10:03' }, { networkId: 'office' }, { proxyAppId: 'other-proxy' }]) {
        assert.deepEqual(applicationProxyDetails({ id: clientId }, { ...options, estimatedRecords: [selected, { ...sibling, ...patch }, next] }).estimates, [next]);
    }
    assert.deepEqual(applicationProxyDetails({ id: clientId, date: '2026-10-02 10:01' }, { ...options, nativeRecords: [], grouping: 'minute' }).estimates, []);
    assert.equal(nativeRecords[2].rxBytes, '7');
    assert.equal(nativeRecords[2].txBytes, '3');
});

test('minute details isolate network and full proxy identity before reading byte totals', () => {
    const selected = minuteEstimate('home', '2026-10-02', '10:01');
    const office = minuteEstimate('office', '2026-10-02', '10:01');
    const other = minuteEstimate('home', '2026-10-02', '10:01', { proxyAppId: 'C:\\Proxy\\Sibling.exe' });
    const unrelatedNative = minuteNative('home', '2026-10-02', '10:01', { appId: 'C:\\Proxy\\Sibling.exe' });
    Object.defineProperties(unrelatedNative, { rxBytes: { get() { throw Error('Unrelated native bytes were read'); } }, txBytes: { get() { throw Error('Unrelated native bytes were read'); } } });
    Object.defineProperties(other, { rxBytes: { get() { throw Error('Unrelated estimate bytes were read'); } }, txBytes: { get() { throw Error('Unrelated estimate bytes were read'); } } });
    const options = { nativeRecords: [minuteNative('home', '2026-10-02', '10:01'), minuteNative('office', '2026-10-02', '10:01'), unrelatedNative], estimatedRecords: [selected, office, other], range, networkId: 'home', grouping: 'minute' };
    assert.deepEqual(applicationProxyDetails({ id: proxyId.toLowerCase(), name: 'Proxy', date: '2026-10-02 10:01' }, options).estimates, [selected]);
});

test('minute resolver invalidates replaced source arrays and rereads current unavailable clients', () => {
    const resolve = proxyDetailsModule.createApplicationProxyResolver();
    const row = minuteEstimate('home', '2026-10-02', '10:01');
    const options = { revision: 1, nativeRecords: [minuteNative('home', '2026-10-02', '10:01')], estimatedRecords: [row], range, grouping: 'minute', proxy: { clients: [{ appId: clientId, measurementAvailable: true, rxPerSecond: '9000' }] } };
    const app = { id: clientId, date: '2026-10-02 10:01' };
    const first = resolve(app, options);
    assert.deepEqual(first.estimates, [row]);
    options.proxy.clients = [{ appId: clientId, measurementAvailable: false, rxPerSecond: '9000' }];
    const cached = resolve(app, options);
    assert.equal(cached.estimates, first.estimates);
    assert.deepEqual(cached.clients, options.proxy.clients);
    assert.deepEqual(resolve(app, { ...options, nativeRecords: [minuteNative('home', '2026-10-02', '10:01', { txBytes: '41' })] }).estimates, []);
    assert.deepEqual(resolve(app, options).estimates, [row]);
    const replacement = [minuteEstimate('home', '2026-10-02', '10:01', { rxBytes: '60', txBytes: '10' }), minuteEstimate('home', '2026-10-02', '10:01', { appId: 'other-client', rxBytes: '40', txBytes: '30' })];
    assert.deepEqual(resolve(app, { ...options, estimatedRecords: replacement }).estimates, [replacement[0]]);
    assert.deepEqual(resolve(app, { ...options, allowEstimates: false }).estimates, []);
});

test('minute resolver distinguishes a selected minute from the same labeled hour', () => {
    const resolve = proxyDetailsModule.createApplicationProxyResolver();
    const estimatedRecords = ['10:00', '10:01'].map(time => minuteEstimate('home', '2026-10-02', time));
    const options = { revision: 1, nativeRecords: ['10:00', '10:01'].map(time => minuteNative('home', '2026-10-02', time)), estimatedRecords, range, grouping: 'minute' };
    const app = { id: clientId, date: '2026-10-02 10:00' };
    assert.deepEqual(resolve(app, options).estimates, [estimatedRecords[0]]);
    assert.deepEqual(resolve(app, { ...options, grouping: 'hour' }).estimates, estimatedRecords);
    assert.deepEqual(resolve(app, options).estimates, [estimatedRecords[0]]);
});

test('minute detail rows display complete timestamps and explain direction weights in both languages', () => {
    const options = { esc, fmtWithUnit: value => value + ' B', appRate: value => value == null ? '—' : value + ' B/s', estimateLabel: () => 'Estimated', proxyDetails: { estimates: [minuteEstimate('home', '2026-10-02', '10:01')], clients: [] } };
    try {
        setLanguage('zh-CN');
        const chinese = applicationDetails({ name: 'Browser', id: clientId }, options);
        assert.match(chinese, /<dt>时间<\/dt><dd>2026-10-02 10:01<\/dd>/);
        assert.match(chinese, /历史下载和上传分别按客户端与代理之间的字节比例估算；缺少字节记录的方向按连接数分配。/);
        setLanguage('en');
        const english = applicationDetails({ name: 'Browser', id: clientId }, options);
        assert.match(english, /<dt>Time<\/dt><dd>2026-10-02 10:01<\/dd>/);
        assert.match(english, /Historical download and upload are estimated separately by the share of bytes exchanged between each client and the proxy; directions without byte evidence use connection counts\./);
        assert.doesNotMatch(english, /历史|字节|连接数/);
    } finally { setLanguage('zh-CN'); }
});
