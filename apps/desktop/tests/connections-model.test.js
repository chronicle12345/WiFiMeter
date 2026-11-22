import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionModel, connectionCsv } from '../renderer/data/connections.js';

const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

test('late connection searches cannot replace the current query', async () => {
    const first = deferred(), second = deferred(), calls = [];
    const model = createConnectionModel({ api: { read(query) { calls.push(query); return calls.length === 1 ? first.promise : second.promise; } } });
    const old = model.load();
    const latest = model.query({ search: 'example.org', application: 'C:/Browser.exe' });
    second.resolve({ records: [{ id: 'new' }], total: 1 });
    await latest;
    first.resolve({ records: [{ id: 'old' }], total: 4 });
    await old;
    assert.equal(model.state.search, 'example.org');
    assert.equal(model.state.result.records[0].id, 'new');
    assert.equal(calls[1].application, 'c:\\browser.exe');
    model.dispose();
});

test('connection status events reread only the visible workspace and stop after disposal', async () => {
    let handler, reads = 0, stopped = false, active = false;
    const model = createConnectionModel({ api: {
        onStatus(receive) { handler = receive; return () => { stopped = true; }; },
        async read() { reads++; return { records: [], total: 0 }; }
    }, isActive: () => active });
    handler({ state: 'connected', active: 2 });
    await Promise.resolve();
    assert.equal(reads, 0);
    assert.equal(model.state.result.active, 2);
    active = true; handler({ state: 'error', active: 0 });
    await model.load();
    assert.equal(reads, 1);
    model.dispose(); handler({ state: 'connected', active: 3 });
    await Promise.resolve();
    assert.equal(reads, 1);
    assert.equal(stopped, true);
});

test('refresh and configure retain search filters and release busy state on failure', async () => {
    const queries = [];
    const model = createConnectionModel({ api: {
        async read(query) { queries.push(query); return { records: [], total: 0 }; },
        async refresh() { return {}; },
        async configure() { throw Error('Cannot save settings'); }
    } });
    await model.query({ search: 'example', routeFilter: 'direct', stateFilter: 'closed' });
    await model.refresh();
    assert.equal(queries.at(-1).route, 'direct');
    assert.equal(queries.at(-1).state, 'closed');
    await assert.rejects(model.configure({ enabled: true }), /Cannot save/);
    assert.equal(model.state.busy, false);
    assert.equal(model.state.error, 'Cannot save settings');
    model.dispose();
});

test('connection CSV preserves decimal byte counters and escapes spreadsheet formulas', () => {
    const text = connectionCsv([{ id: 'a', host: '=1+1', processPath: 'C:/app.exe', route: 'proxy', chains: ['Node', 'Group'],
        downloadBytes: '9007199254740993', uploadBytes: '12', active: false, endReason: 'disconnected' }], 'en');
    assert.ok(text.startsWith('\uFEFF'));
    assert.ok(text.includes('9007199254740993'));
    assert.ok(text.includes("'=1+1"));
    assert.ok(text.includes('disconnected'));
});

test('a status event invalidates an earlier connection response', async () => {
    const pending = deferred(); let receive, reads = 0;
    const model = createConnectionModel({ api: { onStatus(handler) { receive = handler; },
        read() { return ++reads === 1 ? pending.promise : Promise.resolve({ records: [], state: 'error', total: 0 }); }
    }, isActive: () => true });
    const old = model.load(); await Promise.resolve();
    receive({ state: 'error', active: 0 });
    await model.load(); pending.resolve({ state: 'connected', records: [{ id: 'stale' }] }); await old;
    assert.equal(model.state.result.state, 'error');
    assert.deepEqual(model.state.result.records, []);
    model.dispose();
});

test('interruption statuses immediately stop cached live evidence while a reread is pending', async () => {
    for (const [state, reason] of [['error', 'disconnected'], ['disabled', 'disabled'], ['connecting', 'unobserved']]) {
        const pending = deferred(); let receive, reads = 0;
        const live = { id: 'one', active: true, measurementAvailable: true, uploadRate: 10, downloadRate: 20,
            lastSeen: '2026-11-22T00:00:01Z', end: null, endReason: null };
        const model = createConnectionModel({ api: { onStatus(handler) { receive = handler; }, read() {
            return ++reads === 1 ? Promise.resolve({ enabled: true, state: 'connected', records: [live] }) : pending.promise;
        } }, isActive: () => true });
        try {
            await model.load();
            receive({ state, enabled: state !== 'disabled', active: 0 });
            const record = model.state.result.records[0];
            assert.equal(record.active, false);
            assert.equal(record.measurementAvailable, false);
            assert.equal(record.uploadRate, null);
            assert.equal(record.downloadRate, null);
            assert.equal(record.endReason, reason);
            assert.equal(record.end, null);
            const ended = { ...live, active: false, measurementAvailable: false, uploadRate: null, downloadRate: null,
                endReason: reason, end: '2026-11-22T00:00:02Z' };
            pending.resolve({ state, records: [ended] }); await model.load();
            assert.equal(model.state.result.records[0].end, ended.end);
        } finally { model.dispose(); }
    }
});

