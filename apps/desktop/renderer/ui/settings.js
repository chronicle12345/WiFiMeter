import { t, tr } from '../i18n.js';

function row(title, description, control) {
    return `<div class="setting-row"><div><div class="setting-title">${title}</div><div class="setting-desc">${description}</div></div>${control}</div>`;
}
function group(title, body, subtitle = '') {
    return `<section class="panel settings-group"><div class="panel-head"><div><h2>${title}</h2>${subtitle?`<div class="panel-sub">${subtitle}</div>`:''}</div></div>${body}</section>`;
}
function startup(settings, { toggle, option }) {
    return group(t('启动与采集'),
        row(t('登录时自动启动'),t('写入系统的自启动目录，登录后自动开始采集。'),toggle('autoStart',settings.autoStart,t('登录时自动启动'))) +
        row(t('关闭窗口时最小化到托盘'),t('开启后关闭窗口只隐藏窗口，采集继续进行。'),toggle('minimizeToTray',settings.minimizeToTray,t('关闭窗口时最小化到托盘'))) +
        row(t('采样间隔'),t('后端按此间隔读取网卡计数器。'),tr`<select class="select compact" name="interval" aria-label="采样间隔">${[2,5,10].map(value=>option(value,tr`${value} 秒`,settings.interval)).join('')}</select>`),
        t('系统级开关会随系统设置生效'));
}
function display(settings, { toggle, option }) {
    return group(t('显示与提醒'),
        row(t('界面语言'),t('中英文切换，保存后生效。'),tr`<select class="select compact" name="language" aria-label="界面语言">${option('zh-CN','简体中文',settings.language||'zh-CN')}${option('en','English',settings.language||'zh-CN')}</select>`) +
        row(t('流量单位进制'),t('用量自动选择单位；十进制按 1000、二进制按 1024 换算。'),tr`<select class="select compact" name="unit" aria-label="流量单位进制">${option('GB',t('十进制 · KB / MB / GB'),settings.unit)}${option('GiB',t('二进制 · KiB / MiB / GiB'),settings.unit)}</select>`) +
        row(t('实时速度单位'),t('MB/s 是字节速率；Mbps 是比特速率。'),tr`<select class="select compact" name="speedUnit" aria-label="实时速度单位">${option('MB/s','MB/s',settings.speedUnit)}${option('Mbps','Mbps',settings.speedUnit)}</select>`) +
        row(t('允许额度提醒'),t('各网络分别设置提醒阈值；默认不自动断网。'),toggle('notifications',settings.notifications,t('允许额度提醒'))));
}
function storage(settings, { button, option, legacy }) {
    const retention = tr`<select class="select compact" name="retention" aria-label="历史保留时长">
        ${option(30,t('最近 30 天'),settings.retention)}${option(90,t('最近 90 天'),settings.retention)}
        ${option(365,t('最近 365 天'),settings.retention)}${option(0,t('长期保留'),settings.retention)}
        ${![0,30,90,365].includes(settings.retention)?option(settings.retention,tr`${settings.retention} 天`,settings.retention):''}
    </select>`;
    return group(t('数据与存储'),
        row(t('历史保留时长'),t('缩短保留期前会再次确认；建议先导出备份。'),retention) +
        (legacy?row(t('导入旧版数据'),t('选择旧版数据目录；导入结果与备份位置将在下方显示。'),legacy):'') +
        row(t('数据备份'),t('完整备份包含网络备注、额度及记录，不含 Wi-Fi 密码。'),`<div class="settings-actions">${button('backup',t('备份'),'export','small-btn','type="button"')}${button('restore',t('恢复'),'upload','small-btn','type="button"')}</div>`) +
        row(t('清空历史记录'),t('只清除用量记录，保留网络备注与偏好设置。'),button('clear-records',t('清空记录'),'trash','small-btn','type="button"')));
}
function notes(icon) {
    return tr`<aside class="panel settings-aside"><h3>安静运行，清楚记录</h3>
        <div class="check-row">${icon('shield')}<span>网络记录与提醒规则保存在本机，不需要账号。</span></div>
        <div class="check-row">${icon('wifi')}<span>按 Wi-Fi 归属流量，不将未知区间强行计入某个网络。</span></div>
        <div class="check-row">${icon('database')}<span>历史总量与应用统计独立展示，避免相加造成重复。</span></div>
        <div class="check-row">${icon('bell')}<span>超额默认只提醒。自动断网须在网络详情里明确开启。</span></div>
        <div class="note-box" style="padding:12px;font-size:10px">历史、额度与偏好都保存在本机数据库。开机启动与托盘属于系统级设置。</div>
    </aside>`;
}
export function settingsView(settings, controls) {
    return tr`<div class="settings-layout"><form class="settings-main" id="settingsForm">
        ${startup(settings,controls)}${display(settings,controls)}${storage(settings,controls)}
        <div class="save-bar"><span id="settingsSaveHint">更改后点击保存，防止误操作。</span><div class="flex gap8">
        ${controls.button('discard-settings',t('取消更改'),'','','type="button"')}
        <button type="submit" class="btn primary">${controls.icon('check')}保存设置</button></div></div>
    </form>${notes(controls.icon)}</div>`;
}
