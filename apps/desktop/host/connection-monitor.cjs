'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { randomUUID } = require('node:crypto');

const MAX_RECORDS = 5000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CONNECTIONS = 20000;
const MAX_COUNTER = 9223372036854775807n;
const DEFAULT_CONFIG = Object.freeze({ enabled: false, controllerUrl: 'http://127.0.0.1:9090', secret: '', intervalMs: 1000 });
const STATES = ['all', 'active', 'closed'];
const ROUTES = ['all', 'direct', 'proxy', 'blocked', 'unknown'];
const copy = value => JSON.parse(JSON.stringify(value));
const text = (value, limit = 1024) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, limit) : '';

function controllerError(code) {
    const error = Error(code);
    error.code = code;
    return error;
}

function normalizeControllerUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw Error('本地控制器地址无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw Error('控制器须使用本机 HTTP 或 HTTPS 地址，不得包含账号、路径或查询参数。');
    }
    // Literal loopback addresses avoid a DNS lookup and cannot resolve to an external host.
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    if (url.hostname !== '[::1]' && !/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname)) {
        throw Error('控制器仅支持本机回环地址。');
    }
    return url.origin;
}

function validateConfig(patch, previous = DEFAULT_CONFIG) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
        || Object.keys(patch).some(key => !['enabled', 'controllerUrl', 'secret', 'intervalMs'].includes(key))) throw Error('连接监测设置无效。');
    const config = { ...previous, ...patch };
    if (typeof config.enabled !== 'boolean' || typeof config.controllerUrl !== 'string' || config.controllerUrl.length > 2048
        || typeof config.secret !== 'string' || config.secret.length > 4096 || /[\x00-\x1f\x7f]/.test(config.secret)
        || !Number.isSafeInteger(config.intervalMs) || config.intervalMs < 250 || config.intervalMs > 60000) throw Error('连接监测设置无效，刷新间隔须为 250 至 60000 毫秒。');
    config.controllerUrl = normalizeControllerUrl(config.controllerUrl);
    return config;
}

// Go emits int64 counters as JSON numbers. Quote only unsafe integer tokens before
// JSON.parse so byte counters survive without changing strings or ordinary numbers.
function parseControllerJson(body) {
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw controllerError('RESPONSE_SIZE');
    let transformed = '', cursor = 0, quoted = false, escaped = false;
    while (cursor < body.length) {
        const character = body[cursor];
        if (quoted) {
            transformed += character; cursor++;
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') quoted = false;
            continue;
        }
        if (character === '"') { quoted = true; transformed += character; cursor++; continue; }
        if (character === '-' || /[0-9]/.test(character)) {
            const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(body.slice(cursor));
            if (!match) throw controllerError('RESPONSE_INVALID');
            const token = match[0];
            // Quoting a number must not repair an unquoted object property name.
            if (/^\s*:/.test(body.slice(cursor + token.length))) throw controllerError('RESPONSE_INVALID');
            transformed += /^-?[0-9]+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token;
            cursor += token.length;
            continue;
        }
        transformed += character; cursor++;
    }
    try { return JSON.parse(transformed); } catch { throw controllerError('RESPONSE_INVALID'); }
}

function decimalCounter(value) {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0) return null;
        return String(value);
    }
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(value)) return null;
    return BigInt(value) <= MAX_COUNTER ? value : null;
}

function port(value) {
    const number = typeof value === 'string' && /^[0-9]{1,5}$/.test(value) ? Number(value) : value;
    return Number.isInteger(number) && number >= 0 && number <= 65535 ? String(number) : '';
}

function connectionRoute(chains, proxyTypes) {
    const terminal = chains[0];
    if (!terminal) return 'unknown';
    const type = proxyTypes?.get(terminal)?.toLowerCase();
    if (type === 'direct') return 'direct';
    if (['reject', 'rejectdrop', 'reject-drop'].includes(type)) return 'blocked';
    if (type) return ['selector', 'urltest', 'fallback', 'loadbalance', 'relay', 'pass', 'compatible'].includes(type) ? 'unknown' : 'proxy';
    if (terminal === 'DIRECT') return 'direct';
    if (['REJECT', 'REJECT-DROP'].includes(terminal)) return 'blocked';
    return 'unknown';
}

