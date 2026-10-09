import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationRows, historyRange } from '../renderer/data/history.js';
import { createDataClient } from '../renderer/data/backend-client.js';
import { validateSnapshot, validTime } from '../renderer/data/model.js';
import { generateDemo } from '../renderer/data/mock.js';

const minuteRow = (date, time, patch = {}) => ({ date, time, hour: Number(time.slice(0, 2)), minute: Number(time.slice(3)),
    networkId: 'home', appId: '/apps/browser', name: 'Browser', rxBytes: '10', txBytes: '1', ...patch });

test('自定义时间保留小时分钟，省略时间时覆盖完整日期', () => {
    assert.deepEqual(historyRange('custom', '2026-10-09', { start: '2026-10-01', end: '2026-10-02', startTime: '23:58', endTime: '00:01' }),
        { start: '2026-10-01', end: '2026-10-02', startTime: '23:58', endTime: '00:01' });
    assert.deepEqual(historyRange('custom', '2026-10-09', { start: '2026-10-01', end: '2026-10-01' }),
        { start: '2026-10-01', end: '2026-10-01', startTime: '00:00', endTime: '23:59' });
});

test('时间仅接受完整的二十四小时制小时和分钟', () => {
    for (const time of ['00:00', '09:05', '23:59']) assert.equal(validTime(time), true);
    for (const time of ['24:00', '23:60', '9:05', '09:5', '09:05:00', '', undefined]) assert.equal(validTime(time), false);
});

test('跨日分钟筛选包含边界分钟，并按分钟、小时、日期及月份汇总', () => {
    const records = [minuteRow('2026-09-30', '23:57'), minuteRow('2026-09-30', '23:58', { rxBytes: '9007199254740993' }),
        minuteRow('2026-09-30', '23:59'), minuteRow('2026-10-01', '00:00'), minuteRow('2026-10-01', '00:01'), minuteRow('2026-10-01', '00:02'),
        minuteRow('2026-10-01', '00:01', { networkId: 'office' }),
        { networkId: 'home', date: '2026-10-01', appId: 'legacy', name: 'Legacy', rxBytes: '500', txBytes: '0' }];
    const range = { networkId: 'home', start: '2026-09-30', end: '2026-10-01', startTime: '23:58', endTime: '00:01', grouping: 'minute', sort: 'date', direction: 'asc' };
    const rows = applicationRows(records, range);
    assert.deepEqual(rows.map(row => row.date), ['2026-09-30 23:58', '2026-09-30 23:59', '2026-10-01 00:00', '2026-10-01 00:01']);
    assert.equal(rows[0].iconDate, '2026-09-30');
    assert.equal(rows[0].rx, 9007199254740993n);
    const hours = applicationRows(records, { ...range, grouping: 'hour' });
    assert.deepEqual(hours.map(row => row.date), ['2026-09-30 23:00', '2026-10-01 00:00']);
    assert.equal(hours[0].rx, 9007199254741003n);
    assert.equal(applicationRows(records, { ...range, grouping: 'day' }).length, 2);
    assert.equal(applicationRows(records, { ...range, grouping: 'month' }).length, 2);
    assert.equal(applicationRows(records, { ...range, grouping: 'summary' })[0].rx, 9007199254741023n);
});

test('旧日期及小时数据不会被改造成分钟记录', () => {
    const oldRows = [{ date: '2026-10-01', networkId: 'home', appId: 'legacy', name: 'Legacy', rxBytes: '50', txBytes: '1' },
        { date: '2026-10-01', hour: 8, networkId: 'home', appId: 'hour', name: 'Hourly', rxBytes: '20', txBytes: '1' }];
    const range = { networkId: 'all', start: '2026-10-01', end: '2026-10-01' };
    assert.deepEqual(applicationRows(oldRows, { ...range, grouping: 'minute' }), []);
    assert.equal(applicationRows(oldRows, { ...range, grouping: 'day' }).length, 2);
    assert.deepEqual(applicationRows(oldRows, { ...range, startTime: '08:15', endTime: '08:15', grouping: 'day' }), []);
});

test('分钟快照验证拒绝越界时间及重复记录，同时兼容旧快照', () => {
    const data = generateDemo(new Date('2026-10-01T12:00:00'));
    const networkId = data.networks[0].id;
    const row = minuteRow('2026-10-01', '08:15', { networkId });
    data.minuteRecords = [{ ...row }]; data.appMinuteRecords = [{ ...row }];
    assert.equal(validateSnapshot(data).appMinuteRecords[0].time, '08:15');
    assert.throws(() => validateSnapshot({ ...data, minuteRecords: [{ ...row, minute: 60 }] }));
    assert.throws(() => validateSnapshot({ ...data, minuteRecords: [{ ...row }, { ...row }] }));
    const legacy = { ...data }; delete legacy.minuteRecords; delete legacy.appMinuteRecords;
    assert.deepEqual(validateSnapshot(legacy).minuteRecords, []);
    assert.deepEqual(validateSnapshot(legacy).appMinuteRecords, []);
});

