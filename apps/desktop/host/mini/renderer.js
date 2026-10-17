import { applicationBytes, applicationSpeed, liveRates } from './rates.js';
const api = window.miniDesktop;
const upload = document.getElementById('upload');
const download = document.getElementById('download');
const toggle = document.getElementById('apps');
const pin = document.getElementById('pin');
const autoHide = document.getElementById('autoHide');
const proxyFilter = document.getElementById('proxyFilter');
const panel = document.getElementById('appsPanel');
const range = document.getElementById('range');
const liveSource = document.getElementById('liveSource');
const custom = document.getElementById('customMinutes');
const status = document.getElementById('appsStatus');
const errorMessage = document.getElementById('miniError');
const tooltip = document.getElementById('miniTooltip');
const rowsElement = document.getElementById('appRows');
const rows = new Map();
let preferences = { miniExpanded: false, miniPinned: false, miniAutoHide: true, miniExcludeProxy: false,
    miniIncludeProxyEstimates: false, miniRange: '5m', miniCustomMinutes: 15 };
let lastLive = null;
let applicationResult = null;
let applicationRequest = 0;
let tooltipButton = null;

function tooltipText(button) {
    return {
        pin: preferences.miniPinned ? '取消固定：恢复拖动和吸附，按设置自动隐藏。' : '固定位置：禁止拖动、吸附和自动隐藏。',
        autoHide: preferences.miniAutoHide ? '保持显示：靠近左右边缘时不自动隐藏。' : '允许自动隐藏：靠近左右边缘时收起，固定时暂停隐藏。',
        proxyFilter: preferences.miniExcludeProxy ? '显示全部流量：包含代理程序的速度和应用记录。' : '排除代理程序流量：扣除代理程序的速度，隐藏它的应用记录。',
        apps: preferences.miniExpanded ? '收起应用列表：只显示下载和上传速度。' : '展开应用流量：查看各应用的速度和累计流量。',
        open: '打开主窗口：查看流量统计和设置。',
        close: '关闭小窗：WiFiMeter 继续运行。'
    }[button.id];
}

function hideTooltip() {
    tooltipButton?.removeAttribute('aria-describedby');
    tooltipButton = null;
    tooltip.hidden = true;
}

