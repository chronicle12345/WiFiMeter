import test from 'node:test';
import assert from 'node:assert/strict';
import { miniRange, miniApplicationRows, miniFilteredLive } from '../host/mini-usage.cjs';
import { liveRates } from '../host/mini/rates.js';

const minute = (date, time, patch = {}) => ({ networkId: 'home', appId: 'browser', name: 'Browser', date, time,
    hour: Number(time.slice(0, 2)), minute: Number(time.slice(3)), rxBytes: '10', txBytes: '1', ...patch });
const live = processes => ({ state: 'connected', collector: 'running', appCollection: { enabled: true, state: 'running' }, appProcesses: processes });

test('小窗切换端口估算后保留直连与原生分钟累计，不重复计算代理速度', () => {
    const range = miniRange({ miniRange: '1m' }, new Date(2026, 9, 1, 8, 15).getTime());
    const snapshot = { appMinuteRecords: [minute(range.from, '08:15'),
        minute(range.from, '08:15', { appId: 'proxy.exe', name: 'Proxy', rxBytes: '900', txBytes: '90' })] };
    const sample = { ...live([
        { appId: 'browser', name: 'Browser', networkId: 'home', rxPerSecond: '10', txPerSecond: '2' },
        { appId: 'proxy.exe', name: 'Proxy', networkId: 'home', rxPerSecond: '100', txPerSecond: '20' }
    ]), proxy: { available: true, enabled: true, state: 'ready', processNames: ['proxy.exe'],
        clients: [{ appId: 'browser', name: 'Browser', proxyAppId: 'proxy.exe', proxyName: 'Proxy', connections: 1 }] } };
    const native = miniApplicationRows(snapshot, sample, range);
    assert.equal(native.rows.find(row => row.appId === 'browser').rxPerSecond, '10');
    const estimated = miniApplicationRows(snapshot, sample, range, { miniIncludeProxyEstimates: true });
    assert.equal(estimated.miniIncludeProxyEstimates, true);
    const browser = estimated.rows.find(row => row.appId === 'browser');
    assert.equal(browser.rxPerSecond, '110');
    assert.equal(browser.txPerSecond, '22');
    assert.equal(browser.estimated, true);
    assert.equal(browser.rxBytes, '10');
    assert.equal(estimated.rows.find(row => row.appId === 'proxy.exe').rxBytes, '900');
    assert.equal(estimated.rows.reduce((sum, row) => sum + BigInt(row.rxPerSecond || 0), 0n), 110n);
    const filtered = miniApplicationRows(snapshot, sample, range, { miniIncludeProxyEstimates: true, miniExcludeProxy: true });
    assert.equal(filtered.rows.find(row => row.appId === 'browser').rxPerSecond, '110');
    assert.equal(filtered.rows.some(row => row.appId === 'proxy.exe'), false);
    const paused = miniApplicationRows(snapshot, { ...sample, collector: 'paused' }, range, { miniIncludeProxyEstimates: true });
    assert.equal(paused.rows.find(row => row.appId === 'browser').rxPerSecond, null);
});

test('最近时段按本地分钟包含当前分钟，跨日和自定义时长保留正确起点', () => {
    const now = new Date(2026, 9, 1, 0, 1, 45, 750).getTime();
    const expected = {
        '1m': ['2026-10-01', '00:01', 1],
        '5m': ['2026-09-30', '23:57', 5],
        '1h': ['2026-09-30', '23:02', 60],
        custom: ['2026-09-30', '23:45', 17]
    };
    for (const [miniRangeKey, [from, fromTime, minutes]] of Object.entries(expected)) {
        assert.deepEqual(miniRange({ miniRange: miniRangeKey, miniCustomMinutes: 17 }, now),
            { from, fromTime, to: '2026-10-01', toTime: '00:01', minutes });
    }
});

