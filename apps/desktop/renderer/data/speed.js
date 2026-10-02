export function formatSpeedParts(bytes, mode = 'auto') {
    const raw = typeof bytes === 'string' && /^\d+$/.test(bytes) ? Number(bytes) : bytes;
    const fixed = mode === 'MB/s' || mode === 'Mbps';
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return { value: '—', unit: fixed ? mode : 'B/s' };
    if (fixed) return { value: (raw / (mode === 'Mbps' ? 125000 : 1000000)).toFixed(2), unit: mode };
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
    let value = raw, index = 0;
    while (value >= 1000 && index < units.length - 1) { value /= 1000; index++; }
    return { value: value.toFixed(index ? 1 : 0), unit: units[index] };
}
