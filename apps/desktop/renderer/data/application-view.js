import { applicationLiveRows } from './application-live.js';
import { proxyLiveProcesses } from './proxy-live.mjs';
import { applicationRows, applicationSummary, recordInRange } from './history.js';
import { B, sortApps } from './model.js';

// A render pass shares this result; each new call sees in-place usage updates.
export function applicationViewData(options = {}) {
    const { view = 'history', context = {}, networkId = 'all', range = {} } = options;
    if (view === 'live') {
        const rows = options.collecting ? applicationLiveRows(proxyLiveProcesses(options.processes || [], options.proxy, context.liveProxyEstimated), {
            networkId, search: context.liveSearch, sort: context.liveSort
        }) : [];
        return { rows, total: 0n, hasRecords: rows.length > 0 };
    }
    const records = options.records || [], selectedRange = { ...range, networkId };
    if (!context.appGrouping || context.appGrouping === 'summary') {
        const summary = applicationSummary(records, selectedRange);
        return { rows: sortApps(summary, context.appSort, context.appSearch),
            total: summary.reduce((total, row) => total + row.total, 0n), hasRecords: summary.length > 0 };
    }
    const rows = applicationRows(records, { ...selectedRange, grouping: context.appGrouping,
        sort: context.historySort, direction: context.historyDirection, search: context.appSearch });
    let total = 0n, hasRecords = false;
    for (const record of records) {
        if (!recordInRange(record, selectedRange)) continue;
        total += B(record.rxBytes) + B(record.txBytes);
        hasRecords = true;
    }
    return { rows, total, hasRecords };
}
