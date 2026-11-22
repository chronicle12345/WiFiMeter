import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { historyRange } from '../renderer/data/history.js';
import { createLiveTrafficHistory } from '../renderer/data/live-traffic.js';
import { createConnectionModel } from '../renderer/data/connections.js';
import { connectionSettingsView } from '../renderer/ui/connections.js';
import * as trafficChart from '../renderer/ui/traffic-chart.js';
import { updateRegion } from '../renderer/data/render.js';
import { formatSpeedParts } from '../renderer/data/speed.js';

const source = await readFile(new URL('../renderer/app.js', import.meta.url), 'utf8');
const section = (start, end) => {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, 'the actual renderer state and handlers must exist');
    return source.slice(first, last);
};
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
};

// Delayed in-memory IPC drives the actual renderer state and event handlers.
function drawerFixture() {
    const requests = [];
    const ui = { page: 'overview', period: 'recent', start: '2026-11-22', end: '2026-11-22', drawer: null };
    const drawerRoot = { innerHTML: '' };
    const context = vm.createContext({ ui,
        store: { queryRange() { const request = deferred(); requests.push(request); return request.promise; } },
        historyRange, today: () => '2026-11-22', getNetwork: id => ({ id }),
        document: { activeElement: null, getElementById: () => ({ setAttribute() {}, removeAttribute() {} }) },
        $: selector => selector === '#drawerRoot' ? drawerRoot : null,
        appContext: () => ({ appGrouping: 'summary' }), applications: { appView: 'live' },
        renderDrawer() {}, renderMain() {}, setTimeout() {}, ensureMinuteHistory: async () => {}, refreshLive() {},
        connectionModel: { load: async () => {} }, resolveApplicationProxy: { clear() {} }, renderAppList() {},
        settingsCategoryScrollY: null, loadLogs: async () => {}, loadCloud: async () => {},
        history: { replaceState() {} }, location: { pathname: '/', search: '' }, window: { scrollTo() {} }, updateSettingsScroll() {} });
    vm.runInContext(section('let applicationViewVersion=', '\nconst applicationFilterVersions=')
        + section('let rangeRequest=', '\nlet automaticRangeQuery=')
        + section('async function selectRange(', '\nasync function ensureMinuteHistory(')
        + section('async function navigate(', '\nfunction drawerUsage('), context);
    context.syncInert = () => {};
    return { context, requests, ui };
}

function detailFixture() {
    const requests = [], paints = [];
    const ui = { page: 'connections', drawer: { kind: 'connection', record: { id: 'closed', active: true, measurementAvailable: true } } };
    const detailElement = {};
    const context = vm.createContext({ ui,
        connectionModel: { state: { busy: false, result: { records: [], total: 1, matched: 0 } },
            lookupRecord() { const request = deferred(); requests.push(request); return request.promise; } },
        button() {}, esc: String, icon() {}, option() {}, speedLabel: String, fmtWithUnit: String,
        connectionList: () => '', connectionDetail: record => JSON.stringify(record), connectionApplicationOptions: () => '',
        $: selector => selector === '.drawer-content' ? detailElement : null,
        document: { activeElement: null }, window: { getSelection: () => null },
        updateRegion: (element, html) => { if (element === detailElement) paints.push(html); } });
    vm.runInContext(section('const connectionControls=', '\nasync function loadConnections('), context);
    return { context, requests, paints, ui };
}

function preferencesFixture(read) {
    const preferences = { theme: 'system', chartStyle: 'line' };
    const context = vm.createContext({ startingPreferences: preferences, applyTheme() {},
        $: () => null, formAutosaves: { has: () => false }, ui: { page: 'overview', drawer: null },
        renderMain() {}, renderDrawer() {}, refreshLive() {}, fitCharts() {}, liveRender: { schedule() {} },
        window: { desktop: { windowPreferences: { read } } } });
    vm.runInContext(section('let settingsCategory=', '\nif(window.desktop.windowPreferences?.read)')
        + section('let updateStatus = ', '\nfunction markSettingsCategory(')
        + '\nwindowPreferences=startingPreferences;', context);
    return { context, preferences, chartStyle: () => vm.runInContext('windowPreferences.chartStyle', context) };
}

