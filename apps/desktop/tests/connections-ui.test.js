import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionsView, connectionList, connectionDetail, connectionSettingsView, connectionApplicationOptions } from '../renderer/ui/connections.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const controls = {
    esc, icon: name => `<svg data-icon="${name}"></svg>`,
    button: (action, label, icon = '', classes = '', extra = '') => `<button class="btn ${classes}" data-action="${action}" ${extra}>${label}</button>`,
    option: (value, label, selected) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`,
    speedLabel: value => value == null ? '—' : `${value} B/s`,
    formatBytes: value => value == null ? '—' : `${value} B`
};
const record = values => ({ id: 'record-1', host: 'example.test', sniffHost: '', destinationIP: '192.0.2.1', destinationPort: 443, sourceIP: '127.0.0.1', sourcePort: 42000,
    network: 'tcp', type: 'Mixed', process: 'browser.exe', processPath: 'C:/Apps/browser.exe', chains: ['node-one', 'group-a'], rule: 'DomainSuffix', rulePayload: 'example.test',
    route: 'proxy', uploadBytes: '20', downloadBytes: '100', uploadRate: 2.5, downloadRate: 10.25, measurementAvailable: true,
    start: '2026-11-22T00:00:00Z', firstSeen: '2026-11-22T00:00:01Z', lastSeen: '2026-11-22T00:00:02Z', end: '', active: true, ...values });
const state = records => ({ available: true, busy: false, error: '', search: '', stateFilter: 'all', routeFilter: 'all', application: 'all',
    result: { enabled: true, controllerUrl: 'http://127.0.0.1:9090', hasSecret: true, intervalMs: 1000, state: 'connected', lastUpdated: '2026-11-22T00:00:02Z',
        total: records.length, active: records.filter(row => row.active).length, matched: records.length, records, applications: [{ key: 'browser', name: 'browser.exe', path: 'C:/Apps/browser.exe' }] } });

test('connection workspace exposes search, route, state and application filters without exporting configuration', () => {
    const html = connectionsView(state([record()]), controls);
    for (const id of ['connectionSearch', 'connectionState', 'connectionRoute', 'connectionApplication', 'connectionListRegion']) assert.ok(html.includes(`id="${id}"`));
    for (const action of ['connection-refresh', 'connection-clear', 'connection-export', 'connection-settings', 'connection-detail']) assert.ok(html.includes(`data-action="${action}"`));
    assert.ok(html.includes('本地 Clash / Mihomo'));
    assert.doesNotMatch(html, /name="secret"/);
});

test('application options distinguish matching filenames by executable path', () => {
    const value = state([]);
    value.result.applications = [
        { key: 'c:\\apps\\browser.exe', name: 'browser.exe', path: 'C:/Apps/browser.exe' },
        { key: 'd:\\apps\\browser.exe', name: 'browser.exe', path: 'D:/Apps/browser.exe' },
    ];
    value.application = 'd:\\apps\\browser.exe';
    const options = connectionApplicationOptions(value, controls);
    assert.match(options, /browser.exe · C:\/Apps\/browser.exe/);
    assert.match(options, /browser.exe · D:\/Apps\/browser.exe/);
    assert.ok(options.includes('value="d:\\apps\\browser.exe" selected'));
    assert.ok(connectionsView(value, controls).includes(options));
});

test('application options preserve a selected application after its observations disappear', () => {
    const value = state([]);
    value.result.applications = [];
    value.application = 'c:\\apps\\<browser>.exe';
    const options = connectionApplicationOptions(value, controls);
    assert.ok(options.includes('value="c:\\apps\\&lt;browser&gt;.exe" selected'));
    assert.match(options, /&lt;browser&gt;.exe/);
    assert.doesNotMatch(options, /<browser>/);
    value.application = '__unknown__';
    assert.match(connectionApplicationOptions(value, controls), /value="__unknown__" selected>未知应用/);
});

test('connection records preserve observed route labels and never present unavailable rates as zero', () => {
    const rows = [record({ route: 'direct', chains: ['DIRECT'] }), record({ id: 'unknown', route: 'unknown', measurementAvailable: false, uploadRate: '0', downloadRate: '0' }), record({ id: 'blocked', route: 'blocked', active: false })];
    const html = connectionList(state(rows), controls);
    assert.match(html, /data-route="direct"/);
    assert.match(html, /data-route="unknown"/);
    assert.match(html, /data-route="blocked"/);
    assert.match(html, /直连/);
    assert.match(html, /已阻止/);
    assert.match(html, /未知/);
    assert.ok(html.includes('10.25 B/s'));
    assert.ok(html.includes('2.5 B/s'));
    const unknown = html.split('<tr data-connection-id="unknown"')[1]?.split('</tr>')[0];
    assert.ok(unknown);
    assert.equal((unknown.match(/>—<[/]td>/g) || []).length, 2);
    assert.ok(!unknown.includes('0 B/s'));
});

test('untrusted domains, process paths, chains and rule payloads are escaped in rows and details', () => {
    const value = record({ id: 'id"<x>', host: '<img src=x onerror=1>', process: '<script>process</script>', processPath: 'C:/<app>', chains: ['<node>'], rulePayload: '<payload>' });
    for (const html of [connectionList(state([value]), controls), connectionDetail(value, controls)]) {
        assert.doesNotMatch(html, /<script>|<img src=x|<node>|<payload>/);
        assert.match(html, /&lt;img src=x onerror=1&gt;/);
        assert.match(html, /&lt;payload&gt;/);
    }
    const detail = connectionDetail(value, controls);
    assert.match(detail, /127.0.0.1:42000/);
    assert.match(detail, /192.0.2.1:443/);
});

test('connection settings keep secrets empty and distinguish monitoring from complete machine capture', () => {
    const value = state([]);
    value.result.secret = 'must-never-appear';
    const html = connectionSettingsView(value, controls);
    for (const name of ['enabled', 'controllerUrl', 'secret', 'intervalMs']) assert.ok(html.includes(`name="${name}"`));
    assert.match(html, /type="password"/);
    assert.match(html, /type="submit"/);
    assert.match(html, /已保存/);
    assert.match(html, /接管的连接/);
    assert.doesNotMatch(html, /must-never-appear/);
    assert.match(connectionSettingsView({ available: false }, controls), /当前环境/);
});

test('empty, disabled and failed monitoring states explain the required action and preserve old evidence', () => {
    const empty = state([]);
    empty.result.enabled = false; empty.result.state = 'disabled';
    assert.match(connectionList(empty, controls), /配置/);
    empty.result.enabled = true; empty.result.state = 'connected';
    assert.match(connectionList(empty, controls), /暂无/);
    const failed = state([record()]); failed.error = '<controller unavailable>';
    const html = connectionList(failed, controls);
    assert.match(html, /role="alert"/);
    assert.match(html, /&lt;controller unavailable&gt;/);
    assert.match(html, /example.test/);
});

test('lost controller observations and disabled monitoring are not presented as closed remote connections', () => {
    for (const endReason of ['disabled', 'disconnected', 'configured', 'unobserved']) {
        const value = record({ active: false, endReason, end: '2026-11-22T00:00:03Z' });
        const rows = connectionList(state([value]), controls), detail = connectionDetail(value, controls);
        assert.match(rows, /观测已中断/);
        assert.doesNotMatch(rows, /已结束/);
        assert.match(detail, /观测结束时间/);
        assert.match(detail, /观测结束原因/);
        assert.doesNotMatch(detail, /<dt>结束时间<[/]dt>/);
    }
    const closed = record({ active: false, endReason: 'closed', end: '2026-11-22T00:00:03Z' });
    assert.match(connectionList(state([closed]), controls), /已结束/);
});
