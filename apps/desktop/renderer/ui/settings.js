import { statusHelpView } from './status-help.js';
import { autosaveStatus } from './autosave.js';
import { t, tr } from '../i18n.js';

function row(title, description, control) {
    return `<div class="setting-row"><div><div class="setting-title">${title}</div></div>${control}</div>`;
}
function group(title, body, subtitle = '') {
    return `<section class="panel settings-group"><div class="panel-head"><div><h2>${title}</h2></div></div>${body}</section>`;
}
function startup(settings, { toggle, option, windowPreferences }) {
    return group(t('常规'),
        row('Language / 语言','',`<select class="select" id="quickLanguage" name="language" aria-label="Language / 语言">${option('zh-CN','简体中文',settings.language||'zh-CN')}${option('en','English',settings.language||'zh-CN')}</select>`) +
        row(t('开机自启'),t('写入系统的自启动目录，登录后自动开始采集。'),toggle('autoStart',settings.autoStart,t('开机自启'))) +
        (windowPreferences ? row(t('桌面小窗'),'',toggle('miniWindow',windowPreferences.miniWindow,t('桌面小窗'))) + row(t('关闭窗口时'),'',`<select class="select" name="closeAction" aria-label="${t('关闭窗口时')}">${option('ask',t('每次询问'),windowPreferences.closeAction)}${option('tray',t('最小化到托盘'),windowPreferences.closeAction)}${option('exit',t('退出应用'),windowPreferences.closeAction)}</select>`) + `<input type="checkbox" name="minimizeToTray" hidden ${settings.minimizeToTray?'checked':''}>` : row(t('关闭窗口时最小化到托盘'),'',toggle('minimizeToTray',settings.minimizeToTray,t('关闭窗口时最小化到托盘')))) +
        (windowPreferences ? miniControls(windowPreferences,{toggle,option}) : '') +
        row(t('采样间隔'),t('后端按此间隔读取网卡计数器。'),tr`<select class="select compact" name="interval" aria-label="采样间隔">${[2,5,10].map(value=>option(value,tr`${value} 秒`,settings.interval)).join('')}</select>`),
        t('系统级开关会随系统设置生效'));
}
function miniControls(p,{toggle,option}) {
    return row(t('小窗形状'),'',`<select class="select" name="miniShape" aria-label="${t('小窗形状')}">${[['bar','条形'],['square','方形'],['circle','圆形']].map(([v,label])=>option(v,t(label),p.miniShape||'bar')).join('')}</select>`) +
        row(t('小窗配色'),'',`<select class="select" name="miniPalette" aria-label="${t('小窗配色')}">${[['indigo','靛蓝'],['dark','深色'],['light','浅色']].map(([v,label])=>option(v,t(label),p.miniPalette||'indigo')).join('')}</select>`) +
        row(t('贴边吸附'),'',toggle('miniSnap',p.miniSnap,t('贴边吸附'))) + row(t('贴边自动隐藏'),'',toggle('miniAutoHide',p.miniAutoHide,t('贴边自动隐藏')));
}
function display(settings, { toggle, option, windowPreferences }) {
    return group(t('显示与提醒'),
        (windowPreferences?row(t('主题'),'',`<select class="select" name="theme" aria-label="${t('主题')}">${option('system',t('跟随系统'),windowPreferences.theme||'system')}${option('light',t('浅色'),windowPreferences.theme)}${option('dark',t('深色'),windowPreferences.theme)}</select>`):'') +
        row(t('流量单位进制'),t('用量自动选择单位；十进制按 1000、二进制按 1024 换算。'),tr`<select class="select compact" name="unit" aria-label="流量单位进制">${option('GB',t('十进制 · KB / MB / GB'),settings.unit)}${option('GiB',t('二进制 · KiB / MiB / GiB'),settings.unit)}</select>`) +
        row(t('实时速度单位'),t('MB/s 是字节速率；Mbps 是比特速率。'),tr`<select class="select compact" name="speedUnit" aria-label="实时速度单位">${option('auto',t('自动（推荐）'),settings.speedUnit)}${option('MB/s','MB/s',settings.speedUnit)}${option('Mbps','Mbps',settings.speedUnit)}</select>`) +
        row(t('允许额度提醒'),t('各网络分别设置提醒阈值；默认不自动断网。'),toggle('notifications',settings.notifications,t('允许额度提醒'))));
}
function storage(settings, { button, option, legacy, dataLocation }) {
    const retention = tr`<select class="select compact" name="retention" aria-label="历史保留时长">
        ${option(30,t('最近 30 天'),settings.retention)}${option(90,t('最近 90 天'),settings.retention)}
        ${option(365,t('最近 365 天'),settings.retention)}${option(0,t('长期保留'),settings.retention)}
        ${![0,30,90,365].includes(settings.retention)?option(settings.retention,tr`${settings.retention} 天`,settings.retention):''}
    </select>`;
    return group(t('数据与存储'),
        (dataLocation?row(t('数据存储位置'),t('数据库文件所在文件夹；切换会复制当前数据库并保留原文件。'),dataLocation):'') +
        row(t('历史保留时长'),t('缩短保留期前会再次确认；建议先导出备份。'),retention) +
        (legacy?row(t('导入旧版数据'),t('选择旧版数据目录；导入结果与备份位置将在下方显示。'),legacy):'') +
        row(t('数据备份'),t('完整备份包含网络备注、额度及记录，不含 Wi-Fi 密码。'),`<div class="settings-actions">${button('backup',t('备份'),'export','small-btn','type="button"')}${button('restore',t('恢复'),'upload','small-btn','type="button"')}</div>`) +
        row(t('清空历史记录'),t('只清除用量记录，保留网络备注与偏好设置。'),button('clear-records',t('清空记录'),'trash','small-btn','type="button"')));
}
const categories = [['general','常规'],['display','显示'],['data','数据与迁移'],['quota','流量额度'],['proxy','代理'],['status','状态与帮助'],['about','关于更新']];
export function settingsView(settings, controls) {
    const selected = controls.category || 'general';
    const panel = (id, body) => `<div id="settings-${id}" data-settings-panel="${id}" role="region" aria-labelledby="settings-tab-${id}">${body}</div>`;
    return tr`<div class="settings-layout">
        <nav class="settings-categories" aria-label="设置分类">${categories.map(([id,label])=>`<button type="button" id="settings-tab-${id}" aria-controls="settings-${id}" ${selected===id?'aria-current="location"':''} data-action="settings-category" data-category="${id}">${t(label)}</button>`).join('')}</nav>
        <div class="settings-content settings-scroll-panel"><form class="settings-main" id="settingsForm">
        ${panel('general',startup(settings,controls))}${panel('display',display(settings,controls))}${panel('data',migration(controls)+storage(settings,{...controls,legacy:''}))}
        ${autosaveStatus('settingsSaveHint')}
        </form>${panel('quota',controls.quota)}${panel('proxy',controls.proxy)}${panel('status',statusHelpView(controls.status, controls))}${panel('about',controls.updates||group(t('关于更新'),'<div class="setting-row">WiFiMeter</div>'))}</div>
    </div>`;
}
function migration({legacy}) {
    return legacy ? group(t('导入旧版数据'),`<div class="legacy-quick-body"><p>${t('选择含 state.json 或 state.json.bak 的文件夹。')}</p><p>${t('旧版默认目录：')} <code>%LOCALAPPDATA%\\WiFiMeter\\data</code></p>${legacy}</div>`) : '';
}
