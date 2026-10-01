import { t, tr } from '../i18n.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function proxyStatus(proxy) {
    if (!proxy) return t('后端尚未提供代理估算接口。');
    if (!proxy.available) return t('当前平台不支持代理流量估算，原生应用采集不受影响。');
    return t('代理估算与原生采集独立；仅替换匹配网络和日期的代理记录，保留客户端直接流量。');
}
export function proxyForm(proxy) {
    const fields = proxy?.available ? tr`<form id="proxyConfigForm" class="quota-form">
        <div class="field"><label for="proxyPorts">代理端口</label><input class="input" id="proxyPorts" name="ports" value="${esc((proxy.ports||[]).join(', '))}" placeholder="7890, 1080"><div class="field-hint">使用逗号分隔，留空清除配置。</div></div>
        <div class="field"><label for="proxyProcesses">代理进程名（可选）</label><input class="input" id="proxyProcesses" name="processNames" value="${esc((proxy.processNames||[]).join(', '))}" placeholder="Clash.exe, v2ray.exe"></div>
        <div class="form-error" role="alert"></div><button type="submit" class="btn primary">保存代理配置</button>
    </form>` : '';
    return tr`<section class="panel settings-group"><div class="panel-head"><div><h2>代理流量估算</h2><p class="panel-sub">${proxyStatus(proxy)}</p>${proxy?.status?`<p class="small muted">${esc(proxy.status)}</p>`:''}${proxy?.detail?`<p class="small muted">${esc(proxy.detail)}</p>`:''}</div></div>${fields}</section>`;
}
export function proxySourceSelector(proxy, estimated) {
    return tr`<div class="field"><label for="appDataSource">应用数据来源</label><select class="select" id="appDataSource">
        <option value="native" ${!estimated?'selected':''}>原生记录</option>
        <option value="estimated" ${estimated?'selected':''} ${proxy?.available?'':'disabled'}>包含代理估算</option>
    </select><p class="field-hint">${proxyStatus(proxy)}</p></div>`;
}
export function estimateLabel(row) {
    return row.unattributed ? t('估算 · 未归属') : row.estimated ? t('估算') : t('原生记录');
}
