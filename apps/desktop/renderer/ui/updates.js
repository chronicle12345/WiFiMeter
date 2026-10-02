import { t, tr } from '../i18n.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function updatesView(status = {}, busy = false) {
    const messages = { recovered: t('已恢复原采集状态。'), unchecked: t('尚未检查更新。'), cancelled: t('已取消更新。'), manual: t('已打开官方发布页。'), installing: t('正在退出并启动安装程序…'), latest: t('当前已是最新版本。'), available: t('发现新版本。'), error: t('更新检查失败。'), checking: t('正在检查更新…') };
    return tr`<section class="panel settings-group" id="updatesPanel"><div class="panel-head"><div><h2>软件更新</h2></div></div>
        <label class="quota-check"><input id="checkUpdatesOnStartup" type="checkbox" ${status.checkOnStartup !== false ? 'checked' : ''} ${busy ? 'disabled' : ''}>启动时检查更新</label>
        <p class="small muted">当前版本：${esc(status.currentVersion || '—')}${status.latestVersion ? tr` · 最新版本：${esc(status.latestVersion)}` : ''}</p>
        <p role="status">${messages[status.state] || ''}${status.error ? ' ' + esc(status.error) : ''}</p>
        ${status.state === 'available' && status.notes ? `<details><summary>${t('更新说明')}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(status.notes)}</pre></details>` : ''}
        <div class="settings-actions"><button class="btn" data-action="check-updates" ${busy ? 'disabled' : ''}>检查更新</button>
        ${status.recoveryRequired || status.state === 'available' ? `<button class="btn primary" data-action="install-update" ${busy ? 'disabled' : ''}>${status.recoveryRequired ? t('恢复采集') : status.canInstall ? t('下载并安装') : t('打开版本下载页')}</button>` : ''}</div></section>`;
}
