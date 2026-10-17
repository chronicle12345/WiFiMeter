import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createDataClient } from '../renderer/data/backend-client.js';
import { historyRange } from '../renderer/data/history.js';
import { minuteUsageRows } from '../renderer/data/minute-usage.js';
import * as model from '../renderer/data/model.js';

const source = await readFile(new URL('../renderer/app.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const text = (strings, ...values) => strings.reduce((out, part, index) => out + part + (values[index] ?? ''), '');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('导出把合法的浏览器零秒输入转为分钟，拒绝非零秒及倒序范围', async () => {
    let query, saved;
    const doExport = runInNewContext(section('async function doExport(', '\nasync function backup()') + ';doExport;', {
        ...model, today: () => '2026-10-18', t: value => value, tr: text,
        store: { exportUsage: async params => { query = params; return { records: [{ date: '2026-10-18', networkId: 'home', time: '01:59', rxBytes: '10', txBytes: '1' }] }; } },
        data: { source: 'backend' }, getNetwork: () => null,
        dataDownload: async (_name, body) => { saved = JSON.parse(body); return true; }, closeModal() {}, toast() {}
    });
    const values = { networkId: 'all', start: '2026-10-18', end: '2026-10-18', startTime: '00:00:00', endTime: '01:59:00', format: 'json', grouping: 'minute' };
    await doExport(values);
    assert.equal(query.fromTime, '00:00');assert.equal(query.toTime, '01:59');
    assert.equal(saved.startTime, '00:00');assert.equal(saved.endTime, '01:59');
    for (const [startTime, endTime] of [['01:59', '01:59'], ['23:59:00.000', '23:59:00']]) {
        await doExport({ ...values, startTime, endTime });
        assert.equal(query.fromTime, startTime.slice(0, 5));assert.equal(query.toTime, endTime.slice(0, 5));
    }
    for (const patch of [{ startTime: '00:00:01' }, { endTime: '01:59:00.001' }, { startTime: '24:00:00' },
        { startTime: '' }, { startTime: '02:00:00' }, { end: '2026-10-19' }]) {
        query = null;
        await assert.rejects(doExport({ ...values, ...patch }), /Choose|请确认/);
        assert.equal(query, null);
    }
});

test('小时 JSON 导出传递原分组并保留后端一致的小时和分钟字段', async () => {
    const minuteRecords = [{ date: '2026-10-01', time: '08:15', hour: 8, minute: 15, networkId: 'home', rxBytes: '10', txBytes: '1' },
        { date: '2026-10-01', time: '08:16', hour: 8, minute: 16, networkId: 'home', rxBytes: '20', txBytes: '2' }];
    const hours = [{ ...minuteRecords[0], time: '08:00', minute: 0, rxBytes: '30', txBytes: '3', ssid: 'Home', alias: 'Office' }];
    let saved, query;
    const doExport = runInNewContext(section('async function doExport(', '\nasync function backup()') + ';doExport;', {
        store: { exportUsage: async params => { query = params; return { records: params.grouping === 'hour' ? hours : minuteRecords }; } },
        validDate: () => true, validTime: () => true, minuteInputTime: model.minuteInputTime, today: () => '2026-10-10', t: value => value, tr: text,
        B: value => BigInt(value), data: { source: 'backend' }, getNetwork: () => null,
        dataDownload: async (_name, body) => { saved = JSON.parse(body); return true; }, closeModal() {}, toast() {}
    });
    await doExport({ networkId: 'home', start: '2026-10-01', end: '2026-10-01', startTime: '08:15', endTime: '08:16', format: 'json', grouping: 'hour' });
    assert.equal(query.grouping, 'hour');
    assert.equal(saved.grouping, 'hour');
    assert.deepEqual(saved.records, hours);
});