function positionTooltip() {
    if (!tooltipButton || tooltip.hidden) return;
    const button = tooltipButton.getBoundingClientRect();
    const rect = tooltip.getBoundingClientRect();
    const circle = document.body.dataset.shape === 'circle' && !preferences.miniExpanded;
    const center = circle ? innerWidth / 2 : button.left + button.width / 2;
    const left = Math.max(8, Math.min(center - rect.width / 2, innerWidth - rect.width - 8));
    const top = button.top > innerHeight / 2 ? button.top - rect.height - 6 : button.bottom + 6;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(8, Math.min(top, innerHeight - rect.height - 8))}px`;
}

function showTooltip(button) {
    hideTooltip();
    if (document.body.dataset.collapsed === 'true' || document.visibilityState === 'hidden' || button.disabled) return;
    tooltipButton = button;
    tooltip.textContent = tooltipText(button);
    tooltip.hidden = false;
    button.setAttribute('aria-describedby', tooltip.id);
    positionTooltip();
}

for (const button of document.querySelectorAll('nav button')) {
    button.addEventListener('pointerenter', () => showTooltip(button));
    button.addEventListener('pointerleave', hideTooltip);
    button.addEventListener('focus', () => showTooltip(button));
    button.addEventListener('blur', hideTooltip);
    button.addEventListener('pointerdown', hideTooltip);
    button.addEventListener('click', hideTooltip);
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') hideTooltip(); });
window.addEventListener('blur', hideTooltip);
window.addEventListener('resize', positionTooltip);

function renderRate(element, text) {
    const [value, ...unit] = text.split(' ');
    element.querySelector('.rate-number').textContent = value;
    element.querySelector('.rate-unit').textContent = unit.length ? ' ' + unit.join(' ') : '';
}

function showError(error) {
    const message = error?.message || String(error);
    errorMessage.textContent = message;
    errorMessage.hidden = false;
}

function renderLive() {
    const rates = liveRates(lastLive, preferences);
    renderRate(upload, rates.upload);
    renderRate(download, rates.download);
}

function selectedMinutes() {
    return { '1m': 1, '5m': 5, '1h': 60 }[preferences.miniRange] || preferences.miniCustomMinutes;
}

function applyPreferences(value) {
    if (!value) return;
    const previous = preferences;
    preferences = { ...preferences, ...value };
    if (previous.miniShape !== preferences.miniShape || previous.miniExpanded !== preferences.miniExpanded) hideTooltip();
    document.body.dataset.shape = preferences.miniShape || 'bar';
    document.body.dataset.palette = preferences.miniPalette || 'dark';
    document.documentElement.dataset.palette = preferences.miniPalette || 'dark';
    document.body.dataset.expanded = String(preferences.miniExpanded);
    document.body.dataset.pinned = String(preferences.miniPinned);
    panel.hidden = !preferences.miniExpanded;
    toggle.setAttribute('aria-expanded', String(preferences.miniExpanded));
    toggle.setAttribute('aria-label', preferences.miniExpanded ? '收起应用列表' : '展开应用流量');
    pin.setAttribute('aria-pressed', String(preferences.miniPinned));
    pin.setAttribute('aria-label', preferences.miniPinned ? '取消固定' : '固定位置');
    autoHide.setAttribute('aria-pressed', String(!preferences.miniAutoHide));
    autoHide.setAttribute('aria-label', preferences.miniAutoHide ? '保持显示' : '允许自动隐藏');
    proxyFilter.setAttribute('aria-pressed', String(preferences.miniExcludeProxy));
    proxyFilter.setAttribute('aria-label', preferences.miniExcludeProxy ? '显示全部流量' : '排除代理程序流量');
    document.querySelector('.all-traffic-label').textContent = preferences.miniExcludeProxy ? ' · 排除代理' : ' · 全部流量';
    if (document.activeElement !== range) range.value = preferences.miniRange;
    liveSource.value = preferences.miniIncludeProxyEstimates ? 'estimated' : 'native';
    if (document.activeElement !== custom) custom.value = preferences.miniCustomMinutes;
    document.getElementById('customRange').hidden = range.value !== 'custom';
    if (tooltipButton) showTooltip(tooltipButton);
    if (previous.miniRange !== preferences.miniRange || previous.miniCustomMinutes !== preferences.miniCustomMinutes
        || previous.miniExcludeProxy !== preferences.miniExcludeProxy
        || previous.miniIncludeProxyEstimates !== preferences.miniIncludeProxyEstimates) {
        applicationResult = null;
        rowsElement.replaceChildren(); rows.clear();
        document.getElementById('tableWrap').hidden = true;
        status.textContent = '正在读取应用流量'; status.hidden = false;
    }
    if (applicationResult) renderApplications(applicationResult);
    renderLive();
}

function rangeDescription(value) {
    if (!value?.fromTime || !value?.toTime) return '累计为原生分钟记录，正在读取时段';
    const start = value.from === value.to ? value.fromTime : `${value.from} ${value.fromTime}`;
    const end = value.from === value.to ? value.toTime : `${value.to} ${value.toTime}`;
    return `累计为原生分钟记录，含当前分钟 · ${start}–${end}`;
}

function renderApplications(result) {
    if (!result || result.range?.minutes !== selectedMinutes()
        || Boolean(result.miniExcludeProxy) !== preferences.miniExcludeProxy
        || Boolean(result.miniIncludeProxyEstimates) !== preferences.miniIncludeProxyEstimates) return;
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
        cells[0].textContent = (item.name || item.appId) + (item.estimated ? item.unattributed ? ' · 估算未归属' : ' · 估算' : '');
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
for (const [button, key] of [[pin, 'miniPinned'], [autoHide, 'miniAutoHide'], [proxyFilter, 'miniExcludeProxy']]) {
    button.addEventListener('click', async () => {
        button.disabled = true;
        try { await updatePreferences({ [key]: !preferences[key] }); }
        finally { button.disabled = false; }
    });
}
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
liveSource.addEventListener('change', async () => {
    liveSource.disabled = true;
    try { await updatePreferences({ miniIncludeProxyEstimates: liveSource.value === 'estimated' }); }
    finally {
        liveSource.value = preferences.miniIncludeProxyEstimates ? 'estimated' : 'native';
        liveSource.disabled = false;
    }
});
custom.addEventListener('input', () => custom.setCustomValidity(''));
custom.addEventListener('change', () => {
    const minutes = customMinutes();
    if (minutes !== null) updatePreferences({ miniRange: 'custom', miniCustomMinutes: minutes });
});

const subscriptions = [
    api.onLive(event => {
        lastLive = event;
        renderLive();
    }),
    api.onPreferences(applyPreferences),
    api.onState(state => {
        if (state.collapsed) hideTooltip();
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
