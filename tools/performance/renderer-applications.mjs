// Compare one application refresh using the same records and Git baseline.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { applicationViewData } from '../../apps/desktop/renderer/data/application-view.js';
import { applicationRows, applicationSummary } from '../../apps/desktop/renderer/data/history.js';
import { applicationLiveRows } from '../../apps/desktop/renderer/data/application-live.js';
import { proxyUsageRecords } from '../../apps/desktop/renderer/data/proxy.js';
import { sortApps } from '../../apps/desktop/renderer/data/model.js';

const root = path.resolve(import.meta.dirname, '../..'), revision = process.argv[2] || '0df2e49';
const source = execFileSync('git', ['show', `${revision}:apps/desktop/renderer/app.js`], { cwd: root, encoding: 'utf8', windowsHide: true });
const between = (start, end) => {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, 'Baseline application functions are unavailable');
    return source.slice(first, last);
};
const range = { start: '2026-10-01', end: '2026-10-31' };
const record = index => ({ networkId: 'fixture', date: `2026-10-${String(index % 31 + 1).padStart(2, '0')}`,
    appId: `app-${index % 1000}`, name: `Application ${index % 1000}`, rxBytes: String(index + 1), txBytes: '10' });
const daily = Array.from({ length: 50000 }, (_, index) => record(index));
const minutes = Array.from({ length: 200000 }, (_, index) => ({ ...record(index),
    time: `${String(Math.floor(index / 60) % 24).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}` }));
const processes = Array.from({ length: 100 }, (_, index) => ({ networkId: 'fixture', appId: `app-${index}`, name: `Application ${index}`,
    processId: index + 1, rxPerSecond: String(index * 10), txPerSecond: String(index) }));
let context = { appGrouping: 'summary', appSearch: '', appSort: 'total', historySort: 'date', historyDirection: 'desc', liveSort: 'total' };
const data = { appRecords: daily, appMinuteRecords: minutes, appProcesses: processes, proxyEstimatedRecords: [], appCollection: { state: 'running' } };
const legacy = runInNewContext(between('function displayedAppRecords()', '\nfunction drawerApps(') + '\n'
    + between('function currentAppRows()', '\nfunction appControlPanel(') + '\n'
    + between('function namedAppProcesses()', '\nfunction measuredProxy(')
    + '\n({currentAppRows,displayedAppSummary,currentLiveRows});', {
    data, appContext: () => context, appNetworkId: () => 'fixture', getRange: () => range,
    appMinuteSource: () => ['minute', 'hour'].includes(context.appGrouping),
    proxyUsageRecords, applicationRows, applicationSummary, applicationLiveRows, sortApps
});
function oldRefresh(view) {
    if (view === 'live') { const rows = legacy.currentLiveRows({ id: 'fixture' }); legacy.currentLiveRows({ id: 'fixture' }); return { rows, total: 0n, hasRecords: rows.length > 0 }; }
    const rows = context.appGrouping === 'summary' ? sortApps(legacy.displayedAppSummary('fixture', range.start, range.end), context.appSort, context.appSearch) : legacy.currentAppRows();
    const summary = legacy.displayedAppSummary('fixture', range.start, range.end);
    legacy.currentAppRows(); // Export availability previously built all rows again.
    return { rows, total: summary.reduce((total, row) => total + row.total, 0n), hasRecords: summary.length > 0 };
}
function newRefresh(view) {
    return applicationViewData({ view, context, range, networkId: 'fixture', collecting: true, processes,
        records: ['minute', 'hour'].includes(context.appGrouping) ? minutes : daily });
}
function measure(callback) {
    const timings = [];
    for (let run = 0; run < 5; run++) {
        globalThis.gc?.();
        const start = performance.now(); callback();
        timings.push(performance.now() - start);
    }
    return +timings.sort((a, b) => a - b)[2].toFixed(3);
}
const results = [];
for (const [view, grouping] of [['live', 'summary'], ['history', 'summary'], ['history', 'day'], ['history', 'minute']]) {
    context = { ...context, appGrouping: grouping };
    const before = oldRefresh(view), after = newRefresh(view);
    assert.deepEqual(after, structuredClone(before));
    results.push({ view, grouping, beforeMs: measure(() => oldRefresh(view)), afterMs: measure(() => newRefresh(view)), rows: after.rows.length });
}
console.log(JSON.stringify({ baseline: revision, fixture: { dailyRecords: daily.length, minuteRecords: minutes.length, liveProcesses: processes.length },
    scope: 'Data derivation only; excludes DOM rendering, icon decoding and backend collection.', results }, null, 2));