function normalizeConnection(value, proxyTypes) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || !value.id || value.id.length > 256) return null;
    const metadata = value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata) ? value.metadata : {};
    const chainEntries = Array.isArray(value.chains) ? value.chains.slice(0, 32).map(chain => text(chain, 256)) : [];
    // Match the original outbound identity; cleaning is only for display.
    const route = chainEntries[0] ? connectionRoute(value.chains, proxyTypes) : 'unknown';
    const chains = chainEntries.filter(Boolean);
    const processPath = text(metadata.processPath, 4096);
    const process = text(metadata.process, 512) || (processPath ? processPath.split(/[\\/]/).at(-1) : '');
    const rawStart = text(value.start, 40);
    return { id: value.id, host: text(metadata.host, 253), sniffHost: text(metadata.sniffHost, 253),
        destinationIP: text(metadata.destinationIP, 64), destinationPort: port(metadata.destinationPort),
        sourceIP: text(metadata.sourceIP, 64), sourcePort: port(metadata.sourcePort),
        network: text(metadata.network, 16), type: text(metadata.type, 64), process, processPath,
        chains, rule: text(value.rule, 256), rulePayload: text(value.rulePayload, 1024), route,
        uploadBytes: decimalCounter(value.upload), downloadBytes: decimalCounter(value.download),
        start: rawStart && Number.isFinite(Date.parse(rawStart)) ? new Date(rawStart).toISOString() : null };
}

function requestController({ url, secret, signal, resource = 'connections', timeoutMs = 5000, maxBytes = MAX_RESPONSE_BYTES }) {
    return new Promise((resolve, reject) => {
        if (!['connections', 'proxies'].includes(resource)) { reject(controllerError('RESPONSE_INVALID')); return; }
        const endpoint = new URL('/' + resource, normalizeControllerUrl(url));
        const transport = endpoint.protocol === 'https:' ? https : http;
        let timer, finished = false;
        const settle = (error, result) => {
            if (finished) return;
            finished = true; clearTimeout(timer);
            if (error) reject(error); else resolve(result);
        };
        const request = transport.request(endpoint, { method: 'GET', signal, agent: false, headers: { Accept: 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) } }, response => {
            if (response.statusCode !== 200) {
                const code = [401, 403].includes(response.statusCode) ? 'AUTHENTICATION' : response.statusCode >= 300 && response.statusCode < 400 ? 'REDIRECT' : 'HTTP_STATUS';
                response.destroy(); settle(controllerError(code)); return;
            }
            let bytes = 0;
            const chunks = [];
            response.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > maxBytes) { response.destroy(); request.destroy(); settle(controllerError('RESPONSE_SIZE')); return; }
                chunks.push(chunk);
            });
            response.on('end', () => {
                try { settle(null, parseControllerJson(Buffer.concat(chunks).toString('utf8'))); }
                catch (error) { settle(error); }
            });
            response.on('error', () => settle(controllerError('CONNECTION')));
        });
        request.on('error', error => settle(error.code === 'ABORT_ERR' ? controllerError('ABORTED') : controllerError('CONNECTION')));
        timer = setTimeout(() => { settle(controllerError('TIMEOUT')); request.destroy(); }, timeoutMs);
        timer.unref?.();
        request.end();
    });
}

function publicError(error) {
    switch (error?.code) {
        case 'AUTHENTICATION': return '控制器认证失败，请检查密钥。';
        case 'TIMEOUT': return '连接本地控制器超时。';
        case 'REDIRECT': return '控制器返回了重定向，请检查本机地址。';
        case 'RESPONSE_SIZE': return '控制器响应超过大小限制。';
        case 'RESPONSE_INVALID': return '控制器返回的连接数据无效。';
        case 'HTTP_STATUS': return '控制器未能提供连接数据。';
        default: return '无法连接本地控制器，请检查代理软件的外部控制设置。';
    }
}

function applicationKey(row) {
    if (row.processPath) return /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(row.processPath) ? row.processPath.replaceAll('/', '\\').toLowerCase() : row.processPath;
    return row.process || '__unknown__';
}

