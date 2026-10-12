import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationProxyDetails } from '../renderer/data/application-proxy.js';
import { applicationDetails } from '../renderer/ui/applications.js';

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
    assert.match(html, /历史用量按连接权重估算；本地 TCP 实时速度不计入 Wi-Fi 用量。/);
});