function connectionSettingsFixture() {
    const saving = deferred(), status = { textContent: '' }, controls = { esc: value => String(value ?? '') };
    let config = { enabled: true, controllerUrl: 'http://127.0.0.1:9090', intervalMs: 1000, hasSecret: false }, currentPanel;
    const panel = html => {
        const controller = { name: 'controllerUrl', value: /name="controllerUrl"[^>]*value="([^"]+)"/.exec(html)[1] };
        const elements = [controller];
        elements.namedItem = name => elements.find(input => input.name === name);
        const node = { html, isConnected: false, replaceWith(replacement) {
            if (!this.isConnected) return;
            this.isConnected = false; this.form.isConnected = false;
            currentPanel = replacement; currentPanel.isConnected = true; currentPanel.form.isConnected = true;
        } };
        node.form = { elements, isConnected: false, closest: () => node, error: { textContent: '' } };
        return node;
    };
    const context = vm.createContext({ ui: { page: 'settings', drawer: null },
        FormData: class { constructor(form) { this.values = form.values; } has(key) { return this.values.has(key); } get(key) { return this.values.get(key); } },
        $: (selector, root) => selector === '#connectionMonitorForm' ? currentPanel.form : selector === '#connectionSaveStatus' ? status
            : selector === '.connection-settings' ? currentPanel : selector === '.form-error' ? root?.error || currentPanel.form.error : null,
        document: { activeElement: null, createElement: () => ({ set innerHTML(html) { this.firstElementChild = panel(html); } }) },
        window: { getSelection: () => null }, button() {}, esc: controls.esc, icon() {}, option() {}, speedLabel: String, fmtWithUnit: String,
        connectionList: () => '', connectionDetail: () => '', connectionApplicationOptions: () => '', connectionSettingsView, updateRegion() {}, t: value => value });
    const model = createConnectionModel({ api: {
        async read() { return { ...config, records: [], total: 0, matched: 0 }; },
        async configure(patch) { await saving.promise; config = { ...config, ...patch }; return config; }
    }, onChange: () => context.renderConnectionResults() });
    context.connectionModel = model;
    model.state.result = { ...config, records: [] };
    vm.runInContext(section('const connectionControls=', '\nasync function loadConnections(')
        + section('async function saveConnectionSettings(', '\nfunction openConnectionDetail('), context);
    const replacePage = () => {
        if (currentPanel) { currentPanel.isConnected = false; currentPanel.form.isConnected = false; }
        currentPanel = panel(connectionSettingsView(model.state, controls));
        currentPanel.isConnected = true; currentPanel.form.isConnected = true;
    };
    replacePage();
    return { context, model, saving, status, replacePage, form: () => currentPanel.form };
}

function chartPageFixture(rows, style, unit) {
    const context = vm.createContext({
        ui: { period: 'today', networkId: 'all' },
        data: { settings: { unit, speedUnit: 'auto' }, live: { connections: [] } },
        windowPreferences: { chartStyle: style }, chartSizes: new Map(),
        trafficChartScale: trafficChart.trafficChartScale, trafficChartSvg: trafficChart.trafficChartSvg,
        chartRows: () => rows, getRange: () => ({ start: '2026-11-22', end: '2026-11-22' }),
        periodName: () => 'Today', rangeText: () => '2026-11-22', niceDate: String,
        selectedRows: () => [], totalOf: () => ({ rx: 0n, tx: 0n, total: 0n }), groupedDays: () => [],
        fmtNumber: String, fmtWithUnit: String, button: () => '', icon: () => '', esc: String,
        t: value => value, tr: (parts, ...values) => parts.reduce((result, part, index) => result + part + (values[index] ?? ''), '')
    });
    vm.runInContext(section('function chartUnit(', '\n// 图表')
        + section('function chartSvg(', '\nfunction toast(')
        + section('function trendPanel(', '\nfunction quotaPanel(')
        + section('function drawerUsage(', '\nfunction appMinuteSource('), context);
    return context;
}

