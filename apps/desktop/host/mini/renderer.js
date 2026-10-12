import { applicationBytes, applicationSpeed, liveRates } from './rates.js';
const api = window.miniDesktop;
const upload = document.getElementById('upload');
const download = document.getElementById('download');
const toggle = document.getElementById('apps');
const panel = document.getElementById('appsPanel');
const range = document.getElementById('range');
const custom = document.getElementById('customMinutes');
const status = document.getElementById('appsStatus');
const errorMessage = document.getElementById('miniError');
const rowsElement = document.getElementById('appRows');
const rows = new Map();
let preferences = { miniExpanded: false, miniRange: '1m', miniCustomMinutes: 5 };
let applicationResult = null;
let applicationRequest = 0;

function renderRate(element, text) {
    const [value, ...unit] = text.split(' ');
    element.querySelector('.rate-number').textContent = value;
    element.querySelector('.rate-unit').textContent = unit.length ? ' ' + unit.join(' ') : '';
}

function showError(error) {
    const message = error?.message || String(error);
    errorMessage.textContent = message;
    errorMessage.hidden = false;
    if (!preferences.miniExpanded) toggle.title = `无法展开应用流量：${message}`;
}

function selectedMinutes() {
    return { '1m': 1, '5m': 5, '1h': 60 }[preferences.miniRange] || preferences.miniCustomMinutes;
}

function applyPreferences(value) {
    if (!value) return;
    preferences = { ...preferences, ...value };
    document.body.dataset.shape = preferences.miniShape || 'bar';
    document.body.dataset.palette = preferences.miniPalette || 'dark';
    document.documentElement.dataset.palette = preferences.miniPalette || 'dark';
    document.body.dataset.expanded = String(preferences.miniExpanded);
    panel.hidden = !preferences.miniExpanded;
    toggle.setAttribute('aria-expanded', String(preferences.miniExpanded));
    toggle.title = preferences.miniExpanded ? '收起应用列表' : '展开应用流量';
    toggle.setAttribute('aria-label', toggle.title);
    if (document.activeElement !== range) range.value = preferences.miniRange;
    if (document.activeElement !== custom) custom.value = preferences.miniCustomMinutes;
    document.getElementById('customRange').hidden = range.value !== 'custom';
    if (applicationResult) renderApplications(applicationResult);
}

function rangeDescription(value) {
    if (!value?.fromTime || !value?.toTime) return '按分钟汇总，正在读取时段';
    const start = value.from === value.to ? value.fromTime : `${value.from} ${value.fromTime}`;
    const end = value.from === value.to ? value.toTime : `${value.to} ${value.toTime}`;
    return `按分钟汇总，含当前分钟 · ${start}–${end}`;
}

function renderApplications(result) {
    if (!result || result.range?.minutes !== selectedMinutes()) return;
    applicationResult = result;
    const items = Array.isArray(result.rows) ? result.rows : [];
    document.getElementById('rangeSummary').textContent = rangeDescription(result.range);
    const disabled = result.status === 'disabled';
    const unavailable = !['running', 'partial', 'disabled'].includes(result.status);
    const message = disabled ? '应用采集尚未启用。启用后可查看各应用流量。'
        : unavailable ? '应用采集当前不可用。已有累计记录仍可查看，实时速度显示为 —。'
            : !items.length ? '这个时段尚无应用流量记录。' : '';
    status.textContent = result.detail ? [message, result.detail].filter(Boolean).join(' ') : message;
    status.hidden = !status.textContent;
    document.getElementById('enableCollection').hidden = !disabled;
    document.getElementById('tableWrap').hidden = !items.length;
    const retained = new Set();
    const scroll = document.getElementById('tableWrap').scrollTop;
    for (const item of items) {
        if (typeof item.appId !== 'string') continue;
        retained.add(item.appId);
        let row = rows.get(item.appId);
        if (!row) {
            row = document.createElement('tr');
            for (let i = 0; i < 5; i++) row.append(document.createElement('td'));
            rows.set(item.appId, row);
        }
        const cells = row.children;
        cells[0].textContent = item.name || item.appId;
        cells[0].title = item.name || item.appId;
        cells[1].textContent = applicationSpeed(item.rxPerSecond, item.measurementAvailable !== false);
        cells[2].textContent = applicationSpeed(item.txPerSecond, item.measurementAvailable !== false);
        cells[3].textContent = applicationBytes(item.rxBytes);
        cells[4].textContent = applicationBytes(item.txBytes);
        rowsElement.append(row);
    }
    for (const [id, row] of rows) if (!retained.has(id)) { row.remove(); rows.delete(id); }
    document.getElementById('tableWrap').scrollTop = scroll;
}

async function refreshApplications() {
    if (!api.applications) return;
    const request = ++applicationRequest;
    try {
        const result = await api.applications();
        if (request === applicationRequest) renderApplications(result);
    } catch (error) { if (request === applicationRequest) showError(error); }
}

async function updatePreferences(patch) {
    errorMessage.hidden = true;
    try {
        applyPreferences(await api.preferences.update(patch));
        if (preferences.miniExpanded) await refreshApplications();
    } catch (error) { showError(error); }
}

function customMinutes() {
    const minutes = Number(custom.value);
    const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 10080;
    custom.setCustomValidity(valid ? '' : '请输入 1 到 10080 的整数分钟数，最长 7 天。');
    if (!valid) { custom.reportValidity(); return null; }
    return minutes;
}

toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try { await updatePreferences({ miniExpanded: !preferences.miniExpanded }); }
    finally { toggle.disabled = false; }
});
range.addEventListener('change', () => {
    document.getElementById('customRange').hidden = range.value !== 'custom';
    const patch = { miniRange: range.value };
    if (range.value === 'custom') {
        const minutes = customMinutes();
        if (minutes === null) return;
        patch.miniCustomMinutes = minutes;
    }
    updatePreferences(patch);
});
custom.addEventListener('input', () => custom.setCustomValidity(''));
custom.addEventListener('change', () => {
    const minutes = customMinutes();
    if (minutes !== null) updatePreferences({ miniRange: 'custom', miniCustomMinutes: minutes });
});

const subscriptions = [
    api.onLive(event => {
        const rates = liveRates(event);
        renderRate(upload, rates.upload);
        renderRate(download, rates.download);
    }),
    api.onPreferences(applyPreferences),
    api.onState(state => {
        document.body.dataset.collapsed = String(state.collapsed);
        document.body.dataset.edge = state.edge || '';
        document.querySelector('main').inert = state.collapsed;
    }),
    ...(api.onApplications ? [api.onApplications(renderApplications)] : [])
];
document.getElementById('open').addEventListener('click', () => api.openMain().catch(showError));
document.getElementById('close').addEventListener('click', () => api.close().catch(showError));
document.getElementById('enableCollection').addEventListener('click', () => api.openMain().catch(showError));
if (api.preferences) api.preferences.read().then(value => { applyPreferences(value); return refreshApplications(); }).catch(showError);
window.addEventListener('unload', () => subscriptions.forEach(unsubscribe => unsubscribe()), { once: true });
