import { B, monthStart, shiftDay } from './model.js';

// 全部历史查询使用固定下界，不能从最近一次快照推断最早日期。
export function historyRange(period, today, custom = {}) {
    if (period === 'all') return { start: '0001-01-01', end: today };
    if (period === 'today') return { start: today, end: today };
    if (period === 'week') return { start: shiftDay(today, -6), end: today };
    if (period === 'month') return { start: monthStart(today), end: today };
    return { start: custom.start, end: custom.end };
}

export function applicationPath(app) {
    const path = app.path || app.appPath || app.executablePath || app.appId || '';
    return /^(?:[a-z]:[\\/]|\/)/i.test(path) ? path : '';
}

export function applicationRows(records, { networkId, start, end, grouping = 'day', sort = 'date', direction = 'desc', search = '' }) {
    const groups = new Map();
    for (const record of records) {
        if ((networkId !== 'all' && record.networkId !== networkId) || record.date < start || record.date > end) continue;
        const date = grouping === 'month' ? record.date.slice(0, 7) : record.date;
        const key = JSON.stringify([date, record.appId, !!record.estimated, !!record.unattributed]);
        const row = groups.get(key) || { key, date, id: record.appId, name: record.name, path: applicationPath(record), estimated: record.estimated === true, unattributed: record.unattributed === true, rx: 0n, tx: 0n };
        row.rx += B(record.rxBytes); row.tx += B(record.txBytes);
        groups.set(key, row);
    }
    const needle = search.trim().toLocaleLowerCase();
    const key = ['date', 'name', 'rx', 'tx', 'total'].includes(sort) ? sort : 'date';
    const sign = direction === 'asc' ? 1 : -1;
    return [...groups.values()].map(row => ({ ...row, total: row.rx + row.tx }))
        .filter(row => row.name.toLocaleLowerCase().includes(needle))
        .sort((a, b) => (a[key] < b[key] ? -sign : a[key] > b[key] ? sign : 0) || a.key.localeCompare(b.key));
}

export function csvCell(value) {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
}

// 接收表格实际使用的有序记录，导出不另做筛选或排序。
export function applicationCsv(rows, language = 'zh-CN') {
    const header = language === 'en' ? ['Date', 'Application', 'App ID', 'Path', 'Download bytes', 'Upload bytes', 'Total bytes', 'Source']
        : ['日期', '应用', '应用标识', '完整路径', '下载字节', '上传字节', '总计字节', '来源'];
    return '\uFEFF' + [header, ...rows.map(row => [row.date, row.name, row.id, row.path, row.rx, row.tx, row.total, language === 'en' ? (row.unattributed ? 'Estimated / Unattributed' : row.estimated ? 'Estimated' : 'Native') : (row.unattributed ? '估算 / 未归属' : row.estimated ? '估算' : '原生记录')])]
        .map(row => row.map(csvCell).join(',')).join('\r\n');
}
