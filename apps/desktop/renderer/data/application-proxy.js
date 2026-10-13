import { applicationPath, recordInRange } from './history.js';
import { validatedProxyEstimates } from './proxy.js';

const identity = value => {
    const text = String(value || '');
    return /^(?:[a-z]:[\\/]|\\\\)/i.test(text) ? text.replaceAll('/', '\\').toLowerCase() : text;
};

export const applicationProxyClientKey = client => JSON.stringify([client.appId || '', client.proxyAppId || '', client.proxyName || '']);

// Proxy rates are live measurements; historical attribution is independently validated.
export function applicationProxyDetails(app, { proxy, nativeRecords = [], estimatedRecords = [], range = {}, networkId = 'all', allowEstimates = true } = {}) {
    const ids = new Set([app.appId, app.id, app.path, applicationPath(app)].filter(Boolean).map(identity));
    if (!ids.size) return { clients: [], estimates: [] };
    const matches = value => value && ids.has(identity(value));
    const clients = (proxy?.clients || []).filter(client => matches(client.appId) || matches(client.proxyAppId));
    const partial = (range.startTime && range.startTime !== '00:00') || (range.endTime && range.endTime !== '23:59') || /\d{4}-\d{2}-\d{2}\s/.test(app.date || '');
    if (!allowEstimates || partial) return { clients, estimates: [] };
    const selectedDate = /^\d{4}-\d{2}(?:-\d{2})?$/.test(app.date || '') ? app.date : '';
    const estimates = validatedProxyEstimates(nativeRecords, estimatedRecords, row => (matches(row.appId) || matches(row.proxyAppId))
        && recordInRange(row, { ...range, networkId })
        && (!selectedDate || (selectedDate.length === 7 ? row.date.startsWith(selectedDate + '-') : row.date === selectedDate)))
        .map(row => row.proxyName ? row : { ...row, proxyName: row.proxyAppId });
    return { clients, estimates };
}

// The caller owns the history revision; live clients are read afresh on cache hits.
export function createApplicationProxyResolver() {
    let latest = null;
    function resolveApplicationProxy(app, options = {}) {
        const { revision, nativeRecords, estimatedRecords, range = {}, networkId = 'all', allowEstimates = true } = options;
        if (revision == null) { latest = null; return applicationProxyDetails(app, options); }
        const key = JSON.stringify([app.appId, app.id, app.path, applicationPath(app), app.date,
            networkId, range.start, range.end, range.startTime ?? '00:00', range.endTime ?? '23:59', allowEstimates]);
        if (latest && latest.revision === revision && latest.key === key
            && latest.nativeRecords === nativeRecords && latest.estimatedRecords === estimatedRecords) {
            return { clients: applicationProxyDetails(app, { proxy: options.proxy, allowEstimates: false }).clients,
                estimates: latest.estimates };
        }
        const details = applicationProxyDetails(app, options);
        latest = { revision, key, nativeRecords, estimatedRecords, estimates: details.estimates };
        return details;
    }
    resolveApplicationProxy.clear = () => { latest = null; };
    return resolveApplicationProxy;
}