test('导出默认分组沿用历史页选择，其他页面根据是否完整日期选择日或分钟', () => {
    const ui = { page: 'overview', period: 'custom', historyGrouping: 'minute', networkId: 'all' };
    let range = { start: '2020-01-01', end: '2020-01-31', startTime: '00:00', endTime: '23:59' }, html;
    const exportModal = runInNewContext(section('function exportModal(', '\nfunction demoModal()') + ';exportModal;', {
        ui, getRange: () => range, today: () => '2026-10-10', t: value => value, tr: text,
        networkOptions: () => '', button: () => '', icon: () => '', showModal: (_title, body) => { html = body; },
        option: (value, label, selected) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`
    });
    const selected = () => { exportModal(); return /<select[^>]+id="exportGrouping"[^>]*>([\s\S]*?)<\/select>/.exec(html)[1].match(/value="(\w+)" selected/)[1]; };
    assert.equal(selected(), 'day');
    range = { ...range, startTime: '08:15' }; assert.equal(selected(), 'minute');
    ui.page = 'history'; ui.historyGrouping = 'hour'; assert.equal(selected(), 'hour');
    ui.period = 'month'; range = { start: '2026-10-01', end: '2026-10-10' }; assert.equal(selected(), 'hour');
    ui.page = 'networks'; assert.equal(selected(), 'day');
});

async function rangeFixture(t, includeMinutes = true) {
    const previous = globalThis.window;
    t.after(() => { globalThis.window = previous; });
    const minuteRecords = ['10:01', '10:02'].map((time, index) => ({ date: '2026-10-10', time, hour: 10, minute: index + 1,
        networkId: 'home', rxBytes: '100', txBytes: '10' }));
    const resultFor = params => ({ minuteRecordsIncluded: params.includeMinutes,
        minuteRecords: params.includeMinutes ? minuteRecords : [], appMinuteRecords: [] });
    globalThis.window = { desktop: { backend: { request: async (_method, params) => ({ ok: true, result: resultFor(params) }) } } };
    const client = createDataClient(); t.after(() => client.stop());
    await client.queryRange({ from: '2026-10-01', to: '2026-10-10', includeMinutes });
    const requests = [];
    window.desktop.backend.request = async (method, params) => new Promise(resolve => requests.push({ method, params,
        finish: () => resolve({ ok: true, result: resultFor(params) }) }));
    const ui = { page: 'overview', period: 'month', start: '2026-10-01', end: '2026-10-10', startTime: '00:00', endTime: '23:59', historyGrouping: 'minute' };
    const applications = { appGrouping: 'summary' };
    const context = {
        ui, data: client.snapshot, applications, navigationVersion: 0, settingsCategoryScrollY: null, today: () => '2026-10-10', historyRange,
        getRange: () => historyRange(ui.period, '2026-10-10', ui), appContext: () => applications,
        document: { getElementById: () => ({ setAttribute() {}, removeAttribute() {} }) },
        renderMain() {}, updateSettingsScroll() {}, closeDrawer() {}, history: { replaceState() {} }, location: { pathname: '/', search: '' }, window: { scrollTo() {} }, store: client
    };
    const api = runInNewContext(section('let rangeRequest=0', '\nfunction customRangeModal()') + '\n'
        + section('async function doNavigate(', '\nfunction syncInert()') + ';({selectRange,ensureMinuteHistory,doNavigate});', context);
    return { api, ui, requests, data: client.snapshot };
}

test('范围查询未完成时进入分钟历史页，查询结束后补读新范围的分钟明细', async t => {
    const { api, ui, requests, data } = await rangeFixture(t);
    const selecting = api.selectRange('week');
    const navigating = api.doNavigate('history');
    assert.equal(requests[0].params.includeMinutes, false);
    requests[0].finish(); await nextTurn();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].params.from, '2026-10-04');
    assert.equal(requests[1].params.includeMinutes, true);
    requests[1].finish(); await Promise.all([selecting, navigating]);
    assert.equal(ui.page, 'history'); assert.equal(ui.period, 'week'); assert.equal(data.minuteRecordsIncluded, true);
    assert.equal(minuteUsageRows(data.minuteRecords, historyRange(ui.period, '2026-10-10', ui)).length, 2);
});

test('同一范围并发请求分钟明细只发出一次查询', async t => {
    const { api, requests, data } = await rangeFixture(t, false);
    const first = api.ensureMinuteHistory(), second = api.ensureMinuteHistory();
    assert.equal(requests.length, 1);
    requests[0].finish(); await Promise.all([first, second]);
    assert.equal(data.minuteRecordsIncluded, true); assert.equal(data.minuteRecords.length, 2);
});

test('旧范围的分钟补查晚到时，重新读取用户随后选择的范围', async t => {
    const { api, ui, requests, data } = await rangeFixture(t, false);
    ui.page = 'history'; ui.historyGrouping = 'day';
    const detail = api.ensureMinuteHistory().then(() => { ui.historyGrouping = 'minute'; });
    const selecting = api.selectRange('week');
    requests[1].finish(); await selecting;
    requests[0].finish(); await nextTurn();
    assert.equal(requests.length, 3);
    assert.equal(requests[2].params.from, '2026-10-04'); assert.equal(requests[2].params.includeMinutes, true);
    requests[2].finish(); await detail;
    assert.equal(ui.period, 'week'); assert.equal(ui.historyGrouping, 'minute'); assert.equal(data.minuteRecordsIncluded, true);
});

function rolloverFixture(period, date = '2026-10-31') {
    let day = date, renders = 0, hidden = false, reloads = 0;
    const range = historyRange(period, day);
    const ui = { page: 'overview', period, start: range.start, end: range.end, historyGrouping: 'day' };
    const applications = { appGrouping: 'summary' }, requests = [];
    const data = { minuteRecordsIncluded: false, settings: { interval: 5 } };
    const context = {
        ui, data, applications, today: () => day, historyRange,
        getRange: () => historyRange(ui.period, day, ui), appContext: () => applications,
        document: { getElementById: () => ({ setAttribute() {}, removeAttribute() {} }) },
        renderMain: () => { renders++; },
        renderingHidden: () => hidden, liveRender: { visibilityChanged() {} }, restartSampler() {}, refreshLive() {},
        settingsDirty: false, networkDirty: false, totalQuotaDirty: false, proxyDirty: false,
        reloadWindowPreferences: async () => {}, storageFailed: false, renderDrawer() {},
        store: { ready: true, queryRange: params => new Promise((resolve, reject) => requests.push({ params,
            finish: (applied = true) => resolve(applied), fail: reject })), reload: async () => { reloads++; } }
    };
    const refreshStart = source.indexOf(' refresh:async e=>{');
    const refreshAction = source.slice(refreshStart, source.indexOf('\n navigate:', refreshStart));
    const api = runInNewContext(section('let rangeRequest=0', '\nfunction customRangeModal()')
        + '\n' + section('const visibilityChanged=', "\ndocument.addEventListener('visibilitychange'")
        + ';const actions={' + refreshAction + '};({selectRange,ensureMinuteHistory,syncAutomaticRange,visibilityChanged,refresh:actions.refresh});', context);
    return { api, ui, requests, data, tomorrow: () => { day = '2026-11-01'; },
        setHidden: value => { hidden = value; }, renders: () => renders, reloads: () => reloads };
}

for (const period of ['today', 'week', 'month', 'all']) {
    test(`跨日期后 ${period} 自动重查一次，并在完成后更新已加载范围`, async () => {
        const { api, ui, requests, tomorrow } = rolloverFixture(period);
        tomorrow();
        const first = api.syncAutomaticRange(), second = api.syncAutomaticRange();
        assert.equal(requests.length, 1);
        assert.deepEqual(JSON.parse(JSON.stringify(requests[0].params)), {
            from: historyRange(period, '2026-11-01').start, to: '2026-11-01', includeMinutes: false
        });
        requests[0].finish(); await Promise.all([first, second]);
        assert.equal(ui.end, '2026-11-01');
        await api.syncAutomaticRange(); assert.equal(requests.length, 1);
    });
}

test('自定义范围跨日期仍然固定，不发起自动重查', async () => {
    const { api, ui, requests, tomorrow } = rolloverFixture('month');
    Object.assign(ui, { period: 'custom', start: '2026-10-01', end: '2026-10-05', startTime: '08:00', endTime: '18:00' });
    tomorrow(); await api.syncAutomaticRange({ force: true });
    assert.equal(requests.length, 0); assert.equal(ui.end, '2026-10-05');
});

test('用户正在切换范围时自动同步等待，旧自动响应不能覆盖新的自定义选择', async () => {
    const { api, ui, requests, tomorrow } = rolloverFixture('today');
    tomorrow(); const automatic = api.syncAutomaticRange();
    const selecting = api.selectRange('custom', { start: '2026-10-01', end: '2026-10-05', startTime: '08:00', endTime: '18:00' });
    await api.syncAutomaticRange(); assert.equal(requests.length, 2);
    requests[1].finish(); await selecting;
    requests[0].finish(false); await automatic;
    assert.equal(ui.period, 'custom'); assert.equal(ui.start, '2026-10-01'); assert.equal(ui.end, '2026-10-05');
});

test('自动日期同步失败不会立即重复查询，恢复前台或手动刷新可以强制重试', async () => {
    const { api, ui, requests, tomorrow } = rolloverFixture('month');
    tomorrow(); const first = api.syncAutomaticRange();
    requests[0].fail(new Error('offline')); await assert.rejects(first, /offline/);
    await api.syncAutomaticRange(); assert.equal(requests.length, 1);
    const forced = api.syncAutomaticRange({ force: true }); assert.equal(requests.length, 2);
    requests[1].finish(); assert.equal(await forced, true); assert.equal(ui.start, '2026-11-01');
});

test('后台跨日期不重查，恢复前台后更新自动范围', async () => {
    const { api, ui, requests, tomorrow, setHidden } = rolloverFixture('month');
    setHidden(true); tomorrow(); api.visibilityChanged(); assert.equal(requests.length, 0);
    setHidden(false); api.visibilityChanged(); assert.equal(requests.length, 1);
    requests[0].finish(); await nextTurn(); assert.equal(ui.end, '2026-11-01');
});

test('手动刷新跨日期只查询新范围，日期未变时仍可刷新当前记录', async () => {
    const { api, requests, tomorrow, reloads } = rolloverFixture('month');
    const button = {}; tomorrow(); const refresh = api.refresh(button);
    assert.equal(button.disabled, true); assert.equal(requests.length, 1);
    requests[0].finish(); await refresh;
    assert.equal(reloads(), 0); assert.equal(button.disabled, false);
    await api.refresh(button); assert.equal(reloads(), 1); assert.equal(requests.length, 1);
});

test('手动刷新等待用户正在进行的范围选择，不发出覆盖该选择的查询', async () => {
    const { api, ui, requests, reloads, tomorrow } = rolloverFixture('month');
    tomorrow();
    const selection = api.selectRange('custom', { start: '2026-10-01', end: '2026-10-05', startTime: '08:00', endTime: '18:00' });
    const refresh = api.refresh({}); assert.equal(requests.length, 1);
    requests[0].finish(); await Promise.all([selection, refresh]);
    assert.equal(reloads(), 0); assert.equal(ui.period, 'custom'); assert.equal(ui.end, '2026-10-05');
});

test('自动跨日同步不会重建正在编辑的设置页，显式选择范围仍正常渲染', async () => {
    const { api, ui, requests, tomorrow, renders } = rolloverFixture('month');
    ui.page = 'settings'; tomorrow(); const automatic = api.syncAutomaticRange();
    requests[0].finish(); await automatic; assert.equal(renders(), 0);
    const selected = api.selectRange('week'); requests[1].finish(); await selected;
    assert.equal(renders(), 1);
});