test('configuration completion does not reuse a read issued before it committed', async () => {
    const saved = deferred(), oldRead = deferred(); let reads = 0;
    const model = createConnectionModel({ api: { configure: () => saved.promise, read() {
        return ++reads === 1 ? oldRead.promise : Promise.resolve({ records: [], controllerUrl: 'http://127.0.0.1:9091' });
    } } });
    const changing = model.configure({ controllerUrl: 'http://127.0.0.1:9091' });
    const old = model.load(); await Promise.resolve();
    saved.resolve({ controllerUrl: 'http://127.0.0.1:9091' }); await changing;
    oldRead.resolve({ records: [], controllerUrl: 'http://127.0.0.1:9090' }); await old;
    assert.equal(model.state.result.controllerUrl, 'http://127.0.0.1:9091');
    assert.equal(reads, 2); model.dispose();
});

test('a failed configuration keeps its error when an earlier read later succeeds', async () => {
    const saving = deferred(), reading = deferred();
    const model = createConnectionModel({ api: { configure: () => saving.promise, read: () => reading.promise } });
    try {
        const changing = model.configure({ controllerUrl: 'http://127.0.0.1:9091' });
        const oldRead = model.load();
        await Promise.resolve();
        saving.reject(Error('Cannot save settings'));
        await assert.rejects(changing, /Cannot save settings/);
        reading.resolve({ records: [], controllerUrl: 'http://127.0.0.1:9090' });
        await oldRead;
        assert.equal(model.state.error, 'Cannot save settings');
        assert.equal(model.state.busy, false);
    } finally { model.dispose(); }
});

test('connection queries normalize UNC application identities', async () => {
    const queries = [];
    const model = createConnectionModel({ api: { async read(query) { queries.push(query); return { records: [] }; } } });
    try {
        await model.query({ application: '\\\\SERVER\\Apps\\Browser.exe' });
        await model.query({ application: '//server/APPS/browser.exe' });
        assert.deepEqual(queries.map(query => query.application), ['\\\\server\\apps\\browser.exe', '\\\\server\\apps\\browser.exe']);
    } finally { model.dispose(); }
});

test('detail lookup ignores list filters and keeps the visible result unchanged', async () => {
    const queries = [], detail = { id: 'closed', active: false, endReason: 'closed', downloadBytes: '9007199254740993' };
    const visible = { records: [{ id: 'visible' }], total: 2, matched: 1 };
    const model = createConnectionModel({ api: { async read(query) {
        queries.push(query);
        return query.id ? { records: query.id === detail.id ? [detail] : [] } : visible;
    } } });
    try {
        await model.query({ search: 'updater', stateFilter: 'active', routeFilter: 'direct', application: 'C:/updater.exe' });
        assert.deepEqual(await model.lookupRecord('closed'), detail);
        assert.deepEqual(queries.at(-1), { id: 'closed', limit: 1 });
        assert.equal(model.state.result, visible);
        assert.equal(model.state.application, 'c:\\updater.exe');
        assert.equal(await model.lookupRecord('missing'), null);
    } finally { model.dispose(); }
});

test('disposing a connection model discards an outstanding detail lookup', async () => {
    const pending = deferred();
    const model = createConnectionModel({ api: { read: () => pending.promise } });
    const reading = model.lookupRecord('closed');
    model.dispose(); pending.resolve({ records: [{ id: 'closed' }] });
    assert.equal(await reading, null);
});

test('export includes retained matches beyond the table limit with the same filters', async () => {
    const records=Array.from({length:501},(_,index)=>({id:String(index),host:'example.org',downloadBytes:'9007199254740993'}));
    const queries=[];
    const model=createConnectionModel({api:{async read(query){queries.push(query);return {records:records.slice(0,query.limit),matched:501};}}});
    await model.query({search:'example',routeFilter:'proxy',application:'C:/app.exe'});
    assert.equal(model.state.result.records.length,500);
    const exported=await model.exportRecords();
    assert.equal(exported.length,501);
    assert.deepEqual(queries.at(-1),{...queries[0],limit:5000});
    assert.equal(model.state.result.records.length,500);
    model.dispose();
});
