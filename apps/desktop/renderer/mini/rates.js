import { formatSpeedParts } from '../data/speed.js';
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
