'use strict';

const pad = value => String(value).padStart(2, '0');
const dateOf = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const timeOf = date => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
const bytes = value => /^\d+$/.test(String(value ?? '')) ? BigInt(value) : null;

function miniRange(preferences, now = Date.now()) {
    const minutes = { '1m': 1, '5m': 5, '1h': 60 }[preferences.miniRange]
        || preferences.miniCustomMinutes || 5;
    const end = new Date(now);
    end.setSeconds(0, 0);
    const start = new Date(end.getTime() - (minutes - 1) * 60000);
    return { from: dateOf(start), to: dateOf(end), fromTime: timeOf(start), toTime: timeOf(end), minutes };
}

// 用量来自真实分钟表，速度来自采集器；不以速度积分制造历史记录。
function miniApplicationRows(snapshot, live, range) {
    live = live || snapshot?.live;
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
    for (const item of running ? live.appProcesses || [] : []) {
        // 回环观测单独显示在主窗口，避免把同一流量重复加入网卡速度。
        if (item.scope === 'loopback' || typeof item.appId !== 'string' || !item.appId) continue;
        const row = ensure(item);
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
        rxBytes: row.hasUsage ? row.rx.toString() : null, txBytes: row.hasUsage ? row.tx.toString() : null }));
    return { rows, range, status: collection.enabled !== true ? 'disabled' : collection.state || 'unavailable',
        detail: collection.detail || '', updatedAt: snapshot?.live?.updatedAt || live?.updatedAt || null };
}

module.exports = { miniRange, miniApplicationRows };
