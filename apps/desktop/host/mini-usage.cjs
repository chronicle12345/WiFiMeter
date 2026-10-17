'use strict';

const { proxyLiveProcesses } = require('../renderer/data/proxy-live.mjs');

const pad = value => String(value).padStart(2, '0');
const dateOf = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const timeOf = date => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
const bytes = value => (typeof value !== 'number' || Number.isSafeInteger(value))
    && /^\d+$/.test(String(value ?? '')) ? BigInt(value) : null;

// 与后端 processKey 保持一致，代理身份来自设置和已有连接观测。
const processKey = value => String(value || '').trim().toLowerCase().replace(/\.exe$/, '');
const appKey = value => String(value || '').replaceAll('\\', '/').toLowerCase();
function proxyMatcher(snapshot, live) {
    const proxy = { ...snapshot?.proxy, ...live?.proxy };
    const names = new Set((proxy.processNames || []).map(processKey).filter(Boolean));
    const ids = new Set([...(proxy.clients || []), ...(snapshot?.proxyEstimatedRecords || [])]
        .map(item => item.proxyAppId).filter(value => value && value !== 'unknown').map(appKey));
    return item => ids.has(appKey(item.appId)) || names.has(processKey(item.name))
        || names.has(processKey(String(item.appId || '').split(/[\\/]/).pop()));
}

// 小窗复用当前网卡总量，扣除同一轮已测代理程序；回环采样不参加计算。
function miniFilteredLive(event, snapshot = null) {
    if (!event || !event.appCollection && !event.proxy) return event;
    const ratesWithoutProxy = { rxPerSecond: null, txPerSecond: null };
    const collecting = event.appCollection?.enabled === true
        && ['running', 'partial'].includes(event.appCollection.state);
    const unresolvedProxy = (event.proxy?.clients || []).some(item => !item.proxyAppId || item.proxyAppId === 'unknown');
    if (event.collector === 'running' && event.state === 'connected' && event.connections?.length
        && collecting && !unresolvedProxy && Array.isArray(event.appProcesses)) {
        const isProxy = proxyMatcher(snapshot, event);
        const networks = new Set(event.connections.map(item => item.networkId).filter(Boolean));
        const proxies = event.appProcesses.filter(item => (!item.scope || item.scope === 'wifi')
            && (!networks.size || !item.networkId || networks.has(item.networkId)) && isProxy(item));
        for (const key of Object.keys(ratesWithoutProxy)) {
            let total = 0n, excluded = 0n, available = true;
            const networkTotals = new Map(), networkExcluded = new Map();
            for (const item of event.connections) {
                const value = bytes(item[key]);
                if (value === null) { available = false; break; }
                total += value;
                if (item.networkId) networkTotals.set(item.networkId, (networkTotals.get(item.networkId) || 0n) + value);
            }
            for (const item of proxies) {
                const value = bytes(item[key]);
                if (value === null || item.measurementAvailable === false
                    || networks.size && !item.networkId) { available = false; break; }
                excluded += value;
                if (networks.size) {
                    const amount = (networkExcluded.get(item.networkId) || 0n) + value;
                    networkExcluded.set(item.networkId, amount);
                    if (amount > networkTotals.get(item.networkId)) { available = false; break; }
                }
            }
            // 采样时点不同可能使应用速度暂时大于网卡速度，此时保留缺失值。
            if (available && excluded <= total) ratesWithoutProxy[key] = (total - excluded).toString();
        }
    }
    return { ...event, ratesWithoutProxy };
}

function miniRange(preferences, now = Date.now()) {
    const minutes = { '1m': 1, '5m': 5, '1h': 60 }[preferences.miniRange]
        || preferences.miniCustomMinutes || 5;
    const end = new Date(now);
    end.setSeconds(0, 0);
    const start = new Date(end.getTime() - (minutes - 1) * 60000);
    return { from: dateOf(start), to: dateOf(end), fromTime: timeOf(start), toTime: timeOf(end), minutes };
}

