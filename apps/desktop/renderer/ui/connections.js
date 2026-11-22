import { getLocale, t, tr } from '../i18n.js';

const routes = { direct: ['直连', 'gray'], proxy: ['代理', ''], blocked: ['已阻止', 'red'], unknown: ['未知', 'warn'] };
const monitorStates = { disabled: ['未启用', 'gray'], connecting: ['正在连接', 'warn'], connected: ['正在监听', ''], error: ['连接失败', 'red'] };
const endReasons = { closed: '连接已关闭', disabled: '监听已禁用', disconnected: '控制连接中断', configured: '监听设置已更改', unobserved: '停止观测' };
const recordState = record => record.active ? t('活动') : record.endReason === 'closed' ? t('已结束') : t('观测已中断');
const validBytes = value => typeof value === 'bigint' && value >= 0n || typeof value === 'string' && /^\d+$/.test(value);
const bytesText = (value, controls) => validBytes(value) ? controls.formatBytes(value) : '—';
const rateText = (record, field, controls) => {
    const value = record[field], available = typeof value === 'number' ? Number.isFinite(value) && value >= 0 : validBytes(value);
    return record.active && record.measurementAvailable && available ? controls.speedLabel(value) : '—';
};
const applicationName = record => record.process || record.processPath?.split(/[\\/]/).at(-1) || t('未知应用');
const endpoint = (address, port) => address ? `${address.includes(':') ? '[' + address + ']' : address}${port ? ':' + port : ''}` : '—';
const timestamp = value => {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toLocaleString(getLocale(), { hour12: false }) : '—';
};

function routeBadge(record, esc) {
    const route = Object.hasOwn(routes, record.route) ? record.route : 'unknown', [label, tone] = routes[route];
    return `<span class="pill ${tone}" data-route="${route}">${esc(t(label))}</span>`;
}

function ruleText(record) {
    return record.rule ? `${record.rule}${record.rulePayload ? ' · ' + record.rulePayload : ''}` : '—';
}

function monitorSummary(state, { esc }) {
    const result = state.result || {}, [label, tone] = monitorStates[result.state] || monitorStates.disabled;
    const error = state.error || result.error;
    return tr`<div class="connection-monitor-summary" role="status"><span class="pill ${tone}">${t(label)}</span>
        <span>活动连接 ${esc(result.active ?? 0)} · 已记录 ${esc(result.total ?? 0)}</span>
        ${result.lastUpdated ? tr`<span class="connection-last-update">最近更新 ${esc(timestamp(result.lastUpdated))}</span>` : ''}</div>
        ${error ? `<p class="connection-monitor-error form-error" role="alert">${esc(t(error))}</p>` : ''}`;
}

function connectionRow(record, controls) {
    const { button, esc } = controls;
    const target = record.host || record.sniffHost || record.destinationIP || t('未知目标');
    const destination = endpoint(record.destinationIP, record.destinationPort);
    const chain = Array.isArray(record.chains) && record.chains.length ? record.chains.join(' → ') : '—';
    return `<tr data-connection-id="${esc(record.id)}">
        <td class="connection-target">${button('connection-detail', esc(target), '', 'connection-target-button', `type="button" data-id="${esc(record.id)}"`)}
        <div class="connection-cell-secondary" title="${esc(destination)}">${esc(destination)} · ${esc((record.network || '').toUpperCase())}</div></td>
        <td class="connection-application"><span class="connection-cell-main" title="${esc(record.processPath || '')}">${esc(applicationName(record))}</span><div class="connection-cell-secondary" title="${esc(record.processPath || '')}">${esc(record.processPath || t('未提供进程路径'))}</div></td>
        <td class="connection-route">${routeBadge(record, esc)}<div class="connection-cell-secondary" title="${esc(chain)}">${esc(chain)}</div><div class="connection-cell-secondary" title="${esc(ruleText(record))}">${esc(ruleText(record))}</div></td>
        <td class="right num">${esc(rateText(record, 'downloadRate', controls))}</td><td class="right num">${esc(rateText(record, 'uploadRate', controls))}</td>
        <td class="right num connection-bytes"><span>${esc(bytesText(record.downloadBytes, controls))}</span><span class="connection-cell-secondary">${esc(bytesText(record.uploadBytes, controls))}</span></td>
        <td><span class="pill ${record.active ? '' : 'gray'}">${recordState(record)}</span></td></tr>`;
}

