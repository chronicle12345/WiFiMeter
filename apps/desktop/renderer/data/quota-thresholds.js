import { t } from '../i18n.js';
export function parseWarnPercents(raw) {
    const tokens = String(raw ?? '').split(/[,;，；\s]+/).filter(Boolean);
    const values = tokens.map(Number);
    if (!values.length || values.length > 100 || values.some(n => !Number.isFinite(n) || n < 1 || n > 100)) throw Error(t('提醒阈值须为 1 到 100，多个值用逗号分隔。'));
    return [...new Set(values)].sort((a, b) => a - b);
}
export function quotaThresholds(quota) { return quota.warnPercents?.length ? quota.warnPercents : [quota.warnPercent ?? 80]; }
