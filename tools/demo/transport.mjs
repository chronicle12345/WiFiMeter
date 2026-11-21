// Runs in both Node tests and the browser. Every response comes from this fixture.
export function createDemoTransport(initial) {
    const { snapshot, preferences } = structuredClone(initial);
    const originalProcesses = structuredClone(snapshot.appProcesses);
    const listeners = new Set();
    const emit = (channel, payload) => {
        for (const listener of listeners) listener({ payload: { channel, payload: structuredClone(payload) } });
    };
    return {
        listen(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        request(channel, args = []) {
            const unsupported = detail => { throw Error(`Unsupported demo request: ${detail}`); };
            if (channel === 'window-preferences:read') return structuredClone(preferences);
            if (channel === 'window-preferences:update') {
                const patch = args[0];
                if (Object.keys(patch).some(key => key !== 'theme') || !['light', 'dark'].includes(patch.theme)) return unsupported(channel);
                Object.assign(preferences, patch);
                emit('window-preferences:changed', preferences);
                return structuredClone(preferences);
            }
            if (channel === 'app-control:list') return { ok: true, records: [] };
            if (channel === 'app-icons:get') return null;
            if (channel === 'updates:status') return { state: 'idle', currentVersion: '1.3.7', checkOnStartup: false };
            if (channel !== 'backend:request') return unsupported(channel);
            const { method, params = {} } = args[0];
            if (method === 'hello') return { ok: true, result: { protocol: 1 } };
            if (method !== 'snapshot') return unsupported(method);
            const result = structuredClone(snapshot);
            result.range = { from: params.from || '2026-10-11', to: params.to || '2026-11-21' };
            for (const field of ['records', 'hourly', 'appRecords']) {
                result[field] = result[field].filter(row => row.date >= result.range.from && row.date <= result.range.to);
            }
            return { ok: true, result };
        },
        frame(index) {
            snapshot.appProcesses = originalProcesses.map((row, app) => {
                const wave = 0.76 + 0.24 * Math.sin(index * 0.65 + app * 1.7);
                return { ...row, rxPerSecond: String(Math.round(Number(row.rxPerSecond) * wave)),
                    txPerSecond: String(Math.round(Number(row.txPerSecond) * (1.6 - wave))) };
            });
            const connection = snapshot.live.connections[0];
            for (const field of ['rxPerSecond', 'txPerSecond']) {
                connection[field] = snapshot.appProcesses.reduce((sum, row) => sum + BigInt(row[field]), 0n).toString();
            }
            const live = { ...snapshot.live, appCollection: snapshot.appCollection,
                appProcesses: snapshot.appProcesses, proxy: snapshot.proxy };
            emit('backend:event', { event: 'live', ...live });
            return structuredClone(live);
        }
    };
}
