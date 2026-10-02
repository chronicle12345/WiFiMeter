import { t, tr } from '../i18n.js';
import { releaseNotes } from './release-notes.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const renderedNotes = new WeakMap();
const activePhases = new Set(['checking','downloading','verifying','preparing','installing']);
const bytes = value => { let n=Math.max(0,Number(value)||0),i=0;const units=['B','KB','MB','GB'];while(n>=1000&&i<3){n/=1000;i++;}return `${n.toFixed(i?1:0)} ${units[i]}`; };
export function updateProgress(status) {
    if (!activePhases.has(status.state)) return '';
    const progress=status.progress||{},known=status.state==='downloading'&&Number.isFinite(progress.percent)&&progress.totalBytes>0;
    const percent=known?Math.min(100,Math.max(0,progress.percent)):null;
    const label={checking:t('正在检查更新…'),downloading:t('正在下载安装包…'),verifying:t('正在校验安装包…'),preparing:t('正在保存数据并准备安装…'),installing:t('正在启动安装程序…')}[status.state];
    const detail=status.state==='downloading'?`${bytes(progress.receivedBytes)}${known?' / '+bytes(progress.totalBytes):''}${known?' · '+Math.floor(percent)+'%':''}`:status.state==='installing'?t('后续安装进度将在安装程序中显示。'):'';
    return `<div class="update-progress" data-phase="${status.state}"><div class="update-progress-label"><span>${label}</span><span>${esc(detail)}</span></div><progress aria-label="${label}" max="100" ${known?`value="${percent}"`:''}></progress></div>`;
}
export function updatesView(status = {}, busy = false) {
    const locked=busy||status.busy===true||activePhases.has(status.state);
    const messages={recovered:t('已恢复原采集状态。'),unchecked:t('尚未检查更新。'),cancelled:t('已取消更新。'),manual:t('已打开官方发布页。'),latest:t('当前已是最新版本。'),available:t('发现新版本。'),error:t('更新失败。')};
    return tr`<section class="panel settings-group" id="updatesPanel"><div class="panel-head"><div><h2>软件更新</h2></div></div>
        <label class="quota-check"><input id="checkUpdatesOnStartup" type="checkbox" ${status.checkOnStartup !== false ? 'checked' : ''} ${locked ? 'disabled' : ''}>启动时检查更新</label>
        <p class="small muted update-version">当前版本：${esc(status.currentVersion || '—')}${status.latestVersion ? tr` · 最新版本：${esc(status.latestVersion)}` : ''}</p>
        <div id="updateStatusRegion"><p role="status">${messages[status.state] || ''}${status.error ? ' ' + esc(status.error) : ''}</p>${updateProgress(status)}</div>
        ${status.notes ? `<details class="release-notes"><summary>${t('更新说明')}</summary><div class="release-notes-body">${releaseNotes(status.notes)}</div></details>` : ''}
        <div class="settings-actions"><button class="btn" data-action="check-updates" ${locked ? 'disabled' : ''}>检查更新</button>
        ${status.recoveryRequired || status.state === 'available' ? `<button class="btn primary" data-action="install-update" ${locked ? 'disabled' : ''}>${status.recoveryRequired ? t('恢复采集') : status.canInstall ? t('下载并安装') : t('打开版本下载页')}</button>` : ''}</div></section>`;
}

// Progress must not replace the notes DOM or reset its expanded/scroll state.
export function refreshUpdates(panel, status, busy) {
    const template=document.createElement('template');template.innerHTML=updatesView({...status,notes:''},busy);
    const next=template.content.firstElementChild;
    const sameNotes=renderedNotes.get(panel)===String(status.notes||'');
    if(!sameNotes){const open=panel.querySelector('.release-notes')?.open;const full=document.createElement('template');full.innerHTML=updatesView(status,busy);const fresh=full.content.firstElementChild;renderedNotes.set(fresh,String(status.notes||''));if(open&&fresh.querySelector('.release-notes'))fresh.querySelector('.release-notes').open=true;panel.replaceWith(fresh);return;}
    panel.querySelector('.update-version').replaceWith(next.querySelector('.update-version'));
    panel.querySelector('#updateStatusRegion').replaceWith(next.querySelector('#updateStatusRegion'));
    panel.querySelector('.settings-actions').replaceWith(next.querySelector('.settings-actions'));
    panel.querySelector('#checkUpdatesOnStartup').disabled=next.querySelector('#checkUpdatesOnStartup').disabled;
    panel.querySelector('#checkUpdatesOnStartup').checked=next.querySelector('#checkUpdatesOnStartup').checked;
}