function connectionRefreshFixture() {
    const document = { body: {}, documentElement: {}, activeElement: null }, region = {};
    const data = { live: { state: 'connected', collector: 'running', connections: [{ networkId: 'home',
        interfaceId: 'wifi', ssid: 'Home', band: '5 GHz', signal: 70, rxPerSecond: '1000', txPerSecond: '200' }] },
        networks: [{ id: 'home', ssid: 'Home', alias: 'Home' }] };
    let html = '', button = null, rates = {};
    const createButton = id => {
        const node = { dataset: { action: 'detail', id }, isConnected: true,
            focus() { if (this.isConnected) document.activeElement = this; },
            replaceWith(replacement) { this.isConnected = false; replacement.isConnected = true; if (button === this) button = replacement; } };
        return node;
    };
    Object.defineProperty(region, 'innerHTML', { get: () => html, set(value) {
        if (button) { button.isConnected = false; if (document.activeElement === button) document.activeElement = document.body; }
        html = value;
        button = createButton(/data-action="detail" data-id="([^"]+)"/.exec(value)[1]);
        rates = Object.fromEntries(['rx', 'tx', 'rx-unit', 'tx-unit'].map(key => [key,
            { textContent: new RegExp(`data-live-${key}>([^<]*)<`).exec(value)?.[1] ?? '' }]));
    } });
    region.contains = node => node === button && node.isConnected;
    region.querySelectorAll = selector => selector === '[data-action="detail"]' ? [button] : [];
    const context = vm.createContext({ document, data, ui: { page: 'overview', period: 'recent', modal: null, drawer: null },
        renderingHidden: () => false, renderChrome() {}, window: { getSelection: () => null }, updateRegion,
        $: selector => selector === '#overviewConnectionRegion' ? region : selector.startsWith('[data-live-')
            ? rates[selector.slice(11, -1)] : null,
        $$: (selector, root) => root.querySelectorAll(selector),
        getConnection: () => data.live.connections[0], getNetwork: id => data.networks.find(network => network.id === id),
        networkName: network => network.alias || network.ssid, isEthernet: () => false,
        speed: value => formatSpeedParts(value).value, speedUnit: value => formatSpeedParts(value).unit,
        recentMetricCards: () => '', icon: () => '', button: () => '', esc: String,
        t: value => value, tr: (parts, ...values) => parts.reduce((result, part, index) => result + part + (values[index] ?? ''), '')
    });
    vm.runInContext(section('function connectionPanel(', '\nfunction recentMetricCards(')
        + section('function refreshAfterTick(', '\n// 采集由后端进程'), context);
    updateRegion(region, context.connectionPanel());
    button.focus();
    return { context, document, data, region, button: () => button, rate: key => rates[key].textContent };
}

for (const [preference, rx, tx, lineUnit, barUnit] of [
    ['GB', 600000n, 600000n, 'KB', 'MB'],
    ['GiB', 700000n, 700000n, 'KiB', 'MiB']
]) {
    for (const style of ['line', 'bar']) {
        test(`${preference} ${style} chart captions match the axis when directional and combined peaks cross a unit boundary`, () => {
            const rows = [{ key: '10:00', label: '10:00', rx, tx }];
            const context = chartPageFixture(rows, style, preference), expected = style === 'line' ? lineUnit : barUnit;
            const html = context.trendPanel();
            const axis = /<title id="usage-chart-title">[^<]*\(([^)]+)\)<\/title>/.exec(html)?.[1];
            const caption = /<div class="chart-caption"><span>单位：([^<]+)<\/span>/.exec(html)?.[1];
            assert.equal(axis, expected);
            assert.equal(caption, expected);
        });
    }
}

for (const style of ['line', 'bar']) {
    test(`network details use the ${style} chart's upload legend`, () => {
        const context = chartPageFixture([{ key: '10:00', label: '10:00', rx: 600n, tx: 300n }], style, 'GB');
        const html = context.drawerUsage({ id: 'home' });
        const legend = /<div class="legend([^\"]*)">/.exec(html)?.[1];
        assert.ok(legend !== undefined);
        assert.equal(legend.split(/\s+/).includes('traffic-legend'), style === 'line');
        assert.match(html, new RegExp(`traffic-chart-${style}`));
    });
}