// Updating this region keeps the search input and filter controls in place.
export function connectionList(state, controls) {
    const result = state.result || {}, records = result.records || [], { esc } = controls;
    const summary = monitorSummary(state, controls);
    if (!records.length) {
        const disabled = !result.enabled;
        const filtering = Boolean(state.search || state.stateFilter !== 'all' && state.stateFilter || state.routeFilter !== 'all' && state.routeFilter || state.application !== 'all' && state.application);
        const title = disabled ? t('请先配置连接监听') : filtering ? t('没有符合条件的连接') : t('暂无连接记录');
        const message = disabled ? t('在连接设置中填写本地 Clash / Mihomo 的控制地址并启用监听。') : filtering ? t('调整域名搜索或筛选条件。') : t('本地代理接管新连接后会显示在这里。');
        return `${summary}<div class="empty-state"><h3>${title}</h3><p>${message}</p></div>`;
    }
    const count = records.length < (result.matched ?? records.length)
        ? tr`<p class="connection-count">显示最近 ${esc(records.length)} 条 / ${esc(result.matched)} 条匹配记录</p>` : '';
    return tr`${summary}<div class="table-scroll"><table class="connection-table" aria-label="域名连接记录"><thead><tr><th>域名 / 目标</th><th>应用</th><th>路由 / 规则</th><th class="right">下载速度</th><th class="right">上传速度</th><th class="right">下载 / 上传用量</th><th>状态</th></tr></thead><tbody>${records.map(record => connectionRow(record, controls)).join('')}</tbody></table></div>${count}`;
}

export function connectionApplicationOptions(state, { option }) {
    const applications = [...(state.result?.applications || [])], selected = state.application || 'all';
    const name = application => application.name || application.path?.split(/[\\/]/).at(-1) || t('未知应用');
    const names = new Map();
    for (const application of applications) {
        const label = name(application);
        names.set(label, (names.get(label) || 0) + 1);
    }
    let missing;
    if (selected !== 'all' && !applications.some(application => application.key === selected)) {
        missing = { key: selected, name: selected === '__unknown__' ? t('未知应用') : selected.split(/[\\/]/).at(-1),
            path: /[\\/]/.test(selected) ? selected : '' };
        applications.push(missing);
    }
    return option('all', t('全部应用'), selected) + applications.map(application => {
        const label = name(application);
        const showPath = application.path && (names.get(label) > 1 || application === missing);
        return option(application.key, showPath ? `${label} · ${application.path}` : label, selected);
    }).join('');
}

export function connectionsView(state, controls) {
    const { button, esc, icon, option } = controls;
    if (!state.available) return tr`<section class="panel"><div class="empty-state"><h3>当前环境不提供连接监听</h3></div></section>`;
    const result = state.result || {}, disabled = state.busy ? 'disabled' : '';
    const states = [['all', '全部连接'], ['active', '活动连接'], ['closed', '历史连接']];
    const routeChoices = [['all', '全部路由'], ...Object.entries(routes).map(([key, [label]]) => [key, label])];
    return tr`<section class="panel connections-panel"><div class="panel-head"><div><h2>域名与连接</h2><p class="panel-sub">查看本地 Clash / Mihomo 接管的连接、所属应用和路由规则。</p></div>
        <div class="connection-actions">${button('connection-refresh', t('刷新'), 'reset', '', `type="button" ${disabled}`)}${button('connection-export', t('导出记录'), 'export', '', `type="button" ${disabled || !result.total ? 'disabled' : ''}`)}${button('connection-clear', t('清空记录'), '', '', `type="button" ${disabled || !result.total ? 'disabled' : ''}`)}${button('connection-settings', t('连接设置'), 'settings', '', 'type="button"')}</div></div>
        <div class="connection-filters"><label class="search-box">${icon('search')}<input id="connectionSearch" type="search" placeholder="搜索域名、IP、应用、规则或节点" aria-label="搜索域名、IP、应用、规则或节点" value="${esc(state.search || '')}"></label>
        <label class="connection-filter"><span class="sr-only">连接状态</span><select class="select" id="connectionState" aria-label="连接状态">${states.map(([key, label]) => option(key, t(label), state.stateFilter || 'all')).join('')}</select></label>
        <label class="connection-filter"><span class="sr-only">路由类型</span><select class="select" id="connectionRoute" aria-label="路由类型">${routeChoices.map(([key, label]) => option(key, t(label), state.routeFilter || 'all')).join('')}</select></label>
        <label class="connection-filter connection-application-filter"><span class="sr-only">按应用筛选</span><select class="select" id="connectionApplication" aria-label="按应用筛选">${connectionApplicationOptions(state, controls)}</select></label></div>
        <div id="connectionListRegion">${connectionList(state, controls)}</div></section>`;
}

