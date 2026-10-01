import { t } from '../i18n.js';

// 只替换有估算结果的代理日期，不推断其他日期或网络的代理用量。
export function proxyUsageRecords(native, estimates = [], enabled = false) {
    if (!enabled) return native;
    const rows = estimates.filter(row => row.estimated === true && row.proxyAppId);
    const key = (row, appId) => JSON.stringify([row.networkId, row.date, appId]);
    const replaced = new Set(rows.map(row => key(row, row.proxyAppId)));
    return [...native.filter(row => !replaced.has(key(row, row.appId))), ...rows];
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