test('recent traffic refresh retains the network detail button focus while updating rates and connection status', () => {
    const { context, document, data, region, button, rate } = connectionRefreshFixture();
    const focused = button();
    data.live.connections[0].rxPerSecond = '9000';
    data.live.connections[0].txPerSecond = '3000';
    data.live.connections[0].signal = 85;
    context.refreshAfterTick();
    assert.equal(document.activeElement, focused);
    assert.equal(focused.isConnected, true);
    assert.equal(rate('rx'), '9.0');
    assert.equal(rate('tx'), '3.0');
    assert.match(region.innerHTML, /信号 85%/);

    data.live.collector = 'paused';
    context.refreshAfterTick();
    assert.equal(document.activeElement, focused);
    assert.equal(rate('rx'), '—');
    assert.equal(rate('tx'), '—');
    assert.match(region.innerHTML, /统计已暂停/);
});

test('a late network detail cannot replace the more recently opened drawer', async () => {
    const { context, requests, ui } = drawerFixture();
    const older = context.openDrawer('home');
    const newer = context.openDrawer('work');
    requests[1].resolve(true); await newer;
    assert.equal(ui.drawer.id, 'work');
    requests[0].resolve(true); await older;
    assert.equal(ui.drawer.id, 'work');
});

test('a pending network detail cannot open after navigation completed', async () => {
    const { context, requests, ui } = drawerFixture();
    const opening = context.openDrawer('home');
    await context.doNavigate('settings');
    assert.equal(ui.page, 'settings');
    requests[0].resolve(true); await opening;
    assert.equal(ui.drawer, null);
});

test('a superseded history navigation cannot replace the recent range on a newer page', async () => {
    const { context, requests, ui } = drawerFixture();
    const older = context.doNavigate('apps');
    await context.doNavigate('settings');
    assert.equal(ui.page, 'settings');
    assert.equal(ui.period, 'recent');
    requests[0].resolve(true); await older;
    assert.equal(ui.page, 'settings');
    assert.equal(ui.period, 'recent');
});

test('the recent window expires without waiting for a long native sampling interval', () => {
    const origin = Date.parse('2026-11-22T00:00:00.000Z');
    const live = offset => ({ updatedAt: new Date(origin + offset).toISOString(), state: 'connected', collector: 'running', skippedIntervals: 0,
        connections: [{ networkId: 'home', interfaceId: 'wifi', since: '2026-11-21T00:00:00Z', rxPerSecond: '1000', txPerSecond: '0' }] });
    const history = createLiveTrafficHistory();
    history.observe(live(0), { intervalSeconds: 1 });
    history.observe(live(1000), { intervalSeconds: 1 });
    let clock = origin + 1000, rendered = history.summary({ now: clock }), timer;
    assert.equal(rendered.total, 1000n);
    const context = vm.createContext({ clearInterval() {}, renderingHidden: () => false, params: { get: () => null }, data: { settings: { interval: 3600 } },
        setInterval(callback, delay) { timer = { callback, due: clock + delay }; return 1; },
        refreshLive() { rendered = history.summary({ now: clock }); } });
    vm.runInContext(section('let samplerTimer=', '\nfunction fmtExport(')
        + section('function restartSampler()', '\nconst visibilityChanged='), context);
    context.restartSampler();
    clock += 300001;
    if (timer?.due <= clock) timer.callback();
    assert.equal(rendered.total, 0n);
    assert.equal(rendered.observedMs, 0);
});

test('a delayed preferences read cannot overwrite a newer chart style notification', async () => {
    const read = deferred();
    const { context, preferences, chartStyle } = preferencesFixture(() => read.promise);
    const pending = context.reloadWindowPreferences();
    context.receiveWindowPreferences({ ...preferences, chartStyle: 'bar' });
    assert.equal(chartStyle(), 'bar');
    read.resolve(preferences); await pending;
    assert.equal(chartStyle(), 'bar');
});

