import { t, tr } from '../i18n.js';

const errorText = error => typeof error === 'string' ? error : error?.message || '';

// 数据位置区域由界面在读取、切换后重绘；路径属于用户数据，显示前统一转义。
export function dataLocationPanel(state, { esc, button }) {
    if (!state) return `<div id="dataLocationRegion" class="settings-actions" role="status"><span class="small muted">${t('读取中…')}</span></div>`;
    const busy = state.busy === true;
    const note = state.temporaryDefault
        ? t('本次运行暂时使用默认位置；保存的自定义位置会在下次启动时继续尝试。')
        : state.custom ? '' : t('当前使用默认位置。');
    const message = state.notice || state.error || '';
    const disabled = busy ? 'disabled' : '';
    return `<div id="dataLocationRegion"><p class="small muted" role="status"><code>${esc(state.directory || '')}</code></p>${note ? `<p class="small muted">${esc(note)}</p>` : ''}<div class="settings-actions">${button('data-location-change', t(busy ? '正在切换…' : '更改位置'), 'folder', 'small-btn', `type="button" ${disabled}`)}${state.custom || state.temporaryDefault ? button('data-location-reset', t('恢复默认位置'), 'reset', 'small-btn', `type="button" ${disabled}`) : ''}</div>${message ? `<p class="small" role="${state.error ? 'alert' : 'status'}">${esc(message)}</p>` : ''}</div>`;
}

// 切换结果可能是取消、未变化、成功或失败，逐种给出可读结论。
export function dataLocationMessage(result) {
    if (!result || result.canceled) return '';
    if (result.ok === false) return errorText(result.error) || t('未能切换数据位置。');
    if (result.cleared) return t('已恢复默认位置，不再使用自定义位置。');
    if (result.changed === false) return t('当前已经是这个数据位置。');
    if (result.ok !== true) return '';
    const lines = [result.copied ? t('数据位置已切换，当前数据库已复制到新位置。') : t('数据位置已切换，新位置会新建空白数据库。')];
    if (result.source) lines.push(tr`原数据库仍保留在：${result.source}`);
    if (result.archived) lines.push(tr`目标文件夹原有的数据库已归档为：${result.archived}`);
    if (result.database) lines.push(tr`当前数据库：${result.database}`);
    return lines.join(' ');
}
