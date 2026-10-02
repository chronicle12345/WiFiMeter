import { t, tr } from '../i18n.js';

export function appControlView(control, { button, esc }) {
    if (!control.supported) return tr`<section class="detail-section application-control"><h3>应用网络控制</h3><p class="small muted">当前平台暂不支持应用防火墙与上传限速。</p></section>`;
    const state=control.state, disabled=control.busy?'disabled':'';
    const value=state=>state===true?t('已配置'):state===false?t('未配置'):t('未知');
    const actions=[['read',t('查询状态')],['block',t('阻止联网')],['unblock',t('解除阻止')],['unthrottle',t('取消上传限速')]];
    const selected=control.path?tr`<dl><dt>完整路径</dt><dd data-selected-app-path>${esc(control.path)}</dd>
        <dt>防火墙规则</dt><dd>${value(state?.Blocked)}</dd><dt>上传限速</dt>
        <dd>${state?.Throttled===true&&state?.UploadKbps!=null?esc(state.UploadKbps/8)+' KB/s':value(state?.Throttled)}</dd></dl>
        <div class="settings-actions">${actions.map(([action,label])=>button('app-control',label,'','small-btn',`type="button" data-operation="${action}" ${disabled}`)).join('')}</div>
        <form id="appThrottleForm"><div class="field"><label for="uploadKBps">上传限速 KB/s</label>
        <input class="input" id="uploadKBps" name="uploadKBps" type="number" min="0.125" max="125000000" step="0.125" value="${state?.UploadKbps?state.UploadKbps/8:128}" required ${disabled}></div>
        <button class="btn small-btn" type="submit" ${disabled}>设置上传限速</button></form>`:'';
    return tr`<section class="detail-section application-control" aria-label="应用网络控制"><h3>应用网络控制</h3>
        ${button('choose-program',t('选择程序'),'folder','small-btn',`type="button" ${disabled}`)}${selected}
        ${control.name&&!control.path?tr`<p class="small muted">缺少程序路径，请选择程序。</p>`:''}
        ${control.busy?tr`<p role="status">正在等待系统操作完成…</p>`:''}
        ${control.warning?`<p class="small muted">${esc(control.warning)}</p>`:''}
        ${control.error?`<p class="form-error" role="alert">${esc(control.error)}</p>`:''}
        ${state?.FirewallError?`<p class="form-error" role="alert">${esc(state.FirewallError)}</p>`:''}
        ${state?.QosError?`<p class="form-error" role="alert">${esc(state.QosError)}</p>`:''}
    </section>`;
}
