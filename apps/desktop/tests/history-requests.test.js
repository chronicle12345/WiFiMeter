import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createDataClient } from '../renderer/data/backend-client.js';
import { historyRange } from '../renderer/data/history.js';
import { minuteUsageRows } from '../renderer/data/minute-usage.js';

const source = await readFile(new URL('../renderer/app.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const text = (strings, ...values) => strings.reduce((out, part, index) => out + part + (values[index] ?? ''), '');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('小时 JSON 导出传递原分组并保留后端一致的小时和分钟字段', async () => {
    const minuteRecords = [{ date: '2026-10-01', time: '08:15', hour: 8, minute: 15, networkId: 'home', rxBytes: '10', txBytes: '1' },
        { date: '2026-10-01', time: '08:16', hour: 8, minute: 16, networkId: 'home', rxBytes: '20', txBytes: '2' }];
    const hours = [{ ...minuteRecords[0], time: '08:00', minute: 0, rxBytes: '30', txBytes: '3', ssid: 'Home', alias: 'Office' }];
    let saved, query;
    const doExport = runInNewContext(section('async function doExport(', '\nasync function backup()') + ';doExport;', {
        store: { exportUsage: async params => { query = params; return { records: params.grouping === 'hour' ? hours : minuteRecords }; } },
        validDate: () => true, validTime: () => true, today: () => '2026-10-10', t: value => value, tr: text,
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
        ui, data: client.snapshot, applications, today: () => '2026-10-10', historyRange,
        getRange: () => historyRange(ui.period, '2026-10-10', ui), appContext: () => applications,
        document: { getElementById: () => ({ setAttribute() {}, removeAttribute() {} }) },
        renderMain() {}, closeDrawer() {}, history: { replaceState() {} }, location: { pathname: '/', search: '' }, window: { scrollTo() {} }, store: client
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
