const appKey = value => String(value || '').replaceAll('\\', '/').toLowerCase();
const amount = value => (typeof value !== 'number' || Number.isSafeInteger(value))
    && /^\d+$/.test(String(value ?? '')) ? BigInt(value) : null;

// Port observations only distribute measured network rates; local TCP rates stay separate.
export function proxyLiveProcesses(processes = [], proxy, enabled = false) {
    if (!enabled || !proxy?.available || proxy.status && proxy.status !== 'ready') return processes;
    const groups = new Map();
    for (const client of proxy.clients || []) {
        const proxyId = appKey(client.proxyAppId), weight = amount(client.connections);
        if (!proxyId || proxyId === 'unknown' || weight === null || weight === 0n) continue;
        let group = groups.get(proxyId);
        if (!group) { group = { total: 0n, clients: new Map() }; groups.set(proxyId, group); }
        group.total += weight;
        const key = appKey(client.appId), existing = group.clients.get(key);
        if (existing) existing.weight += weight;
        else group.clients.set(key, { ...client, weight });
    }
    return processes.flatMap(process => {
        const proxyId = appKey(process.appId), group = groups.get(proxyId);
        const rx = amount(process.rxPerSecond), tx = amount(process.txPerSecond);
        if (!group || process.scope === 'loopback' || !process.networkId
            || process.measurementAvailable === false || rx === null || tx === null) return [process];
        const rows = [];
        let remainingRx = rx, remainingTx = tx;
        const estimate = (client, download, upload, unattributed = false) => ({
            appId: client.appId, name: client.name || client.appId, networkId: process.networkId,
            scope: process.scope || 'wifi', live: true, processId: null,
            proxyAppId: process.appId, proxyName: process.name || process.appId,
            estimated: true, unattributed, measurementAvailable: true,
            rxPerSecond: download.toString(), txPerSecond: upload.toString()
        });
        for (const [key, client] of group.clients) {
            if (!key || key === 'unknown' || key === proxyId) continue;
            const download = rx * client.weight / group.total, upload = tx * client.weight / group.total;
            rows.push(estimate(client, download, upload));
            remainingRx -= download; remainingTx -= upload;
        }
        if (remainingRx || remainingTx || !rows.length)
            rows.push(estimate({ appId: 'proxy/unattributed', name: 'Unattributed' }, remainingRx, remainingTx, true));
        return rows;
    });
}