async function eventClient(t, initial = {}) {
    const original = globalThis.window; t.after(() => { globalThis.window = original; });
    let receive; const calls = [];
    globalThis.window = { desktop: { backend: {
        request: async (method, params) => { calls.push({ method, params }); return { ok: true, result: method === 'snapshot' ? initial : {} }; },
        onEvent: handler => { receive = handler; return () => {}; }
    } } };
    const client = createDataClient(); await client.start(); t.after(() => client.stop());
    return { client, calls, receive: message => receive(message) };
}

test('网络及应用分钟增量独立累计，保留超出 Number 精度的字节数并在清空时移除', async t => {
    const row = minuteRow('2026-10-01', '08:15', { rxBytes: '9007199254740993' });
    const { client, receive } = await eventClient(t, { minuteRecords: [{ ...row }], appMinuteRecords: [{ ...row }] });
    receive({ event: 'usage', day: row.date, hour: 8, networks: [{ networkId: 'home', rxBytes: '2', txBytes: '3' }], minuteRecords: [{ ...row, rxBytes: '2', txBytes: '3' }] });
    receive({ event: 'appUsage', records: [], minuteRecords: [{ ...row, rxBytes: '4', txBytes: '2' }] });
    assert.equal(client.snapshot.minuteRecords[0].rxBytes, '9007199254740995');
    assert.equal(client.snapshot.appMinuteRecords[0].rxBytes, '9007199254740997');
    receive({ event: 'usage', day: row.date, hour: 9, networks: [{ networkId: 'home', rxBytes: '5', txBytes: '1' }] });
    assert.equal(client.snapshot.minuteRecords.length, 1);
    await client.clearRecords();
    assert.deepEqual(client.snapshot.minuteRecords, []); assert.deepEqual(client.snapshot.appMinuteRecords, []);
});

test('指定分钟区间后实时事件仅进入所选网络和分钟，同时更新实时状态', async t => {
    const { client, calls, receive } = await eventClient(t);
    const params = { from: '2026-10-01', to: '2026-10-01', fromTime: '08:15', toTime: '08:15', networkKey: 'home' };
    await client.queryRange(params);
    assert.deepEqual(calls.at(-1), { method: 'snapshot', params });
    const send = (time, networkId = 'home') => {
        const row = minuteRow('2026-10-01', time, { networkId });
        receive({ event: 'usage', day: row.date, hour: row.hour, networks: [{ networkId, rxBytes: '10', txBytes: '1' }], minuteRecords: [row] });
        receive({ event: 'appUsage', records: [{ ...row }], minuteRecords: [row] });
    };
    send('08:14'); send('08:15'); send('08:16'); send('08:15', 'office');
    assert.equal(client.snapshot.minuteRecords.length, 1); assert.equal(client.snapshot.appMinuteRecords.length, 1);
    assert.equal(client.snapshot.minuteRecords[0].rxBytes, '10'); assert.equal(client.snapshot.appMinuteRecords[0].rxBytes, '10');
    assert.equal(client.snapshot.records[0].rxBytes, '10'); assert.equal(client.snapshot.appRecords[0].rxBytes, '10');
    receive({ event: 'live', appProcesses: [{ appId: 'running', rxPerSecond: '100', txPerSecond: '1' }] });
    assert.equal(client.snapshot.appProcesses[0].appId, 'running');
    await client.reload(); assert.deepEqual(calls.at(-1).params, params);
});

test('晚到历史响应恢复较新分钟事件，并避免重新累计响应已经包含的事件', async t => {
    const { client, receive } = await eventClient(t);
    let finish;
    window.desktop.backend.request = async () => new Promise(resolve => { finish = result => resolve({ ok: true, result }); });
    const row = minuteRow('2026-10-01', '08:15');
    const query = client.queryRange({ from: row.date, to: row.date, fromTime: '08:15', toTime: '08:15' });
    receive({ event: 'usage', usageRevision: 2, day: row.date, hour: 8, networks: [{ networkId: 'home', rxBytes: '10', txBytes: '1' }], minuteRecords: [row] });
    receive({ event: 'usage', usageRevision: 3, day: row.date, hour: 8, networks: [{ networkId: 'home', rxBytes: '4', txBytes: '2' }], minuteRecords: [{ ...row, rxBytes: '4', txBytes: '2' }] });
    receive({ event: 'appUsage', usageRevision: 4, records: [row], minuteRecords: [row] });
    finish({ usageRevision: 2, minuteRecords: [{ ...row }], appMinuteRecords: [], records: [{ ...row }], appRecords: [] });
    await query;
    assert.equal(client.snapshot.minuteRecords[0].rxBytes, '14'); assert.equal(client.snapshot.appMinuteRecords[0].rxBytes, '10');
    assert.equal(client.snapshot.records[0].rxBytes, '14'); assert.equal(client.snapshot.appRecords[0].rxBytes, '10');
});

