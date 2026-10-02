import { formatSpeedParts } from './speed.js';

// Live sockets are grouped only within their measured scope; loopback never joins Wi-Fi totals.
export function applicationLiveRows(processes, { networkId = 'all', search = '' } = {}) {
    const groups = new Map();
    for (const process of processes || []) {
        if (networkId !== 'all' && process.networkId !== networkId) continue;
        const scope = process.scope || 'wifi';
        const key = JSON.stringify([process.appId, process.networkId, scope]);
        let row = groups.get(key);
        if (!row) {
            row = { ...process, key, scope, processIds: new Set(), rxPerSecond: 0n, txPerSecond: 0n, measurementAvailable: true };
            groups.set(key, row);
        }
        if (process.processId) row.processIds.add(process.processId);
        for (const field of ['rxPerSecond', 'txPerSecond']) {
            const value = process[field];
            if (value == null || !/^\d+$/.test(String(value))) row.measurementAvailable = false;
            else row[field] += BigInt(value);
        }
        if (process.measurementAvailable === false) row.measurementAvailable = false;
    }
    const needle = search.trim().toLocaleLowerCase();
    return [...groups.values()].map(row => ({ ...row,
        processIds: [...row.processIds],
        rxPerSecond: row.measurementAvailable ? row.rxPerSecond.toString() : null,
        txPerSecond: row.measurementAvailable ? row.txPerSecond.toString() : null
    })).filter(row => String(row.name || row.appId).toLocaleLowerCase().includes(needle));
}

export function measuredRate(value, mode) {
    const parts = formatSpeedParts(value, mode);
    return parts.value === '—' ? parts.value : `${parts.value} ${parts.unit}`;
}
