import { t, tr } from '../i18n.js';
import { applicationSourceFilter } from './applications.js';

export function applicationViewTabs(view, panelId = 'appViewPanel') {
    return tr`<div class="application-view-tabs" role="tablist" aria-label="应用视图">${[['live', t('实时流量排行')], ['history', t('应用用量记录')]].map(([key, label]) => `<button role="tab" id="${panelId}-${key}" aria-controls="${panelId}" aria-selected="${view === key}" tabindex="${view === key ? 0 : -1}" data-action="application-view" data-view="${key}" class="${view === key ? 'active' : ''}">${label}</button>`).join('')}</div>`;
}

export function applicationSortOptions(context, view, option) {
    const live = view === 'live';
    const grouped = !live && context.appGrouping !== 'summary';
    const choices = live ? [['total', t('按总速度')], ['rx', t('按下载速度')], ['tx', t('按上传速度')]]
        : [['total', t('按总量')], ['rx', t('按下载')], ['tx', t('按上传')]];
    if (grouped) choices.push(['date', t('按日期')], ['name', t('按应用名称')]);
    return choices.map(([key, label]) => option(key, label, live ? context.liveSort : grouped ? context.historySort : context.appSort)).join('');
}

export function applicationFilters(context, { view, minuteSource, proxy, exportAvailable, esc, icon, option, button }) {
    const live = view === 'live';
    return tr`<div class="application-toolbar app-filters"><label class="search-box">${icon('search')}<input id="appSearch" type="search" placeholder="搜索应用" aria-label="搜索应用" value="${esc(live ? context.liveSearch : context.appSearch)}"></label><label><span class="sr-only">应用排序</span><select class="select compact" id="appSort">${applicationSortOptions(context, view, option)}</select></label>${live ? applicationSourceFilter(proxy, context.liveProxyEstimated, true) : tr`<label><span class="sr-only">历史分组</span><select class="select compact" id="appGrouping">${[['summary', t('应用汇总')], ['minute', t('按分钟')], ['hour', t('按小时')], ['day', t('按日')], ['month', t('按月')]].map(([key, label]) => option(key, label, context.appGrouping)).join('')}</select></label>${applicationSourceFilter(minuteSource ? { available: false } : proxy, !minuteSource && context.proxyEstimated)}${button('export-apps', t('导出当前表格'), 'export', 'small-btn', exportAvailable ? '' : 'disabled')}`}${button('application-control', t('选择程序'), 'folder', 'small-btn')}</div>`;
}

export function applicationWorkspace({ view, content }) {
    return tr`<section class="panel applications-page application-workspace" data-view="${view}"><header class="application-workspace-head"><div><h2>应用流量</h2><p class="panel-sub">${view === 'live' ? t('点击应用查看实时详情与代理归属。') : t('查看所选时段的用量，原生记录与代理估算分别标注。')}</p></div>${applicationViewTabs(view)}</header><div class="applications-content" id="appViewPanel" role="tabpanel" aria-labelledby="appViewPanel-${view}">${content}</div></section>`;
}