test('同轮网络与应用事件分别恢复，大序号保持精度，已包含的事件不覆盖较新额度', async t => {
    const { client, receive } = await eventClient(t);
    let finish;
    window.desktop.backend.request = async () => new Promise(resolve => { finish = result => resolve({ ok: true, result }); });
    const row = minuteRow('2026-10-01', '08:15');
    const query = client.reload();
    receive({ event: 'usage', usageRevision: '9007199254740994', day: row.date, hour: 8, networks: [{ networkId: 'home', rxBytes: '10', txBytes: '1' }], minuteRecords: [row], totalQuota: { usedBytes: '10' } });
    receive({ event: 'appUsage', usageRevision: '9007199254740994', records: [row], minuteRecords: [row] });
    finish({ usageRevision: '9007199254740993', minuteRecords: [{ ...row, rxBytes: '20' }], appMinuteRecords: [{ ...row, rxBytes: '20' }], totalQuota: { usedBytes: '20' } });
    await query;
    assert.equal(client.snapshot.minuteRecords[0].rxBytes, '30'); assert.equal(client.snapshot.appMinuteRecords[0].rxBytes, '30');
    const next = client.reload();
    receive({ event: 'usage', usageRevision: '9007199254740994', day: row.date, hour: 8, minuteRecords: [row], totalQuota: { usedBytes: '10' } });
    finish({ usageRevision: '9007199254740995', minuteRecords: [{ ...row, rxBytes: '50' }], totalQuota: { usedBytes: '50' } });
    await next;
    assert.equal(client.snapshot.minuteRecords[0].rxBytes, '50'); assert.equal(client.snapshot.totalQuota.usedBytes, '50');
});

test('分钟增量查找在重载、日期变化与清空后继续更新当前记录', async t => {
    const row = minuteRow('2026-10-01', '08:15');
    const { client, receive } = await eventClient(t, { minuteRecords: [{ ...row }], appMinuteRecords: [{ ...row }] });
    const send = record => {
        receive({ event: 'usage', day: record.date, hour: record.hour, minuteRecords: [record] });
        receive({ event: 'appUsage', records: [], minuteRecords: [record] });
    };
    send(row); const previous = client.snapshot.minuteRecords[0];
    window.desktop.backend.request = async () => ({ ok: true, result: { minuteRecords: [{ ...row, rxBytes: '100' }], appMinuteRecords: [{ ...row, rxBytes: '100' }] } });
    await client.reload(); send(row);
    assert.equal(previous.rxBytes, '20'); assert.equal(client.snapshot.minuteRecords[0].rxBytes, '110');
    send({ ...row, date: '2026-10-02' }); send(row);
    assert.equal(client.snapshot.minuteRecords[0].rxBytes, '120'); assert.equal(client.snapshot.appMinuteRecords[0].rxBytes, '120');
    await client.clearRecords(); send(row);
    assert.equal(client.snapshot.minuteRecords.length, 1); assert.equal(client.snapshot.appMinuteRecords.length, 1);
    assert.equal(client.snapshot.minuteRecords[0].rxBytes, '10');
});

test('首次快照查询期间已订阅分钟事件，启动完成后保留快照之后的采样', async t => {
    const original = globalThis.window; t.after(() => { globalThis.window = original; });
    let receive, finish;
    globalThis.window = { desktop: { backend: {
        request: async method => method !== 'snapshot' ? { ok: true, result: {} }
            : new Promise(resolve => { finish = result => resolve({ ok: true, result }); }),
        onEvent: handler => { receive = handler; return () => {}; }
    } } };
    const client = createDataClient(); t.after(() => client.stop());
    const started = client.start(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof receive, 'function');
    const row = minuteRow('2026-10-01', '08:15');
    receive({ event: 'usage', usageRevision: '1', day: row.date, hour: 8, networks: [{ networkId: 'home', rxBytes: '10', txBytes: '1' }], minuteRecords: [row] });
    finish({ usageRevision: '0', minuteRecords: [] });
    await started;
    assert.equal(client.ready, true); assert.equal(client.snapshot.minuteRecords[0].rxBytes, '10');
});

