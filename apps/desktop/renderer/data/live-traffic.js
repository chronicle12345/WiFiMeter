const RATE = /^(0|[1-9]\d*)$/;
const byteRate = value => typeof value === 'bigint' && value >= 0n ? value
    : typeof value === 'string' && RATE.test(value) ? BigInt(value) : null;
const intervalMs = seconds => Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000;
const sampleClock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function networkRates(live) {
    const networks = new Map();
    if (live?.collector !== 'running' || live?.state !== 'connected') return networks;
    for (const connection of live.connections || []) {
        if (typeof connection.networkId !== 'string' || typeof connection.interfaceId !== 'string') continue;
        const network = networks.get(connection.networkId) || { rx: 0n, tx: 0n, valid: true, interfaces: [] };
        const rx = byteRate(connection.rxPerSecond), tx = byteRate(connection.txPerSecond);
        network.valid &&= connection.measurementAvailable !== false && rx !== null && tx !== null;
        network.rx += rx ?? 0n;
        network.tx += tx ?? 0n;
        network.interfaces.push(JSON.stringify([connection.interfaceId, connection.since || '']));
        networks.set(connection.networkId, network);
    }
    for (const value of networks.values()) value.identity = JSON.stringify(value.interfaces.sort());
    return networks;
}

function frameValue(frame, networkId) {
    if (networkId !== 'all') return frame.networks.get(networkId) || { rx: 0n, tx: 0n, intervalValid: false };
    const values = [...frame.networks.values()];
    return { rx: values.reduce((sum, value) => sum + value.rx, 0n), tx: values.reduce((sum, value) => sum + value.tx, 0n),
        intervalValid: frame.allIntervalValid && values.length > 0 && values.every(value => value.intervalValid) };
}

// Session-only rate history. Integrals are estimates and never update stored usage or quotas.
export function createLiveTrafficHistory({ windowMs = 300000, maxSamples = 2401 } = {}) {
    if (!Number.isSafeInteger(windowMs) || windowMs < 1 || !Number.isSafeInteger(maxSamples) || maxSamples < 2) throw new RangeError('Invalid live traffic window');
    let frames = [], interrupted = false, suspended = false;
    function observe(live, { intervalSeconds = 5 } = {}) {
        const at = Date.parse(live?.updatedAt), previous = frames.at(-1);
        if (!Number.isFinite(at) || previous && at < previous.at) return false;
        const running = live?.collector === 'running' && live?.state === 'connected';
        if (!running) { interrupted = true; suspended = true; }
        if (previous && at === previous.at) return false;
        const networks = networkRates(live), elapsed = previous ? at - previous.at : 0;
        const uninterrupted = previous && !interrupted && elapsed <= Math.max(1000, intervalMs(intervalSeconds) * 3)
            && Number(live.skippedIntervals || 0) === previous.skippedIntervals;
        for (const [id, value] of networks) {
            const old = previous?.networks.get(id);
            value.intervalValid = Boolean(uninterrupted && value.valid && old?.valid && old.identity === value.identity);
        }
        const allIdentity = JSON.stringify([...networks].map(([id, value]) => [id, value.identity]).sort(([first], [second]) => first.localeCompare(second)));
        const allIntervalValid = Boolean(uninterrupted && previous.allIdentity === allIdentity);
        frames.push({ at, label: sampleClock.format(at), from: previous?.at ?? at, networks, allIdentity, allIntervalValid, skippedIntervals: Number(live.skippedIntervals || 0) });
        if (running) { interrupted = false; suspended = false; }
        const cutoff = at - windowMs;
        let remove = 0;
        while (remove + 1 < frames.length && frames[remove + 1].at < cutoff) remove++;
        remove = Math.max(remove, frames.length - maxSamples);
        if (remove > 0) frames.splice(0, remove);
        return true;
    }
    function rows({ networkId = 'all', now = Date.now(), intervalSeconds = 5 } = {}) {
        const start = now - windowMs;
        const rows = frames.filter(frame => frame.at >= start && frame.at <= now).map(frame => {
            const value = frameValue(frame, networkId);
            const label = frame.label;
            return { key: label, label, at: frame.at, rx: value.rx, tx: value.tx, missing: !value.intervalValid };
        });
        const latest = frames.at(-1);
        if (rows.length && latest && !rows.at(-1).missing && (suspended || now - latest.at > Math.max(1000, intervalMs(intervalSeconds) * 3))) {
            rows.push({ key: '', label: '', at: now, rx: 0n, tx: 0n, missing: true });
        }
        return rows;
    }
    function summary({ networkId = 'all', now = Date.now() } = {}) {
        const start = now - windowMs;
        let rxMilliseconds = 0n, txMilliseconds = 0n, observedMs = 0;
        for (const frame of frames) {
            const value = frameValue(frame, networkId);
            if (!value.intervalValid) continue;
            const elapsed = Math.max(0, Math.min(frame.at, now) - Math.max(frame.from, start));
            rxMilliseconds += value.rx * BigInt(elapsed);
            txMilliseconds += value.tx * BigInt(elapsed);
            observedMs += elapsed;
        }
        const rx = rxMilliseconds / 1000n, tx = txMilliseconds / 1000n;
        return { rx, tx, total: rx + tx, observedMs, estimated: true };
    }
    return { observe, rows, summary, clear() { frames = []; interrupted = false; suspended = false; } };
}
