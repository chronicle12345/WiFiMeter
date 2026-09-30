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
    gaps: [],
    settings: { unit: 'GB', speedUnit: 'MB/s', interval: 5, retention: 90, autoStart: false, minimizeToTray: false, notifications: true },
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

    async function request(method, params = {}) {
        if (!state.available) throw Error('后端不可用，无法读取本机流量。');
        const response = await window.desktop.backend.request(method, params);
        if (!response) throw Error('后端没有响应。');
        if (response.ok) return response.result ?? {};
        const error = Error(response.error?.message || '后端返回失败。');
        error.code = response.error?.code || 'unknown';
        throw error;
    }

    // 就地替换字段：页面里保存的是 snapshot 的引用，整体替换会让它变成旧对象。
    function applySnapshot(next) {
        for (const key of Object.keys(snapshot)) delete snapshot[key];
        Object.assign(snapshot, emptySnapshot(), next);
    }

    function applyUsageEvent(message) {
        // 增量并入本地记录，避免每几秒重新拉取整份历史。
        for (const item of message.networks ?? []) {
            let row = snapshot.records.find(record => record.date === message.day && record.networkId === item.networkId);
            if (!row) {
                row = { date: message.day, networkId: item.networkId, rxBytes: '0', txBytes: '0' };
                snapshot.records.push(row);
            }
            row.rxBytes = (BigInt(row.rxBytes) + BigInt(item.rxBytes ?? '0')).toString();
            row.txBytes = (BigInt(row.txBytes) + BigInt(item.txBytes ?? '0')).toString();
            // 后端在新网络的第一个增量里带上网络记录：首次见到某个网络时（新装的应用、
            // 换了新 Wi-Fi）快照里还没有它，只并增量的话用量会算不出来，界面显示成
            // “未识别网络”且一直 0，必须重启应用才恢复。
            if (item.network && !snapshot.networks.some(candidate => candidate.id === item.network.id))
                snapshot.networks.push(item.network);

            const network = snapshot.networks.find(candidate => candidate.id === item.networkId);
            if (network?.quotaLedger) {
                const added = BigInt(item.rxBytes ?? '0') + BigInt(item.txBytes ?? '0');
                network.quotaLedger.usedBytes = (BigInt(network.quotaLedger.usedBytes) + added).toString();
            }
        }
    }

    function subscribe() {
        if (state.unsubscribe || !state.available) return;
        state.unsubscribe = window.desktop.backend.onEvent(message => {
            if (message.event === 'live') {
                snapshot.live = payloadOf(message);
                handlers.onLive?.();
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
        async start() {
            if (!state.available) {
                state.storageFailed = true;
                return snapshot;
            }
            try {
                await request('hello');
                applySnapshot(await request('snapshot'));
                state.ready = true;
                subscribe();
            } catch (error) {
                state.storageFailed = true;
                throw error;
            }
            return snapshot;
        },

        async reload() {
            applySnapshot(await request('snapshot'));
            return snapshot;
        },

        async updateSettings(settings) {
            const result = await request('updateSettings', { settings });
            snapshot.settings = { ...snapshot.settings, ...result.settings };
            // system 是主进程回填的“实际生效结果”：开机启动可能因权限失败。
            return { settings: snapshot.settings, system: result.system };
        },

        async updateNetwork(id, patch) {
            const result = await request('updateNetwork', { key: id, ...patch });
            const index = snapshot.networks.findIndex(network => network.id === id);
            if (result.network && index >= 0) snapshot.networks[index] = result.network;
            return result.network;
        },

        async clearRecords() {
            await request('clearUsage');
            snapshot.records = [];
            snapshot.hourly = [];
            snapshot.appRecords = [];
            snapshot.gaps = [];
            for (const network of snapshot.networks) {
                if (network.quotaLedger) network.quotaLedger.usedBytes = '0';
            }
            snapshot.live = { ...snapshot.live, collector: 'paused' };
        },

        async pause(paused) {
            const result = await request('setPaused', { paused });
            snapshot.live = { ...snapshot.live, collector: result.paused ? 'paused' : 'running' };
            return result.paused;
        },

        async disconnect(interfaceId, ssid) {
            return request('disconnect', { interfaceId, ssid });
        },

        async exportUsage(params) {
            return request('exportUsage', params);
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
        }
    };
}