test('分钟用量跨网络精确归并，速度按全部应用排序且回环流量不重复计入', () => {
    const range = miniRange({ miniRange: '5m' }, new Date(2026, 9, 1, 0, 1, 45).getTime());
    const snapshot = { appMinuteRecords: [minute('2026-09-30', '23:56', { rxBytes: '99999' }),
        minute('2026-09-30', '23:57', { rxBytes: '9007199254740993' }),
        minute('2026-10-01', '00:01', { networkId: 'office', rxBytes: '7', txBytes: '2' }),
        minute('2026-10-01', '00:02', { rxBytes: '99999' })] };
    const processes = [{ appId: 'browser', name: 'Browser', rxPerSecond: '10', txPerSecond: '1' },
        { appId: 'browser', name: 'Browser', rxPerSecond: '2', txPerSecond: '3' },
        { appId: 'browser', name: 'Browser', scope: 'loopback', rxPerSecond: '10000', txPerSecond: '10000' },
        { appId: 'upload', name: 'Uploader', rxPerSecond: '1', txPerSecond: '1000' },
        ...Array.from({ length: 12 }, (_, i) => ({ appId: `idle${i}`, rxPerSecond: '0', txPerSecond: '0' }))];
    const saved = structuredClone(snapshot);
    const result = miniApplicationRows(snapshot, live(processes), range);
    assert.equal(result.rows.length, 14); assert.equal(result.rows[0].appId, 'upload');
    assert.deepEqual(result.rows[1], { appId: 'browser', name: 'Browser', rxBytes: '9007199254741000', txBytes: '3',
        rxPerSecond: '12', txPerSecond: '4', measurementAvailable: true });
    assert.deepEqual(snapshot, saved);
});

test('缺失的分钟用量和不可测速度保留缺失值，旧每日与小时记录不补造分钟用量', () => {
    const range = miniRange({ miniRange: '1m' }, new Date(2026, 9, 1, 8, 15).getTime());
    const legacy = { appRecords: [{ date: range.from, appId: 'browser', name: 'Browser', rxBytes: '500', txBytes: '5' }],
        hourly: [{ date: range.from, hour: 8, rxBytes: '500', txBytes: '5' }] };
    const processes = [{ appId: 'browser', name: 'Browser', rxPerSecond: '100', txPerSecond: '10' },
        { appId: 'browser', name: 'Browser', measurementAvailable: false, rxPerSecond: '0', txPerSecond: '0' }];
    assert.deepEqual(miniApplicationRows(legacy, live(processes), range).rows, [{ appId: 'browser', name: 'Browser',
        rxBytes: null, txBytes: null, rxPerSecond: null, txPerSecond: null, measurementAvailable: false }]);
    assert.deepEqual(miniApplicationRows(legacy, live([]), range).rows, []);
});

test('停止或暂停采集后保留真实分钟用量，速度不沿用旧采样', () => {
    const range = miniRange({ miniRange: '1m' }, new Date(2026, 9, 1, 8, 15).getTime());
    const snapshot = { appMinuteRecords: [minute(range.from, '08:15')] };
    const processes = [{ appId: 'browser', name: 'Browser', rxPerSecond: '100', txPerSecond: '10' }];
    for (const status of [
        { ...live(processes), collector: 'paused' },
        { ...live(processes), state: 'disconnected' },
        { ...live(processes), appCollection: { enabled: false, state: 'disabled' } },
        { ...live(processes), appCollection: { enabled: true, state: 'unavailable' } }
    ]) {
        assert.deepEqual(miniApplicationRows(snapshot, status, range).rows, [{ appId: 'browser', name: 'Browser',
            rxBytes: '10', txBytes: '1', rxPerSecond: null, txPerSecond: null, measurementAvailable: false }]);
    }
});

