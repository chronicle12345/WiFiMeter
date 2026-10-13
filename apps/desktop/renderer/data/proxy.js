import { t } from '../i18n.js';

// Windows 应用按完整路径忽略大小写匹配；网络和日期保持精确匹配。
export const proxyUsageKey = (row, appId = row.proxyAppId) =>
    JSON.stringify([row.networkId, row.date, appId.toLowerCase()]);

// Candidate groups still include every client before checking the native byte totals.
function validatedProxyGroups(native, estimates, selectedKeys) {
    const groups = new Map(), scopes = new Map();
    for (const row of estimates) {
        if (row.estimated !== true || !row.proxyAppId) continue;
        const key = proxyUsageKey(row);
        if (selectedKeys && !selectedKeys.has(key)) continue;
        let group = groups.get(key);
        if (!group) {
            group = { rx: 0n, tx: 0n, rows: [], native: null };
            groups.set(key, group);
            let dates = scopes.get(row.networkId);
            if (!dates) { dates = new Map(); scopes.set(row.networkId, dates); }
            let apps = dates.get(row.date);
            if (!apps) { apps = new Map(); dates.set(row.date, apps); }
            apps.set(row.proxyAppId.toLowerCase(), group);
        }
        group.rx += BigInt(row.rxBytes);
        group.tx += BigInt(row.txBytes);
        group.rows.push(row);
    }
    if (!groups.size) return groups;
    for (const row of native) {
        const group = scopes.get(row.networkId)?.get(row.date)?.get(row.appId.toLowerCase());
        if (!group) continue;
        const total = group.native || { rx: 0n, tx: 0n };
        total.rx += BigInt(row.rxBytes); total.tx += BigInt(row.txBytes);
        group.native = total;
    }
    for (const [key, group] of groups) {
        if (!group.native || group.native.rx !== group.rx || group.native.tx !== group.tx) groups.delete(key);
    }
    return groups;
}

export function validatedProxyEstimates(native, estimates = [], include = () => true) {
    const selectedKeys = new Set();
    for (const row of estimates) {
        if (row.estimated === true && row.proxyAppId && include(row)) selectedKeys.add(proxyUsageKey(row));
    }
    if (!selectedKeys.size) return [];
    return [...validatedProxyGroups(native, estimates, selectedKeys).values()].flatMap(group => group.rows.filter(include));
}

// 每组估算必须覆盖原生累计收发字节，事件先后到达时暂时保留原生行。
export function proxyUsageRecords(native, estimates = [], enabled = false) {
    if (!enabled) return native;
    const groups = validatedProxyGroups(native, estimates);
    if (!groups.size) return native;
    return [...native.filter(row => !groups.has(proxyUsageKey(row, row.appId))), ...[...groups.values()].flatMap(group => group.rows)];
}

export function proxyConfigPatch(values) {
    const tokens = String(values.get('ports') || '').split(/[,;，；\s]+/).filter(Boolean);
    if (tokens.some(value => !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) throw Error(t('代理端口须为 1 到 65535 的整数。'));
    const ports = [...new Set(tokens.map(Number))];
    const names = String(values.get('processNames') || '').split(/[,;，；\n]+/).map(value => value.trim()).filter(Boolean);
    const processNames = [...new Map(names.map(name => [name.toLowerCase(), name])).keys()].map(key => names.find(name => name.toLowerCase() === key));
    if (ports.length > 64 || processNames.length > 32 || processNames.some(name => name.length > 64 || /[\x00-\x1f\x7f]/.test(name))) throw Error(t('最多设置 64 个端口、32 个进程名；进程名最长 64 个字符且不能包含控制字符。'));
    return { ports, processNames };
}
