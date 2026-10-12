import { getLocale, t, tr } from '../i18n.js';

export function appRulesView(control, { button, esc }) {
    if (!control.supported) return '';
    const value = state => state === true ? t('已配置') : state === false ? t('未配置') : t('未知');
    const rate = (enabled, kbps) => enabled === true && Number.isFinite(kbps) && kbps > 0 ? esc(kbps / 8) + ' KB/s' : value(enabled);
    const disabled = control.busy || control.rulesBusy ? 'disabled' : '';
    const rules = control.rules || [];
    const rows = rules.map(record => {
        const state = record.state || {}, saved = new Date(record.savedAt);
        const blocked = state.FirewallError || state.FirewallErrorCode ? null : state.Blocked;
        const upload = state.QosError || state.QosErrorCode ? null : state.Throttled;
        const download = state.DownloadError || state.DownloadErrorCode ? null : state.DownloadThrottled;
        const savedAt = Number.isFinite(saved.getTime()) ? saved.toLocaleString(getLocale(), { hour12: false }) : t('未知');
        return tr`<li class="app-rule-row"><span class="app-avatar" aria-hidden="true">${esc((record.name || record.path).slice(0, 1).toUpperCase())}</span>
            <div class="app-rule-meta"><div class="app-rule-name">${esc(record.name || record.path)}</div><div class="app-source">${esc(record.path)}</div>
            <div class="app-rule-limits" aria-label="上次记录的状态"><span class="pill ${blocked === true ? 'red' : blocked === false ? 'gray' : 'warn'}">${t('防火墙规则')} · ${value(blocked)}</span>
            <span class="pill ${upload === true ? '' : upload === false ? 'gray' : 'warn'}">${t('上传限速')} · ${rate(upload, state.UploadKbps)}</span>
            <span class="pill ${download === true ? '' : download === false ? 'gray' : 'warn'}">${t('下载限速')} · ${rate(download, state.DownloadKbps)}</span></div>
            <div class="small muted">最近保存 <time datetime="${esc(record.savedAt)}">${esc(savedAt)}</time></div>
            ${record.operationError ? tr`<div class="small form-error">上次操作未完成：${esc(record.operationError.message)}</div>` : ''}</div>
            <div class="app-rule-actions">${button('select-controlled-app', t('查看与调整'), '', 'small-btn', `type="button" data-path="${esc(record.path)}" data-name="${esc(record.name || record.path)}" ${disabled}`)}</div></li>`;
    }).join('');
    return tr`<section class="panel app-rules-panel" aria-label="应用限制记录"><div class="panel-head"><div><h2>应用限制记录</h2>
        <div class="panel-sub">列表保存最近一次查询结果。实际限制请查询状态；下载限速退出后停止。</div></div>
        ${button('app-rules-refresh', t('刷新记录'), 'reset', 'small-btn', `type="button" ${disabled}`)}</div>
        ${control.rulesBusy ? tr`<p class="small muted" role="status">正在读取记录…</p>` : ''}
        ${control.rulesError ? `<p class="form-error" role="alert">${esc(control.rulesError)}</p>` : ''}
        ${rules.length ? `<ul class="app-rules-list">${rows}</ul>` : tr`<div class="empty-state"><div class="small muted">还没有应用限制记录。设置成功后会显示在这里。</div></div>`}
    </section>`;
}

export function appControlView(control, { button, esc }) {
    if (!control.supported) return tr`<section class="detail-section application-control"><h3>应用网络控制</h3><p class="small muted">当前平台暂不支持应用防火墙与上传、下载限速。</p></section>`;
    const state=control.state, disabled=control.busy?'disabled':'';
    const value=state=>state===true?t('已配置'):state===false?t('未配置'):t('未知');
    const actions=[['read',t('查询状态')],['block',t('阻止联网')],['unblock',t('解除阻止')]];
    const selected=control.path?tr`<dl><dt>完整路径</dt><dd data-selected-app-path>${esc(control.path)}</dd>
        <dt>防火墙规则</dt><dd>${value(state?.Blocked)}</dd><dt>上传限速</dt>
        <dd>${state?.Throttled===true&&state?.UploadKbps!=null?esc(state.UploadKbps/8)+' KB/s':value(state?.Throttled)}</dd>
        <dt>下载限速</dt><dd>${state?.DownloadThrottled===true&&state?.DownloadKbps!=null?esc(state.DownloadKbps/8)+' KB/s':value(state?.DownloadThrottled)}</dd></dl>
        <div class="settings-actions">${actions.map(([action,label])=>button('app-control',label,'','small-btn',`type="button" data-operation="${action}" ${disabled}`)).join('')}</div>
        <form id="appThrottleForm"><div class="field"><label for="uploadKBps">上传限速 KB/s</label>
        <input class="input" id="uploadKBps" name="uploadKBps" type="number" min="0.125" max="125000000" step="0.125" value="${state?.UploadKbps?state.UploadKbps/8:128}" required ${disabled}></div>
        <div class="settings-actions"><button class="btn small-btn" type="submit" ${disabled}>设置上传限速</button>${button('app-control',t('取消上传限速'),'','small-btn',`type="button" data-operation="unthrottle" data-direction="upload" ${disabled}`)}</div></form>
        <form id="appDownloadThrottleForm"><div class="field"><label for="downloadKBps">下载限速 KB/s</label>
        <input class="input" id="downloadKBps" name="downloadKBps" type="number" min="0.125" max="125000000" step="0.125" value="${state?.DownloadKbps?state.DownloadKbps/8:128}" required ${disabled}></div>
        <div class="settings-actions"><button class="btn small-btn" type="submit" ${disabled}>设置下载限速</button>${button('app-control',t('取消下载限速'),'','small-btn',`type="button" data-operation="unthrottle" data-direction="download" ${disabled}`)}</div></form>`:'';
    return tr`<section class="detail-section application-control" aria-label="应用网络控制"><h3>应用网络控制</h3>
        ${button('choose-program',t('选择程序'),'folder','small-btn',`type="button" ${disabled}`)}${selected}
        ${control.name&&!control.path?tr`<p class="small muted">缺少程序路径，请选择程序。</p>`:''}
        ${control.path?tr`<p class="small muted">下载限速在 WiFiMeter 运行期间生效，退出后自动停止。</p>`:''}
        ${control.busy?tr`<p role="status">正在等待系统操作完成…</p>`:''}
        ${control.warning?`<p class="small muted">${esc(control.warning)}</p>`:''}
        ${control.error?`<p class="form-error" role="alert">${esc(control.error)}</p>`:''}
        ${state?.FirewallError?`<p class="form-error" role="alert">${esc(state.FirewallError)}</p>`:''}
        ${state?.QosError?`<p class="form-error" role="alert">${esc(state.QosError)}</p>`:''}
        ${state?.DownloadError?`<p class="form-error" role="alert">${esc(state.DownloadError)}</p>`:''}
    </section>`;
}