test('代理筛选复用配置进程名与已识别路径，分钟用量保持精确且默认包含代理', () => {
    const range = miniRange({ miniRange: '1m' }, new Date(2026, 9, 1, 8, 15).getTime());
    const snapshot = { appMinuteRecords: [
        minute(range.from, '08:15', { appId: 'C:\\Proxy\\Clash.exe', name: 'Clash', rxBytes: '90' }),
        minute(range.from, '08:15', { appId: 'c:/Proxy/Agent.exe', name: 'Agent', rxBytes: '80' }),
        minute(range.from, '08:15', { appId: 'old-proxy', name: 'Old Proxy', rxBytes: '70' }),
        minute(range.from, '08:15', { rxBytes: '9007199254740993' }),
        minute(range.from, '08:15', { rxBytes: '7', txBytes: '2' }),
        minute(range.from, '08:15', { appId: 'clash-monitor.exe', name: 'Clash Monitor' })
    ], proxyEstimatedRecords: [{ proxyAppId: 'old-proxy', estimated: true }],
    proxy: { processNames: ['  CLASH.EXE  '] } };
    const sample = { ...live([
        { appId: 'browser', name: 'Browser', rxPerSecond: '10', txPerSecond: '2' },
        { appId: 'browser', scope: 'loopback', rxPerSecond: '9999', txPerSecond: '9999' },
        { appId: 'C:\\Proxy\\Clash.exe', name: 'Clash', rxPerSecond: '90', txPerSecond: '10' },
        { appId: 'c:/Proxy/Agent.exe', name: 'Agent', rxPerSecond: '80', txPerSecond: '10' }
    ]), proxy: { clients: [{ appId: 'browser', proxyAppId: 'C:\\PROXY\\AGENT.EXE' },
        { appId: 'browser', proxyAppId: '' }] } };
    const saved = structuredClone({ snapshot, sample });
    assert.equal(miniApplicationRows(snapshot, sample, range).rows.length, 5);
    assert.equal(miniApplicationRows(snapshot, sample, range).miniExcludeProxy, false);
    const filtered = miniApplicationRows(snapshot, sample, range, { miniExcludeProxy: true });
    assert.equal(filtered.miniExcludeProxy, true);
    assert.deepEqual(filtered.rows.map(row => row.appId), ['browser', 'clash-monitor.exe']);
    assert.deepEqual(filtered.rows[0], { appId: 'browser', name: 'Browser', rxBytes: '9007199254741000',
        txBytes: '3', rxPerSecond: '10', txPerSecond: '2', measurementAvailable: true });
    assert.deepEqual({ snapshot, sample }, saved);
});

test('排除代理总速率只扣除物理网络实测量，保留直接流量与 BigInt 精度', () => {
    const sample = { ...live([
        { networkId: 'home', appId: 'C:\\Proxy\\Clash.exe', name: 'Clash', rxPerSecond: '9007199254740993', txPerSecond: '1000' },
        { networkId: 'office', appId: 'C:\\Proxy\\Clash.exe', name: 'Clash', rxPerSecond: '10', txPerSecond: '1000' },
        { networkId: 'home', appId: 'browser', rxPerSecond: '100', txPerSecond: '200' },
        { networkId: '', appId: 'C:\\Proxy\\Clash.exe', scope: 'loopback', rxPerSecond: '999999', txPerSecond: '999999' },
        { networkId: 'unselected', appId: 'C:\\Proxy\\Clash.exe', rxPerSecond: '999999', txPerSecond: '999999' }
    ]), connections: [{ networkId: 'home', rxPerSecond: '9007199254741993', txPerSecond: '1500' },
        { networkId: 'office', rxPerSecond: '1010', txPerSecond: '1500' }], proxy: { processNames: ['clash.exe'], clients: [] } };
    const saved = structuredClone(sample), enriched = miniFilteredLive(sample);
    assert.deepEqual(enriched.ratesWithoutProxy, { rxPerSecond: '2000', txPerSecond: '1000' });
    assert.deepEqual(liveRates(enriched, { miniExcludeProxy: true }), { download: '2.0 KB/s', upload: '1.0 KB/s' });
    assert.deepEqual(liveRates(enriched), liveRates(sample));
    assert.deepEqual(sample, saved);
});

