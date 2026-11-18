import { getLocale, t, tr } from '../i18n.js';

const SECTIONS = [['settings', '系统设置'], ['networks', '网络与额度'], ['daily', '按天流量'], ['hourly', '按小时流量'], ['apps', '应用流量'], ['minutes', '按分钟流量'], ['logs', '运行日志']];
const RANGES = [[7, '最近 7 天'], [30, '最近 30 天'], [90, '最近 90 天'], [365, '最近一年'], [0, '全部历史']];
const INTERVALS = [['hourly', '每小时'], ['daily', '每天'], ['weekly', '每周']];
const sectionNames = keys => SECTIONS.filter(([key]) => keys.includes(key)).map(([, label]) => t(label)).join(getLocale() === 'en-US' ? ', ' : '、');
const when = iso => { const date = new Date(iso); return Number.isFinite(date.getTime()) ? date.toLocaleString(getLocale(), { hour12: false }) : '—'; };
export const sizeText = bytes => { let value = Math.max(0, Number(bytes) || 0), unit = 0; while (value >= 1024 && unit < 3) { value /= 1024; unit++; } return `${value.toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][unit]}`; };

function remoteList(state, { button, esc }) {
    if (state.listError) return `<p class="form-error" role="alert">${esc(state.listError)}</p>`;
    if (!state.files) return '';
    if (!state.files.length) return tr`<p class="cloud-empty">远端还没有备份。</p>`;
    return tr`<ul class="cloud-files">${state.files.map(file => tr`<li><div class="cloud-file-meta"><strong>${esc(when(file.createdAt))}</strong><span>${esc(file.device)}${file.own ? t(' · 本机') : ''} · ${esc(sizeText(file.size))}</span></div>
        <div class="settings-actions">${button('cloud-restore', t('恢复'), '', 'small-btn', `type="button" data-name="${esc(file.name)}" ${state.busy ? 'disabled' : ''}`)}${button('cloud-remove', t('删除备份'), '', 'small-btn', `type="button" data-name="${esc(file.name)}" ${state.busy ? 'disabled' : ''}`)}</div></li>`).join('')}</ul>`;
}

export function cloudBackupView(state, { button, esc, option }) {
    if (!state.available) return '';
    const config = state.config || {}, locked = state.busy ? 'disabled' : '';
    const status = state.busy ? { save: t('正在保存…'), backup: t('正在备份…'), restore: t('正在恢复…'), test: t('正在测试连接…'), list: t('正在读取远端备份…'), estimate: t('正在估算大小…'), remove: t('正在删除…') }[state.busy] || ''
        : state.message || (config.lastError ? tr`上次备份失败：${esc(config.lastError)}` : config.lastBackupAt ? tr`上次备份：${esc(when(config.lastBackupAt))}` : '');
    return tr`<section class="panel settings-group cloud-backup"><div class="panel-head"><h2>WebDAV 云备份</h2></div>
        <form id="cloudBackupForm" class="quota-form">
        <div class="field"><label for="cloudUrl">WebDAV 地址</label><input class="input" id="cloudUrl" name="url" type="url" value="${esc(config.url || '')}" placeholder="https://dav.example.com/backup/wifimeter" autocomplete="off" spellcheck="false"></div>
        <div class="cloud-credentials"><div class="field"><label for="cloudUser">用户名</label><input class="input" id="cloudUser" name="username" value="${esc(config.username || '')}" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label for="cloudPassword">访问密码</label><input class="input" id="cloudPassword" name="password" type="password" placeholder="${config.hasPassword ? t('已保存，留空则不修改') : ''}" autocomplete="new-password"></div></div>
        <fieldset class="cloud-sections"><legend>备份内容</legend>${SECTIONS.map(([key, label]) => `<label class="quota-check"><input type="checkbox" name="sections" value="${key}" ${(config.sections || []).includes(key) ? 'checked' : ''}>${t(label)}</label>`).join('')}</fieldset>
        <div class="cloud-options"><div class="field"><label for="cloudDays">数据范围</label><select class="select" id="cloudDays" name="days">${RANGES.map(([value, label]) => option(value, t(label), config.days ?? 90)).join('')}</select></div>
        <div class="field"><label for="cloudKeep">保留本机备份份数</label><input class="input" id="cloudKeep" name="keep" type="number" min="1" max="100" step="1" value="${esc(config.keep ?? 10)}"></div>
        <div class="field"><label for="cloudInterval">自动同步间隔</label><select class="select" id="cloudInterval" name="syncInterval">${INTERVALS.map(([value, label]) => option(value, t(label), config.interval || 'daily')).join('')}</select></div></div>
        <label class="quota-check"><input type="checkbox" name="auto" ${config.auto ? 'checked' : ''}>自动同步到 WebDAV</label>
        <div class="form-error" role="alert">${esc(state.error || '')}</div>
        <div class="settings-actions">${button('cloud-backup', t('立即备份'), 'export', 'primary', `type="button" ${locked}`)}${button('cloud-test', t('测试连接'), '', '', `type="button" ${locked}`)}${button('cloud-estimate', t('估算大小'), '', '', `type="button" ${locked}`)}${button('cloud-list', t('查看远端备份'), '', '', `type="button" ${locked}`)}</div>
        <p class="cloud-status" role="status">${status}</p></form>
        <div id="cloudFilesRegion">${remoteList(state, { button, esc })}</div></section>`;
}

export function cloudBackupPatch(form) {
    const values = new FormData(form), password = values.get('password');
    return { url: values.get('url'), username: values.get('username'), sections: values.getAll('sections'), days: Number(values.get('days')),
        keep: Number(values.get('keep')), interval: values.get('syncInterval'), auto: values.has('auto'), ...(password ? { password } : {}) };
}

export const cloudSummary = summary => tr`${esc(sectionNames(summary.sections))} · ${summary.days} 天 · ${summary.apps} 条应用记录`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
