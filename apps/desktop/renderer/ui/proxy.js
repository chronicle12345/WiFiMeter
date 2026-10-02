import { measuredRate } from '../data/application-live.js';
import { autosaveStatus } from './autosave.js';
import { t, tr } from '../i18n.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function proxyStatus(proxy) {
    if (!proxy) return t('后端尚未提供代理估算接口。');
    if (!proxy.available) return t('当前平台不支持代理流量估算，原生应用采集不受影响。');
    return t('代理估算与原生采集独立；仅替换匹配网络和日期的代理记录，保留客户端直接流量。');
}
export function proxyForm(proxy) {
    const fields = proxy?.available ? tr`<form id="proxyConfigForm" class="quota-form">
        <div class="field"><label for="proxyPorts">代理端口</label><input class="input" id="proxyPorts" name="ports" value="${esc((proxy.ports||[]).join(', '))}" placeholder="7890, 1080"></div>
        <div class="field"><label for="proxyProcesses">代理进程名（可选）</label><input class="input" id="proxyProcesses" name="processNames" value="${esc((proxy.processNames||[]).join(', '))}" placeholder="Clash.exe, v2ray.exe"></div>
        <div class="form-error" role="alert"></div>${autosaveStatus('proxySaveStatus')}
    </form>` : '';
    return tr`<section class="panel settings-group"><div class="panel-head"><div><h2>代理流量估算</h2>${!proxy?.available?`<p class="panel-sub">${proxyStatus(proxy)}</p>`:''}${proxy?.status&&proxy.status!=='ready'?`<p class="small muted">${esc(proxy.status)}</p>`:''}${proxy?.detail?`<p class="small muted">${esc(proxy.detail)}</p>`:''}</div></div>${fields}</section>`;
}
export function proxySourceSelector(proxy, estimated) {
    return tr`<div class="field"><label for="appDataSource">应用数据来源</label><select class="select" id="appDataSource">
        <option value="native" ${!estimated?'selected':''}>原生记录</option>
        <option value="estimated" ${estimated?'selected':''} ${proxy?.available?'':'disabled'}>包含代理估算</option>
    </select>${!proxy?.available?`<p class="field-hint">${proxyStatus(proxy)}</p>`:''}</div>`;
}
export function estimateLabel(row) {
    return row.unattributed ? t('估算 · 未归属') : row.estimated ? t('估算') : t('原生记录');
}
export function proxyClientsView(proxy, speedUnit = 'auto') {
    const clients = proxy?.clients || [];
    if (!clients.length) return '';
    return tr`<section class="detail-section proxy-clients"><h3>检测到的代理客户端</h3><div class="table-scroll"><table class="proxy-client-table"><thead><tr><th>应用</th><th>代理</th><th class="right">连接数</th><th class="right">下载速度</th><th class="right">上传速度</th></tr></thead><tbody>${clients.map(client=>`<tr><td><button class="network-name" data-action="select-proxy-app" data-app-id="${esc(client.appId)}" data-app-name="${esc(client.name)}">${esc(client.name)}</button></td><td>${esc(client.proxyName)}</td><td class="right num">${esc(client.connections)}</td><td class="right num">${esc(measuredRate(client.measurementAvailable?client.rxPerSecond:null,speedUnit))}</td><td class="right num">${esc(measuredRate(client.measurementAvailable?client.txPerSecond:null,speedUnit))}</td></tr>`).join('')}</tbody></table></div><p class="small muted">本地代理连接 · 实时速度不计入 Wi-Fi 总量</p></section>`;
}