// 用量来自真实分钟表，速度来自采集器；不以速度积分制造历史记录。
function miniApplicationRows(snapshot, live, range, preferences = {}) {
    live = live || snapshot?.live;
    const miniExcludeProxy = preferences.miniExcludeProxy === true;
    const miniIncludeProxyEstimates = preferences.miniIncludeProxyEstimates === true;
    const isProxy = miniExcludeProxy ? proxyMatcher(snapshot, live) : () => false;
    const groups = new Map();
    const ensure = item => {
        let row = groups.get(item.appId);
        if (!row) {
            row = { appId: item.appId, name: item.name || item.appId, rx: 0n, tx: 0n,
                rxRate: 0n, txRate: 0n, active: false, rateAvailable: true, hasUsage: false };
            groups.set(item.appId, row);
        }
        return row;
    };
    const start = `${range.from}T${range.fromTime}`, end = `${range.to}T${range.toTime}`;
    for (const item of snapshot?.appMinuteRecords || []) {
        if (typeof item.appId !== 'string' || !item.appId) continue;
        if (isProxy(item)) continue;
        const time = item.time || (Number.isInteger(item.hour) && Number.isInteger(item.minute) ? `${pad(item.hour)}:${pad(item.minute)}` : '');
        const key = `${item.date}T${time}`;
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(key) || key < start || key > end) continue;
        const rx = bytes(item.rxBytes), tx = bytes(item.txBytes);
        if (rx === null || tx === null) continue;
        const row = ensure(item);
        row.rx += rx; row.tx += tx; row.hasUsage = true;
    }
    const collection = live?.appCollection || snapshot?.appCollection || {};
    const collecting = collection.enabled === true && ['running', 'partial'].includes(collection.state);
    const running = collecting && live?.collector === 'running' && live?.state === 'connected';
    const processes = running ? proxyLiveProcesses(live.appProcesses || [], live.proxy, miniIncludeProxyEstimates) : [];
    for (const item of processes) {
        // 回环观测单独显示在主窗口，避免把同一流量重复加入网卡速度。
        if (item.scope === 'loopback' || typeof item.appId !== 'string' || !item.appId || isProxy(item)) continue;
        const row = ensure(item);
        if (item.estimated) { row.estimated = true; row.unattributed ||= item.unattributed === true; }
        row.active = true;
        const rx = bytes(item.rxPerSecond), tx = bytes(item.txPerSecond);
        if (rx === null || tx === null || item.measurementAvailable === false) row.rateAvailable = false;
        else { row.rxRate += rx; row.txRate += tx; }
    }
    const rows = [...groups.values()].sort((a, b) => {
        const left = a.active && a.rateAvailable ? a.rxRate + a.txRate : 0n;
        const right = b.active && b.rateAvailable ? b.rxRate + b.txRate : 0n;
        if (left !== right) return left > right ? -1 : 1;
        const usageLeft = a.rx + a.tx, usageRight = b.rx + b.tx;
        return usageLeft > usageRight ? -1 : usageLeft < usageRight ? 1 : a.name.localeCompare(b.name);
    }).map(row => ({ appId: row.appId, name: row.name,
        rxPerSecond: running && row.rateAvailable ? row.rxRate.toString() : null,
        txPerSecond: running && row.rateAvailable ? row.txRate.toString() : null,
        measurementAvailable: running && row.rateAvailable,
        ...(row.estimated ? { estimated: true, unattributed: row.unattributed === true } : {}),
        rxBytes: row.hasUsage ? row.rx.toString() : null, txBytes: row.hasUsage ? row.tx.toString() : null }));
    return { rows, range, miniExcludeProxy, miniIncludeProxyEstimates, status: collection.enabled !== true ? 'disabled' : collection.state || 'unavailable',
        detail: collection.detail || '', updatedAt: snapshot?.live?.updatedAt || live?.updatedAt || null };
}

module.exports = { miniRange, miniApplicationRows, miniFilteredLive };
