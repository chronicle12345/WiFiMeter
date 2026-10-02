import { getLanguage } from '../i18n.js';
const text = (zh, en) => getLanguage() === 'en' ? en : zh;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const states = {
    connected:['已连接','Connected','good'], disconnected:['未连接','Disconnected','muted'],
    running:['正在采集','Collecting','good'], paused:['已暂停','Paused','warn'],
    offline:['采集器离线','Collector offline','warn'], loading:['正在连接','Connecting','muted'],
    unreadable:['无法读取网络','Network unreadable','warn'], permission:['需要系统授权','Permission required','warn'],
    disabled:['未启用','Disabled','muted'], starting:['正在启动','Starting','muted'],
    unavailable:['暂不可用','Unavailable','warn'], partial:['部分数据缺失','Partial data','warn'],
    unsupported:['平台不支持','Not supported','muted'], failed:['采样失败','Sampling failed','error'],
    ready:['可用','Ready','good'], unchecked:['尚未检查','Not checked','muted'],
    checking:['正在检查','Checking','muted'], latest:['已是最新版本','Up to date','good'],
    available:['发现新版本','Update available','good'], error:['发生错误','Error','error'],
    downloading:['正在下载','Downloading','muted'], verifying:['正在校验','Verifying','muted'], preparing:['准备安装','Preparing installation','muted'], installing:['启动安装程序','Starting installer','muted'], recovered:['已恢复采集','Collection restored','good'],
    cancelled:['已取消','Cancelled','muted'], manual:['已打开发布页','Release page opened','muted']
};
function diagnostic(source) {
    const error = source?.error;
    return (typeof error === 'string' ? error : error?.message) || source?.detail || source?.message || '';
}
/** Raw snapshot fields only; rendered proxy/update panels remain separate controls. */
export function statusRows({ live, appCollection, proxy, updates } = {}) {
    const row = (id, zh, en, state, source) => {
        const [label, english, tone] = states[state] || ['等待状态','Waiting for status','muted'];
        return { id, title:text(zh,en), label:text(label,english), tone, detail:diagnostic(source) };
    };
    return [
        row('network','网络连接','Network',live?.state),
        row('collector','网络采集','Network collection',live?.collector,live),
        row('apps','应用采集','Application collection',appCollection?.state,appCollection),
        row('proxy','代理连接','Proxy connections',proxy ? (proxy.status && proxy.status !== 'ready' ? proxy.status : proxy.available === false ? 'unavailable' : proxy.status) : undefined,proxy),
        row('updates','软件更新','Software updates',updates?.state,updates)
    ];
}
export function statusHelpView(status = {}, controls = {}) {
    const rows = statusRows(status);
    const action = (name, zh, en, icon) => controls.button?.(name,text(zh,en),icon,'small-btn','type="button"') || '';
    return `<section class="panel settings-group status-help" aria-labelledby="status-help-title">
        <div class="panel-head"><h2 id="status-help-title">${text('状态与帮助','Status and help')}</h2></div>
        <dl class="status-list">${rows.map(row => `<div class="status-item" data-status="${row.id}"><dt>${esc(row.title)}</dt><dd><span class="status-value" data-tone="${row.tone}"><i aria-hidden="true"></i>${esc(row.label)}</span>${row.detail ? `<details class="status-detail"><summary>${text('查看详情','View details')}</summary><pre>${esc(row.detail)}</pre></details>` : ''}</dd></div>`).join('')}</dl>
        <details class="status-guide"><summary>${text('统计口径与常见问题','Measurement and common questions')}</summary><div class="status-guide-body">
            <p>${text('网络用量来自网卡采样；暂停或离线期间不补算流量。','Network usage comes from adapter samples. Paused or offline intervals are not reconstructed.')}</p>
            <p>${text('应用采集需要系统权限。本地代理实时速度来自 TCP 连接计数，与 Wi-Fi 总量分开；历史估算单独标注。','Application collection requires system permission. Live local proxy rates use TCP counters and remain separate from Wi-Fi totals; historical estimates are labeled.')}</p>
            <p>${text('速率显示为 — 时，先检查网络连接和采集状态。','If the rate shows —, check the network and collection status first.')}</p>
            <div class="settings-actions">${action('demo','采集诊断','Collection diagnostics','info')}${action('help','更多帮助','More help','help')}</div>
        </div></details>
    </section>`;
}

// Update values in place so an open diagnostic remains open during live samples.
export function refreshStatusHelp(root, status) {
    if (!root) return;
    for (const row of statusRows(status)) {
        const item = root.querySelector(`[data-status="${row.id}"]`);
        if (!item) continue;
        const value = item.querySelector('.status-value');
        value.dataset.tone = row.tone;
        const label = value.lastChild;
        if (label?.nodeType === 3) label.textContent = row.label;
        let details = item.querySelector('.status-detail');
        if (row.detail && !details) {
            details = document.createElement('details');
            details.className = 'status-detail';
            const summary = document.createElement('summary');
            summary.textContent = text('查看详情', 'View details');
            details.append(summary, document.createElement('pre'));
            item.querySelector('dd').append(details);
        }
        if (details) {
            details.hidden = !row.detail;
            details.querySelector('pre').textContent = row.detail;
        }
    }
}
