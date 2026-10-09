import { appendCoverageGaps } from './coverage.js';
import { proxyUsageKey } from './proxy.js';
import { recordInRange } from './history.js';
import { recordTime } from './model.js';
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
    minuteRecordsIncluded: false,
    minuteRecords: [],
    appRecords: [],
    appMinuteRecords: [],
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
const usageRevisionOf = value => /^\d+$/.test(String(value ?? '')) ? BigInt(value) : null;

export function createDataClient(handlers = {}) {
    const snapshot = emptySnapshot();
    const state = { storageFailed: false, available: Boolean(window.desktop?.backend), unsubscribe: null, ready: false };

    let rangeVersion = 0;
    let eventRevision = 0;
    let pendingSnapshot = null;

    // 全量字段直接恢复；字节增量只按后端提交序号恢复，避免重复累计。
    function rememberEvent(message) {
        const revision = ++eventRevision;
        if (!pendingSnapshot) return;
        const updatedAt = Date.parse(message.updatedAt);
        const remember = (map, key, value) => map.set(key, { revision, updatedAt, usageRevision: usageRevisionOf(message.usageRevision), value: structuredClone(value) });
        if (message.event === 'usage' || message.event === 'appUsage') pendingSnapshot.usage.push(structuredClone(message));
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

    function restorePendingEvents(pending, next) {
        const snapshotTime = Date.parse(next.live?.updatedAt);
        const snapshotRevision = usageRevisionOf(next.usageRevision);
        // 提交序号排除快照已包含的采样；没有序号的全量字段按采样时间保留最后值。
        const fresh = entry => entry.revision > pending.revision
            && (snapshotRevision !== null && entry.usageRevision !== null ? entry.usageRevision > snapshotRevision
                : !(Number.isFinite(snapshotTime) && Number.isFinite(entry.updatedAt) && entry.updatedAt < snapshotTime));
        for (const [key, entry] of pending.fields) {
            if (fresh(entry)) snapshot[key] = entry.value;
        }
        const inRange = group => inActiveRange(group);
        applyProxyEstimatedUpdates([...pending.groups.values()]
            .filter(entry => fresh(entry) && inRange(entry.value)).map(entry => entry.value));
        for (const message of pending.usage) {
            const revision = usageRevisionOf(message.usageRevision);
            const updatedAt = Date.parse(message.updatedAt);
            // 旧协议没有序号时，仅能恢复采样时间明确晚于快照的事件。
            const newer = snapshotRevision !== null && revision !== null ? revision > snapshotRevision
                : Number.isFinite(snapshotTime) && Number.isFinite(updatedAt) && updatedAt > snapshotTime;
            if (!newer) continue;
            if (message.event === 'usage') applyUsageEvent(message);
            else applyAppUsageEvent(message);
        }
    }

    let activeRange = {};
    // Keep a lookup only for rows touched by live updates, not a second copy of all history.
    const dailyRows = new Map(), appRows = new Map(), hourlyRows = new Map(), minuteRows = new Map(), appMinuteRows = new Map();
    let liveDay = null;
    const keyOf = (...parts) => JSON.stringify(parts);
    function resetLiveRows() { dailyRows.clear(); appRows.clear(); hourlyRows.clear(); minuteRows.clear(); appMinuteRows.clear(); liveDay = null; }
    function prepareDay(day) {
        if (liveDay !== day) { resetLiveRows(); liveDay = day; }
    }
    function inActiveRange(record) {
        return recordInRange(record, { start: activeRange.from, end: activeRange.to,
            startTime: activeRange.fromTime, endTime: activeRange.toTime, networkId: activeRange.networkKey || 'all' });
    }
    const hasTimeBoundary = () => (activeRange.fromTime != null && activeRange.fromTime !== '00:00')
        || (activeRange.toTime != null && activeRange.toTime !== '23:59');
    function addBytes(row, item) {
        row.rxBytes = (BigInt(row.rxBytes ?? '0') + BigInt(item.rxBytes ?? '0')).toString();
        row.txBytes = (BigInt(row.txBytes ?? '0') + BigInt(item.txBytes ?? '0')).toString();
    }
    function applyMinuteUpdates(items, application = false) {
        const rows = application ? snapshot.appMinuteRecords : snapshot.minuteRecords;
        const lookup = application ? appMinuteRows : minuteRows;
        for (const item of items ?? []) {
            const time = recordTime(item);
            if (!time || !inActiveRange(item)) continue;
            prepareDay(item.date);
            const key = keyOf(item.date, time, item.networkId, application ? item.appId : null);
            let row = lookup.get(key) || rows.find(candidate => candidate.date === item.date && recordTime(candidate) === time
                && candidate.networkId === item.networkId && (!application || candidate.appId === item.appId));
            if (!row) { row = { ...item, time, rxBytes: '0', txBytes: '0' }; rows.push(row); }
            lookup.set(key, row);
            if (application) { row.name = item.name; if (item.path) row.path = item.path; }
            addBytes(row, item);
        }
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
        applyMinuteUpdates(message.minuteRecords);
        // 新采样可能跨小时或午夜，按分钟自己的日期更新汇总；旧协议保留原有精度。
        const deltas = Array.isArray(message.minuteRecords) ? message.minuteRecords.filter(item => recordTime(item) && inActiveRange(item))
            : (message.networks ?? []).map(item => ({ ...item, date: message.day, hour: message.hour })).filter(inActiveRange);
        for (const item of deltas) {
            prepareDay(item.date);
            const key = keyOf(item.date, item.networkId);
            let row = dailyRows.get(key) || snapshot.records.find(record => record.date === item.date && record.networkId === item.networkId);
            if (!row) { row = { date: item.date, networkId: item.networkId, rxBytes: '0', txBytes: '0' }; snapshot.records.push(row); }
            dailyRows.set(key, row); addBytes(row, item);
            const hourNumber = recordTime(item) ? Number(recordTime(item).slice(0, 2)) : item.hour;
            if (Number.isInteger(hourNumber) && hourNumber >= 0 && hourNumber < 24) {
                const hourKey = keyOf(item.date, hourNumber, item.networkId);
                let hour = hourlyRows.get(hourKey) || snapshot.hourly.find(candidate => candidate.date === item.date && candidate.hour === hourNumber && candidate.networkId === item.networkId);
                if (!hour) { hour = {date: item.date, hour: hourNumber, networkId: item.networkId, rxBytes: '0', txBytes: '0'}; snapshot.hourly.push(hour); }
                hourlyRows.set(hourKey, hour); addBytes(hour, item);
            }
        }
        for (const item of message.networks ?? []) {
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

    function applyAppUsageEvent(message) {
        applyMinuteUpdates(message.minuteRecords, true);
        // 局部时间范围的日汇总必须由真实分钟增量构成，不能纳入整日字节数。
        const items = hasTimeBoundary() ? (message.minuteRecords ?? []).filter(inActiveRange) : (message.records ?? []).filter(inActiveRange);
        for (const item of items) {
            prepareDay(item.date);
            const key = keyOf(item.date, item.networkId, item.appId);
            let row = appRows.get(key) || snapshot.appRecords.find(record => record.date === item.date && record.networkId === item.networkId && record.appId === item.appId);
            if (!row) {
                const { time, hour, minute, ...daily } = item;
                row = { ...daily, rxBytes: '0', txBytes: '0' }; snapshot.appRecords.push(row);
            }
            appRows.set(key, row); row.name = item.name; if (item.path) row.path = item.path;
            addBytes(row, item);
        }
    }

    // live/appUsage 只携带受影响组的完整累计值；空 records 表示撤销该组。
    function applyProxyEstimatedUpdates(updates) {
        if (!updates?.length) return;
        const groups = new Map(updates.filter(inActiveRange).map(update => [proxyUsageKey(update), update.records]));
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
                applyAppUsageEvent(message);
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

        // 首次加载先订阅，再查询快照，恢复查询期间在快照之后提交的采样。
        async start(params = {}) {
            if (!state.available) {
                state.storageFailed = true;
                return snapshot;
            }
            try {
                await request('hello');
                subscribe();
                await this.queryRange(params);
                state.ready = true;
            } catch (error) {
                state.storageFailed = true;
                throw error;
            }
            return snapshot;
        },

        async queryRange(params) {
            const version = ++rangeVersion;
            const pending = { revision: eventRevision, groups: new Map(), fields: new Map(), usage: [] };
            pendingSnapshot = pending;
            try {
                const next = await request('snapshot', params);
                if (version !== rangeVersion) return false;
                activeRange = { ...params };
                applySnapshot(next);
                restorePendingEvents(pending, next);
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
            snapshot.minuteRecords = [];
            snapshot.appRecords = [];
            snapshot.appMinuteRecords = [];
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
            const minute = params.grouping === 'minute';
            const hour = params.grouping === 'hour';
            const result = await request(hour ? 'exportUsage' : 'snapshot', minute ? { ...params, includeMinutes: true } : params);
            const records = minute ? result.minuteRecords : result.records;
            if (!Array.isArray(records)) throw Error(t('导出查询未返回流量记录。'));
            const networks = new Map((hour ? snapshot.networks : result.networks || []).map(network => [network.id, network]));
            return { from: params.from, to: params.to, fromTime: params.fromTime, toTime: params.toTime, records: records
                .filter(row => recordInRange(row, { start: params.from, end: params.to, networkId: params.networkKey || 'all',
                    ...(minute ? { startTime: params.fromTime, endTime: params.toTime } : {}) }))
                .map(row => ({ ...row, ssid: row.ssid ?? networks.get(row.networkId)?.ssid ?? '', alias: row.alias ?? networks.get(row.networkId)?.alias ?? '' })) };
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