function createConnectionMonitor({ userDataDir, io = fs, now = Date.now, request = requestController,
    setTimer = setTimeout, clearTimer = clearTimeout, onStatus = () => {}, maxRecords = MAX_RECORDS } = {}) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS) throw Error('Invalid connection history limit.');
    const filePath = userDataDir ? path.join(userDataDir, 'connection-monitor.json') : null;
    let config = { ...DEFAULT_CONFIG }, state = 'disabled', error = '', lastUpdated = null;
    let ready, queue = Promise.resolve(), timer = null, flight = null, controller = null, epoch = 0, disposed = false, observation = 0;
    let proxyTypes = new Map();
    const records = new Map();

    function publicState() {
        return { enabled: config.enabled, controllerUrl: config.controllerUrl, hasSecret: Boolean(config.secret), intervalMs: config.intervalMs,
            state, error, lastUpdated, total: records.size, active: [...records.values()].filter(row => row.active).length };
    }

    function emit() { try { onStatus(publicState()); } catch { /* A subscriber cannot stop polling. */ } }
    function cancelTimer() { if (timer !== null) { clearTimer(timer); timer = null; } }
    function schedule(delay = config.intervalMs) {
        cancelTimer();
        if (disposed || !config.enabled) return;
        timer = setTimer(() => { timer = null; refresh().catch(() => {}); }, delay);
        timer?.unref?.();
    }

    function stopObserving(reason, timestamp = now()) {
        for (const row of records.values()) {
            if (!row.active) continue;
            row.active = false; row.end = new Date(timestamp).toISOString(); row.endReason = reason;
            row.uploadRate = null; row.downloadRate = null; row.measurementAvailable = false;
        }
    }

    function ensureLoaded() {
        if (!ready && disposed) ready = Promise.resolve();
        if (!ready) ready = (async () => {
            if (filePath) {
                try {
                    const body = await io.readFile(filePath, 'utf8');
                    if (Buffer.byteLength(body, 'utf8') > 16 * 1024) throw Error('size');
                    config = validateConfig(JSON.parse(body));
                } catch (failure) {
                    if (failure.code !== 'ENOENT') { state = 'error'; error = '连接监测配置无法读取，请重新保存设置。'; return; }
                }
            }
            if (disposed) { config.enabled = false; config.secret = ''; }
            state = config.enabled ? 'connecting' : 'disabled';
            if (config.enabled) schedule(0);
        })();
        return ready;
    }

    function serial(work) {
        const result = queue.then(work); queue = result.catch(() => {}); return result;
    }

    async function save(next) {
        if (!filePath) return;
        const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await io.mkdir(userDataDir, { recursive: true });
            await io.writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await io.rename(temporary, filePath);
        } catch { throw Error('连接监测设置无法保存。'); }
        finally { await io.unlink(temporary).catch(() => {}); }
    }

    function view(query = {}) {
        if (!query || typeof query !== 'object' || Array.isArray(query)) throw Error('连接查询无效。');
        const search = typeof query.search === 'string' ? query.search.slice(0, 1024).toLocaleLowerCase() : '';
        const selectedState = query.state ?? 'all', route = query.route ?? 'all';
        if (!STATES.includes(selectedState) || !ROUTES.includes(route) || (query.application != null && typeof query.application !== 'string')
            || (query.id != null && (typeof query.id !== 'string' || !query.id || query.id.length > 256))) throw Error('连接筛选无效。');
        const selectedApplication = query.application ? applicationKey({ processPath: query.application }) : '';
        const limit = query.limit ?? 500;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORDS) throw Error('连接查询条数无效。');
        const all = [...records.values()].sort((left, right) => right.lastSeen.localeCompare(left.lastSeen) || left.id.localeCompare(right.id));
        const applications = new Map();
        for (const row of all) {
            const key = applicationKey(row);
            if (!applications.has(key)) applications.set(key, { key, name: row.process, path: row.processPath });
        }
        const filtered = all.filter(row => (!query.id || row.id === query.id)
            && (selectedState === 'all' || row.active === (selectedState === 'active'))
            && (route === 'all' || row.route === route)
            && (!selectedApplication || selectedApplication === 'all' || applicationKey(row) === selectedApplication)
            && (!search || [row.host, row.sniffHost, row.destinationIP, row.destinationPort, row.sourceIP, row.sourcePort, row.process, row.processPath, row.rule, row.rulePayload, ...row.chains].join(' ').toLocaleLowerCase().includes(search)));
        const publicRecords = filtered.slice(0, limit).map(({ sampledAt, observation: sampleObservation, ...record }) => record);
        return { ...publicState(), matched: filtered.length, records: copy(publicRecords), applications: [...applications.values()] };
    }

    function applySnapshot(snapshot, timestamp) {
        if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.connections) || snapshot.connections.length > MAX_CONNECTIONS) throw controllerError('RESPONSE_INVALID');
        const connections = [], seen = new Set();
        for (const value of snapshot.connections) {
            const normalized = normalizeConnection(value, proxyTypes);
            if (!normalized) throw controllerError('RESPONSE_INVALID');
            if (seen.has(normalized.id)) throw controllerError('RESPONSE_INVALID');
            seen.add(normalized.id); connections.push(normalized);
        }
        const observedAt = new Date(timestamp).toISOString();
        observation++;
        for (const row of records.values()) {
            if (row.active && !seen.has(row.id)) { row.active = false; row.end = observedAt; row.endReason = 'closed'; row.uploadRate = null; row.downloadRate = null; row.measurementAvailable = false; }
        }
        for (const connection of connections) {
            const previous = records.get(connection.id), elapsed = previous ? timestamp - previous.sampledAt : 0;
            const continuous = previous?.active && previous.observation === observation - 1 && previous.start === connection.start && elapsed > 0;
            const measurable = continuous && connection.uploadBytes !== null && connection.downloadBytes !== null
                && previous.uploadBytes !== null && previous.downloadBytes !== null
                && BigInt(connection.uploadBytes) >= BigInt(previous.uploadBytes) && BigInt(connection.downloadBytes) >= BigInt(previous.downloadBytes);
            records.set(connection.id, { ...connection, active: true, firstSeen: previous?.firstSeen || observedAt, lastSeen: observedAt, end: null, endReason: null,
                uploadRate: measurable ? Number(BigInt(connection.uploadBytes) - BigInt(previous.uploadBytes)) * 1000 / elapsed : null,
                downloadRate: measurable ? Number(BigInt(connection.downloadBytes) - BigInt(previous.downloadBytes)) * 1000 / elapsed : null,
                measurementAvailable: Boolean(measurable), sampledAt: timestamp, observation });
        }
        if (records.size > maxRecords) {
            const candidates = [...records.values()].sort((left, right) => Number(left.active) - Number(right.active) || left.lastSeen.localeCompare(right.lastSeen));
            for (const row of candidates.slice(0, records.size - maxRecords)) records.delete(row.id);
        }
        lastUpdated = observedAt; state = 'connected'; error = '';
    }

    async function refresh() {
        await ensureLoaded();
        if (disposed || !config.enabled) return view();
        if (flight) { await flight; return view(); }
        cancelTimer();
        const generation = epoch, requestConfig = { ...config };
        const abort = new AbortController(); controller = abort;
        flight = (async () => {
            const requestOptions = { url: requestConfig.controllerUrl, secret: requestConfig.secret, signal: abort.signal, timeoutMs: 5000, maxBytes: MAX_RESPONSE_BYTES };
            try {
                // These are supplementary, read-only snapshots. Definitions are
                // reread each time so a controller reload cannot reuse stale types.
                let sampledAt;
                const [snapshot, definitionsResponse] = await Promise.all([
                    request({ ...requestOptions, resource: 'connections' }).then(value => { sampledAt = now(); return value; }),
                    request({ ...requestOptions, resource: 'proxies' }).catch(() => null),
                ]);
                if (generation !== epoch || disposed || !config.enabled) return;
                let definitions = definitionsResponse;
                if (typeof definitions === 'string') { try { definitions = parseControllerJson(definitions); } catch { definitions = null; } }
                const entries = definitions?.proxies && typeof definitions.proxies === 'object' && !Array.isArray(definitions.proxies) ? Object.entries(definitions.proxies) : [];
                // The response and entry limits bound storage without truncating name identities.
                proxyTypes = new Map(entries.slice(0, MAX_CONNECTIONS).filter(([, value]) => typeof value?.type === 'string').map(([name, value]) => [name, value.type.slice(0, 64)]));
                applySnapshot(typeof snapshot === 'string' ? parseControllerJson(snapshot) : snapshot, sampledAt);
            } catch (failure) {
                abort.abort();
                if (generation !== epoch || disposed || !config.enabled) return;
                stopObserving('disconnected'); state = 'error'; error = publicError(failure);
            } finally {
                requestOptions.secret = ''; requestConfig.secret = '';
                if (controller === abort) controller = null;
            }
        })();
        try { await flight; } finally { flight = null; if (!disposed && config.enabled) schedule(generation === epoch ? config.intervalMs : 0); }
        if (generation === epoch) emit();
        return view();
    }

    return {
        status: async () => { await ensureLoaded(); return publicState(); },
        read: async query => { await ensureLoaded(); return view(query); },
        configure: patch => serial(async () => {
            await ensureLoaded();
            if (disposed) throw Error('连接监测已停止。');
            const next = validateConfig(patch, config);
            await save(next);
            if (disposed) { next.secret = ''; throw Error('连接监测已停止。'); }
            epoch++; cancelTimer(); controller?.abort(); stopObserving(next.enabled ? 'configured' : 'disabled');
            proxyTypes = new Map();
            config = next; error = ''; state = config.enabled ? 'connecting' : 'disabled';
            if (config.enabled) schedule(0);
            emit(); return publicState();
        }),
        refresh,
        clear: () => serial(async () => { await ensureLoaded(); epoch++; controller?.abort(); records.clear(); lastUpdated = null; emit(); return view(); }),
        dispose: () => { if (disposed) return; disposed = true; epoch++; cancelTimer(); controller?.abort(); stopObserving('unobserved'); config = { ...config, enabled: false, secret: '' }; proxyTypes.clear(); state = 'disabled'; },
    };
}

module.exports = { createConnectionMonitor, normalizeControllerUrl, parseControllerJson, normalizeConnection, requestController, MAX_RECORDS, MAX_RESPONSE_BYTES };
