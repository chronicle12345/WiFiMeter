import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationTable } from '../renderer/ui/application-table.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const helpers = { esc, formatValue: (value, mode) => value == null ? '—' : `${value} ${mode === 'live' ? 'B/s' : 'B'}`, networkLabel: id => `Network ${id}` };
const usage = extra => ({ key: 'usage', id: 'C:\\Apps\\Browser.exe', name: 'Browser', date: '', rx: 3n, tx: 1n, total: 4n, ...extra });

test('one application table renders the same five metric columns for live and usage rows', () => {
    const live = applicationTable([{ appId: 'C:\\Apps\\Browser.exe', name: 'Browser', key: 'live', networkId: 'home', scope: 'wifi', processIds: [42, 43], measurementAvailable: true, rxPerSecond: '3', txPerSecond: '1', totalPerSecond: '4' }], { mode: 'live' }, helpers);
    const history = applicationTable([usage()], { mode: 'usage', grouping: 'summary', sum: 8n }, helpers);
    for (const html of [live, history]) {
        assert.equal((html.match(/<th\b/g) || []).length, 5);
        assert.equal((html.match(/<td\b/g) || []).length, 5);
        assert.match(html, /class="application-table"/);
        assert.match(html, /class="application-table-row/);
    }
    assert.match(live, /data-action="select-live-app"[^>]*data-live-key="live"/);
    assert.match(live, /Network home/);
    assert.match(live, /PID 42, 43/);
    assert.match(live, /实测/);
    assert.match(history, /data-action="select-app"[^>]*data-key="usage"/);
    assert.match(history, /50\.0%/);
    assert.match(history, /class="application-row-share"/);
    assert.doesNotMatch(live, /app-history-sort/);
    assert.doesNotMatch(history, /app-history-sort/);
});

test('grouped usage preserves row identity, sorting state, provenance and dates', () => {
    const html = applicationTable([usage({ date: '2026-10', estimated: true, unattributed: true })], { mode: 'usage', grouping: 'month', sort: 'rx', direction: 'asc', selectedKey: 'usage', startIndex: 50 }, helpers);
    assert.match(html, /data-action="select-app-row"[^>]*data-key="usage"/);
    assert.match(html, /data-app-row="usage"/);
    assert.match(html, /selected-row/);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /月份/);
    assert.match(html, /2026-10/);
    assert.match(html, /估算 · 未归属/);
    assert.equal((html.match(/data-action="app-history-sort"/g) || []).length, 5);
    assert.match(html, /aria-sort="ascending"><button[^>]*data-key="rx"/);
    assert.doesNotMatch(html, /application-row-share/);
});

test('unknown live measurements remain unavailable and application buttons contain only avatar and name', () => {
    const row = { key: 'loop', appId: 'client', name: 'Client', networkId: '', scope: 'loopback', processIds: [42], measurementAvailable: false, rxPerSecond: null, txPerSecond: null, totalPerSecond: null };
    const html = applicationTable([row], { mode: 'live', startIndex: 10 }, helpers);
    assert.equal((html.match(/>—<\/td>/g) || []).length, 3);
    assert.match(html, /本地 TCP/);
    assert.match(html, /不可测/);
    assert.match(html, /application-row-rank">11<\/td>/);
    const button = html.match(/<button class="network-name application-name"[^>]*>(.*?)<\/button>/s)[1];
    assert.match(button, /aria-hidden="true"/);
    assert.match(button, /application-name-text">Client/);
    assert.doesNotMatch(button, /PID|TCP|不可测/);
});

test('table keeps large usage values as BigInt and escapes all dynamic display values', () => {
    const received = [];
    const html = applicationTable([usage({ key: '<key>', id: 'C:\\<Apps>\\Browser.exe', name: '<script>App</script>', rx: 9007199254740993n, tx: 1n, total: 9007199254740994n })], { mode: 'usage', grouping: 'summary', sum: 9007199254740994n }, { ...helpers, formatValue: value => { received.push(value); return `${value}<bytes>`; } });
    assert.deepEqual(received, [9007199254740993n, 1n, 9007199254740994n]);
    assert.match(html, /9007199254740993&lt;bytes&gt;/);
    assert.match(html, /100\.0%/);
    assert.match(html, /&lt;script&gt;App&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>|<bytes>/);
    assert.match(html, /data-key="&lt;key&gt;"/);
});

test('zero history totals retain an unavailable share instead of an invented percentage', () => {
    const html = applicationTable([usage({ rx: 0n, tx: 0n, total: 0n })], { mode: 'usage', grouping: 'summary', sum: 0n }, helpers);
    assert.match(html, /class="application-share-label">—<\/span>/);
    assert.doesNotMatch(html, /application-row-share|0\.0%/);
});