test('采样跨午夜时按真实分钟日期归并日及小时汇总，并保留昨日末分钟筛选', async t => {
    const { client, receive } = await eventClient(t);
    const before = minuteRow('2026-09-30', '23:59', { rxBytes: '30', txBytes: '3' });
    const after = minuteRow('2026-10-01', '00:00', { rxBytes: '20', txBytes: '2' });
    const event = { event: 'usage', day: after.date, hour: 0, minuteRecords: [before, after], networks: [{ networkId: 'home', rxBytes: '50', txBytes: '5' }] };
    await client.queryRange({ from: before.date, to: after.date }); receive(event);
    assert.deepEqual(client.snapshot.records.map(row => [row.date, row.rxBytes]), [[before.date, '30'], [after.date, '20']]);
    assert.deepEqual(client.snapshot.hourly.map(row => [row.date, row.hour, row.rxBytes]), [[before.date, 23, '30'], [after.date, 0, '20']]);
    await client.queryRange({ from: before.date, to: before.date, fromTime: '23:59', toTime: '23:59' }); receive(event);
    assert.deepEqual(client.snapshot.records.map(row => [row.date, row.rxBytes]), [[before.date, '30']]);
    assert.deepEqual(client.snapshot.hourly.map(row => [row.date, row.hour, row.rxBytes]), [[before.date, 23, '30']]);
});

test('导出分钟记录独立查询完整分钟数据，准确筛选并保留网络名称', async t => {
    const row = minuteRow('2026-10-01', '08:15');
    const { client, calls } = await eventClient(t, { records: [{ ...row, rxBytes: '500' }],
        networks: [{ id: 'home', ssid: 'Original', alias: 'Home' }],
        minuteRecords: [minuteRow(row.date, '08:14'), row, minuteRow(row.date, '08:16')] });
    const current = client.snapshot.records;
    const params = { from: row.date, to: row.date, fromTime: row.time, toTime: row.time, networkKey: 'home', grouping: 'minute' };
    const exported = await client.exportUsage(params);
    assert.deepEqual(calls.at(-1), { method: 'snapshot', params: { ...params, includeMinutes: true } });
    assert.equal(exported.records.length, 1); assert.equal(exported.records[0].time, '08:15');
    assert.equal(exported.records[0].rxBytes, '10'); assert.equal(exported.records[0].alias, 'Home');
    assert.equal(client.snapshot.records, current); assert.equal(exported.fromTime, row.time); assert.equal(exported.toTime, row.time);
});

test('完整日期按小时导出使用后端小时记录，跨日期保留名称且不替换页面数据', async t => {
    const { client, calls } = await eventClient(t, { networks: [{ id: 'home', ssid: 'Original', alias: 'Home' }],
        records: [{ date: '2026-10-10', networkId: 'home', rxBytes: '999', txBytes: '0' }], minuteRecords: [] });
    const oldHours = [{ date: '2020-01-01', hour: 7, minute: 0, time: '07:00', networkId: 'home', rxBytes: '9007199254740993', txBytes: '1' },
        { date: '2020-01-02', hour: 9, minute: 0, time: '09:00', networkId: 'home', rxBytes: '20', txBytes: '2' }];
    window.desktop.backend.request = async (method, params) => { calls.push({ method, params }); return { ok: true,
        result: method === 'exportUsage' ? { records: oldHours } : { records: [], minuteRecords: [] } }; };
    const current = client.snapshot.records;
    const params = { from: '2020-01-01', to: '2020-01-02', fromTime: '00:00', toTime: '23:59', grouping: 'hour', networkKey: 'home' };
    const exported = await client.exportUsage(params);
    assert.deepEqual(calls.at(-1), { method: 'exportUsage', params });
    assert.deepEqual(exported.records, oldHours.map(row => ({ ...row, ssid: 'Original', alias: 'Home' })));
    assert.equal(client.snapshot.records, current);
});

test('部分小时导出保留后端按分钟计算的小时总量，不把小时标签当作起始分钟过滤', async t => {
    const { client } = await eventClient(t, { networks: [{ id: 'home', ssid: 'Home', alias: '' }] });
    const hour = { date: '2026-10-01', hour: 8, minute: 0, time: '08:00', networkId: 'home', rxBytes: '30', txBytes: '3' };
    let query;
    window.desktop.backend.request = async (method, params) => { query = { method, params }; return { ok: true, result: { records: [hour] } }; };
    const params = { from: hour.date, to: hour.date, fromTime: '08:15', toTime: '08:16', networkKey: 'home', grouping: 'hour' };
    const result = await client.exportUsage(params);
    assert.deepEqual(query, { method: 'exportUsage', params });
    assert.deepEqual(result.records, [{ ...hour, ssid: 'Home', alias: '' }]);
});
