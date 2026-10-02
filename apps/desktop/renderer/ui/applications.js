import { tr } from '../i18n.js';
import { applicationRows, applicationPath } from '../data/history.js';

// 复用历史记录的范围筛选和字节处理，跨网络按应用归并。
export function applicationSummary(records, range) {
    const groups = new Map();
    for (const row of applicationRows(records, range)) {
        const key = JSON.stringify([row.id, row.estimated, row.unattributed]);
        const app = groups.get(key) || { ...row, key, iconDate: row.date, date: '', rx: 0n, tx: 0n, total: 0n };
        app.rx += row.rx; app.tx += row.tx; app.total += row.total;
        if (!app.path) app.path = row.path;
        groups.set(key, app);
    }
    return [...groups.values()];
}

export function applicationSourceFilter(proxy, estimated) {
    return tr`<label class="application-source-filter"><span class="sr-only">应用数据来源</span><select class="select compact" id="appDataSource" title="代理估算与原生采集独立；仅替换匹配网络和日期的代理记录，保留客户端直接流量。"><option value="native" ${!estimated?'selected':''}>原生记录</option><option value="estimated" ${estimated?'selected':''} ${proxy?.available?'':'disabled'}>包含代理估算</option></select></label>`;
}

export function applicationDetails(app, { esc, fmtWithUnit, appRate, estimateLabel }) {
    const live=app.processId!=null, hasUsage=app.total!=null;
    if (!app.name) return '';
    return tr`<section class="application-summary detail-section" aria-label="应用详情"><dl class="kv-grid">${live?tr`<div><dt>PID</dt><dd>${esc(app.processIds?.join(', ')||app.processId)}</dd></div><div><dt>下载速度</dt><dd>${appRate(app.rxPerSecond)}</dd></div><div><dt>上传速度</dt><dd>${appRate(app.txPerSecond)}</dd></div>`:''}${hasUsage?tr`<div><dt>总用量</dt><dd>${fmtWithUnit(app.total)}</dd></div><div><dt>下载</dt><dd>${fmtWithUnit(app.rx)}</dd></div><div><dt>上传</dt><dd>${fmtWithUnit(app.tx)}</dd></div><div><dt>来源</dt><dd>${estimateLabel(app)}</dd></div>`:''}${app.date?tr`<div><dt>日期</dt><dd>${esc(app.date)}</dd></div>`:''}</dl>${app.proxyClient?tr`<p class="small muted">连接已检测到，流量数值需启用应用采集。</p>`:''}</section>`;
}


export function applicationAvatar(app, esc, compact = false) {
    const id = app.appId || app.id;
    const known = id && !app.unattributed && applicationPath(app);
    const date = app.iconDate || (/^\d{4}-\d{2}-\d{2}$/.test(app.date || '') ? app.date : /^\d{4}-\d{2}$/.test(app.date || '') ? app.date + '-01' : '');
    return `<span class="app-avatar${compact ? ' app-avatar--compact' : ''}" aria-hidden="true" ${known ? `data-app-icon="${esc(id)}" data-app-icon-date="${esc(date)}"` : ''}>${esc([...(app.name || '?')][0])}</span>`;
}