test('an older preferences read cannot replace a newer completed read', async () => {
    const reads = [deferred(), deferred()];
    let call = 0;
    const { context, preferences, chartStyle } = preferencesFixture(() => reads[call++].promise);
    const older = context.reloadWindowPreferences();
    const newer = context.reloadWindowPreferences();
    reads[1].resolve({ ...preferences, chartStyle: 'bar' }); await newer;
    assert.equal(chartStyle(), 'bar');
    reads[0].resolve(preferences); await older;
    assert.equal(chartStyle(), 'bar');
});

test('an off-list connection detail can finish while status notifications keep arriving', async () => {
    const { context, requests, paints, ui } = detailFixture();
    const closed = { id: 'closed', active: false, measurementAvailable: false, endReason: 'closed' };
    context.renderConnectionResults();
    for (let index = 0; index < 3; index++) {
        context.renderConnectionResults();
        if (requests[index]) { requests[index].resolve(closed); await Promise.resolve(); }
    }
    assert.equal(ui.drawer.record.active, false);
    assert.equal(ui.drawer.record.endReason, 'closed');
    assert.ok(paints.some(html => JSON.parse(html).endReason === 'closed'));
});

for (const state of ['error', 'disabled']) {
    test(`late off-list connection details cannot restore live rates after ${state}`, async () => {
        const { context, requests, paints, ui } = detailFixture();
        const stale = { id: 'closed', active: true, measurementAvailable: true, downloadRate: 20, uploadRate: 10,
            end: null, endReason: null };
        ui.drawer.record = { ...stale };
        context.connectionModel.state.result = { state: 'connected', enabled: true, records: [], total: 1, active: 1, matched: 0 };
        context.renderConnectionResults();
        assert.equal(requests.length, 1);

        context.connectionModel.state.result = { ...context.connectionModel.state.result, state, enabled: state !== 'disabled', active: 0 };
        context.renderConnectionResults();
        requests[0].resolve(stale);
        await Promise.resolve();

        assert.equal(ui.drawer.record.active, false);
        assert.equal(ui.drawer.record.measurementAvailable, false);
        assert.equal(ui.drawer.record.downloadRate, null);
        assert.equal(ui.drawer.record.uploadRate, null);
        assert.ok(paints.every(html => !JSON.parse(html).active || !JSON.parse(html).measurementAvailable));

        assert.equal(requests.length, 2);
        requests[1].resolve(stale);
        await Promise.resolve();
        assert.equal(ui.drawer.record.active, false);
        assert.equal(ui.drawer.record.measurementAvailable, false);
        assert.equal(ui.drawer.record.downloadRate, null);
        assert.equal(ui.drawer.record.uploadRate, null);
    });
}

test('repeated error notifications share the replacement lookup and keep the old flight invalid', async () => {
    const { context, requests, ui } = detailFixture();
    const stale = { id: 'closed', active: true, measurementAvailable: true, downloadRate: 20, uploadRate: 10,
        end: null, endReason: null };
    ui.drawer.record = { ...stale };
    context.connectionModel.state.result = { state: 'connected', enabled: true, records: [], total: 1, active: 1, matched: 0 };
    context.renderConnectionResults();
    context.connectionModel.state.result = { ...context.connectionModel.state.result, state: 'error', active: 0 };
    context.renderConnectionResults();
    assert.equal(requests.length, 2);
    for (let index = 0; index < 3; index++) context.renderConnectionResults();
    assert.equal(requests.length, 2);

    const ended = { ...stale, active: false, measurementAvailable: false, downloadRate: null, uploadRate: null,
        endReason: 'disconnected', end: '2026-11-22T00:00:02Z' };
    requests[1].resolve(ended);
    await Promise.resolve();
    assert.equal(ui.drawer.record.endReason, 'disconnected');
    requests[0].resolve(stale);
    await Promise.resolve();
    assert.equal(ui.drawer.record.active, false);
    assert.equal(ui.drawer.record.measurementAvailable, false);
    assert.equal(ui.drawer.record.downloadRate, null);
    assert.equal(ui.drawer.record.uploadRate, null);
    assert.equal(ui.drawer.record.endReason, 'disconnected');
});

