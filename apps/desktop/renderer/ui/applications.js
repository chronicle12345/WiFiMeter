import { t, tr } from '../i18n.js';
import { applicationPath } from '../data/history.js';
export { applicationSummary } from '../data/history.js';

export function applicationSourceFilter(proxy, estimated, live = false) {
    const title = live ? t('按当前端口连接数分配代理程序的网络速度，保留客户端直接流量。') : t('代理估算与原生采集独立；仅替换匹配网络和日期的代理记录，保留客户端直接流量。');
    return tr`<label class="application-source-filter"><span class="sr-only">应用数据来源</span><select class="select compact" id="appDataSource" title="${title}"><option value="native" ${!estimated?'selected':''}>${live ? t('原生采集') : t('原生记录')}</option><option value="estimated" ${estimated?'selected':''} ${proxy?.available?'':'disabled'}>${live ? t('包含端口估算') : t('包含代理估算')}</option></select></label>`;
}

export function applicationDetails(app, { esc, fmtWithUnit, appRate, estimateLabel, proxyDetails = { clients: [], estimates: [] }, rangeLabel = '' }) {
    const live=app.live||app.processId!=null, hasUsage=app.total!=null;
    if (!app.name) return '';
    const clients = proxyDetails.clients || [], estimates = proxyDetails.estimates || [];
    const proxyName = row => esc(row.proxyName || row.proxyAppId || tr`未知代理`);
    const proxyProgram = row => esc(row.proxyAppId || row.proxyName || tr`未知代理`);
    const liveRows = clients.map(client => tr`<li class="proxy-detail-item">
        <div class="proxy-detail-head"><strong>${proxyName(client)}</strong><span class="application-source-badge ${client.measurementAvailable ? 'measured' : 'unavailable'}">${client.measurementAvailable ? tr`实测` : tr`不可测`}</span></div>
        <dl class="proxy-detail-metrics"><div><dt>代理程序</dt><dd>${proxyProgram(client)}</dd></div><div><dt>客户端</dt><dd>${esc(client.name || client.appId)}</dd></div><div><dt>连接数</dt><dd>${esc(client.connections ?? '—')}</dd></div><div><dt>下载速度</dt><dd>${esc(appRate(client.measurementAvailable ? client.rxPerSecond : null))}</dd></div><div><dt>上传速度</dt><dd>${esc(appRate(client.measurementAvailable ? client.txPerSecond : null))}</dd></div></dl>
    </li>`).join('');
    const liveProxy = clients.length ? tr`<section class="application-proxy-details proxy-live-connections"><h3>实时本地 TCP 连接</h3><ul class="proxy-detail-list">${liveRows}</ul><p class="small muted">本地代理连接 · 实时速度不计入 Wi-Fi 总量</p></section>` : '';
    const estimateRows = estimates.map(row => tr`<li class="proxy-detail-item">
        <div class="proxy-detail-head"><strong>${proxyName(row)}</strong><span class="application-source-badge estimated">${esc(estimateLabel(row))}</span></div>
        <dl class="proxy-detail-metrics"><div><dt>日期</dt><dd>${esc(row.date)}</dd></div><div><dt>代理程序</dt><dd>${proxyProgram(row)}</dd></div><div><dt>客户端</dt><dd>${esc(row.name || row.appId)}</dd></div><div><dt>下载</dt><dd>${esc(fmtWithUnit(row.rxBytes))}</dd></div><div><dt>上传</dt><dd>${esc(fmtWithUnit(row.txBytes))}</dd></div></dl>
    </li>`).join('');
    const historyProxy = (estimates.length ? tr`<section class="application-proxy-details proxy-history-estimates"><h3>历史代理估算</h3>${rangeLabel ? tr`<p class="small muted">记录范围：${esc(rangeLabel)}</p>` : ''}<ul class="proxy-detail-list">${estimateRows}</ul><p class="small muted">历史用量按连接权重估算；本地 TCP 实时速度不计入 Wi-Fi 用量。</p></section>` : '') + (app.usageUnavailable ? tr`<p class="small muted" role="status">所选时段没有应用记录</p>` : '');
    return tr`<section class="application-summary detail-section" aria-label="应用详情"><dl class="kv-grid">${live?`${app.estimated ? tr`<div><dt>代理程序</dt><dd>${proxyName(app)}</dd></div><div><dt>来源</dt><dd>${estimateLabel(app)}</dd></div>` : tr`<div><dt>PID</dt><dd>${esc(app.processIds?.join(', ')||app.processId)}</dd></div>`}${tr`<div><dt>下载速度</dt><dd>${appRate(app.rxPerSecond)}</dd></div><div><dt>上传速度</dt><dd>${appRate(app.txPerSecond)}</dd></div>`}`:''}${hasUsage?tr`<div><dt>总用量</dt><dd>${fmtWithUnit(app.total)}</dd></div><div><dt>下载</dt><dd>${fmtWithUnit(app.rx)}</dd></div><div><dt>上传</dt><dd>${fmtWithUnit(app.tx)}</dd></div><div><dt>来源</dt><dd>${estimateLabel(app)}</dd></div>`:''}${app.date?tr`<div><dt>日期</dt><dd>${esc(app.date)}</dd></div>`:''}</dl>${app.estimated&&live?tr`<p class="small muted">按当前端口连接数分配代理程序的网络速度，保留客户端直接流量。</p>`:''}${app.proxyClient&&!clients.length?tr`<p class="small muted">连接已检测到，流量数值需启用应用采集。</p>`:''}${liveProxy}${historyProxy}</section>`;
}


export function applicationAvatar(app, esc, compact = false) {
    const id = app.appId || app.id;
    const known = id && !app.unattributed && applicationPath(app);
    const date = app.iconDate || (/^\d{4}-\d{2}-\d{2}$/.test(app.date || '') ? app.date : /^\d{4}-\d{2}$/.test(app.date || '') ? app.date + '-01' : '');
    return `<span class="app-avatar${compact ? ' app-avatar--compact' : ''}" aria-hidden="true" ${known ? `data-app-icon="${esc(id)}" data-app-icon-date="${esc(date)}"` : ''}>${esc([...(app.name || '?')][0])}</span>`;
}
