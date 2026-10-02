import { appendCoverageGaps } from './coverage.js';
import { proxyUsageKey } from './proxy.js';
import { t } from '../i18n.js';
// 页面数据客户端：把后端协议包装成 app.js 需要的形状。
//
// snapshot 始终是同一个对象引用，客户端就地更新，页面不必重新取引用。
// 页面只读快照，所有写操作都通过这里的异步方法回到后端，由后端落库后再更新本地快照。

const emptySnapshot = () => ({
    version: 1,
    source: 'backend',
    networks: [],
    records: [],
    hourly: [],
    appRecords: [],
    proxyEstimatedRecords: [],
    appCollection: { enabled: false, available: false, state: 'disabled' },
    appProcesses: [],
    appGaps: [],
    gaps: [],
    settings: { unit: 'GB', speedUnit: 'auto', interval: 5, retention: 90, autoStart: false, minimizeToTray: false, notifications: true },
    live: { state: 'loading', collector: 'offline', connections: [], updatedAt: new Date().toISOString(), skippedIntervals: 0 }
});

// 事件负载把事件名和字段放在同一层，去掉 event 字段就是负载本身。
const payloadOf = message => {
    const { event, ...rest } = message;
    return rest;
};

export function createDataClient(handlers = {}) {
    const snapshot = emptySnapshot();
    const state = { storageFailed: false, available: Boolean(window.desktop?.backend), unsubscribe: null, ready: false };

    let rangeVersion = 0;
    let eventRevision = 0;
    let pendingSnapshot = null;

    // 只记录当前请求期间的全量组和字段，不重放 usage/appUsage 的字节增量。
    function rememberEvent(message) {
        const revision = ++eventRevision;
        if (!pendingSnapshot) return;
        const updatedAt = Date.parse(message.updatedAt);
        const remember = (map, key, value) => map.set(key, { revision, updatedAt, value: structuredClone(value) });
        if (message.totalQuota) remember(pendingSnapshot.fields, 'totalQuota', message.totalQuota);
        if (message.event === 'live') {
            remember(pendingSnapshot.fields, 'live', payloadOf(message));
            for (const key of ['appCollection', 'proxy', 'appProcesses']) {
                if (message[key] != null) remember(pendingSnapshot.fields, key, message[key]);
            }
        }
        if (message.event === 'live' || message.event === 'appUsage') {
            for (const update of message.proxyEstimatedUpdates ?? []) {
                remember(pendingSnapshot.groups, proxyUsageKey(update), update);
            }
        }
    }

    function restorePendingEvents(pending, next, params) {
        const snapshotTime = Date.parse(next.live?.updatedAt);
        // updatedAt 是采样时间，非协议序号：只能排除明确较旧的事件。
        // 时间相同或缺失时按请求内接收 revision 保留最后值，不能保证跨通道严格顺序。
        const fresh = entry => entry.revision > pending.revision
            && !(Number.isFinite(snapshotTime) && Number.isFinite(entry.updatedAt) && entry.updatedAt < snapshotTime);
        for (const [key, entry] of pending.fields) {
            if (fresh(entry)) snapshot[key] = entry.value;
        }
        const inRange = group => (!params.networkKey || group.networkId === params.networkKey)
            && (!params.from || group.date >= params.from) && (!params.to || group.date <= params.to);
        applyProxyEstimatedUpdates([...pending.groups.values()]
            .filter(entry => fresh(entry) && inRange(entry.value)).map(entry => entry.value));
    }

    let activeRange = {};
    // Keep a lookup only for rows touched by live updates, not a second copy of all history.
    const dailyRows = new Map(), appRows = new Map(), hourlyRows = new Map();
    let liveDay = null;
    const keyOf = (...parts) => JSON.stringify(parts);
    function resetLiveRows() { dailyRows.clear(); appRows.clear(); hourlyRows.clear(); liveDay = null; }
    function prepareDay(day) {
        if (liveDay !== day) { resetLiveRows(); liveDay = day; }
    }

    async function request(method, params = {}) {
        if (!state.available) throw Error(t('后端不可用，无法读取本机流量。'));
        const response = await window.desktop.backend.request(method, params);
        if (!response) throw Error(t('后端没有响应。'));
        if (response.ok) return response.result ?? {};
        const error = Error(response.error?.message || t('后端返回失败。'));
        error.code = response.error?.code || 'unknown';
        throw error;
    }

    // 就地替换字段：页面里保存的是 snapshot 的引用，整体替换会让它变成旧对象。
    function applySnapshot(next) {
        for (const key of Object.keys(snapshot)) delete snapshot[key];
        Object.assign(snapshot, emptySnapshot(), next);
        resetLiveRows();
    }

    function applyUsageEvent(message) {
        // 增量并入本地记录，避免每几秒重新拉取整份历史。
        prepareDay(message.day);
        for (const item of message.networks ?? []) {
            const key = keyOf(message.day, item.networkId);
            let row = dailyRows.get(key) || snapshot.records.find(record => record.date === message.day && record.networkId === item.networkId);
            if (!row) {
                row = { date: message.day, networkId: item.networkId, rxBytes: '0', txBytes: '0' };
                snapshot.records.push(row);
            }
            dailyRows.set(key, row);
            row.rxBytes = (BigInt(row.rxBytes) + BigInt(item.rxBytes ?? '0')).toString();
            row.txBytes = (BigInt(row.txBytes) + BigInt(item.txBytes ?? '0')).toString();
            if (Number.isInteger(message.hour) && message.hour >= 0 && message.hour < 24) {
                const hourKey = keyOf(message.day, message.hour, item.networkId);
                let hour = hourlyRows.get(hourKey) || snapshot.hourly.find(candidate => candidate.date === message.day && candidate.hour === message.hour && candidate.networkId === item.networkId);
                if (!hour) { hour = {date: message.day, hour: message.hour, networkId: item.networkId, rxBytes: '0', txBytes: '0'}; snapshot.hourly.push(hour); }
                hourlyRows.set(hourKey, hour);
                hour.rxBytes = (BigInt(hour.rxBytes) + BigInt(item.rxBytes ?? '0')).toString();
                hour.txBytes = (BigInt(hour.txBytes) + BigInt(item.txBytes ?? '0')).toString();
            }
            // 后端在新网络的第一个增量里带上网络记录：首次见到某个网络时（新装的应用、
            // 换了新 Wi-Fi）快照里还没有它，只并增量的话用量会算不出来，界面显示成
            // “未识别网络”且一直 0，必须重启应用才恢复。
            const network = snapshot.networks.find(candidate => candidate.id === item.networkId);
            if (item.network) {
                // The backend includes the already-committed ledger, including period rollover.
                if (network) Object.assign(network, item.network);
                else snapshot.networks.push(item.network);
            } else if (network?.quotaLedger) {
                const added = BigInt(item.rxBytes ?? '0') + BigInt(item.txBytes ?? '0');
                network.quotaLedger.usedBytes = (BigInt(network.quotaLedger.usedBytes) + added).toString();
            }
        }
    }

    // live/appUsage 只携带受影响组的完整累计值；空 records 表示撤销该组。
    function applyProxyEstimatedUpdates(updates) {
        if (!updates?.length) return;
        const groups = new Map(updates.map(update => [proxyUsageKey(update), update.records]));
        snapshot.proxyEstimatedRecords = snapshot.proxyEstimatedRecords
            .filter(row => !groups.has(proxyUsageKey(row)));
        for (const records of groups.values()) {
            snapshot.proxyEstimatedRecords.push(...records.map(row => ({ ...row })));
        }
    }

    function subscribe() {
        if (state.unsubscribe || !state.available) return;
        state.unsubscribe = window.desktop.backend.onEvent(message => {
            rememberEvent(message);
            if (message.totalQuota) snapshot.totalQuota = message.totalQuota;
            if (message.event === 'live') {
                applyProxyEstimatedUpdates(message.proxyEstimatedUpdates);
                snapshot.live = payloadOf(message);
                snapshot.appCollection = message.appCollection ?? snapshot.appCollection;
                snapshot.proxy = message.proxy ?? snapshot.proxy;
                snapshot.appProcesses = message.appProcesses ?? snapshot.appProcesses;
                handlers.onLive?.();
                return;
            }
            if (message.event === 'appUsage') {
                for (const item of message.records ?? []) {
                    prepareDay(item.date);
                    const key = keyOf(item.date, item.networkId, item.appId);
                    let row = appRows.get(key) || snapshot.appRecords.find(record => record.date === item.date && record.networkId === item.networkId && record.appId === item.appId);
                    if (!row) {
                        row = { ...item, rxBytes: '0', txBytes: '0' };
                        snapshot.appRecords.push(row);
                    }
                    appRows.set(key, row);
                    row.name = item.name;
                    row.rxBytes = (BigInt(row.rxBytes) + BigInt(item.rxBytes)).toString();
                    row.txBytes = (BigInt(row.txBytes) + BigInt(item.txBytes)).toString();
                }
                applyProxyEstimatedUpdates(message.proxyEstimatedUpdates);
                appendCoverageGaps(snapshot.appGaps, message.gaps ?? []);
                (handlers.onAppUsage ?? handlers.onUsage)?.(message);
                return;
            }
            if (message.event === 'usage') {
                applyUsageEvent(message);
                handlers.onUsage?.(message);
                return;
            }
            if (message.event === 'alert') handlers.onAlert?.(payloadOf(message));
        });
    }

    return {
        get snapshot() {
            return snapshot;
        },
        get storageFailed() {
            return state.storageFailed;
        },
        get available() {
            return state.available;
        },
        get ready() {
            return state.ready;
        },

        // 首次加载：问一次后端版本，再取一份快照，然后开始接收事件。
        async start(params = {}) {
            if (!state.available) {
                state.storageFailed = true;
                return snapshot;
            }
            try {
                await request('hello');
                await this.queryRange(params);
                state.ready = true;
                subscribe();
            } catch (error) {
                state.storageFailed = true;
                throw error;
            }
            return snapshot;
        },

        async queryRange(params) {
            const version = ++rangeVersion;
            const pending = { revision: eventRevision, groups: new Map(), fields: new Map() };
            pendingSnapshot = pending;
            try {
                const next = await request('snapshot', params);
                if (version !== rangeVersion) return false;
                activeRange = { ...params };
                applySnapshot(next);
                restorePendingEvents(pending, next, activeRange);
                return true;
            } finally {
                if (pendingSnapshot === pending) pendingSnapshot = null;
            }
        },

        async reload() {
            await this.queryRange(activeRange);
            return snapshot;
        },

        async updateSettings(settings) {
            const result = await request('updateSettings', { settings });
            snapshot.settings = { ...snapshot.settings, ...result.settings };
            // system 是主进程回填的“实际生效结果”：开机启动可能因权限失败。
            return { settings: snapshot.settings, system: result.system };
        },

        async updateProxyConfig(patch) {
            const result = await request('updateProxyConfig', patch);
            if (!result.proxy) throw Error(t('代理配置更新未返回状态。'));
            snapshot.proxy = result.proxy;
            return result.proxy;
        },

        async updateTotalQuota(patch) {
            const result = await request('updateTotalQuota', patch);
            if (!result.totalQuota) throw Error(t('总额度更新未返回状态。'));
            snapshot.totalQuota = result.totalQuota;
            return result.totalQuota;
        },

        async updateNetwork(id, patch) {
            const result = await request('updateNetwork', { key: id, ...patch });
            const index = snapshot.networks.findIndex(network => network.id === id);
            if (result.network && index >= 0) snapshot.networks[index] = result.network;
            return result.network;
        },

        async clearRecords() {
            await request('clearUsage');
            resetLiveRows();
            snapshot.records = [];
            snapshot.hourly = [];
            snapshot.appRecords = [];
            snapshot.proxyEstimatedRecords = [];
            snapshot.appGaps = [];
            snapshot.appProcesses = [];
            snapshot.gaps = [];
            if (snapshot.totalQuota) snapshot.totalQuota.usedBytes = '0';
            for (const network of snapshot.networks) {
                if (network.quotaLedger) network.quotaLedger.usedBytes = '0';
            }
            snapshot.live = { ...snapshot.live, collector: 'paused' };
            if (snapshot.appCollection.enabled) snapshot.appCollection = { ...snapshot.appCollection, state: 'paused' };
        },

        async pause(paused) {
            const result = await request('setPaused', { paused });
            snapshot.live = { ...snapshot.live, collector: result.paused ? 'paused' : 'running' };
            if (snapshot.appCollection.enabled) snapshot.appCollection = { ...snapshot.appCollection, state: result.paused ? 'paused' : 'starting' };
            if (result.paused) snapshot.appProcesses = [];
            return result.paused;
        },

        async setAppCollection(enabled) {
            const result = await request('setAppCollection', { enabled });
            snapshot.appCollection = result.appCollection;
            snapshot.appProcesses = [];
            return result.appCollection;
        },

        async disconnect(interfaceId, ssid) {
            return request('disconnect', { interfaceId, ssid });
        },

        async exportUsage(params) {
            // 与历史页使用同一查询口径，但不替换页面当前快照。
            const result = await request('snapshot', params);
            if (!Array.isArray(result.records)) throw Error(t('导出查询未返回流量记录。'));
            const networks = new Map((result.networks || []).map(network => [network.id, network]));
            return { from: params.from, to: params.to, records: result.records
                .filter(row => row.date >= params.from && row.date <= params.to && (!params.networkKey || row.networkId === params.networkKey))
                .map(row => ({ ...row, ssid: networks.get(row.networkId)?.ssid || '', alias: networks.get(row.networkId)?.alias || '' })) };
        },

        async backup() {
            const result = await request('backup');
            return result.backup;
        },

        async restore(document) {
            const result = await request('restore', { backup: document });
            await this.reload();
            snapshot.live = { ...snapshot.live, collector: 'paused' };
            return result;
        },

        async pruneUsage() {
            return request('pruneUsage');
        },

        stop() {
            state.unsubscribe?.();
            state.unsubscribe = null;
            resetLiveRows();
        }
    };
}
