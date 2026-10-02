import { t } from '../i18n.js';

// Windows 应用按完整路径忽略大小写匹配；网络和日期保持精确匹配。
export const proxyUsageKey = (row, appId = row.proxyAppId) =>
    JSON.stringify([row.networkId, row.date, appId.toLowerCase()]);

// 每组估算必须覆盖原生累计收发字节，事件先后到达时暂时保留原生行。
export function proxyUsageRecords(native, estimates = [], enabled = false) {
    if (!enabled) return native;
    const totals = new Map();
    for (const row of native) {
        const key = proxyUsageKey(row, row.appId);
        const total = totals.get(key) || { rx: 0n, tx: 0n };
        total.rx += BigInt(row.rxBytes);
        total.tx += BigInt(row.txBytes);
        totals.set(key, total);
    }
    const groups = new Map();
    for (const row of estimates) {
        if (row.estimated !== true || !row.proxyAppId) continue;
        const key = proxyUsageKey(row);
        const group = groups.get(key) || { rx: 0n, tx: 0n, rows: [] };
        group.rx += BigInt(row.rxBytes);
        group.tx += BigInt(row.txBytes);
        group.rows.push(row);
        groups.set(key, group);
    }
    const replaced = new Set();
    const rows = [];
    for (const [key, group] of groups) {
        const total = totals.get(key);
        if (total && total.rx === group.rx && total.tx === group.tx) {
            replaced.add(key);
            rows.push(...group.rows);
        }
    }
    return [...native.filter(row => !replaced.has(proxyUsageKey(row, row.appId))), ...rows];
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
