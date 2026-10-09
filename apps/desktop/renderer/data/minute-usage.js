import { B } from './model.js';
import { recordInRange } from './history.js';

export function minuteUsageRows(records, range, grouping = 'minute') {
    const groups = new Map();
    for (const record of records || []) {
        if (!recordInRange(record, range) || record.time == null && record.minute == null) continue;
        const time = record.time || `${String(record.hour).padStart(2, '0')}:${String(record.minute).padStart(2, '0')}`;
        const bucket = grouping === 'hour' ? time.slice(0, 2) + ':00' : time;
        const key = `${record.date} ${bucket}`;
        const row = groups.get(key) || { key, date: record.date, time: bucket, rx: 0n, tx: 0n };
        row.rx += B(record.rxBytes); row.tx += B(record.txBytes);
        groups.set(key, row);
    }
    return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}