test('代理扣减分别校验所属网络，其他网络的速度不补足采样差异', () => {
    const sample = { ...live([
        { appId: 'proxy.exe', networkId: 'home', rxPerSecond: '501', txPerSecond: '100' },
        { appId: 'proxy.exe', networkId: 'home', rxPerSecond: '500', txPerSecond: '100' }
    ]), connections: [{ networkId: 'home', rxPerSecond: '300', txPerSecond: '50' },
        { networkId: 'home', rxPerSecond: '700', txPerSecond: '450' },
        { networkId: 'office', rxPerSecond: '1000', txPerSecond: '500' }],
    proxy: { processNames: ['proxy.exe'] } };
    assert.deepEqual(miniFilteredLive(sample).ratesWithoutProxy, { rxPerSecond: null, txPerSecond: '800' });
    const legacy = { ...sample, connections: sample.connections.map(({ networkId, ...connection }) => connection),
        appProcesses: sample.appProcesses.map(({ networkId, ...process }) => process) };
    assert.deepEqual(miniFilteredLive(legacy).ratesWithoutProxy, { rxPerSecond: '999', txPerSecond: '800' });
});

test('代理采集不可用时保留缺失值，单方向异常与采样差异不伪装成零', () => {
    const sample = { ...live([{ appId: 'proxy.exe', rxPerSecond: '500', txPerSecond: '200' }]),
        connections: [{ rxPerSecond: '1000', txPerSecond: '500' }], proxy: { processNames: ['proxy.exe'] } };
    for (const patch of [{ collector: 'paused' }, { state: 'offline' },
        { appCollection: { enabled: false, state: 'disabled' } },
        { appCollection: { enabled: true, state: 'unavailable' } }, { appProcesses: null },
        { proxy: { clients: [{ appId: 'browser', proxyAppId: '', pathAvailable: false }] } }]) {
        assert.deepEqual(miniFilteredLive({ ...sample, ...patch }).ratesWithoutProxy,
            { rxPerSecond: null, txPerSecond: null });
    }
    const unreadable = miniFilteredLive({ ...sample, appProcesses: [{ appId: 'proxy.exe', rxPerSecond: null, txPerSecond: '200' }] });
    assert.deepEqual(unreadable.ratesWithoutProxy, { rxPerSecond: null, txPerSecond: '300' });
    assert.deepEqual(liveRates(unreadable, { miniExcludeProxy: true }), { download: '—', upload: '300 B/s' });
    const skewed = miniFilteredLive({ ...sample, appProcesses: [{ appId: 'proxy.exe', rxPerSecond: '1001', txPerSecond: '200' }] });
    assert.deepEqual(skewed.ratesWithoutProxy, { rxPerSecond: null, txPerSecond: '300' });
    assert.deepEqual(liveRates(sample, { miniExcludeProxy: true }), { download: '—', upload: '—' });
    const zero = miniFilteredLive({ ...sample, appProcesses: [], connections: [{ rxPerSecond: '0', txPerSecond: '0' }] });
    assert.deepEqual(liveRates(zero, { miniExcludeProxy: true }), { download: '0 B/s', upload: '0 B/s' });
});

test('已知历史代理身份用于相同的列表与总速度筛选', () => {
    const snapshot = { proxyEstimatedRecords: [{ proxyAppId: 'C:/custom/Agent.exe', estimated: true }] };
    const sample = { ...live([{ appId: 'c:\\CUSTOM\\agent.exe', networkId: 'home', rxPerSecond: '600', txPerSecond: '20' }]),
        connections: [{ networkId: 'home', rxPerSecond: '1000', txPerSecond: '100' }], proxy: { processNames: [], clients: [] } };
    const range = miniRange({ miniRange: '1m' });
    assert.deepEqual(miniApplicationRows(snapshot, sample, range, { miniExcludeProxy: true }).rows, []);
    assert.deepEqual(miniFilteredLive(sample, snapshot).ratesWithoutProxy, { rxPerSecond: '400', txPerSecond: '80' });
});