export function connectionDetail(record, controls) {
    const { esc } = controls;
    if (!record) return tr`<div class="empty-state"><h3>连接记录已移除</h3></div>`;
    const item = (label, value, raw = false) => `<div><dt>${t(label)}</dt><dd>${raw ? value : esc(value || '—')}</dd></div>`;
    const chain = Array.isArray(record.chains) && record.chains.length ? record.chains.join(' → ') : '—';
    return tr`<section class="detail-section"><h3>连接详情</h3><dl class="connection-detail-list">
        ${item('域名', record.host || record.sniffHost || '—')}${record.sniffHost && record.sniffHost !== record.host ? item('识别到的域名', record.sniffHost) : ''}
        ${item('应用', applicationName(record))}${item('程序路径', record.processPath)}
        ${item('来源地址', endpoint(record.sourceIP, record.sourcePort))}${item('目标地址', endpoint(record.destinationIP, record.destinationPort))}
        ${item('连接类型', [record.network?.toUpperCase(), record.type].filter(Boolean).join(' · '))}${item('路由类型', routeBadge(record, esc), true)}
        ${item('代理链', chain)}${item('命中规则', ruleText(record))}
        ${item('下载速度', rateText(record, 'downloadRate', controls))}${item('上传速度', rateText(record, 'uploadRate', controls))}
        ${item('下载流量', bytesText(record.downloadBytes, controls))}${item('上传流量', bytesText(record.uploadBytes, controls))}
        ${item('连接开始', timestamp(record.start))}${item('首次观测', timestamp(record.firstSeen))}${item('最近观测', timestamp(record.lastSeen))}
        ${item('状态', recordState(record))}${record.end ? item('观测结束时间', timestamp(record.end)) : ''}
        ${record.endReason ? item('观测结束原因', t(endReasons[record.endReason] || record.endReason)) : ''}
    </dl></section>`;
}

export function connectionSettingsView(state, { esc }) {
    if (!state.available) return tr`<section class="panel settings-group"><div class="empty-state"><h3>当前环境不提供连接监听</h3></div></section>`;
    const config = state.result || {}, disabled = state.busy ? 'disabled' : '';
    return tr`<section class="panel settings-group connection-settings"><div class="panel-head"><div><h2>域名与连接监听</h2><p class="panel-sub">读取本地 Clash / Mihomo 接管的连接，显示域名、应用、命中规则和代理链。</p></div></div>
        <form id="connectionMonitorForm" class="quota-form"><label class="quota-check"><input type="checkbox" name="enabled" ${config.enabled ? 'checked' : ''} ${disabled}>启用连接监听</label>
        <div class="field"><label for="connectionControllerUrl">控制地址</label><input class="input" id="connectionControllerUrl" name="controllerUrl" type="url" value="${esc(config.controllerUrl || 'http://127.0.0.1:9090')}" placeholder="http://127.0.0.1:9090" autocomplete="off" spellcheck="false" required aria-describedby="connectionControllerHint" ${disabled}><p class="field-hint" id="connectionControllerHint">填写代理软件的外部控制地址，支持本机回环地址。此处不是 HTTP / SOCKS 代理端口。</p></div>
        <div class="field"><label for="connectionSecret">控制密钥</label><input class="input" id="connectionSecret" name="secret" type="password" value="" autocomplete="new-password" placeholder="${config.hasSecret ? t('已保存，留空则不修改') : t('无密钥可留空')}" aria-describedby="connectionSecretHint" ${disabled}><p class="field-hint" id="connectionSecretHint">与代理软件的 secret 一致；留空保留已保存的密钥。</p></div>
        ${config.hasSecret ? tr`<label class="quota-check"><input type="checkbox" name="clearSecret" ${disabled}>清除已保存的控制密钥</label>` : ''}
        <div class="field"><label for="connectionInterval">刷新间隔（毫秒）</label><input class="input" id="connectionInterval" name="intervalMs" type="number" min="250" max="60000" step="1" value="${esc(config.intervalMs || 1000)}" required ${disabled}></div>
        <p class="field-hint">只显示代理软件可观测的连接；未经过它的访问不会出现在这里。进程或域名缺失时保留未知状态。</p>
        <div class="form-error" role="alert">${esc(t(state.error || ''))}</div><div class="settings-actions"><button class="btn primary" type="submit" ${disabled}>保存连接设置</button></div><div id="connectionSaveStatus" class="connection-save-status" role="status">${esc(state.message || '')}</div></form></section>`;
}