test('a newer connected snapshot suppresses stale detail rates without replacing the pending lookup', async () => {
    const { context, requests, paints, ui } = detailFixture();
    // The host writes active lastSeen and status lastUpdated from the same snapshot timestamp.
    // T1 and T2 are successive successful host snapshots, without a renderer clock.
    const t1 = '2026-11-22T00:00:01.000Z', t2 = '2026-11-22T00:00:02.000Z';
    const stale = { id: 'closed', active: true, measurementAvailable: true, lastSeen: t1,
        downloadRate: 20, uploadRate: 10, end: null, endReason: null };
    ui.drawer.record = { ...stale };
    context.connectionModel.state.result = { state: 'connected', enabled: true, lastUpdated: t1,
        records: [], total: 2, active: 1, matched: 0 };
    context.renderConnectionResults();
    assert.equal(requests.length, 1);
    const previousPaints = paints.length;

    // The filtered list remains empty; the host still observes another active connection.
    context.connectionModel.state.result = { ...context.connectionModel.state.result, lastUpdated: t2 };
    context.renderConnectionResults();
    const assertUnavailable = () => {
        assert.equal(ui.drawer.record.active, false);
        assert.equal(ui.drawer.record.measurementAvailable, false);
        assert.equal(ui.drawer.record.downloadRate, null);
        assert.equal(ui.drawer.record.uploadRate, null);
        assert.notEqual(ui.drawer.record.endReason, 'closed');
        assert.equal(ui.drawer.record.end, null);
    };
    assertUnavailable();
    assert.ok(paints.length > previousPaints);
    assert.equal(context.connectionModel.state.result.active, 1);
    for (let index = 0; index < 3; index++) context.renderConnectionResults();
    assert.equal(requests.length, 1);

    requests[0].resolve(stale);
    await Promise.resolve();
    assertUnavailable();
    assert.ok(paints.slice(previousPaints).every(html => !JSON.parse(html).measurementAvailable));
});

test('an older connection lookup cannot update a different drawer', async () => {
    const { context, requests, paints, ui } = detailFixture();
    context.renderConnectionResults();
    const newer = { kind: 'connection', record: { id: 'newer', active: true, measurementAvailable: true } };
    ui.drawer = newer;
    requests[0].resolve({ id: 'closed', active: false, measurementAvailable: false, endReason: 'closed' });
    await Promise.resolve();
    assert.equal(ui.drawer, newer);
    assert.equal(ui.drawer.record.id, 'newer');
    assert.deepEqual(paints, []);
});

test('a connection settings save updates the current form after the submitting page was replaced', async () => {
    const { context, model, saving, status, replacePage, form } = connectionSettingsFixture();
    try {
        const submittingForm = form();
        submittingForm.values = new Map([['enabled', 'on'], ['controllerUrl', 'http://127.0.0.1:9091'], ['intervalMs', '250']]);
        const pending = context.saveConnectionSettings(submittingForm);
        replacePage();
        assert.equal(form().elements.namedItem('controllerUrl').value, 'http://127.0.0.1:9090');
        saving.resolve(); await pending;
        assert.equal(model.state.result.controllerUrl, 'http://127.0.0.1:9091');
        assert.equal(form().elements.namedItem('controllerUrl').value, 'http://127.0.0.1:9091');
        assert.ok(status.textContent.length > 0);
    } finally { model.dispose(); }
});

test('a failed connection settings save shows its error in the current form and preserves its fields', async () => {
    const { context, model, saving, replacePage, form } = connectionSettingsFixture();
    try {
        const submittingForm = form();
        submittingForm.values = new Map([['enabled', 'on'], ['controllerUrl', 'http://127.0.0.1:9091'], ['intervalMs', '250']]);
        const pending = context.saveConnectionSettings(submittingForm);
        replacePage();
        const current = form(), controller = current.elements.namedItem('controllerUrl').value;
        saving.reject(Error('Cannot save connection settings'));
        await assert.rejects(pending, /Cannot save connection settings/);
        assert.equal(form(), current);
        assert.equal(current.elements.namedItem('controllerUrl').value, controller);
        assert.equal(current.error.textContent, 'Cannot save connection settings');
        assert.equal(model.state.busy, false);
    } finally { model.dispose(); }
});
