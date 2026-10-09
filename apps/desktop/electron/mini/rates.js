import { formatSpeedParts } from '../../renderer/data/speed.js';
export function formatSpeed(value, mode = 'auto') {
    const parts = formatSpeedParts(value, mode);
    return parts.value === '—' ? '—' : `${parts.value} ${parts.unit}`;
}

export function liveRates(event) {
    if (event?.collector !== 'running' || event.state !== 'connected' || !event.connections?.length) return { upload: '—', download: '—' };
    const sum = key => event.connections.reduce((total, connection) => {
        const raw = connection[key];
        const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
        return total + (Number.isFinite(value) && value >= 0 ? value : NaN);
    }, 0);
    return { upload: formatSpeed(sum('txPerSecond'), event.speedUnit), download: formatSpeed(sum('rxPerSecond'), event.speedUnit) };
}

export function applicationSpeed(value, available = true) {
    const raw = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    return available && typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
        ? (raw / 1000).toFixed(1) : '—';
}

export function applicationBytes(value) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return '—';
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return '—';
    const bytes = BigInt(value);
    const units = [[1000000000000n, 'TB'], [1000000000n, 'GB'], [1000000n, 'MB'], [1000n, 'KB']];
    const unit = units.find(([size]) => bytes >= size);
    if (!unit) return bytes + ' B';
    const [size, suffix] = unit;
    const tenths = (bytes * 10n + size / 2n) / size;
    return `${tenths / 10n}.${tenths % 10n} ${suffix}`;
}
