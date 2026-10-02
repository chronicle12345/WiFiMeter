import { applicationLiveRows } from './data/application-live.js';
import { refreshStatusHelp } from './ui/status-help.js';
import { createAutosave, autosaveStatus } from './ui/autosave.js';
import { parseWarnPercents, quotaThresholds } from './data/quota-thresholds.js';
import { formatSpeedParts } from './data/speed.js';
import { createRenderScheduler } from './data/render-scheduler.js';
import { updatesView, refreshUpdates } from './ui/updates.js';
import { isEthernet, networkDisplayName } from './data/networks.js';
import { proxyConfigPatch, proxyUsageRecords } from './data/proxy.js';
import { proxyForm, proxyClientsView, estimateLabel } from './ui/proxy.js';
import { settingsView } from './ui/settings.js';
import { drawerShell } from './ui/drawer.js';
import { applicationDetails, applicationSourceFilter } from './ui/applications.js';
import { applicationSummary, applicationAvatar } from './ui/applications.js';
import { createAppIconLoader } from './ui/app-icons.js';
import { appControlView } from './ui/app-control.js';
import { t, tr, setLanguage, getLocale } from './i18n.js';
import { totalQuotaForm, totalQuotaCard } from './ui/total-quota.js';
import { updateRegion } from './data/render.js';
import { createAppControlModel, legacyMessage } from './data/desktop-actions.js';
import { historyRange, applicationRows, applicationCsv } from './data/history.js';
import { MAX_QUOTA_GB, validQuotaGb, GB, GiB, B, byteUnitFor, formatByteParts, dayKey, dateOf, shiftDay, today, monthStart, niceDate, totalOf, validDate, quotaFor, bytePercent, sortApps } from './data/model.js';
import { createDataClient } from './data/client.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const params = new URLSearchParams(location.search);
const icons = {
 ethernet:'<rect x="4" y="3" width="16" height="12" rx="2"/><path d="M8 15v4h8v-4M8 7v3M12 7v3M16 7v3M12 19v3"/>',
 wifi:'<path d="M2 8.5a16 16 0 0 1 20 0M5.5 12a10.5 10.5 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0"/><circle cx="12" cy="19" r=".7" fill="currentColor"/>',
 overview:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
 history:'<path d="M3 12a9 9 0 1 0 2.5-6.2M3 4v5h5M12 7v5l3 2"/>',
 settings:'<path d="M4 7h16M4 17h16"/><rect x="7" y="4" width="4" height="6" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="14" width="4" height="6" rx="1" fill="currentColor" stroke="none"/>',
 down:'<path d="M12 3v17M6 14l6 6 6-6"/>', up:'<path d="M12 21V4M6 10l6-6 6 6"/>',
 transfer:'<path d="M8 3v17M3 15l5 5 5-5M16 21V4M11 9l5-5 5 5"/>',
 export:'<path d="M12 3v12M7 10l5 5 5-5M4 16v5h16v-5"/>',
 arrow:'<path d="m9 5 7 7-7 7"/>', calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M7 14h2M13 14h2M7 17h2"/>',
 bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
 shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-5"/>',
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
 help:'<circle cx="12" cy="12" r="9"/><path d="M9.4 9a2.6 2.6 0 0 1 5.2 0c0 2-2.6 2-2.6 4M12 17h.01"/>',
 pause:'<path d="M8 5v14M16 5v14"/>',play:'<path d="m8 4 12 8-12 8Z"/>',
 search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
 close:'<path d="m6 6 12 12M18 6 6 18"/>',check:'<path d="m5 12 4 4L19 6"/>',
 home:'<path d="m3 10 9-7 9 7M5 9v12h14V9M10 21v-7h4v7"/>',
 office:'<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M8 7h1M15 7h1M8 11h1M15 11h1M10 21v-6h4v6"/>',
 phone:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4M11 19h2"/>',
 coffee:'<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9ZM17 9h2a3 3 0 0 1 0 6h-2M3 22h16M7 3v2M12 3v2"/>',
 edit:'<path d="m14 5 5 5M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z"/>',
 copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/>',
 folder:'<path d="M3 6h7l2 3h9v11H3V6Z"/>',
 offline:'<path d="m3 3 18 18M2 8.5a16 16 0 0 1 4-2.5M10 5a16 16 0 0 1 12 3.5M5.5 12a10.5 10.5 0 0 1 3-1.6M14 10.2a10.5 10.5 0 0 1 4.5 1.8M9 15.5a5 5 0 0 1 6 0"/><circle cx="12" cy="19" r=".7"/>',
 alert:'<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
 reset:'<path d="M3 9V3M3 9h6M3 9a9 9 0 1 1 .7 7"/>',
 signal:'<path d="M4 20v-3M9 20v-7M14 20V9M19 20V4"/>',
 database:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
 upload:'<path d="M12 17V4M7 9l5-5 5 5M4 17v4h16v-4"/>',
 trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>'
};
const icon = (name, extra = '') => `<svg class="icon ${extra}" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.wifi}</svg>`;
const productName = window.desktop.appName;
const appControl=createAppControlModel(window.desktop);
const appIcons=createAppIconLoader({request:window.desktop.appIcons?.get});
let legacyResult=null,legacyBusy=false;
let settingsCategory='general',windowPreferences=null;
if(window.desktop.windowPreferences?.read){try{windowPreferences=await window.desktop.windowPreferences.read();}catch(error){console.warn('Window preferences unavailable',error);}}
const systemTheme=window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme(){const theme=windowPreferences?.theme||'system';document.documentElement.dataset.theme=theme==='system'?(systemTheme.matches?'dark':'light'):theme;}
applyTheme();systemTheme.addEventListener('change',applyTheme);
$('.brand-name').textContent = productName;
// 数据来自本机后端进程；snapshot 是同一个对象，客户端收到事件后就地更新。
const store = createDataClient({onLive:refreshLive,onUsage:refreshLive,onAlert:showAlert});
let data=store.snapshot;
let storageFailed=false;
const ui={page:['overview','networks','apps','history','settings'].includes(location.hash.slice(1))?location.hash.slice(1):'overview',period:'month',start:monthStart(today()),end:today(),networkId:'all',search:'',sort:'total',historyPage:1,drawer:null,modal:null,activeInterfaceId:null,lastFocus:null};
const applications={appSearch:'',appSort:'total',appAll:false,appGrouping:'summary',proxyEstimated:false,historySort:'date',historyDirection:'desc',selectedApp:null};
function appContext(){const drawer=ui.drawer?.kind==='app'?ui.drawer.parent:ui.drawer;return drawer?.tab==='apps'?drawer:applications;}
function appNetworkId(){const drawer=ui.drawer?.kind==='app'?ui.drawer.parent:ui.drawer;return drawer?.tab==='apps'?drawer.id:ui.networkId;}
function applicationsPage(){return `${toolbar()}<section class="panel applications-page"><div class="applications-content">${drawerApps({id:ui.networkId})}</div></section>`;}
let samplerTimer=null,lastTick=performance.now(),settingsDirty=false;
function fmtExport(bytes,precision=6){const divisor=data.settings.unit==='GiB'?GiB:GB;return (Number(B(bytes))/Number(divisor)).toLocaleString('en-US',{minimumFractionDigits:precision,maximumFractionDigits:precision});}
function fmtWithUnit(bytes){const {value,unit}=formatByteParts(bytes,data.settings.unit);return `${value} ${unit}`;}
function fmtNumber(bytes,hasRecords=true){if(!hasRecords)return '—';const {value,unit}=formatByteParts(bytes,data.settings.unit);return `${value}<span>${unit}</span>`;}
function speed(bytes){return formatSpeedParts(bytes,data.settings.speedUnit).value;}
function speedUnit(bytes){return formatSpeedParts(bytes,data.settings.speedUnit).unit;}
function speedLabel(bytes){const parts=formatSpeedParts(bytes,data.settings.speedUnit);return `${parts.value} ${parts.unit}`;}
function getRange(){return historyRange(ui.period,today(),ui);}
function periodName(){return {today:t('今日'),week:t('近 7 天'),month:t('本月'),custom:t('所选期间'),all:t('全部历史')}[ui.period];}
function rangeText(){const r=getRange();if(ui.period==='all')return t('全部已保留历史');return r.start===r.end?`${r.start.replaceAll('-',' / ')}`:`${r.start.replaceAll('-',' / ')} — ${r.start.slice(0,4)===r.end.slice(0,4)?r.end.slice(5).replace('-',' / '):r.end.replaceAll('-',' / ')}`;}
function networkName(n){return networkDisplayName(n,data.live.state==='connected'?data.live.connections:[]);}
function getNetwork(id){return data.networks.find(n=>n.id===id);}
function getConnection(){return data.live.connections.find(c=>c.interfaceId===ui.activeInterfaceId)||data.live.connections[0]||null;}
function isConnected(id){return data.live.state==='connected'&&data.live.connections.some(c=>c.networkId===id);}
function selectedRows(networkId=ui.networkId){const {start,end}=getRange();return data.records.filter(r=>r.date>=start&&r.date<=end&&(networkId==='all'||r.networkId===networkId));}
function quota(n){return quotaFor(data,n);}
function groupedDays(networkId=ui.networkId){const map=new Map();for(const r of selectedRows(networkId)){const v=map.get(r.date)||{date:r.date,rx:0n,tx:0n};v.rx+=B(r.rxBytes);v.tx+=B(r.txBytes);map.set(r.date,v);}return [...map.values()].sort((a,b)=>a.date.localeCompare(b.date));}
function chartRows(networkId=ui.networkId){
 const r=getRange();
 if(ui.period==='today'){
  const subset=data.hourly.filter(v=>v.date===r.start&&(networkId==='all'||v.networkId===networkId));if(!subset.length)return [];
  const m=new Map();for(const x of subset){const a=m.get(x.hour)||{rx:0n,tx:0n};a.rx+=B(x.rxBytes);a.tx+=B(x.txBytes);m.set(x.hour,a);}
  return Array.from({length:new Date().getHours()+1},(_,i)=>({key:`${i}:00`,label:`${String(i).padStart(2,'0')}:00`,...(m.get(i)||{rx:0n,tx:0n,missing:true})}));
 }
 const rows=groupedDays(networkId);if(!rows.length)return [];
 // 长区间按有记录的月份展示，避免把全部历史截成最早 367 天。
 if(ui.period==='all'||(+dateOf(r.end)-+dateOf(r.start))/86400000>365){
  const months=new Map();for(const row of rows){const key=row.date.slice(0,7),v=months.get(key)||{key,label:key,rx:0n,tx:0n};v.rx+=row.rx;v.tx+=row.tx;months.set(key,v);}return [...months.values()];
 }
 const m=new Map(rows.map(x=>[x.date,x]));const all=[];
 for(let k=r.start;k<=r.end&&all.length<367;k=shiftDay(k,1)){const x=m.get(k);all.push({key:niceDate(k),label:`${Number(k.slice(5,7))}/${Number(k.slice(8))}`,rx:x?.rx||0n,tx:x?.tx||0n,missing:!x});}
 return all;
}
function chartUnit(rows){return byteUnitFor(rows.reduce((peak,r)=>r.rx+r.tx>peak?r.rx+r.tx:peak,0n),data.settings.unit);}
function chartSvg(rows,id='usage-chart') {
 if(!rows.length)return `<div class="loading-box">${ui.period==='today'?t('暂无小时明细'):t('所选时段暂无流量记录')}</div>`;
 const w=660,h=194,left=43,right=9,top=18,bottom=30,pw=w-left-right,ph=h-top-bottom;
 const {unit,divisor:bytesPerUnit}=chartUnit(rows),divisor=Number(bytesPerUnit),vals=rows.map(r=>Number(r.rx+r.tx)/divisor),peak=Math.max(...vals,1);
 const power=10**Math.floor(Math.log10(peak)),step=Math.ceil(peak/power/4)*power,max=step*4;
 let s=tr`<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="${id}-title ${id}-desc"><title id="${id}-title">${esc(periodName())}上传与下载流量（${unit}）</title><desc id="${id}-desc">单位 ${unit}；深蓝色代表下载，浅蓝色代表上传。缺失日期不表示零用量。可聚焦每根柱查看数据。</desc><text x="${left}" y="11">${unit}</text>`;
 for(let i=0;i<=4;i++){const y=top+ph-ph*i/4,v=max*i/4;s+=`<line class="gridline" x1="${left}" y1="${y}" x2="${w-right}" y2="${y}"/><text x="${left-10}" y="${y+3}" text-anchor="end">${v.toLocaleString('en-US',{maximumFractionDigits:2})}</text>`;}
 const cell=pw/rows.length,bw=Math.min(26,cell*.56),labelStep=rows.length<=8?1:Math.ceil(rows.length/6);
 rows.forEach((r,i)=>{
  const x=left+cell*i+cell/2-bw/2,rxH=ph*(Number(r.rx)/divisor)/max,txH=ph*(Number(r.tx)/divisor)/max,y=top+ph;
  s+=`<g class="bar-group" tabindex="0" data-chart-point="1" data-key="${esc(r.key)}" data-rx="${r.rx}" data-tx="${r.tx}" data-missing="${r.missing?'1':'0'}" aria-label="${esc(r.key)}，${r.missing?t('无记录'):tr`下载 ${fmtWithUnit(r.rx)}，上传 ${fmtWithUnit(r.tx)}`}">`;
  if(r.missing)s+=`<line x1="${x}" y1="${y-1}" x2="${x+bw}" y2="${y-1}" stroke="#cedaeb" stroke-dasharray="2 2"/>`;
  else s+=`<rect class="bar-rx" x="${x}" y="${y-rxH}" width="${bw}" height="${rxH}" rx="2"/><rect class="bar-tx" x="${x}" y="${y-rxH-txH}" width="${bw}" height="${txH}" rx="2"/>`;
  s+=`<rect class="bar-hit" x="${left+cell*i}" y="${top}" width="${cell}" height="${ph+5}"/></g>`;
  if(i%labelStep===0||(i===rows.length-1&&(rows.length-1)%labelStep>labelStep/2))s+=`<text x="${x+bw/2}" y="${h-9}" text-anchor="middle">${esc(r.label)}</text>`;
 });
 return s+'</svg>';
}
function toast(text,error=false){const e=document.createElement('div');e.className='toast'+(error?' error':'');e.innerHTML=icon(error?'alert':'check')+`<div>${esc(text)}</div>`;while($('#toasts').children.length>=2)$('#toasts').firstElementChild.remove();$('#toasts').append(e);setTimeout(()=>e.remove(),4200);}
function empty(title=t('暂无流量记录'),text=t('连接 Wi-Fi 后，采集器会从新的基线开始记录。'),button=''){return `<div class="empty-state"><div class="empty-icon">${icon('wifi')}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${button}</div>`;}
function button(action,label,ico='',cls='',extra=''){return `<button class="btn ${cls}" data-action="${action}" ${extra}>${ico?icon(ico):''}${label}</button>`;}
function toggle(name,checked,label){return `<label class="switch"><input type="checkbox" name="${name}" ${checked?'checked':''} aria-label="${esc(label)}"><span class="switch-track"></span></label>`;}
function option(v,label,selected){return `<option value="${esc(v)}" ${String(v)===String(selected)?'selected':''}>${esc(label)}</option>`;}
function networkOptions(selected=ui.networkId,all=true){return (all?option('all',t('全部网络'),selected):'')+data.networks.map(n=>option(n.id,networkName(n),selected)).join('');}
function toolbar(){return tr`<div class="toolbar"><div class="toolbar-start"><div class="segmented" aria-label="统计时间范围">${[['today',t('今日')],['week',t('近 7 天')],['month',t('本月')],['all',t('全部历史')],['custom',t('自定义')]].map(([k,v])=>`<button data-action="period" data-value="${k}" class="${ui.period===k?'active':''}" aria-pressed="${ui.period===k}">${v}</button>`).join('')}</div><div class="date-text">${icon('calendar')}${esc(rangeText())}</div></div><label><span class="sr-only">按网络筛选</span><select class="select compact" id="networkFilter">${networkOptions()}</select></label><div class="toolbar-actions">${button('refresh',t('刷新'),'reset')}${button('export',t('导出数据'),'export')}</div></div>`;}
function renderChrome(){
 document.documentElement.dataset.page=ui.page;
 setLanguage(data.settings.language||'zh-CN');document.documentElement.lang=getLocale();
 $('.brand-sub')?.remove();$('.nav-label')?.remove();$('.sidebar').setAttribute('aria-label',t('主导航'));
 const labels={overview:[t('流量总览'),t('查看用量、连接状态与网络额度。')],networks:[t('我的网络'), ''],apps:[t('应用流量'),''],history:[t('历史记录'),t('按时间回看用量，保留清晰的流量记录。')],settings:[t('偏好设置'),t('让统计方式，适合你的使用习惯。')]};
 const [title,description]=labels[ui.page];document.title=`${productName} · ${title}`;
 updateRegion($('#brandMark'),'<img src="../assets/icon.png" alt="" width="37" height="37">');
 updateRegion($('#nav'),[['overview','overview',t('总览')],['networks','wifi',t('网络')],['apps','shield',t('应用流量')],['history','history',t('历史')],['settings','settings',t('设置')]].map(([id,ico,label])=>`<button class="nav-item ${ui.page===id?'active':''}" data-action="navigate" data-page="${id}" ${ui.page===id?'aria-current="page"':''}>${icon(ico)}<span class="nav-text">${label}</span>${id==='networks'?`<span class="nav-count">${data.networks.length}</span>`:''}</button>`).join(''));
 const running=data.live.collector==='running'&&data.live.state!=='offline',paused=data.live.collector==='paused';
 updateRegion($('#collector'),tr`<div class="flex gap8"><i class="dot ${paused?'warn':!running?'gray':''}"></i><span class="collector-title">${paused?t('统计已暂停'):running?t('正在采集'):t('采集器未就绪')}</span></div>${button('pause',paused?t('恢复统计'):t('暂停统计'),paused?'play':'pause','small-btn',!running&&!paused?'disabled':'')}`);
 updateRegion($('#sidebarFooter'),'');
 $('#pageHead')?.remove();
 updateRegion($('#footer'),storageFailed?tr`<div role="alert">无法连接采集后端，请检查状态</div>`:'');
}
function connectionPanel(){
 const c=getConnection(),n=c?getNetwork(c.networkId):null,state=data.live.state;
 if(state==='loading')return tr`<div class="connection"><div class="connection-icon">${icon('clock')}</div><div><div class="connection-title">等待本机采集器</div><div class="connection-details">正在连接本机采集后端。</div></div>${button('demo',t('查看状态'),'reset','','style="margin-left:auto"')}</div>`;
 if(state==='permission')return tr`<div class="connection warn"><div class="connection-icon">${icon('shield')}</div><div><div class="connection-title">无法读取 Wi-Fi 名称</div><div class="connection-details">网络身份权限不足 · 未识别流量不会记到上一个 Wi-Fi</div></div>${button('permission-help',t('处理方式'),'arrow','','style="margin-left:auto"')}</div>`;
 if(state==='offline'||data.live.collector==='offline')return tr`<div class="connection error"><div class="connection-icon">${icon('alert')}</div><div><div class="connection-title">采集器暂未响应</div><div class="connection-details">下方为已保存的记录，不代表当前实时状态。</div></div>${button('demo',t('检查状态'),'reset','','style="margin-left:auto"')}</div>`;
 if(state==='unreadable')return tr`<div class="connection warn"><div class="connection-icon">${icon('alert')}</div><div><div class="connection-title">无法读取 Wi-Fi 信息</div><div class="connection-details">${esc(data.live.message||t('无法确认连接信息'))}</div></div>${button('demo',t('查看状态'),'arrow','','style="margin-left:auto"')}</div>`;
 if(state==='disconnected'||!c)return tr`<div class="connection"><div class="connection-icon">${icon('offline')}</div><div><div class="connection-title">尚未连接 Wi-Fi</div><div class="connection-details">历史记录仍可查看；重新连接后从新的基线开始统计。</div></div>${button('demo',t('查看连接'),'arrow','','style="margin-left:auto"')}</div>`;
 const paused=data.live.collector==='paused',more=data.live.connections.length-1;
 // 刚连上新网络、还没有产生任何流量时，快照里只有连接而没有对应的网络条目，
 // getNetwork 会返回 undefined：这时 SSID 只能从连接本身取，不能直接读 n.ssid。
 const ssid=n?.ssid??c.ssid??'',wired=isEthernet(c)||isEthernet(n);
 return tr`<div class="connection"><div class="connection-icon">${icon(wired?'ethernet':'wifi')}</div><div><div class="connection-title">${esc(networkName(n??c))}<span class="pill"><i class="dot"></i>已连接</span>${more?tr`<button class="pill gray" data-action="connections">+${more} 张网卡</button>`:''}</div><div class="connection-details">${wired?`<span>${esc(c.adapterAlias)}</span><span>${t('有线网络')}</span>`:tr`<span>${esc(ssid)}</span><span class="divider-dot">/</span><span>${esc(c.band)}</span><span class="divider-dot">/</span><span>信号 ${c.signal}%</span>`}${paused?t('<span class="pill warn">统计已暂停</span>'):''}</div></div><div class="connection-right"><div class="rate"><div class="rate-label">${icon('down')}当前下载</div><div class="rate-value num"><b data-live-rx style="font-weight:inherit">${paused?'—':speed(c.rxPerSecond)}</b><span data-live-rx-unit>${speedUnit(c.rxPerSecond)}</span></div></div><div class="rate"><div class="rate-label">${icon('up')}当前上传</div><div class="rate-value num"><b data-live-tx style="font-weight:inherit">${paused?'—':speed(c.txPerSecond)}</b><span data-live-tx-unit>${speedUnit(c.txPerSecond)}</span></div></div>${n?tr`<button class="icon-btn" aria-label="查看当前网络详情" data-action="detail" data-id="${n.id}">${icon('arrow')}</button>`:''}</div></div>`;
}
function metrics(){const rows=selectedRows(),v=totalOf(rows),count=new Set(rows.map(r=>r.networkId)).size;return tr`<div class="metrics"><div class="metric featured"><div class="metric-title"><span>${periodName()} ${t('总用量')}</span>${icon('transfer')}</div><div class="metric-number">${fmtNumber(v.total,rows.length)}</div><div class="metric-note positive">${rows.length?tr`${count} 个网络 · 本机累计记录`:t('暂无记录，不代表零流量')}</div></div><div class="metric"><div class="metric-title"><span>下载流量</span>${icon('down')}</div><div class="metric-number">${fmtNumber(v.rx,rows.length)}</div><div class="metric-note">${v.total?tr`占总用量 ${(Number(v.rx)*100/Number(v.total)).toFixed(1)}%`:t('等待采样记录')}</div></div><div class="metric"><div class="metric-title"><span>上传流量</span>${icon('up')}</div><div class="metric-number">${fmtNumber(v.tx,rows.length)}</div><div class="metric-note">${v.total?tr`占总用量 ${(Number(v.tx)*100/Number(v.total)).toFixed(1)}%`:t('等待采样记录')}</div></div></div>`;}
function trendPanel(){const r=getRange(),rows=chartRows(),unit=chartUnit(rows).unit;return tr`<section class="panel"><div class="panel-head"><div><h2>流量趋势</h2><div class="panel-sub">${niceDate(r.start)} — ${niceDate(r.end)} · ${ui.period==='today'?t('按小时'):ui.period==='all'||(+dateOf(r.end)-+dateOf(r.start))/86400000>365?t('按月'):t('按日')}</div></div><div class="legend"><span><i></i>下载</span><span><i class="tx"></i>上传</span></div></div><div class="chart-wrap">${chartSvg(rows)}</div><div class="chart-caption"><span>单位：${unit}</span>${ui.period==='today'?tr`<span>今日尚未结束</span>`:''}</div></section>`;}
function quotaPanel(){
 const n=getNetwork(getConnection()?.networkId)||data.networks[0];if(!n)return tr`<section class="panel quota-card"><div class="panel-head"><h2>网络额度</h2></div>${empty(t('尚无网络'),t('连接并开始记录后，可设置流量额度。'))}</section>`;
 const q=quota(n),cls=q.percent>=100?'red':q.percent>=n.warnPercent?'warn':'';
 return tr`<section class="panel quota-card"><div class="panel-head"><div><h2>网络额度</h2><div class="panel-sub">${esc(networkName(n))} · ${q.period}固定周期</div></div><button class="icon-btn" data-action="detail" data-tab="settings" data-id="${n.id}" aria-label="设置该网络额度">${icon('edit')}</button></div><div class="quota-body"><div class="quota-label">${n.capGb?t('剩余额度'):t('尚未设置流量额度')}</div><div class="quota-main">${fmtNumber(q.remaining,n.capGb)}</div><div class="progress ${cls}" role="progressbar" aria-label="网络额度使用比例" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100,Math.round(q.percent))}"><span style="width:${Math.min(100,q.percent)}%"></span></div><div class="progress-meta"><span>${n.capGb?tr`已用 ${fmtWithUnit(q.used)} / ${fmtWithUnit(q.cap)}`:t('不限制用量')}</span><span>${n.capGb?`${q.percent.toFixed(1)}%`:''}</span></div>${n.capGb?`<div class="quota-foot">${icon(n.notify?'bell':'info')}<span>${n.capGb?(n.notify?tr`达到 ${quotaThresholds(n).join(', ')}% 时提醒`:t('流量提醒未开启')):''}${n.capGb&&!n.autoDisconnect?t('，不自动断网'):''}</span></div>`:''}</div></section>`;
}
function networkTable(full=false){
 const needle=ui.search.toLowerCase();let list=data.networks.filter(n=>(ui.networkId==='all'||n.id===ui.networkId)&&(!full||`${networkName(n)} ${n.ssid}`.toLowerCase().includes(needle))).map(n=>({...n,usage:totalOf(selectedRows(n.id)),hasRecords:selectedRows(n.id).length>0}));
 list.sort((a,b)=>ui.sort==='name'?networkName(a).localeCompare(networkName(b),getLocale()):ui.sort==='connected'?Number(isConnected(b.id))-Number(isConnected(a.id)):(a.usage.total>b.usage.total?-1:a.usage.total<b.usage.total?1:0));
 if(!list.length)return empty(full&&needle?t('没有匹配的网络'):t('暂无网络记录'),full&&needle?t('试试其他 SSID 或网络备注。'):t('首次连接后会在这里出现，不需要手动添加。'));
 return tr`<div class="table-scroll"><table><thead><tr><th>网络名称</th><th class="right">下载</th><th class="right">上传</th><th class="right">总用量</th><th>额度进度 <span class="tiny">/ 独立周期</span></th><th><span class="sr-only">操作</span></th></tr></thead><tbody>${list.map(n=>{const q=quota(n),cl=q.percent>=100?'red':q.percent>=n.warnPercent?'warn':'';return tr`<tr><td><div class="network-cell"><div class="network-symbol ${isConnected(n.id)?'current':''}">${icon(n.type)}</div><div><div class="flex gap8"><button class="network-name" data-action="detail" data-id="${n.id}">${esc(networkName(n))}</button>${isConnected(n.id)?t('<i class="dot" title="已连接"></i>'):''}</div><div class="network-ssid">${esc(n.ssid)}</div></div></div></td><td class="right">${n.hasRecords?fmtWithUnit(n.usage.rx):'—'}</td><td class="right">${n.hasRecords?fmtWithUnit(n.usage.tx):'—'}</td><td class="right strong">${n.hasRecords?fmtWithUnit(n.usage.total):'—'}</td><td><div class="table-limit">${n.capGb?`<span class="${cl==='warn'?'muted':''}">${q.percent.toFixed(0)}% <span class="tiny muted">/ ${q.period}</span></span><span class="mini-progress ${cl}"><i style="width:${Math.min(100,q.percent)}%"></i></span>`:t('<span class="tiny muted">未设置额度</span>')}</div></td><td><button class="icon-btn" data-action="detail" data-id="${n.id}" aria-label="查看 ${esc(networkName(n))} 详情">${icon('arrow')}</button></td></tr>`;}).join('')}</tbody></table></div>`;
}
function quotaNotice(){const alerts=data.networks.filter(n=>n.capGb&&n.notify&&quota(n).percent>=n.warnPercent);if(!alerts.length)return '';const n=alerts[0],q=quota(n);return tr`<div class="notice-line">${icon('bell')}<span>${esc(networkName(n))} · ${q.period} 用量已达 ${q.percent.toFixed(0)}%${q.percent<100?tr`，剩余 ${fmtWithUnit(q.remaining)}`:t('，已超过所设额度')}。</span><button class="link-btn" style="margin-left:auto" data-action="detail" data-id="${n.id}" data-tab="settings">查看额度 ${icon('arrow')}</button></div>`;}
function overview(){return tr`${toolbar()}${connectionPanel()}${metrics()}${totalQuotaCard(data.totalQuota,data.settings.unit)}<div class="chart-row">${trendPanel()}${quotaPanel()}</div>${quotaNotice()}`;}
function networksPage(){return tr`${toolbar()}<section class="panel table-panel"><div class="filter-line"><label class="search-box">${icon('search')}<input id="networkSearch" type="search" placeholder="搜索网络备注或 SSID" value="${esc(ui.search)}" aria-label="搜索网络"></label><div class="flex gap12"><span class="small muted">共 ${data.networks.length} 个网络</span><label><span class="sr-only">网络排序</span><select id="networkSort" class="select compact">${option('total',t('按用量排序'),ui.sort)}${option('name',t('按名称排序'),ui.sort)}${option('connected',t('已连接优先'),ui.sort)}</select></label></div></div><div id="networkTableRegion">${networkTable(true)}</div></section>`;}
function historyPage(){
 const days=groupedDays(),all=totalOf(selectedRows()),max=days.reduce((m,x)=>x.rx+x.tx>m.rx+m.tx?x:m,{date:'',rx:0n,tx:0n}),average=days.length?all.total/BigInt(days.length):0n,pages=Math.max(1,Math.ceil(days.length/10));ui.historyPage=Math.min(ui.historyPage,pages);const sliced=days.slice().reverse().slice((ui.historyPage-1)*10,ui.historyPage*10);
 return tr`${toolbar()}<div class="history-top"><div class="panel history-stat"><div class="metric-title">${periodName()} ${t('总用量')}</div><div class="metric-number">${fmtNumber(all.total,days.length)}</div><div class="metric-note">有记录的日期：${days.length} 天</div></div><div class="panel history-stat"><div class="metric-title">日均用量</div><div class="metric-number">${fmtNumber(average,days.length)}</div><div class="metric-note">仅按有记录的日期计算</div></div><div class="panel history-stat"><div class="metric-title">单日最高用量</div><div class="metric-number">${fmtNumber(max.rx+max.tx,days.length)}</div><div class="metric-note">${max.date?niceDate(max.date):t('暂无记录')}</div></div></div>${trendPanel()}<section class="panel table-panel" style="margin-top:18px"><div class="panel-head"><div><h2>每日明细</h2><div class="panel-sub">本机采集 · 日期按本地时间归档</div></div></div>${days.length?tr`<div class="table-scroll"><table><thead><tr><th>日期</th><th class="right">下载流量</th><th class="right">上传流量</th><th class="right">总用量</th><th>记录说明</th></tr></thead><tbody>${sliced.map(d=>`<tr><td>${d.date}</td><td class="right">${fmtWithUnit(d.rx)}</td><td class="right">${fmtWithUnit(d.tx)}</td><td class="right strong">${fmtWithUnit(d.rx+d.tx)}</td><td><span class="pill ${d.date===today()?'warn':'gray'}">${d.date===today()?t('当日未结束'):t('已保存记录')}</span></td></tr>`).join('')}</tbody></table></div><div class="pagination"><span>共 ${days.length} 天 · 每页 10 条</span><div class="flex gap8">${button('history-prev',t('上一页'),'','small-btn',ui.historyPage<=1?'disabled':'')}<span>${ui.historyPage} / ${pages}</span>${button('history-next',t('下一页'),'','small-btn',ui.historyPage>=pages?'disabled':'')}</div></div>`:empty(t('所选时段没有记录'),t('更换日期或网络试试；缺失记录不会被当作零流量。'))}</section>`;
}
let updateStatus = {}, updateBusy = false;
function settingsPage(){return settingsView(data.settings,{button,toggle,option,icon,category:settingsCategory,windowPreferences,status:{live:data.live,appCollection:data.appCollection,proxy:data.proxy,updates:updateStatus},legacy:window.desktop.legacy?legacyPanel():'',updates:window.desktop.updates?updatesView(updateStatus,updateBusy):'',quota:totalQuotaForm(data.totalQuota),proxy:proxyForm(data.proxy)});}
function receiveWindowPreferences(next){
 const previous=windowPreferences;windowPreferences=next;applyTheme();
 for(const key of ['miniWindow','closeAction','theme','miniShape','miniPalette','miniSnap','miniAutoHide']){
  const input=$('#settingsForm [name="'+key+'"]');if(!input||formSaves.get(input.form)?.has(key))continue;
  const value=input.type==='checkbox'?input.checked:input.value;
  if(!previous||value===(previous[key]??(key==='theme'?'system':undefined))){if(input.type==='checkbox')input.checked=next[key];else input.value=next[key]??'system';}
 }
}
async function reloadWindowPreferences(){if(window.desktop.windowPreferences?.read)receiveWindowPreferences(await window.desktop.windowPreferences.read());}
function markSettingsCategory(category){
 settingsCategory=category;
 for(const link of $$('[data-action="settings-category"]')){if(link.dataset.category===category)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');}
}
function selectSettingsCategory(category){
 markSettingsCategory(category);
 $('#settings-'+category)?.scrollIntoView({block:'start',behavior:'instant'});
}
let settingsScrollFrame=null;
function updateSettingsScroll(){
 if(ui.page!=='settings')return;
 const panels=$$('[data-settings-panel]');if(!panels.length)return;
 let active=panels[0];
 for(const panel of panels)if(panel.getBoundingClientRect().top<=48)active=panel;
 if(window.scrollY>0&&window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-2)active=panels.at(-1);
 markSettingsCategory(active.dataset.settingsPanel);
}
window.addEventListener('scroll',()=>{if(settingsScrollFrame!==null)return;settingsScrollFrame=requestAnimationFrame(()=>{settingsScrollFrame=null;updateSettingsScroll();});},{passive:true});
function renderMain(){
 renderChrome();
 updateRegion($('#content'),({overview,networks:networksPage,apps:applicationsPage,history:historyPage,settings:settingsPage}[ui.page])(),{force:ui.page==='settings'});
 syncSaveFlags();
 syncInert();
 appIcons.hydrate(document);
}
function renderSettingsDrafts(preserveSettings=true){
 const focused=document.activeElement,focusName=focused?.name,focusForm=focused?.form?.id,start=focused?.selectionStart,end=focused?.selectionEnd;
 const dirty=preserveSettings&&settingsDirty;
 const ids=[...(preserveSettings?['settingsForm']:[]),'totalQuotaForm','proxyConfigForm'];
 const drafts=ids.map(id=>[id,$('#'+id)?new FormData($('#'+id)):null]);
 renderMain();
 for(const [id,draft] of drafts){
  const form=$('#'+id);if(!draft||!form)continue;
  for(const input of $$('[name]',form)){
   if(input.name==='language')continue;
   if(input.type==='checkbox')input.checked=draft.has(input.name);else input.value=draft.get(input.name);
  }
 }
 if(focusForm&&focusName){const input=$('#'+focusForm)?.elements.namedItem(focusName);input?.focus();if(input?.setSelectionRange&&start!=null)input.setSelectionRange(start,end);}
 settingsDirty=dirty;
 if(dirty&&$('#settingsSaveHint'))$('#settingsSaveHint').textContent=t('有尚未保存的更改。');
}
async function navigate(page){
 await flushAutosaves(['settingsForm','totalQuotaForm','proxyConfigForm','networkForm']);
 if(settingsDirty||totalQuotaDirty||proxyDirty||networkDirty){confirmModal(t('放弃未保存的更改？'),t('当前设置尚未保存。离开后会恢复上一次保存的偏好。'),t('放弃并离开'),()=>{discardAutosaves(['settingsForm','totalQuotaForm','proxyConfigForm','networkForm']);doNavigate(page);});return;}
 doNavigate(page);
}
function doNavigate(page){ui.page=page;closeDrawer();try{history.replaceState(null,'',location.pathname+location.search+'#'+page);}catch{/* Sandboxed previews may not permit URL updates. */}renderMain();window.scrollTo({top:0,behavior:'instant'});}
function syncInert(){
 const hasDrawer=!!ui.drawer,hasModal=!!ui.modal;
 $('.sidebar').inert=hasDrawer||hasModal;$('#main').inert=hasDrawer||hasModal;
 const drawer=$('.drawer');if(drawer)drawer.inert=hasModal;
 document.body.style.overflow=hasDrawer||hasModal?'hidden':'';
}
function openDrawer(id,tab='usage'){
 if(!getNetwork(id))return;ui.lastFocus=document.activeElement;ui.drawer={id,tab,appSearch:'',appSort:'total',appAll:false,appGrouping:'summary',proxyEstimated:false,historySort:'date',historyDirection:'desc',selectedApp:null};renderDrawer();syncInert();setTimeout(()=>$('#closeDrawer')?.focus(),0);
}
function closeDrawer(){
 if(ui.drawer?.kind==='app'&&ui.drawer.parent){const {parent,returnFocus,parentScroll}=ui.drawer;ui.drawer=parent;renderDrawer();$('.drawer-content').scrollTop=parentScroll||0;const target=$$('.drawer [data-action]').find(e=>e.dataset.action===returnFocus?.action&&e.dataset.key===returnFocus?.key&&e.dataset.appId===returnFocus?.appId);(target||$('#closeDrawer'))?.focus();return;}
 ui.drawer=null;$('#drawerRoot').innerHTML='';syncInert();renderAppList();if(ui.lastFocus?.isConnected)ui.lastFocus.focus();
}
function drawerUsage(n){
 const rows=selectedRows(n.id),v=totalOf(rows),connection=data.live.connections.find(c=>c.networkId===n.id),days=groupedDays(n.id).slice(-5).reverse();
 return tr`<div class="between"><span class="small muted">${esc(periodName())} · ${esc(rangeText())}</span><span class="pill gray">本机采样</span></div><div class="drawer-total"><div class="small muted">总用量</div><div class="metric-number">${fmtNumber(v.total,rows.length)}</div></div><div class="metrics"><div class="metric"><div class="metric-title">下载 ${icon('down')}</div><div class="metric-number">${fmtNumber(v.rx,rows.length)}</div></div><div class="metric"><div class="metric-title">上传 ${icon('up')}</div><div class="metric-number">${fmtNumber(v.tx,rows.length)}</div></div></div><div class="detail-section"><div class="between"><h3>用量趋势</h3><div class="legend"><span><i></i>下载</span><span><i class="tx"></i>上传</span></div></div><div class="chart-wrap">${chartSvg(chartRows(n.id),'drawer-chart')}</div></div>${connection&&data.live.state==='connected'?tr`<dl class="kv-grid"><div><dt>${isEthernet(n)?t('有线网卡'):t('无线网卡')}</dt><dd>${esc(connection.adapterAlias)}</dd></div>${isEthernet(n)||isEthernet(connection)?'':tr`<div><dt>频段 / 信号</dt><dd>${esc(connection.band)} / ${connection.signal}%</dd></div>`}<div><dt>连接开始</dt><dd>${esc(new Date(connection.since).toLocaleString(getLocale(),{hour12:false}))}</dd></div><div><dt>统计状态</dt><dd>${data.live.collector==='paused'?t('已暂停'):t('采样中')}</dd></div></dl>`:''}<div class="detail-section"><h3>最近记录</h3>${days.length?tr`<table><thead><tr><th>日期</th><th class="right">下载</th><th class="right">上传</th></tr></thead><tbody>${days.map(d=>`<tr><td>${niceDate(d.date)}</td><td class="right">${fmtWithUnit(d.rx)}</td><td class="right">${fmtWithUnit(d.tx)}</td></tr>`).join('')}</tbody></table>`:t('<p class="small muted">所选时间内没有该网络的记录。</p>')}</div>${button('export-network',t('导出此网络记录'),'export','','data-id="'+n.id+'"')}`;
}
function displayedAppRecords(){return proxyUsageRecords(data.appRecords,data.proxyEstimatedRecords,appContext().proxyEstimated&&data.proxy?.available);}
function displayedAppSummary(networkId,start,end){return applicationSummary(displayedAppRecords(),{networkId,start,end});}
function drawerApps(n){
 const {start,end}=getRange(),apps=displayedAppSummary(n.id,start,end),sum=apps.reduce((s,a)=>s+a.total,0n);
 return tr`<div class="applications-toolbar app-filters"><label class="search-box">${icon('search')}<input id="appSearch" type="search" placeholder="搜索应用" aria-label="搜索应用" value="${esc(appContext().appSearch)}"></label><label><span class="sr-only">应用排序</span><select class="select compact" id="appSort">${[['total',t('按总量')],['rx',t('按下载')],['tx',t('按上传')]].map(([v,label])=>option(v,label,appContext().appSort)).join('')}</select></label><label><span class="sr-only">历史分组</span><select class="select compact" id="appGrouping">${[['summary',t('应用汇总')],['day',t('按日')],['month',t('按月')],['live',t('实时采集')]].map(([value,label])=>option(value,label,appContext().appGrouping)).join('')}</select></label>${applicationSourceFilter(data.proxy,appContext().proxyEstimated)}<span class="applications-total" id="appTotal" aria-label="总用量">${fmtNumber(sum,apps.length)}</span>${button('application-control',t('选择程序'),'folder','small-btn')}</div><div id="appStatusRegion">${appStatus(n)}</div><div id="appListRegion" aria-live="polite">${appList(n)}</div><div id="proxyClientsRegion">${proxyClientsView(data.proxy,data.settings.speedUnit)}</div>`;
}
function appStatus(n){
 const c=data.appCollection||{state:'disabled'},labels={disabled:t('应用采集未启用'),starting:t('应用采集正在启动'),running:t('应用采集中'),paused:t('应用采集已暂停'),permission:t('应用采集需要系统授权'),unavailable:t('应用采集暂不可用'),partial:t('应用采集有缺失')};
 return `<div class="between app-status">${c.state==='disabled'?'':`<span class="small muted">${esc(labels[c.state]||labels.unavailable)}</span>`}${c.available?button('app-collection',c.enabled?t('停止应用采集'):t('启用应用采集'),'','small-btn'):''}</div>${(c.detail||c.message)&&['permission','unavailable','partial'].includes(c.state)?`<details class="app-diagnostic"><summary>${t('采集详情')}</summary><p class="small muted">${esc(c.detail||c.message)}</p></details>`:''}${c.available&&(c.state==='permission'||c.state==='unavailable')?button('app-collection-retry',t('重试应用采集'),'','small-btn'):''}`;
}
function currentAppRows(){const {start,end}=getRange();if(appContext().appGrouping==='summary')return sortApps(displayedAppSummary(appNetworkId(),start,end),appContext().appSort,appContext().appSearch);return applicationRows(displayedAppRecords(),{networkId:appNetworkId(),start,end,grouping:appContext().appGrouping,sort:appContext().historySort,direction:appContext().historyDirection,search:appContext().appSearch});}
function appControlPanel(){return appControlView(appControl,{button,esc});}
function renderAppControl(){const region=$('#appControlRegion');if(region)region.innerHTML=appControlPanel();}
async function controlOperation(action,rate){
 const pending=action==='choose'?appControl.choose():appControl.run(action,rate);
 renderAppControl();const result=await pending;if(action==='choose'&&result?.ok&&ui.drawer?.kind==='app'){ui.drawer.app={name:appControl.path.split(/[\\/]/).pop(),path:appControl.path};appControl.name=ui.drawer.app.name;renderDrawer();$('#closeDrawer')?.focus();}else renderAppControl();
}
function legacyPanel(){return `<div id="legacyRegion"><p class="small muted" role="status">${esc(legacyMessage(legacyResult))}</p>${button('legacy-status',t('检查旧版数据'),'','small-btn',`type="button" ${legacyBusy?'disabled':''}`)}${button('legacy-import',t('导入旧版目录'),'folder','small-btn',`type="button" ${legacyBusy?'disabled':''}`)}</div>`;}
async function legacyAction(importing){
 if(legacyBusy||!window.desktop.legacy)return;legacyBusy=true;const render=()=>{const region=$('#legacyRegion');if(region)region.outerHTML=legacyPanel();};render();
 try{legacyResult=await (importing?window.desktop.legacy.importDirectory():window.desktop.legacy.status());if(legacyResult.imported){await store.reload();renderMain();}}
 catch(error){legacyResult={error:error.message};}
 finally{legacyBusy=false;render();}
}

function appHistoryTable(){
 const rows=currentAppRows();
 const columns=[['date',appContext().appGrouping==='month'?t('月份'):t('日期')],['name',t('应用')],['rx',t('下载')],['tx',t('上传')],['total',t('总用量')]];
 return `${button('export-apps',t('导出当前表格'),'export','small-btn',rows.length?'':'disabled')}<div class="table-scroll"><table><thead><tr>${columns.map(([key,label])=>`<th aria-sort="${appContext().historySort===key?(appContext().historyDirection==='asc'?'ascending':'descending'):'none'}"><button class="link-btn" data-action="app-history-sort" data-key="${key}">${label}</button></th>`).join('')}<th>${t('来源')}</th></tr></thead><tbody>${rows.map(row=>`<tr data-app-row="${esc(row.key)}" class="${appContext().selectedApp?.key===row.key?'selected-row':''}"><td>${row.date}</td><td><button class="network-name" data-action="select-app-row" data-key="${esc(row.key)}" aria-pressed="${appContext().selectedApp?.key===row.key}">${applicationAvatar(row,esc,true)}${esc(row.name)}</button></td><td class="right">${fmtWithUnit(row.rx)}</td><td class="right">${fmtWithUnit(row.tx)}</td><td class="right">${fmtWithUnit(row.total)}</td><td>${estimateLabel(row)}</td></tr>`).join('')}</tbody></table></div>${rows.length?'':empty(t('所选时段没有应用记录'),t('更换日期或应用名称后重试。'))}`;
}
async function exportApps(){if(appContext().appGrouping==='live'){toast(t('请切换到应用汇总或历史后导出。'));return;}const rows=currentAppRows();if(!rows.length)return;if(await dataDownload(`WiFiMeter_apps_${appContext().appGrouping}_${getRange().end}.csv`,applicationCsv(rows,data.settings.language)))toast(tr`已导出 ${rows.length} 条记录。`);}
function appRate(bytes){const {value,unit}=formatSpeedParts(bytes,data.settings.speedUnit);return `${esc(value)} ${esc(unit)}`;}
function liveAppName(process){return process.name||data.appRecords.find(row=>row.appId===process.appId)?.name||process.appId;}
function appLiveList(n){
 const collection=data.appCollection||{},running=collection.state==='running'||collection.state==='partial';
 const rows=running?applicationLiveRows((data.appProcesses||[]).map(p=>({...p,name:liveAppName(p)})),{networkId:n.id,search:appContext().appSearch}):[];
 if(!rows.length)return `<p class="small muted">${t('当前没有应用进程数据。')}</p>`;
 return tr`<div class="table-scroll"><table><thead><tr><th>应用</th><th>PID</th><th>网络名称</th><th>下载速度</th><th>上传速度</th></tr></thead><tbody>${rows.map(p=>`<tr><td><button class="network-name" data-action="select-live-app" data-app-id="${esc(p.appId)}" data-network-id="${esc(p.networkId)}" data-live-key="${esc(p.key)}">${applicationAvatar({...p,name:liveAppName(p)},esc,true)}${esc(liveAppName(p))}</button></td><td>${esc(p.processIds.join(', '))}</td><td>${p.scope==='loopback'?t('本地 TCP'):esc(getNetwork(p.networkId)?networkName(getNetwork(p.networkId)):p.networkId)}</td><td>${appRate(p.rxPerSecond)}</td><td>${appRate(p.txPerSecond)}</td></tr>`).join('')}</tbody></table></div>`;
}
function appList(n){
 if(appContext().appGrouping==='live')return appLiveList(n);
 if(appContext().appGrouping!=='summary')return appHistoryTable();
 const {start,end}=getRange(),apps=displayedAppSummary(n.id,start,end),sum=apps.reduce((s,a)=>s+a.total,0n);
 const list=sortApps(apps,appContext().appSort,appContext().appSearch),visible=appContext().appAll?list:list.slice(0,10);
 if(!apps.length)return empty(t('所选时段没有应用记录'),data.appCollection?.available&&!data.appCollection.enabled?t('启用应用采集后开始记录。'):t('试试其他日期或网络。'));
 if(!list.length)return empty(t('没有匹配的应用'),t('试试其他应用名称。'));
 return tr`<div class="small muted">共 ${list.length} 个应用 · 显示 ${visible.length} 个</div><ol class="app-list">${visible.map(a=>{const percent=bytePercent(a.total,sum);return tr`<li class="app-row">${applicationAvatar(a,esc)}<div class="app-description"><button class="network-name" data-action="select-app" data-app-id="${esc(a.id)}" data-key="${esc(a.key)}">${esc(a.name)}</button>${a.estimated?`<span class="pill warn">${estimateLabel(a)}</span>`:''}<div class="app-source">下载 ${fmtWithUnit(a.rx)} · 上传 ${fmtWithUnit(a.tx)}</div><div class="progress" aria-hidden="true"><span style="width:${percent}%"></span></div></div><div class="app-value"><strong>${fmtWithUnit(a.total)}</strong><div class="app-source">${sum?percent.toFixed(1)+'%':'—'}</div></div></li>`;}).join('')}</ol>${list.length>10?button('apps-expand',appContext().appAll?t('收起列表'):t('显示全部应用'),'','small-btn'):''}`;
}
function refreshApplicationDetails(){
 if(ui.drawer?.kind!=='app'||!ui.drawer.app.key||ui.drawer.app.processId==null)return;
 const current=applicationLiveRows((data.appProcesses||[]).map(p=>({...p,name:liveAppName(p)}))).find(p=>p.key===ui.drawer.app.key);
 ui.drawer.app={...ui.drawer.app,...current,rxPerSecond:current?.rxPerSecond??null,txPerSecond:current?.txPerSecond??null};
 const section=$('.application-summary');
 if(section){const wrapper=document.createElement('div');wrapper.innerHTML=applicationDetails(ui.drawer.app,{esc,fmtWithUnit,appRate,estimateLabel});updateRegion(section,wrapper.firstElementChild.innerHTML);}
}
function renderAppList(){
 if(ui.drawer?.tab!=='apps'&&(ui.drawer||ui.page!=='apps'))return;
 if(!$('#appListRegion')){if(data.appRecords.length||data.appCollection?.available||data.proxy?.available)renderDrawer();return;}
 const active=document.activeElement,focused=active?.matches('#appListRegion button,#appStatusRegion button')?{action:active.dataset.action,appId:active.dataset.appId,key:active.dataset.key}:null;
 const n={id:appNetworkId()},{start,end}=getRange(),apps=displayedAppSummary(n.id,start,end),sum=apps.reduce((s,a)=>s+a.total,0n);
 if($('#proxyClientsRegion'))updateRegion($('#proxyClientsRegion'),proxyClientsView(data.proxy,data.settings.speedUnit));
 updateRegion($('#appListRegion'),appList(n),{selection:window.getSelection()});updateRegion($('#appStatusRegion'),appStatus(n));updateRegion($('#appTotal'),fmtNumber(sum,apps.length));
 appIcons.hydrate(document);
 if(focused)$$('#appListRegion button,#appStatusRegion button').find(b=>b.dataset.action===focused.action&&b.dataset.appId===focused.appId&&b.dataset.key===focused.key)?.focus();
}
async function setAppCollection(enabled){
 const buttons=$$('[data-action="app-collection"],[data-action="app-collection-retry"]');buttons.forEach(b=>b.disabled=true);
 try{await store.setAppCollection(enabled);renderAppList();}finally{buttons.forEach(b=>b.disabled=false);}
}
function drawerSettings(n){
 return tr`<form id="networkForm" data-id="${n.id}"><div class="field"><label for="aliasInput">网络备注</label><input class="input" id="aliasInput" name="alias" value="${esc(n.alias)}" placeholder="给这个 Wi-Fi 起一个容易辨认的名字" maxlength="128"></div><div class="field-row"><div class="field"><label for="quotaInput">流量额度</label><div class="input-unit"><input class="input" id="quotaInput" name="capGb" type="number" value="${n.capGb||''}" placeholder="不限制" min="0" max="${MAX_QUOTA_GB}" step="any"><span>GB</span></div></div><div class="field"><label for="quotaPeriod">额度周期</label><select class="input" id="quotaPeriod" name="quotaPeriod">${option('month',t('每自然月'),n.quotaPeriod)}${option('day',t('每天'),n.quotaPeriod)}${option('all',t('累计不重置'),n.quotaPeriod)}</select></div></div><div class="setting-row" style="padding:17px 0"><div><div class="setting-title">用量接近额度时提醒</div></div>${toggle('notify',n.notify,t('接近额度时提醒'))}</div><div class="field" style="margin-top:18px"><label for="warnPercent">提醒阈值</label><input class="input" id="warnPercent" name="warnPercents" type="text" value="${esc(quotaThresholds(n).join(', '))}" placeholder="50, 75, 90, 100" required></div>${isEthernet(n)?tr`<p class="small muted">有线网络不支持无线断开操作。</p>`:tr`<div class="setting-row" style="padding:17px 0"><div><div class="setting-title">达到额度后自动断开</div></div>${toggle('autoDisconnect',n.autoDisconnect,t('达到额度后自动断开'))}</div>`}<div class="form-error" id="networkFormError" role="alert"></div>${autosaveStatus('networkSaveStatus')}</form>`;
}
async function openApplicationDrawer(app={}){
 if(appControl.busy)return;
 const active=document.activeElement,parent=ui.drawer?.kind==='app'?ui.drawer.parent:ui.drawer;
 if(!ui.drawer)ui.lastFocus=active;
 appControl.select(app);
 ui.drawer={kind:'app',app,parent,parentScroll:$('.drawer-content')?.scrollTop||0,returnFocus:active?.dataset?{...active.dataset}:null};
 renderDrawer();syncInert();$('#closeDrawer')?.focus();
 if(appControl.path)await controlOperation('read');
}
function renderDrawer(){
 if(!ui.drawer){$('#drawerRoot').innerHTML='';return;}
 if(ui.drawer.kind==='app'){$('#drawerRoot').innerHTML=drawerShell({title:applicationAvatar(ui.drawer.app,esc,true)+esc(ui.drawer.app.name||t('选择程序')),closeLabel:t('关闭应用详情'),back:ui.drawer.parent?button('close-drawer',t('返回网络详情'),'','small-btn'):'',content:applicationDetails(ui.drawer.app,{esc,fmtWithUnit,appRate,estimateLabel})+`<div id="appControlRegion">${appControlPanel()}</div>`,icon});syncInert();appIcons.hydrate(document);return;}
 const n=getNetwork(ui.drawer.id);if(!n){closeDrawer();return;}
 const tab=ui.drawer.tab;
 $('#drawerRoot').innerHTML=drawerShell({title:esc(networkName(n)),badge:isConnected(n.id)?t('<span class="pill"><i class="dot"></i>已连接</span>'):'',closeLabel:t('关闭网络详情'),subtitle:tr`<div class="drawer-sub"><span>${isEthernet(n)?t('原始身份'):'SSID'} · ${esc(n.ssid)}</span><button class="icon-btn small-icon" data-action="copy-ssid" data-id="${n.id}" aria-label="复制 SSID">${icon('copy')}</button></div>`,tabs:tr`<div class="drawer-tabs" role="tablist" aria-label="网络详情分类">${[['usage',t('用量明细')],['apps',t('应用分布')],['settings',t('网络设置')]].map(([id,label])=>`<button class="drawer-tab ${tab===id?'active':''}" role="tab" aria-selected="${tab===id}" data-action="drawer-tab" data-tab="${id}">${label}</button>`).join('')}</div>`,content:tab==='usage'?drawerUsage(n):tab==='apps'?drawerApps(n):drawerSettings(n),icon});appIcons.hydrate(document);
 syncInert();
}
let modalReturnFocus=null;
function showModal(title,body,actions='',onShow=null){
 modalReturnFocus=document.activeElement;
 ui.modal={title};$('#modalRoot').innerHTML=tr`<div class="modal-shell" data-modal-shell="1"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div class="between"><h2 id="modalTitle">${esc(title)}</h2><button class="icon-btn" data-action="close-modal" aria-label="关闭对话框">${icon('close')}</button></div>${body}${actions?`<div class="modal-actions">${actions}</div>`:''}</section></div>`;
 syncInert();setTimeout(()=>{const e=$('[autofocus]', $('#modalRoot'))||$('button', $('#modalRoot'));e?.focus();onShow?.();},0);
}
function closeModal(){const cancel=pendingAutosaveCancel;pendingAutosaveCancel=null;cancel?.();ui.modal=null;$('#modalRoot').innerHTML='';syncInert();if(modalReturnFocus?.isConnected)modalReturnFocus.focus();}
let pendingConfirm=null;
function confirmModal(title,text,label,fn,danger=false,requireText=false){
 pendingConfirm=fn;
 showModal(title,`<p class="modal-desc">${esc(text)}</p>${requireText?t('<div class="field"><label for="confirmText">输入清空确认</label><input id="confirmText" class="input" autocomplete="off" autofocus><div class="field-hint">该操作无法撤销。建议先导出备份。</div></div>'):''}`,button('close-modal',t('取消'))+button('confirm',label,'',danger?'danger':'primary',requireText?'id="confirmAction" disabled':''));
}
function exportModal(networkId=null){
 const id=networkId||ui.networkId;
 showModal(t('导出流量记录'),tr`<p class="modal-desc">导出当前筛选范围内的本机记录。包含原始字节数，便于后续核对。</p><form id="exportForm"><div class="field"><label for="exportNetwork">网络范围</label><select id="exportNetwork" class="input" name="networkId">${networkOptions(id)}</select></div><div class="field-row"><div class="field"><label for="exportStart">开始日期</label><input class="input" id="exportStart" name="start" type="date" value="${getRange().start}" required></div><div class="field"><label for="exportEnd">结束日期</label><input class="input" id="exportEnd" name="end" type="date" value="${getRange().end}" max="${today()}" required></div></div><div class="field"><label for="exportFormat">文件格式</label><select class="input" id="exportFormat" name="format">${option('csv',t('CSV · 可用表格软件打开'),'csv')}${option('json',t('JSON · 精确字节数'),'csv')}</select></div><div class="form-error" id="exportError" role="alert"></div><div class="modal-actions">${button('close-modal',t('取消'),'','','type="button"')}<button class="btn primary" type="submit">${icon('export')}导出记录</button></div></form>`);
}
function demoModal(){
 const labels={unreadable:[t('无法读取 Wi-Fi 信息'),t('无法确认连接信息')],connected:[t('已连接'),t('正在读取当前网络与速率')],disconnected:[t('未连接 Wi-Fi'),t('有无线网卡但没有关联网络')],permission:[t('权限不足'),t('无法确定网络身份，未见过的流量不会记到上一个网络')],offline:[t('采集器不可用'),t('读不到网卡信息，下方记录可能已过期')],loading:[t('正在启动'),t('正在连接本机采集后端')]};
 const [title,detail]=labels[data.live.state]??[t('未知状态'),''];
 const interfaces=data.live.connections.length?data.live.connections.map(c=>tr`<div class="check-row">${icon(isEthernet(c)?'ethernet':'wifi')}<span>${esc(c.adapterAlias)} · ${esc(networkName(getNetwork(c.networkId)))} ${isEthernet(c)?t('有线网络'):tr`· 信号 ${c.signal}%`}</span></div>`).join(''):tr`<div class="check-row">${icon('offline')}<span>${['unreadable','permission'].includes(data.live.state)?t('无法确认连接信息'):t('当前没有已关联的无线网卡')}</span></div>`;
 const gaps=(data.gaps??[]).length;
 showModal(t('采集状态'),tr`<p class="modal-desc">数据由本机后端进程读取网卡计数器后写入本机数据库，不经过网络。</p><div class="check-row">${icon('database')}<span>采集器：${data.live.collector==='running'?t('运行中'):data.live.collector==='paused'?t('已暂停'):t('不可用')} · ${title}</span></div><div class="check-row">${icon('info')}<span>${esc(detail)}</span></div>${interfaces}${gaps?tr`<div class="check-row">${icon('alert')}<span>有 ${gaps} 段区间没有采集到数据，已单独记录，不会显示成 0。</span></div>`:''}<div class="note-box" style="margin-top:18px">${icon('info')}<div>备注、额度、导出与备份都写入本机数据库；开机启动、托盘与真实断网属于系统级设置。</div></div>`,button('close-modal',t('完成'),'','primary'));
}
function helpModal(){showModal(t('统计口径与使用说明'),tr`<div class="modal-desc"><strong>总量 = 下载 + 上传</strong><br>首页和网络明细展示采集器记录的网卡流量；用量自动选择单位，设置中可切换十进制或二进制。<br><br><strong>历史与实时分开</strong><br>日期筛选仅影响历史用量。连接卡片显示当前选中网卡的实时状态，额度使用独立日 / 月周期。<br><br><strong>缺失记录不会伪装成零流量</strong><br>断网、暂停、计数器重置与身份不明期间的覆盖情况，由后端记录并说明。<br><br><strong>应用用量独立统计</strong><br>应用分布按当前网络与时段展示已采集的应用记录。启用应用采集后从新的基线开始，暂停和停止不会删除历史；是否可采集以及缺失区间会在页面说明。<br><br><strong>数据来源</strong><br>页面读取本机后端进程的采集结果，数据存放在本机 SQLite 数据库，不上传任何内容。</div>`,button('close-modal',t('知道了'),'','primary'));}
function permissionModal(){showModal(t('无法确定网络身份'),tr`<p class="modal-desc">采集器读不到当前连接的网络名。无法归属的流量不会被记到上一次连接的网络。</p><div class="note-box">${icon('shield')}<div>常见原因是 NetworkManager 未运行或当前用户无权查询连接信息。恢复后采集会从新的基线继续，中间区间会记为覆盖空档。</div></div><p class="field-hint" style="margin-top:15px">可以用 <code>nmcli dev status</code> 确认 NetworkManager 是否正常。</p>`,button('close-modal',t('关闭'))+button('demo',t('查看采集状态'),'','primary'));}
async function dataDownload(filename,body){
 const result=await window.desktop.saveFile({filename,body});
 if(result.error)throw Error(result.error);
 return !result.canceled;
}
function csvCell(value){let text=String(value??'');if(/^[\s]*[=+\-@]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}
async function doExport(values){
 const {networkId,start,end,format}=values;
 if(!validDate(start)||!validDate(end)||start>end||end>today())throw Error(t('请选择有效日期，结束日期不能早于开始日期或晚于今天。'));
 const result=await store.exportUsage({from:start,to:end,networkKey:networkId==='all'?'':networkId});
 const rows=(result.records||[]).sort((a,b)=>a.date.localeCompare(b.date));if(!rows.length)throw Error(t('所选范围没有可导出的流量记录。'));
 let saved;
 if(format==='json')saved=await dataDownload(`WiFiMeter_${start}_${end}.json`,JSON.stringify({version:1,type:'usage-export',source:data.source,start,end,records:rows.map(r=>{const n=getNetwork(r.networkId);return {...r,ssid:r.ssid??n?.ssid??'',alias:r.alias??n?.alias??''};})},null,2),'application/json;charset=utf-8');
 else {const header=[t('日期'),t('网络备注'),'SSID',t('下载字节'),t('上传字节'),t('总计字节'),tr`下载_${data.settings.unit}`,tr`上传_${data.settings.unit}`,tr`总计_${data.settings.unit}`,t('数据来源')];const lines=[header,...rows.map(r=>{const n=getNetwork(r.networkId);return [r.date,r.alias||r.ssid||networkName(n),r.ssid??n?.ssid??'',r.rxBytes,r.txBytes,(B(r.rxBytes)+B(r.txBytes)).toString(),fmtExport(r.rxBytes,6).replaceAll(',',''),fmtExport(r.txBytes,6).replaceAll(',',''),fmtExport(B(r.rxBytes)+B(r.txBytes),6).replaceAll(',',''),t('本机采集')];})];saved=await dataDownload(`WiFiMeter_${start}_${end}.csv`,'\uFEFF'+lines.map(row=>row.map(csvCell).join(',')).join('\r\n'),'text/csv;charset=utf-8');}
 if(!saved)return;
 closeModal();toast(tr`已导出 ${rows.length} 条记录。`);
}
async function backup(){
 // 备份内容由后端从数据库导出，界面只负责把文件写到用户选择的位置。
 const document=await store.backup();
 if(await dataDownload(`WiFiMeter_backup_${today()}.json`,JSON.stringify(document,null,2)))toast(t('已导出完整数据备份。'));
}
async function restore(){
 const result=await window.desktop.openBackup();
 if(result.canceled)return;
 if(result.error)throw Error(result.error);
 let document;
 try{document=JSON.parse(result.body);}catch{throw Error(t('这个文件不是有效的备份文件。'));}
 if(document?.backupType!=='wifimeter-backend-backup')throw Error(t('请选择备份功能生成的完整文件。'));
 confirmModal(t('恢复这份备份？'),tr`包含 ${document.networks?.length??0} 个网络和 ${document.records?.length??0} 条每日记录。当前数据将被替换。`,t('确认恢复'),async()=>{
  await store.restore(document);
  ui.networkId='all';ui.search='';ui.historyPage=1;
  restartSampler();closeDrawer();renderMain();toast(t('已恢复备份，采集已暂停。'));
 });
}
function clearRecords(){confirmModal(t('清空全部用量记录？'),t('此操作删除每日与小时记录、覆盖说明，并重置当前额度计数；保留网络备注与提醒设置。不能撤销。'),t('清空记录'),async()=>{await store.clearRecords();restartSampler();renderMain();toast(t('记录已清空，采集已暂停。'));},true,true);}
const autosaveForms=new Set(['settingsForm','networkForm','totalQuotaForm','proxyConfigForm']);
const formSaves=new WeakMap(), activeSaves=new Set(), fieldEdits=new WeakMap(), statusTimers=new WeakMap();
const windowFields=new Set(['miniWindow','closeAction','theme','miniShape','miniPalette','miniSnap','miniAutoHide']);
let pendingAutosaveCancel=null, languageRenderNeeded=false;
function syncSaveFlags(){
 for(const entry of activeSaves)if(!entry.form.isConnected&&!entry.save.dirty)activeSaves.delete(entry);
 const dirty=id=>[...activeSaves].some(entry=>entry.form.id===id&&entry.save.dirty);
 settingsDirty=dirty('settingsForm');networkDirty=dirty('networkForm');totalQuotaDirty=dirty('totalQuotaForm');proxyDirty=dirty('proxyConfigForm');
}
async function flushAutosaves(ids){await Promise.all([...activeSaves].filter(entry=>ids.includes(entry.form.id)).map(entry=>entry.save.flush()));}
function discardAutosaves(ids){for(const entry of activeSaves)if(ids.includes(entry.form.id)){entry.save.discard();activeSaves.delete(entry);}syncSaveFlags();}
function formAutosave(form){
 if(formSaves.has(form))return formSaves.get(form);
 const save=createAutosave({write:patch=>writeAutosave(form,patch),onState:status=>{
  syncSaveFlags();
  const feedback=$('.autosave-feedback',form),label=feedback?.querySelector('[role="status"]'),retry=feedback?.querySelector('button');
  clearTimeout(statusTimers.get(form));
  if(status.state==='saved'&&label)statusTimers.set(form,setTimeout(()=>{label.textContent='';},1800));
  if(label){label.dataset.state=status.state;label.textContent=status.state==='error'?t('保存失败，请重试。')+' '+status.error:status.state==='saving'?t('正在保存…'):status.state==='pending'?t('等待保存…'):t('已自动保存');}
  if(retry){retry.hidden=status.state!=='error';retry.textContent=t('重试');}
  const error=$('.form-error',form);if(error)error.textContent=status.error;
  if(languageRenderNeeded&&!settingsDirty&&!networkDirty&&!totalQuotaDirty&&!proxyDirty){languageRenderNeeded=false;queueMicrotask(()=>{if(settingsDirty||networkDirty||totalQuotaDirty||proxyDirty){languageRenderNeeded=true;return;}if(ui.page==='settings')renderSettingsDrafts();else renderChrome();});}
 }});
 formSaves.set(form,save);activeSaves.add({form,save});return save;
}
function fieldPatch(input){
 const key=input.name,value=input.type==='checkbox'?input.checked:input.value;
 if(key==='warnPercents'){const values=parseWarnPercents(value);return {warnPercents:values,warnPercent:values[0]};}
 if(key==='capGb'){if(value===''&&input.form.id==='totalQuotaForm'||input.validity.badInput||!validQuotaGb(Number(value)))throw Error(t('额度须为 0 或 0.000000001 到 9000000000 GB。'));return {capGb:Number(value)};}
 if(key==='ports'||key==='processNames')return {[key]:proxyConfigPatch(new Map([[key,value]]))[key]};
 if(key==='alias')return {alias:String(value).trim()};
 return {[key]:['interval','retention'].includes(key)?Number(value):value};
}
function editAutosave(input,immediate){
 if(!input.name)return;
 const save=formAutosave(input.form),raw=input.type==='checkbox'?input.checked:input.value;
 const previous=fieldEdits.get(input);
 if(previous?.raw===raw){if(immediate)save.expedite(input.name);return;}
 try{
  const patch=fieldPatch(input);fieldEdits.set(input,{raw,patch});
  const current=input.form.id==='settingsForm'?(windowFields.has(input.name)?windowPreferences:data.settings):input.form.id==='networkForm'?getNetwork(input.form.dataset.id):input.form.id==='totalQuotaForm'?data.totalQuota:data.proxy;
  if(!save.has(input.name)&&Object.entries(patch).every(([key,value])=>JSON.stringify(current?.[key])===JSON.stringify(value)))return;
  save.set(input.name,patch,immediate);
 }catch(error){fieldEdits.set(input,{raw});save.invalid(input.name,error.message);}
}
function confirmAutosave(title,text){return new Promise(resolve=>{
 confirmModal(title,text,t('确认启用'),()=>resolve(true),true);
 pendingAutosaveCancel=()=>resolve(false);
});}
function restoreField(form,key,value,expected){const input=form.elements.namedItem(key);if(!input||fieldEdits.get(input)?.patch!==expected)return;fieldEdits.delete(input);if(input.type==='checkbox')input.checked=!!value;else input.value=value;}
async function writeAutosave(form,fields){
 const patch=Object.assign({},...Object.values(fields));
 if(form.id==='settingsForm'){
  let retentionShortened=false;
  if(Object.hasOwn(patch,'retention')){
   const previous=data.settings.retention,shortening=patch.retention>0&&(previous===0||patch.retention<previous);
   if(shortening&&!await confirmAutosave(t('应用新的保留时长？'),t('缩短保留期将删除范围外的历史记录，建议先备份。'))){restoreField(form,'retention',previous,fields.retention);delete patch.retention;}
   retentionShortened=shortening&&Object.hasOwn(patch,'retention');
  }
  const prefs=Object.fromEntries(Object.entries(patch).filter(([key])=>windowFields.has(key)));
  const settings=Object.fromEntries(Object.entries(patch).filter(([key])=>!windowFields.has(key)));
  if(Object.keys(prefs).length){receiveWindowPreferences(await window.desktop.windowPreferences.update(prefs));if(Object.hasOwn(prefs,'closeAction'))settings.minimizeToTray=prefs.closeAction==='tray';}
  if(Object.keys(settings).length){const result=await store.updateSettings(settings);if(settings.autoStart&&result.system&&!result.system.autoStart)throw Error(t('偏好已保存，但写入开机启动项失败，请检查用户目录权限。'));}
  if(retentionShortened){await store.pruneUsage();await store.reload();}
  if(Object.hasOwn(settings,'language')){setLanguage(settings.language);languageRenderNeeded=true;}
  restartSampler();return;
 }
 if(form.id==='proxyConfigForm'){
  // This endpoint replaces the configuration, so merge only with committed values.
  await store.updateProxyConfig({ports:data.proxy?.ports||[],processNames:data.proxy?.processNames||[],...patch});return;
 }
 const current=form.id==='networkForm'?getNetwork(form.dataset.id):data.totalQuota;
 if(patch.autoDisconnect&&!current.autoDisconnect){
  const accepted=await confirmAutosave(t('启用自动断开规则？'),form.id==='networkForm'?tr`达到所设额度后，应用会断开当前连接的网络：${networkName(current)}。断开只在确认连的正是这个网络时执行。`:t('总额度达到上限时将断开全部 Wi-Fi。'));
  if(!accepted){restoreField(form,'autoDisconnect',current.autoDisconnect,fields.autoDisconnect);delete patch.autoDisconnect;}
 }
 if(!Object.keys(patch).length)return;
 if(form.id==='networkForm'){
  if((patch.autoDisconnect||patch.notify)&&!(patch.capGb??current.capGb))throw Error(t('请先设置大于 0 的额度，或关闭该网络的提醒与自动断网。'));
  await store.updateNetwork(form.dataset.id,patch);
 }else await store.updateTotalQuota(patch);
}
document.addEventListener('focusout',event=>{const input=event.target;if(autosaveForms.has(input.form?.id)&&input.name&&input.type!=='checkbox'&&input.tagName!=='SELECT')formSaves.get(input.form)?.expedite(input.name);});
let nativeWindowHidden = false;
const renderingHidden = () => document.hidden || nativeWindowHidden;
function refreshAfterTick(){
 if(renderingHidden())return;
 renderChrome();
 const c=getConnection(),ok=data.live.state==='connected'&&data.live.collector==='running';
 if($('[data-live-rx]'))$('[data-live-rx]').textContent=ok&&c?speed(c.rxPerSecond):'—';
 if($('[data-live-tx]'))$('[data-live-tx]').textContent=ok&&c?speed(c.txPerSecond):'—';
 if(c){if($('[data-live-rx-unit]'))$('[data-live-rx-unit]').textContent=speedUnit(c.rxPerSecond);if($('[data-live-tx-unit]'))$('[data-live-tx-unit]').textContent=speedUnit(c.txPerSecond);}
 const active=document.activeElement;
 // Do not recreate forms, dialogs, focused charts, or inputs during background refresh.
 if(!ui.modal&&!ui.drawer&&ui.page==='overview'&&(active===document.body||active===document.documentElement||active===$('#main')))updateRegion($('#content'),overview(),{selection:window.getSelection()});
}
// 采集由后端进程按设置的间隔进行，并通过事件推送状态；界面只需要重绘。
const liveRender = createRenderScheduler({ render: paintLive, hidden: renderingHidden,
 requestFrame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id) });
function refreshLive(){liveRender.schedule();}
function paintLive(){
 refreshAfterTick();renderStatusHelp();refreshApplicationDetails();
 if(!ui.modal){
  renderAppList();
  if(!ui.drawer&&ui.page==='networks')updateRegion($('#networkTableRegion'),networkTable(true),{selection:window.getSelection()});
  if(!ui.drawer&&ui.page==='history'&&!$('#content').contains(document.activeElement))updateRegion($('#content'),historyPage(),{selection:window.getSelection()});
 }
}
function showAlert(alert){
 if(alert.scope==='total')alert={...alert,alias:t('总 Wi-Fi 额度')};
 if(alert.kind==='quotaLimit')toast(tr`额度提醒：${alert.alias||alert.ssid} 已达到额度上限。`,true);
 else if(alert.kind==='quotaWarn')toast(tr`额度提醒：${alert.alias||alert.ssid} 已用 ${Number(alert.percent).toFixed(0)}%。`);
 else if(alert.kind==='quotaDisconnect')toast(alert.outcome===0?tr`已达到额度上限，已断开 ${alert.alias||alert.ssid}。`:tr`已达到额度上限，但未能断开 ${alert.alias||alert.ssid}：${alert.detail||t('请检查系统状态')}`,true);
}
function restartSampler(){clearInterval(samplerTimer);lastTick=performance.now();if(!renderingHidden()&&params.get('still')!=='1')samplerTimer=setInterval(refreshLive,data.settings.interval*1000);}
const visibilityChanged=()=>{liveRender.visibilityChanged();restartSampler();if(!renderingHidden())refreshLive();};
document.addEventListener('visibilitychange',visibilityChanged);
window.desktop.onVisibility?.(visible=>{nativeWindowHidden=!visible;visibilityChanged();});
window.addEventListener('unload',()=>{appIcons.stop();liveRender.stop();clearInterval(samplerTimer);});
async function pauseCollector(){
 const paused=data.live.collector==='paused';
 await store.pause(!paused);
 if(paused)await store.reload();
 restartSampler();renderMain();
 toast(paused?t('已恢复统计，从新的基线继续。'):t('已暂停统计。暂停期间不会补记到任何网络。'));
}
let rangeRequest=0;
async function selectRange(period,custom=ui){
 const version=++rangeRequest,range=historyRange(period,today(),custom);
 document.getElementById('content').setAttribute('aria-busy','true');
 try {
  const applied=await store.queryRange({from:range.start,to:range.end});
  if(version!==rangeRequest||!applied)return;
  ui.period=period;ui.start=range.start;ui.end=range.end;ui.historyPage=1;renderMain();
 } finally {if(version===rangeRequest)document.getElementById('content').removeAttribute('aria-busy');}
}
function customRangeModal(){const r=getRange();showModal(t('选择日期范围'),tr`<p class="modal-desc">开始和结束日期均包含在统计范围内，将从数据库查询所选日期。</p><form id="rangeForm"><div class="field-row"><div class="field"><label for="rangeStart">开始日期</label><input class="input" id="rangeStart" name="start" type="date" value="${r.start}" max="${today()}" required autofocus></div><div class="field"><label for="rangeEnd">结束日期</label><input class="input" id="rangeEnd" name="end" type="date" value="${r.end}" max="${today()}" required></div></div><div class="form-error" id="rangeError" role="alert"></div><div class="modal-actions">${button('close-modal',t('取消'),'','','type="button"')}<button class="btn primary" type="submit">应用筛选</button></div></form>`);}
let networkDirty=false,totalQuotaDirty=false,proxyDirty=false;
async function requestCloseDrawer(){await flushAutosaves(['networkForm']);if(networkDirty){confirmModal(t('放弃未保存的网络设置？'),t('网络备注与额度的更改尚未保存。'),t('放弃更改'),()=>{discardAutosaves(['networkForm']);closeDrawer();});}else closeDrawer();}
async function copySsid(id){const text=getNetwork(id)?.ssid||'';try{await navigator.clipboard.writeText(text);toast(t('已复制原始 SSID。'));}catch(e){showModal(t('复制网络名称'),tr`<p class="modal-desc">浏览器不允许直接写入剪贴板。可以选中下方名称复制。</p><input class="input" value="${esc(text)}" readonly autofocus>`,button('close-modal',t('完成'),'','primary'),()=>$('.modal input')?.select());}}
function renderStatusHelp(){refreshStatusHelp($('#settings-status'),{live:data.live,appCollection:data.appCollection,proxy:data.proxy,updates:updateStatus});}
function renderUpdates(){renderStatusHelp();const panel=$('#updatesPanel');if(panel)refreshUpdates(panel,updateStatus,updateBusy);}
async function updateAction(action){
 if(updateBusy)return;
 if(action==='install'&&(settingsDirty||networkDirty||totalQuotaDirty||proxyDirty)){toast(t('请等待自动保存完成，或重试保存失败的更改。'),true);return;}
 updateBusy=true;if(action==='check')updateStatus={...updateStatus,state:'checking',error:'',progress:null};renderUpdates();
 const content=$('#content');
 try{updateStatus=await window.desktop.updates[action]();}
 catch(error){updateStatus={...updateStatus,state:'error',error:error.message};}
 finally{content.inert=false;updateBusy=false;renderUpdates();}
}
const actions={
 'check-updates':()=>updateAction('check'),
 'install-update':()=>updateAction('install'),
 refresh:async e=>{
  if(settingsDirty||networkDirty||totalQuotaDirty||proxyDirty){toast(t('请等待自动保存完成，或重试保存失败的更改。'),true);return;}
  e.disabled=true;
  try{await store.reload();await reloadWindowPreferences();storageFailed=false;renderMain();if(ui.drawer)renderDrawer();}
  finally{e.disabled=false;}
 },
 navigate:e=>navigate(e.dataset.page),
 'settings-category':e=>selectSettingsCategory(e.dataset.category),
 period:e=>{if(e.dataset.value==='custom')customRangeModal();else return selectRange(e.dataset.value);},
 detail:e=>{networkDirty=false;openDrawer(e.dataset.id,e.dataset.tab||'usage');},
 'close-drawer':requestCloseDrawer,
 'drawer-tab':async e=>{await flushAutosaves(['networkForm']);const change=()=>{discardAutosaves(['networkForm']);ui.drawer.tab=e.dataset.tab;renderDrawer();$(`.drawer-tab[data-tab="${e.dataset.tab}"]`)?.focus();};if(networkDirty)confirmModal(t('放弃未保存的网络设置？'),t('切换标签页将放弃当前表单中的更改。'),t('放弃更改'),change);else change();},
 'apps-expand':()=>{appContext().appAll=!appContext().appAll;renderAppList();$('#appListRegion [data-action="apps-expand"]')?.focus();},
 'app-collection':()=>setAppCollection(!data.appCollection?.enabled),
 'app-collection-retry':()=>setAppCollection(true),
 'export-apps':exportApps,
 'app-history-sort':e=>{const d=appContext();d.historyDirection=d.historySort===e.dataset.key&&d.historyDirection==='desc'?'asc':'desc';d.historySort=e.dataset.key;renderAppList();},
 'select-live-app':e=>{const record=applicationLiveRows((data.appProcesses||[]).map(p=>({...p,name:liveAppName(p)}))).find(p=>p.key===e.dataset.liveKey);if(record)return openApplicationDrawer({...record,name:liveAppName(record)});},
 'select-app-row':e=>{const selected=currentAppRows().find(row=>row.key===e.dataset.key);if(selected){appContext().selectedApp=selected;return openApplicationDrawer(selected);}},
 'select-app':e=>{const record=currentAppRows().find(r=>r.key===e.dataset.key);if(record){appContext().selectedApp=record;return openApplicationDrawer(record);}},
 'select-proxy-app':e=>openApplicationDrawer({appId:e.dataset.appId,name:e.dataset.appName,proxyClient:true}),
 'application-control':()=>openApplicationDrawer(),
 'choose-program':()=>controlOperation('choose'),
 'app-control':e=>controlOperation(e.dataset.operation),
 'legacy-status':()=>legacyAction(false),
 'legacy-import':()=>legacyAction(true),
 'close-modal':closeModal,
 confirm:async()=>{const fn=pendingConfirm;pendingConfirm=null;pendingAutosaveCancel=null;closeModal();if(fn)await fn();},
 export:()=>ui.page==='apps'?exportApps():exportModal(), 'export-network':e=>exportModal(e.dataset.id),
 demo:demoModal,
 help:helpModal, 'permission-help':permissionModal,
 pause:pauseCollector,
 'history-prev':()=>{ui.historyPage=Math.max(1,ui.historyPage-1);renderMain();},
 'history-next':()=>{ui.historyPage++;renderMain();},
 backup,restore,
 'clear-records':clearRecords,
 'retry-autosave':e=>formAutosave(e.closest('form')).flush(),
 'copy-ssid':e=>copySsid(e.dataset.id),
 connections:()=>showModal(t('选择要查看的网卡'),tr`<p class="modal-desc">实时速度按网卡显示；历史用量按网络聚合，不重复累加。</p><div class="demo-options">${data.live.connections.map(c=>`<button data-action="select-interface" data-id="${esc(c.interfaceId)}">${esc(c.adapterAlias)}<small>${esc(networkName(getNetwork(c.networkId)))}</small></button>`).join('')}</div>`),
 'select-interface':e=>{ui.activeInterfaceId=e.dataset.id;closeModal();renderMain();}
};
document.addEventListener('click',async event=>{
 const updateLink=event.target.closest('.release-notes-body a');if(updateLink){event.preventDefault();const href=updateLink.getAttribute('href');if(href)try{await window.desktop.updates.openLink(href);}catch(error){toast(error.message,true);}return;}
 const target=event.target.closest('[data-action]');if(!target||target.disabled)return;
 const handler=actions[target.dataset.action];if(!handler)return;if(target.tagName==='A')event.preventDefault();
 try{await handler(target);}catch(e){toast(e.message||t('操作失败，请重试。'),true);}
});
document.addEventListener('submit',async event=>{
 const form=event.target;event.preventDefault();
 if(form.dataset.busy)return;
 form.dataset.busy='true';
 try{
  if(autosaveForms.has(form.id))await formAutosave(form).flush();
  else if(form.id==='appThrottleForm')await controlOperation('throttle',Number(new FormData(form).get('uploadKBps')));
  else if(form.id==='exportForm')await doExport(Object.fromEntries(new FormData(form)));
  else if(form.id==='rangeForm'){
   const {start,end}=Object.fromEntries(new FormData(form));
   if(!validDate(start)||!validDate(end)||start>end||end>today())throw Error(t('请确认开始、结束日期有效，且结束日期不晚于今天。'));
   await selectRange('custom',{start,end});closeModal();
  }
 }catch(e){const errorBox=$('.form-error',form);if(errorBox)errorBox.textContent=e.message;else toast(e.message,true);}
 finally{delete form.dataset.busy;}
});
document.addEventListener('change',async event=>{
 const e=event.target;
 if(autosaveForms.has(e.form?.id)){editAutosave(e,true);return;}
 if(e.id==='networkFilter'){ui.networkId=e.value;ui.historyPage=1;renderMain();}
 if(e.id==='networkSort'){ui.sort=e.value;$('#networkTableRegion').innerHTML=networkTable(true);}
 if(e.id==='checkUpdatesOnStartup'){try{updateStatus=await window.desktop.updates.setCheckOnStartup(e.checked);}catch(error){toast(error.message,true);}renderUpdates();return;}
 if(e.id==='appDataSource'){const wanted=e.value==='estimated';try{if(wanted)await store.reload();if(ui.drawer?.tab!=='apps'&&ui.page!=='apps')return;appContext().proxyEstimated=wanted&&!!data.proxy?.available;appContext().selectedApp=null;if(ui.drawer)renderDrawer();else renderMain();}catch(error){e.value=appContext().proxyEstimated?'estimated':'native';toast(error.message,true);}}
 if(e.id==='appGrouping'){appContext().appGrouping=e.value;renderAppList();}
 if(e.id==='appSort'){appContext().appSort=e.value;renderAppList();}

});
document.addEventListener('input',event=>{
 const e=event.target;
 if(e.id==='networkSearch'){ui.search=e.value;$('#networkTableRegion').innerHTML=networkTable(true);}
 if(e.id==='appSearch'){appContext().appSearch=e.value;appContext().appAll=false;renderAppList();}
 if(e.id==='confirmText')$('#confirmAction').disabled=e.value!==t('清空');
 if(autosaveForms.has(e.form?.id)&&e.type!=='checkbox'&&e.tagName!=='SELECT')editAutosave(e,false);
});
document.addEventListener('keydown',event=>{
 if(event.target.matches('[data-action="settings-category"]')&&['ArrowUp','ArrowDown','Home','End'].includes(event.key)){
  const tabs=$$('[data-action="settings-category"]'),index=tabs.indexOf(event.target);
  const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowDown'?1:-1)+tabs.length)%tabs.length;
  event.preventDefault();tabs[next].click();tabs[next].focus();return;
 }

 if(event.key==='Escape'){
  if(ui.modal){closeModal();event.preventDefault();}
  else if(ui.drawer){requestCloseDrawer();event.preventDefault();}
  $('#tooltip').style.display='none';return;
 }
 if(event.key==='Tab'&&(ui.modal||ui.drawer)){
  const root=ui.modal?$('.modal'):$('.drawer');
  const focusable=$$('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]',root).filter(e=>e.getClientRects().length);
  if(!focusable.length)return;const first=focusable[0],last=focusable.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
 }
 if(['ArrowLeft','ArrowRight'].includes(event.key)&&document.activeElement.matches('.drawer-tab')){
  const tabs=$$('.drawer-tab'),i=tabs.indexOf(document.activeElement),target=tabs[(i+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];event.preventDefault();target.click();
 }
});
function showTooltip(point,x,y){
 const tooltip=$('#tooltip');tooltip.innerHTML=`<strong>${esc(point.dataset.key)}</strong><br>${point.dataset.missing==='1'?t('<span>此时段没有记录</span>'):tr`<span>下载</span>　${fmtWithUnit(point.dataset.rx)}<br><span>上传</span>　${fmtWithUnit(point.dataset.tx)}`}`;
 tooltip.style.display='block';tooltip.style.left=Math.max(8,Math.min(innerWidth-195,x+12))+'px';tooltip.style.top=Math.max(8,Math.min(innerHeight-100,y-88))+'px';
}
document.addEventListener('pointermove',e=>{const point=e.target.closest('[data-chart-point]');if(point)showTooltip(point,e.clientX,e.clientY);else $('#tooltip').style.display='none';});
document.addEventListener('focusin',e=>{const point=e.target.closest('[data-chart-point]');if(point){const r=point.getBoundingClientRect();showTooltip(point,r.left+r.width/2,r.top+40);}else $('#tooltip').style.display='none';});
window.addEventListener('blur',()=>$('#tooltip').style.display='none');
window.addEventListener('beforeunload',event=>{if(settingsDirty||networkDirty||totalQuotaDirty||proxyDirty){event.preventDefault();event.returnValue='';}});
window.addEventListener('hashchange',()=>{const p=location.hash.slice(1);if(['overview','networks','apps','history','settings'].includes(p))navigate(p);});
const stopPreferences=window.desktop.windowPreferences?.onChanged(receiveWindowPreferences);
window.addEventListener('unload',()=>{stopPreferences?.();systemTheme.removeEventListener('change',applyTheme);},{once:true});
window.addEventListener('focus',()=>reloadWindowPreferences().catch(console.error));
// 启动：先取一份快照再渲染；后端不可用时给出明确提示而不是显示空数据。
renderMain();
const initialRange=getRange();
store.start({from:initialRange.start,to:initialRange.end}).then(()=>{
 storageFailed=false;restartSampler();renderMain();
 if(data.live.state==='disconnected')setTimeout(()=>toast(t('当前没有已连接的 Wi-Fi，连接后会从新的基线开始统计。')),300);
}).catch(error=>{
 storageFailed=true;renderMain();
 toast(tr`无法连接采集后端：${error.message}`,true);
});

if(window.desktop.updates){
 window.desktop.updates.status().then(status=>{updateStatus=status;renderUpdates();}).catch(error=>{updateStatus={state:'error',error:error.message};renderUpdates();});
 window.desktop.updates.onStatus(status=>{updateStatus={...updateStatus,...status};renderUpdates();if(status.state==='available')toast(t('发现新版本，请在设置中查看更新。'));});
}
