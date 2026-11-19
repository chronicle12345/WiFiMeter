import { getLocale, t, tr } from '../i18n.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const levelLabel = level => ({ debug: t('调试'), info: t('信息'), warn: t('警告'), error: t('错误') }[level] || level);
const levelTone = { debug: 'gray', info: '', warn: 'warn', error: 'red' };

function logRows(entries, esc) {
    return entries.map(entry => {
        const time = new Date(entry.time);
        const stamp = Number.isFinite(time.getTime()) ? time.toLocaleString(getLocale(), { hour12: false }) : entry.time;
        return `<tr><td class="log-time">${esc(stamp)}</td><td><span class="pill ${levelTone[entry.level] ?? ''}">${esc(levelLabel(entry.level))}</span></td><td class="log-source">${esc(entry.source)}</td><td class="log-message">${esc(entry.message)}</td></tr>`;
    }).join('');
}

// Only the rows change while typing in the search box, so the toolbar keeps focus.
export function logList(state, { esc }) {
    if (state.error) return `<div class="empty-state"><h3>${t('无法读取日志')}</h3><p>${esc(state.error)}</p></div>`;
    if (!state.entries.length) return `<div class="empty-state"><h3>${t('没有符合条件的日志')}</h3><p>${t('调整显示级别或搜索内容。')}</p></div>`;
    const shown = state.entries.length < state.total ? tr`<p class="log-count">仅显示最近的日志：${state.entries.length} / ${state.total}</p>` : '';
    return tr`<div class="table-scroll"><table class="log-table" aria-label="日志"><thead><tr><th>日志时间</th><th>日志级别</th><th>日志来源</th><th>日志内容</th></tr></thead><tbody>${logRows(state.entries, esc)}</tbody></table></div>${shown}`;
}

export function logsView(state, { button, esc, icon, option }) {
    if (!state.available) return tr`<section class="panel"><div class="empty-state"><h3>当前环境不提供日志</h3></div></section>`;
    const levels = selected => LOG_LEVELS.map(level => option(level, levelLabel(level), selected)).join('');
    return tr`<section class="panel logs-panel"><div class="panel-head"><h2>运行日志</h2>
        <div class="logs-actions">${button('logs-refresh', t('刷新'), 'reset')}${button('logs-export', t('导出日志'), 'export', '', state.total ? '' : 'disabled')}${button('logs-clear', t('清空日志'), '', '', state.total ? '' : 'disabled')}</div></div>
        <div class="logs-toolbar"><label class="search-box">${icon('search')}<input id="logSearch" type="search" placeholder="搜索日志" aria-label="搜索日志" value="${esc(state.search)}"></label>
        <label class="logs-select"><span>显示级别</span><select class="select" id="logMinimum" aria-label="显示级别">${levels(state.minimum)}</select></label>
        <label class="logs-select"><span>记录级别</span><select class="select" id="logLevel" aria-label="记录级别" title="${t('低于此级别的日志不会写入文件。')}">${levels(state.level)}</select></label></div>
        <div id="logListRegion">${logList(state, { esc })}</div></section>`;
}
