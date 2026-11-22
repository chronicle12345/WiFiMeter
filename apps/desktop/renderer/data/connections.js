import { csvCell } from './history.js';

// 查询状态独立于页面 DOM；过期查询不能覆盖用户刚选择的筛选。
export function createConnectionModel({ api, onChange = () => {}, isActive = () => false } = {}) {
    const state = { available: !!api, busy: false, error: '', search: '', stateFilter: 'all',
        routeFilter: 'all', application: 'all', result: null };
    let revision = 0, disposed = false;
    const flights = new Map();
    const notify = () => { if (!disposed) onChange(state); };
    const queryInput = () => ({ search: state.search, state: state.stateFilter, route: state.routeFilter,
        application: state.application, limit: 500 });

    function applyStatus(status) {
        const result = { ...state.result, ...status };
        const reason = { error: 'disconnected', disabled: 'disabled', connecting: 'unobserved' }[result.state];
        if (reason && result.records) {
            result.records = result.records.map(record => record.active ? { ...record, active: false,
                measurementAvailable: false, uploadRate: null, downloadRate: null, end: null, endReason: reason } : record);
        }
        state.result = result;
    }

    function load() {
        if (!api || disposed) return Promise.resolve();
        const input = queryInput(), current = revision, key = `${current}:${JSON.stringify(input)}`;
        if (flights.has(key)) return flights.get(key);
        const flight = Promise.resolve().then(() => api.read(input)).then(result => {
            if (disposed || current !== revision) return;
            state.result = result; state.error = ''; notify();
        }, error => {
            if (!disposed && current === revision) { state.error = error.message; notify(); }
        }).finally(() => { if (flights.get(key) === flight) flights.delete(key); });
        flights.set(key, flight);
        return flight;
    }

    async function mutate(action, input) {
        if (!api || disposed || state.busy) return;
        state.busy = true; state.error = ''; notify();
        revision++;
        try {
            const result = await api[action](input);
            if (disposed) return;
            revision++;
            if (result) applyStatus(result);
            await load();
            return result;
        } catch (error) {
            if (!disposed) { revision++; state.error = error.message; }
            throw error;
        }
        finally { state.busy = false; notify(); }
    }

    const stop = api?.onStatus?.(status => {
        if (disposed) return;
        revision++;
        applyStatus(status);
        notify();
        if (isActive() && !state.busy) load();
    });
    return { state, load,
        query(patch) {
            if (typeof patch.application === 'string' && /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(patch.application)) {
                patch = { ...patch, application: patch.application.replaceAll('/', '\\').toLowerCase() };
            }
            Object.assign(state, patch); revision++; return load();
        },
        refresh: () => mutate('refresh'),
        async exportRecords() {
            if (!api || disposed) return [];
            const result = await api.read({ ...queryInput(), limit: 5000 });
            return result.records || [];
        },
        async lookupRecord(id) {
            if (!api || disposed) return null;
            const result = await api.read({ id, limit: 1 });
            return disposed ? null : result.records?.find(record => record.id === id) || null;
        },
        configure: patch => mutate('configure', patch),
        clear: () => mutate('clear'),
        dispose() { if (disposed) return; disposed = true; revision++; stop?.(); flights.clear(); }
    };
}

export function connectionCsv(records, language = 'zh-CN') {
    const header = language === 'en'
        ? ['Domain', 'Destination IP', 'Port', 'Application', 'Application path', 'Protocol', 'Route', 'Proxy chain', 'Rule', 'Rule payload', 'Download bytes', 'Upload bytes', 'Started', 'Last observed', 'Active', 'End reason']
        : ['域名', '目标 IP', '端口', '应用', '应用路径', '协议', '连接去向', '代理链', '规则', '规则内容', '下载字节', '上传字节', '开始时间', '最后观测', '活跃', '结束原因'];
    const rows = records.map(row => [row.host || row.sniffHost, row.destinationIP, row.destinationPort,
        row.process, row.processPath, row.network, row.route, row.chains?.join(' → '), row.rule, row.rulePayload,
        row.downloadBytes, row.uploadBytes, row.start, row.lastSeen, row.active, row.endReason]);
    return '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
}
