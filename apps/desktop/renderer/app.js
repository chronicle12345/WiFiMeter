import { GB, GiB, B, byteUnitFor, formatByteParts, dayKey, dateOf, shiftDay, today, monthStart, niceDate, totalOf, validDate, quotaFor, appUsageInRange, bytePercent, sortApps } from './data/model.js';
import { createDataClient } from './data/client.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const params = new URLSearchParams(location.search);
const icons = {
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
$('.brand-name').textContent = productName;
// 数据来自本机后端进程；snapshot 是同一个对象，客户端收到事件后就地更新。
const store = createDataClient({onLive:refreshLive,onUsage:refreshLive,onAlert:showAlert});
let data=store.snapshot;
let storageFailed=false;
const ui={page:['overview','networks','history','settings'].includes(location.hash.slice(1))?location.hash.slice(1):'overview',period:'month',start:monthStart(today()),end:today(),networkId:'all',search:'',sort:'total',historyPage:1,drawer:null,modal:null,activeInterfaceId:null,lastFocus:null};
let samplerTimer=null,lastTick=performance.now(),settingsDirty=false;
function fmtExport(bytes,precision=6){const divisor=data.settings.unit==='GiB'?GiB:GB;return (Number(B(bytes))/Number(divisor)).toLocaleString('en-US',{minimumFractionDigits:precision,maximumFractionDigits:precision});}
function fmtWithUnit(bytes){const {value,unit}=formatByteParts(bytes,data.settings.unit);return `${value} ${unit}`;}
function fmtNumber(bytes,hasRecords=true){if(!hasRecords)return '—';const {value,unit}=formatByteParts(bytes,data.settings.unit);return `${value}<span>${unit}</span>`;}
function speed(bytes){const divisor=data.settings.speedUnit==='Mbps'?125000:1000000;return (Number(B(bytes))/divisor).toFixed(2);}
function getRange(){if(ui.period==='today')return {start:today(),end:today()};if(ui.period==='week')return {start:shiftDay(today(),-6),end:today()};if(ui.period==='month')return {start:monthStart(today()),end:today()};return {start:ui.start,end:ui.end};}
function periodName(){return {today:'今日',week:'近 7 天',month:'本月',custom:'所选期间'}[ui.period];}
function rangeText(){const r=getRange();return r.start===r.end?`${r.start.replaceAll('-',' / ')}`:`${r.start.replaceAll('-',' / ')} — ${r.end.slice(5).replace('-',' / ')}`;}
function networkName(n){return n?.alias||n?.ssid||n?.profileName||'未识别网络';}
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
 const m=new Map(rows.map(x=>[x.date,x]));const all=[];
 for(let k=r.start;k<=r.end&&all.length<367;k=shiftDay(k,1)){const x=m.get(k);all.push({key:niceDate(k),label:`${Number(k.slice(5,7))}/${Number(k.slice(8))}`,rx:x?.rx||0n,tx:x?.tx||0n,missing:!x});}
 return all;
}
function chartUnit(rows){return byteUnitFor(rows.reduce((peak,r)=>r.rx+r.tx>peak?r.rx+r.tx:peak,0n),data.settings.unit);}
function chartSvg(rows,id='usage-chart') {
 if(!rows.length)return `<div class="loading-box">${ui.period==='today'?'暂无小时明细':'所选时段暂无流量记录'}</div>`;
 const w=660,h=194,left=43,right=9,top=18,bottom=30,pw=w-left-right,ph=h-top-bottom;
 const {unit,divisor:bytesPerUnit}=chartUnit(rows),divisor=Number(bytesPerUnit),vals=rows.map(r=>Number(r.rx+r.tx)/divisor),peak=Math.max(...vals,1);
 const power=10**Math.floor(Math.log10(peak)),step=Math.ceil(peak/power/4)*power,max=step*4;
 let s=`<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="${id}-title ${id}-desc"><title id="${id}-title">${esc(periodName())}上传与下载流量（${unit}）</title><desc id="${id}-desc">单位 ${unit}；深蓝色代表下载，浅蓝色代表上传。缺失日期不表示零用量。可聚焦每根柱查看数据。</desc><text x="${left}" y="11">${unit}</text>`;
 for(let i=0;i<=4;i++){const y=top+ph-ph*i/4,v=max*i/4;s+=`<line class="gridline" x1="${left}" y1="${y}" x2="${w-right}" y2="${y}"/><text x="${left-10}" y="${y+3}" text-anchor="end">${v.toLocaleString('en-US',{maximumFractionDigits:2})}</text>`;}
 const cell=pw/rows.length,bw=Math.min(26,cell*.56),labelStep=rows.length<=8?1:Math.ceil(rows.length/6);
 rows.forEach((r,i)=>{
  const x=left+cell*i+cell/2-bw/2,rxH=ph*(Number(r.rx)/divisor)/max,txH=ph*(Number(r.tx)/divisor)/max,y=top+ph;
  s+=`<g class="bar-group" tabindex="0" data-chart-point="1" data-key="${esc(r.key)}" data-rx="${r.rx}" data-tx="${r.tx}" data-missing="${r.missing?'1':'0'}" aria-label="${esc(r.key)}，${r.missing?'无记录':`下载 ${fmtWithUnit(r.rx)}，上传 ${fmtWithUnit(r.tx)}`}">`;
  if(r.missing)s+=`<line x1="${x}" y1="${y-1}" x2="${x+bw}" y2="${y-1}" stroke="#cedaeb" stroke-dasharray="2 2"/>`;
  else s+=`<rect class="bar-rx" x="${x}" y="${y-rxH}" width="${bw}" height="${rxH}" rx="2"/><rect class="bar-tx" x="${x}" y="${y-rxH-txH}" width="${bw}" height="${txH}" rx="2"/>`;
  s+=`<rect class="bar-hit" x="${left+cell*i}" y="${top}" width="${cell}" height="${ph+5}"/></g>`;
  if(i%labelStep===0||(i===rows.length-1&&(rows.length-1)%labelStep>labelStep/2))s+=`<text x="${x+bw/2}" y="${h-9}" text-anchor="middle">${esc(r.label)}</text>`;
 });
 return s+'</svg>';
}
function toast(text,error=false){const e=document.createElement('div');e.className='toast'+(error?' error':'');e.innerHTML=icon(error?'alert':'check')+`<div>${esc(text)}</div>`;while($('#toasts').children.length>=2)$('#toasts').firstElementChild.remove();$('#toasts').append(e);setTimeout(()=>e.remove(),4200);}
function empty(title='暂无流量记录',text='连接 Wi-Fi 后，采集器会从新的基线开始记录。',button=''){return `<div class="empty-state"><div class="empty-icon">${icon('wifi')}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${button}</div>`;}
function button(action,label,ico='',cls='',extra=''){return `<button class="btn ${cls}" data-action="${action}" ${extra}>${ico?icon(ico):''}${label}</button>`;}
function toggle(name,checked,label){return `<label class="switch"><input type="checkbox" name="${name}" ${checked?'checked':''} aria-label="${esc(label)}"><span class="switch-track"></span></label>`;}
function option(v,label,selected){return `<option value="${esc(v)}" ${String(v)===String(selected)?'selected':''}>${esc(label)}</option>`;}
function networkOptions(selected=ui.networkId,all=true){return (all?option('all','全部网络',selected):'')+data.networks.map(n=>option(n.id,networkName(n),selected)).join('');}
function toolbar(){return `<div class="toolbar"><div class="toolbar-start"><div class="segmented" aria-label="统计时间范围">${[['today','今日'],['week','近 7 天'],['month','本月'],['custom','自定义']].map(([k,v])=>`<button data-action="period" data-value="${k}" class="${ui.period===k?'active':''}" aria-pressed="${ui.period===k}">${v}</button>`).join('')}</div><div class="date-text">${icon('calendar')}${esc(rangeText())}</div></div><label><span class="sr-only">按网络筛选</span><select class="select compact" id="networkFilter">${networkOptions()}</select></label></div>`;}
function renderChrome(){
 const labels={overview:['流量总览','查看用量、连接状态与网络额度。'],networks:['我的网络','按 Wi-Fi 分别记录，每段连接都有归属。'],history:['历史记录','按时间回看用量，保留清晰的流量记录。'],settings:['偏好设置','让统计方式，适合你的使用习惯。']};
 const [title,description]=labels[ui.page];document.title=`${productName} · ${title}`;
 $('#brandMark').innerHTML=icon('wifi');
 $('#nav').innerHTML=[['overview','overview','总览'],['networks','wifi','网络'],['history','history','历史'],['settings','settings','设置']].map(([id,ico,label])=>`<button class="nav-item ${ui.page===id?'active':''}" data-action="navigate" data-page="${id}" ${ui.page===id?'aria-current="page"':''}>${icon(ico)}<span class="nav-text">${label}</span>${id==='networks'?`<span class="nav-count">${data.networks.length}</span>`:''}</button>`).join('');
 const running=data.live.collector==='running'&&data.live.state!=='offline',paused=data.live.collector==='paused';
 $('#collector').innerHTML=`<div class="flex gap8"><i class="dot ${paused?'warn':!running?'gray':''}"></i><span class="collector-title">${paused?'统计已暂停':running?'正在采集':'采集器未就绪'}</span></div><div class="collector-sub">每 ${data.settings.interval} 秒采样 · SQLite 落盘<br>${paused?'历史记录仍可查看':'按网络独立累计'}</div>${button('pause',paused?'恢复统计':'暂停统计',paused?'play':'pause','small-btn',!running&&!paused?'disabled':'')}`;
 $('#sidebarFooter').innerHTML=icon('shield')+`<span>记录保存在本机数据库</span>`;
 $('#pageHead').innerHTML=`<div><div class="breadcrumbs">工作台 / ${{overview:'总览',networks:'网络',history:'历史',settings:'设置'}[ui.page]}</div><h1>${title}</h1><p class="page-description">${description}</p></div><div class="head-actions"><button class="icon-btn help-btn" aria-label="统计口径与帮助" data-action="help">${icon('help')}</button><button class="demo-pill" data-action="demo">${icon('info')}采集状态</button>${button('export','导出数据','export','primary')}</div>`;
 const time=new Date(data.live.updatedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
 $('#footer').innerHTML=`<div>${icon('shield')}本机采集 · 数据存于本机数据库<span>·</span>${storageFailed?'无法连接采集后端，请检查状态':`更新于 ${esc(time)}`}</div><div class="footer-secondary">${esc(productName)} / Desktop<span>·</span>上传与下载分别统计</div>`;
}
function connectionPanel(){
 const c=getConnection(),n=c?getNetwork(c.networkId):null,state=data.live.state;
 if(state==='loading')return `<div class="connection"><div class="connection-icon">${icon('clock')}</div><div><div class="connection-title">等待本机采集器</div><div class="connection-details">正在连接本机采集后端。</div></div>${button('demo','查看状态','reset','','style="margin-left:auto"')}</div>`;
 if(state==='permission')return `<div class="connection warn"><div class="connection-icon">${icon('shield')}</div><div><div class="connection-title">无法读取 Wi-Fi 名称</div><div class="connection-details">网络身份权限不足 · 未识别流量不会记到上一个 Wi-Fi</div></div>${button('permission-help','处理方式','arrow','','style="margin-left:auto"')}</div>`;
 if(state==='offline'||data.live.collector==='offline')return `<div class="connection error"><div class="connection-icon">${icon('alert')}</div><div><div class="connection-title">采集器暂未响应</div><div class="connection-details">下方为已保存的记录，不代表当前实时状态。</div></div>${button('demo','检查状态','reset','','style="margin-left:auto"')}</div>`;
 if(state==='disconnected'||!c)return `<div class="connection"><div class="connection-icon">${icon('offline')}</div><div><div class="connection-title">尚未连接 Wi-Fi</div><div class="connection-details">历史记录仍可查看；重新连接后从新的基线开始统计。</div></div>${button('demo','查看连接','arrow','','style="margin-left:auto"')}</div>`;
 const paused=data.live.collector==='paused',more=data.live.connections.length-1;
 // 刚连上新网络、还没有产生任何流量时，快照里只有连接而没有对应的网络条目，
 // getNetwork 会返回 undefined：这时 SSID 只能从连接本身取，不能直接读 n.ssid。
 const ssid=n?.ssid??c.ssid??'';
 return `<div class="connection"><div class="connection-icon">${icon('wifi')}</div><div><div class="connection-title">${esc(networkName(n??c))}<span class="pill"><i class="dot"></i>已连接</span>${more?`<button class="pill gray" data-action="connections">+${more} 张网卡</button>`:''}</div><div class="connection-details"><span>${esc(ssid)}</span><span class="divider-dot">/</span><span>${esc(c.band)}</span><span class="divider-dot">/</span><span>信号 ${c.signal}%</span>${paused?'<span class="pill warn">统计已暂停</span>':''}</div></div><div class="connection-right"><div class="rate"><div class="rate-label">${icon('down')}当前下载</div><div class="rate-value num"><b data-live-rx style="font-weight:inherit">${paused?'—':speed(c.rxPerSecond)}</b><span>${data.settings.speedUnit}</span></div></div><div class="rate"><div class="rate-label">${icon('up')}当前上传</div><div class="rate-value num"><b data-live-tx style="font-weight:inherit">${paused?'—':speed(c.txPerSecond)}</b><span>${data.settings.speedUnit}</span></div></div>${n?`<button class="icon-btn" aria-label="查看当前网络详情" data-action="detail" data-id="${n.id}">${icon('arrow')}</button>`:''}</div></div>`;
}
function metrics(){const rows=selectedRows(),v=totalOf(rows),count=new Set(rows.map(r=>r.networkId)).size;return `<div class="metrics"><div class="metric featured"><div class="metric-title"><span>${periodName()}总用量</span>${icon('transfer')}</div><div class="metric-number">${fmtNumber(v.total,rows.length)}</div><div class="metric-note positive">${rows.length?`${count} 个网络 · 本机累计记录`:'暂无记录，不代表零流量'}</div></div><div class="metric"><div class="metric-title"><span>下载流量</span>${icon('down')}</div><div class="metric-number">${fmtNumber(v.rx,rows.length)}</div><div class="metric-note">${v.total?`占总用量 ${(Number(v.rx)*100/Number(v.total)).toFixed(1)}%`:'等待采样记录'}</div></div><div class="metric"><div class="metric-title"><span>上传流量</span>${icon('up')}</div><div class="metric-number">${fmtNumber(v.tx,rows.length)}</div><div class="metric-note">${v.total?`占总用量 ${(Number(v.tx)*100/Number(v.total)).toFixed(1)}%`:'等待采样记录'}</div></div></div>`;}
function trendPanel(){const r=getRange(),rows=chartRows(),unit=chartUnit(rows).unit;return `<section class="panel"><div class="panel-head"><div><h2>流量趋势</h2><div class="panel-sub">${niceDate(r.start)} — ${niceDate(r.end)} · ${ui.period==='today'?'按小时':'按日'}</div></div><div class="legend"><span><i></i>下载</span><span><i class="tx"></i>上传</span></div></div><div class="chart-wrap">${chartSvg(rows)}</div><div class="chart-caption"><span>单位：${unit}</span><span class="quality-text">无记录不等于零流量</span><span>${ui.period==='today'?'今日尚未结束':'按所选网络汇总'}</span></div></section>`;}
function quotaPanel(){
 const n=getNetwork(getConnection()?.networkId)||data.networks[0];if(!n)return `<section class="panel quota-card"><div class="panel-head"><h2>网络额度</h2></div>${empty('尚无网络','连接并开始记录后，可设置流量额度。')}</section>`;
 const q=quota(n),cls=q.percent>=100?'red':q.percent>=n.warnPercent?'warn':'';
 return `<section class="panel quota-card"><div class="panel-head"><div><h2>网络额度</h2><div class="panel-sub">${esc(networkName(n))} · ${q.period}固定周期</div></div><button class="icon-btn" data-action="detail" data-tab="settings" data-id="${n.id}" aria-label="设置该网络额度">${icon('edit')}</button></div><div class="quota-body"><div class="quota-label">${n.capGb?'剩余额度':'尚未设置流量额度'}</div><div class="quota-main">${fmtNumber(q.remaining,n.capGb)}</div><div class="progress ${cls}" role="progressbar" aria-label="网络额度使用比例" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100,Math.round(q.percent))}"><span style="width:${Math.min(100,q.percent)}%"></span></div><div class="progress-meta"><span>${n.capGb?`已用 ${fmtWithUnit(q.used)} / ${fmtWithUnit(q.cap)}`:'不限制用量'}</span><span>${n.capGb?`${q.percent.toFixed(1)}%`:''}</span></div><div class="quota-foot">${icon(n.notify?'bell':'info')}<span>${n.capGb?(n.notify?`达到 ${n.warnPercent}% 时提醒`:'流量提醒未开启'):'可单独为每个 Wi-Fi 设置'}${n.capGb&&!n.autoDisconnect?'，不自动断网':''}</span></div></div></section>`;
}
function networkTable(full=false){
 const needle=ui.search.toLowerCase();let list=data.networks.filter(n=>(ui.networkId==='all'||n.id===ui.networkId)&&(!full||`${networkName(n)} ${n.ssid}`.toLowerCase().includes(needle))).map(n=>({...n,usage:totalOf(selectedRows(n.id)),hasRecords:selectedRows(n.id).length>0}));
 list.sort((a,b)=>ui.sort==='name'?networkName(a).localeCompare(networkName(b),'zh'):ui.sort==='connected'?Number(isConnected(b.id))-Number(isConnected(a.id)):(a.usage.total>b.usage.total?-1:a.usage.total<b.usage.total?1:0));
 if(!list.length)return empty(full&&needle?'没有匹配的网络':'暂无网络记录',full&&needle?'试试其他 SSID 或网络备注。':'首次连接后会在这里出现，不需要手动添加。');
 return `<div class="table-scroll"><table><thead><tr><th>网络名称</th><th class="right">下载</th><th class="right">上传</th><th class="right">总用量</th><th>额度进度 <span class="tiny">/ 独立周期</span></th><th><span class="sr-only">操作</span></th></tr></thead><tbody>${list.map(n=>{const q=quota(n),cl=q.percent>=100?'red':q.percent>=n.warnPercent?'warn':'';return `<tr><td><div class="network-cell"><div class="network-symbol ${isConnected(n.id)?'current':''}">${icon(n.type)}</div><div><div class="flex gap8"><button class="network-name" data-action="detail" data-id="${n.id}">${esc(networkName(n))}</button>${isConnected(n.id)?'<i class="dot" title="已连接"></i>':''}</div><div class="network-ssid">${esc(n.ssid)}</div></div></div></td><td class="right">${n.hasRecords?fmtWithUnit(n.usage.rx):'—'}</td><td class="right">${n.hasRecords?fmtWithUnit(n.usage.tx):'—'}</td><td class="right strong">${n.hasRecords?fmtWithUnit(n.usage.total):'—'}</td><td><div class="table-limit">${n.capGb?`<span class="${cl==='warn'?'muted':''}">${q.percent.toFixed(0)}% <span class="tiny muted">/ ${q.period}</span></span><span class="mini-progress ${cl}"><i style="width:${Math.min(100,q.percent)}%"></i></span>`:'<span class="tiny muted">未设置额度</span>'}</div></td><td><button class="icon-btn" data-action="detail" data-id="${n.id}" aria-label="查看 ${esc(networkName(n))} 详情">${icon('arrow')}</button></td></tr>`;}).join('')}</tbody></table></div>`;
}
function quotaNotice(){const alerts=data.networks.filter(n=>n.capGb&&n.notify&&quota(n).percent>=n.warnPercent);if(!alerts.length)return '';const n=alerts[0],q=quota(n);return `<div class="notice-line">${icon('bell')}<span>${esc(networkName(n))}${q.period}用量已达 ${q.percent.toFixed(0)}%${q.percent<100?`，剩余 ${fmtWithUnit(q.remaining)}`:'，已超过所设额度'}。</span><button class="link-btn" style="margin-left:auto" data-action="detail" data-id="${n.id}" data-tab="settings">查看额度 ${icon('arrow')}</button></div>`;}
function overview(){return `${toolbar()}${connectionPanel()}${metrics()}<div class="chart-row">${trendPanel()}${quotaPanel()}</div><section class="panel table-panel"><div class="panel-head"><div><h2>网络用量</h2><div class="panel-sub">${periodName()} · 按 SSID 分类记录</div></div><button class="link-btn" data-action="navigate" data-page="networks">管理网络 ${icon('arrow')}</button></div>${networkTable()}${quotaNotice()}</section>`;}
function networksPage(){return `${toolbar()}<section class="panel table-panel"><div class="filter-line"><label class="search-box">${icon('search')}<input id="networkSearch" type="search" placeholder="搜索网络备注或 SSID" value="${esc(ui.search)}" aria-label="搜索网络"></label><div class="flex gap12"><span class="small muted">共 ${data.networks.length} 个网络</span><label><span class="sr-only">网络排序</span><select id="networkSort" class="select compact">${option('total','按用量排序',ui.sort)}${option('name','按名称排序',ui.sort)}${option('connected','已连接优先',ui.sort)}</select></label></div></div><div id="networkTableRegion">${networkTable(true)}</div></section><div class="note-box" style="margin-top:18px">${icon('info')}<div>网络名称可添加备注，原始 SSID 不会被修改。同名 SSID 的身份合并由采集器决定；网卡信息在详情中查看。额度始终使用自己的日 / 月周期，不随页面筛选变化。</div></div>`;}
function historyPage(){
 const days=groupedDays(),all=totalOf(selectedRows()),max=days.reduce((m,x)=>x.rx+x.tx>m.rx+m.tx?x:m,{date:'',rx:0n,tx:0n}),average=days.length?all.total/BigInt(days.length):0n,pages=Math.max(1,Math.ceil(days.length/10));ui.historyPage=Math.min(ui.historyPage,pages);const sliced=days.slice().reverse().slice((ui.historyPage-1)*10,ui.historyPage*10);
 return `${toolbar()}<div class="history-top"><div class="panel history-stat"><div class="metric-title">${periodName()}总用量</div><div class="metric-number">${fmtNumber(all.total,days.length)}</div><div class="metric-note">有记录的日期：${days.length} 天</div></div><div class="panel history-stat"><div class="metric-title">日均用量</div><div class="metric-number">${fmtNumber(average,days.length)}</div><div class="metric-note">仅按有记录的日期计算</div></div><div class="panel history-stat"><div class="metric-title">单日最高用量</div><div class="metric-number">${fmtNumber(max.rx+max.tx,days.length)}</div><div class="metric-note">${max.date?niceDate(max.date):'暂无记录'}</div></div></div>${trendPanel()}<section class="panel table-panel" style="margin-top:18px"><div class="panel-head"><div><h2>每日明细</h2><div class="panel-sub">本机采集 · 日期按本地时间归档</div></div><button class="link-btn" data-action="export">导出所选记录 ${icon('export')}</button></div>${days.length?`<div class="table-scroll"><table><thead><tr><th>日期</th><th class="right">下载流量</th><th class="right">上传流量</th><th class="right">总用量</th><th>记录说明</th></tr></thead><tbody>${sliced.map(d=>`<tr><td>${d.date}</td><td class="right">${fmtWithUnit(d.rx)}</td><td class="right">${fmtWithUnit(d.tx)}</td><td class="right strong">${fmtWithUnit(d.rx+d.tx)}</td><td><span class="pill ${d.date===today()?'warn':'gray'}">${d.date===today()?'当日未结束':'已保存记录'}</span></td></tr>`).join('')}</tbody></table></div><div class="pagination"><span>共 ${days.length} 天 · 每页 10 条</span><div class="flex gap8">${button('history-prev','上一页','','small-btn',ui.historyPage<=1?'disabled':'')}<span>${ui.historyPage} / ${pages}</span>${button('history-next','下一页','','small-btn',ui.historyPage>=pages?'disabled':'')}</div></div>`:empty('所选时段没有记录','更换日期或网络试试；缺失记录不会被当作零流量。')}</section>`;
}
function settingsPage(){
 const s=data.settings;
 const row=(title,desc,control)=>`<div class="setting-row"><div><div class="setting-title">${title}</div><div class="setting-desc">${desc}</div></div>${control}</div>`;
 return `<div class="settings-layout"><form class="settings-main" id="settingsForm"><section class="panel settings-group"><div class="panel-head"><div><h2>启动与采集</h2><div class="panel-sub">系统级开关会随系统设置生效</div></div></div>${row('登录时自动启动','写入系统的自启动目录，登录后自动开始采集。',toggle('autoStart',s.autoStart,'登录时自动启动'))}${row('关闭窗口时最小化到托盘','开启后关闭窗口只隐藏窗口，采集继续进行。',toggle('minimizeToTray',s.minimizeToTray,'关闭窗口时最小化到托盘'))}${row('采样间隔','后端按此间隔读取网卡计数器。',`<select class="select compact" name="interval" aria-label="采样间隔">${[2,5,10].map(v=>option(v,`${v} 秒`,s.interval)).join('')}</select>`)}</section><section class="panel settings-group"><div class="panel-head"><h2>显示与提醒</h2></div>${row('流量单位进制','用量自动选择单位；十进制按 1000、二进制按 1024 换算。',`<select class="select compact" name="unit" aria-label="流量单位进制">${option('GB','十进制 · KB / MB / GB',s.unit)}${option('GiB','二进制 · KiB / MiB / GiB',s.unit)}</select>`)}${row('实时速度单位','MB/s 是字节速率；Mbps 是比特速率。',`<select class="select compact" name="speedUnit" aria-label="实时速度单位">${option('MB/s','MB/s',s.speedUnit)}${option('Mbps','Mbps',s.speedUnit)}</select>`)}${row('允许额度提醒','各网络分别设置提醒阈值；默认不自动断网。',toggle('notifications',s.notifications,'允许额度提醒'))}</section><section class="panel settings-group"><div class="panel-head"><h2>数据与存储</h2></div>${row('历史保留时长','缩短保留期前会再次确认；建议先导出备份。',`<select class="select compact" name="retention" aria-label="历史保留时长">${option(30,'最近 30 天',s.retention)}${option(90,'最近 90 天',s.retention)}${option(365,'最近 365 天',s.retention)}${option(0,'长期保留',s.retention)}</select>`)}${row('数据备份','完整备份包含网络备注、额度及记录，不含 Wi-Fi 密码。',`<div class="settings-actions">${button('backup','备份','export','small-btn','type="button"')}${button('restore','恢复','upload','small-btn','type="button"')}</div>`)}${row('清空历史记录','只清除用量记录，保留网络备注与偏好设置。',button('clear-records','清空记录','trash','small-btn','type="button"'))}</section><div class="save-bar"><span id="settingsSaveHint">更改后点击保存，防止误操作。</span><div class="flex gap8">${button('discard-settings','取消更改','','','type="button"')}<button type="submit" class="btn primary">${icon('check')}保存设置</button></div></div></form><aside class="panel settings-aside"><h3>安静运行，清楚记录</h3><div class="check-row">${icon('shield')}<span>网络记录与提醒规则保存在本机，不需要账号。</span></div><div class="check-row">${icon('wifi')}<span>按 Wi-Fi 归属流量，不将未知区间强行计入某个网络。</span></div><div class="check-row">${icon('database')}<span>历史总量与应用统计独立展示，避免相加造成重复。</span></div><div class="check-row">${icon('bell')}<span>超额默认只提醒。自动断网须在网络详情里明确开启。</span></div><div class="note-box" style="padding:12px;font-size:10px">历史、额度与偏好都保存在本机数据库。开机启动与托盘属于系统级设置。</div></aside></div>`;
}
function renderMain(){
 renderChrome();
 $('#content').innerHTML=({overview,networks:networksPage,history:historyPage,settings:settingsPage}[ui.page])();
 if(ui.page==='settings')settingsDirty=false;
 syncInert();
}
function navigate(page){
 if(ui.page==='settings'&&settingsDirty){confirmModal('放弃未保存的更改？','当前设置尚未保存。离开后会恢复上一次保存的偏好。','放弃并离开',()=>{settingsDirty=false;doNavigate(page);});return;}
 doNavigate(page);
}
function doNavigate(page){ui.page=page;ui.search='';closeDrawer();try{history.replaceState(null,'',location.pathname+location.search+'#'+page);}catch{/* Sandboxed previews may not permit URL updates. */}renderMain();window.scrollTo({top:0,behavior:'instant'});}
function syncInert(){
 const hasDrawer=!!ui.drawer,hasModal=!!ui.modal;
 $('.sidebar').inert=hasDrawer||hasModal;$('#main').inert=hasDrawer||hasModal;
 const drawer=$('.drawer');if(drawer)drawer.inert=hasModal;
 document.body.style.overflow=hasDrawer||hasModal?'hidden':'';
}
function openDrawer(id,tab='usage'){
 if(!getNetwork(id))return;ui.lastFocus=document.activeElement;ui.drawer={id,tab,appSearch:'',appSort:'total',appAll:false};renderDrawer();syncInert();setTimeout(()=>$('#closeDrawer')?.focus(),0);
}
function closeDrawer(){
 ui.drawer=null;$('#drawerRoot').innerHTML='';syncInert();if(ui.lastFocus?.isConnected)ui.lastFocus.focus();
}
function drawerUsage(n){
 const rows=selectedRows(n.id),v=totalOf(rows),connection=data.live.connections.find(c=>c.networkId===n.id),days=groupedDays(n.id).slice(-5).reverse();
 return `<div class="between"><span class="small muted">${esc(periodName())} · ${esc(rangeText())}</span><span class="pill gray">本机采样</span></div><div class="drawer-total"><div class="small muted">总用量</div><div class="metric-number">${fmtNumber(v.total,rows.length)}</div></div><div class="metrics"><div class="metric"><div class="metric-title">下载 ${icon('down')}</div><div class="metric-number">${fmtNumber(v.rx,rows.length)}</div></div><div class="metric"><div class="metric-title">上传 ${icon('up')}</div><div class="metric-number">${fmtNumber(v.tx,rows.length)}</div></div></div><div class="detail-section"><div class="between"><h3>用量趋势</h3><div class="legend"><span><i></i>下载</span><span><i class="tx"></i>上传</span></div></div><div class="chart-wrap">${chartSvg(chartRows(n.id),'drawer-chart')}</div></div>${connection&&data.live.state==='connected'?`<dl class="kv-grid"><div><dt>无线网卡</dt><dd>${esc(connection.adapterAlias)}</dd></div><div><dt>频段 / 信号</dt><dd>${esc(connection.band)} / ${connection.signal}%</dd></div><div><dt>连接开始</dt><dd>${esc(new Date(connection.since).toLocaleString('zh-CN',{hour12:false}))}</dd></div><div><dt>统计状态</dt><dd>${data.live.collector==='paused'?'已暂停':'采样中'}</dd></div></dl>`:''}<div class="detail-section"><h3>最近记录</h3>${days.length?`<table><thead><tr><th>日期</th><th class="right">下载</th><th class="right">上传</th></tr></thead><tbody>${days.map(d=>`<tr><td>${niceDate(d.date)}</td><td class="right">${fmtWithUnit(d.rx)}</td><td class="right">${fmtWithUnit(d.tx)}</td></tr>`).join('')}</tbody></table>`:'<p class="small muted">所选时间内没有该网络的记录。</p>'}</div>${button('export-network','导出此网络记录','export','','data-id="'+n.id+'"')}`;
}
function drawerApps(n){
 const {start,end}=getRange(),apps=appUsageInRange(data.appRecords,n.id,start,end);
 const heading=`<div class="between"><span class="small muted">${esc(periodName())} · ${esc(rangeText())}</span><span class="pill gray">应用记录</span></div>`;
 if(!data.appRecords.length&&!data.appCollection?.available)return `${heading}<div class="source-tag" style="margin-top:16px">${icon('info')}尚未采集</div>${empty('应用级流量尚未采集','按进程归属流量需要额外的系统能力，当前构建没有可用的应用采集器。')}<div class="note-box" style="margin-top:16px">${icon('info')}<div>网卡用量明细与历史记录来自真实采集；应用分布将在接入原生采集器后填充。</div></div>`;
 const sum=apps.reduce((s,a)=>s+a.total,0n);
 return `${heading}<div id="appStatusRegion">${appStatus(n)}</div><div class="drawer-total"><div class="small muted">已统计应用总用量</div><div class="metric-number" id="appTotal">${fmtNumber(sum,apps.length)}</div></div><div class="note-box">${icon('info')}<div>占比按当前网络和时段的已统计应用流量计算。应用统计与网卡统计口径可能不同，两者分别展示。</div></div><div class="app-filters"><label class="search-box">${icon('search')}<input id="appSearch" type="search" placeholder="搜索应用" aria-label="搜索应用" value="${esc(ui.drawer.appSearch)}"></label><label><span class="sr-only">应用排序</span><select class="select compact" id="appSort">${[['total','按总量'],['rx','按下载'],['tx','按上传']].map(([v,label])=>option(v,label,ui.drawer.appSort)).join('')}</select></label></div><div id="appListRegion" aria-live="polite">${appList(n)}</div>`;
}
function appStatus(n){
 const c=data.appCollection||{state:'disabled'},labels={disabled:'应用采集未启用',starting:'应用采集正在启动',running:'应用采集中',paused:'应用采集已暂停',permission:'应用采集需要系统授权',unavailable:'应用采集暂不可用',partial:'应用采集有缺失'};
 const {start,end}=getRange(),gaps=(data.appGaps||[]).filter(g=>(!g.networkId||g.networkId===n.id)&&dayKey(new Date(g.startedAt))<=end&&(!g.endedAt||dayKey(new Date(g.endedAt))>=start));
 return `<div class="between app-status"><span class="small muted">${esc(labels[c.state]||labels.unavailable)}</span>${c.available?button('app-collection',c.enabled?'停止应用采集':'启用应用采集','','small-btn'):''}</div>${c.state==='permission'?'<p class="small muted">开启应用采集需要额外的系统权限，请完成系统授权后重试。</p>':''}${c.available&&(c.state==='permission'||c.state==='unavailable')?button('app-collection-retry','重试应用采集','','small-btn'):''}${gaps.length?`<p class="small muted">所选时段有 ${gaps.length} 段应用采集缺失；已记录的流量仍可查看。</p>`:''}`;
}
function appList(n){
 const {start,end}=getRange(),apps=appUsageInRange(data.appRecords,n.id,start,end),sum=apps.reduce((s,a)=>s+a.total,0n);
 const list=sortApps(apps,ui.drawer.appSort,ui.drawer.appSearch),visible=ui.drawer.appAll?list:list.slice(0,10);
 if(!apps.length){const historical=data.appRecords.length||data.appCollection?.enabled;return empty(historical?'所选时段没有应用记录':'应用级流量尚未采集',historical?'试试其他日期或网络。应用采集开始前的流量无法补算。':'启用后将从新的基线开始记录应用用量。');}
 if(!list.length)return empty('没有匹配的应用','试试其他应用名称。');
 return `<div class="small muted">共 ${list.length} 个应用 · 显示 ${visible.length} 个</div><ol class="app-list">${visible.map(a=>{const percent=bytePercent(a.total,sum);return `<li class="app-row"><div class="app-avatar" aria-hidden="true">${esc([...a.name][0]||'?')}</div><div class="app-description"><div class="app-name">${esc(a.name)}</div><div class="app-source">下载 ${fmtWithUnit(a.rx)} · 上传 ${fmtWithUnit(a.tx)}</div><div class="progress" aria-hidden="true"><span style="width:${percent}%"></span></div>${data.appCollection?.available?button('app-processes','最近采样进程','','small-btn',`data-app-id="${esc(a.id)}"`):''}</div><div class="app-value"><strong>${fmtWithUnit(a.total)}</strong><div class="app-source">${sum?percent.toFixed(1)+'%':'—'}</div></div></li>`;}).join('')}</ol>${list.length>10?button('apps-expand',ui.drawer.appAll?'收起列表':'显示全部应用','','small-btn'):''}`;
}
function renderAppList(){
 if(ui.drawer?.tab!=='apps')return;
 if(!$('#appListRegion')){if(data.appRecords.length||data.appCollection?.available)renderDrawer();return;}
 const active=document.activeElement,focused=active?.matches('#appListRegion button,#appStatusRegion button')?{action:active.dataset.action,appId:active.dataset.appId}:null;
 const n=getNetwork(ui.drawer.id),{start,end}=getRange(),apps=appUsageInRange(data.appRecords,n.id,start,end),sum=apps.reduce((s,a)=>s+a.total,0n);
 $('#appListRegion').innerHTML=appList(n);$('#appStatusRegion').innerHTML=appStatus(n);$('#appTotal').innerHTML=fmtNumber(sum,apps.length);
 if(focused)$$('#appListRegion button,#appStatusRegion button').find(b=>b.dataset.action===focused.action&&b.dataset.appId===focused.appId)?.focus();
}
async function setAppCollection(enabled){
 const buttons=$$('[data-action="app-collection"],[data-action="app-collection-retry"]');buttons.forEach(b=>b.disabled=true);
 try{await store.setAppCollection(enabled);renderAppList();}finally{buttons.forEach(b=>b.disabled=false);}
}
function appProcessesModal(appId){
 const processes=(data.appProcesses||[]).filter(p=>p.networkId===ui.drawer.id&&p.appId===appId);
 showModal('最近采样进程',`<p class="modal-desc">显示本次采集的进程与速率，历史用量已按应用归并。</p>${processes.length?`<table><thead><tr><th>PID</th><th class="right">下载速度</th><th class="right">上传速度</th></tr></thead><tbody>${processes.map(p=>`<tr><td>${esc(p.processId)}</td><td class="right">${speed(p.rxPerSecond)}</td><td class="right">${speed(p.txPerSecond)}</td></tr>`).join('')}</tbody></table>`:'<p class="small muted">当前没有该应用的进程数据。</p>'}`,button('close-modal','关闭'));
}
function drawerSettings(n){
 return `<form id="networkForm" data-id="${n.id}"><div class="field"><label for="aliasInput">网络备注</label><input class="input" id="aliasInput" name="alias" value="${esc(n.alias)}" placeholder="给这个 Wi-Fi 起一个容易辨认的名字" maxlength="128"><div class="field-hint">仅用于显示；原始 SSID 为 ${esc(n.ssid)}。</div></div><div class="field-row"><div class="field"><label for="quotaInput">流量额度</label><div class="input-unit"><input class="input" id="quotaInput" name="capGb" type="number" value="${n.capGb||''}" placeholder="不限制" min="0" max="100000" step="0.01"><span>GB</span></div><div class="field-hint">固定十进制 GB；留空或 0 表示不设额度。</div></div><div class="field"><label for="quotaPeriod">额度周期</label><select class="input" id="quotaPeriod" name="quotaPeriod">${option('month','每自然月',n.quotaPeriod)}${option('day','每天',n.quotaPeriod)}</select><div class="field-hint">按本地日期重置，不随页面筛选变化。</div></div></div><div class="setting-row" style="padding:17px 0"><div><div class="setting-title">用量接近额度时提醒</div><div class="setting-desc">此网络的提醒还受全局提醒开关控制。</div></div>${toggle('notify',n.notify,'接近额度时提醒')}</div><div class="field" style="margin-top:18px"><label for="warnPercent">提醒阈值</label><select class="input" id="warnPercent" name="warnPercent">${[50,75,80,90,95,100].map(v=>option(v,`已用额度的 ${v}%`,n.warnPercent)).join('')}${![50,75,80,90,95,100].includes(n.warnPercent)?option(n.warnPercent,`已用额度的 ${n.warnPercent}%`,n.warnPercent):''}</select></div><div class="setting-row" style="padding:17px 0"><div><div class="setting-title">达到额度后自动断开</div><div class="setting-desc">达到额度后由后端核对网络身份并断开当前连接。</div></div>${toggle('autoDisconnect',n.autoDisconnect,'达到额度后自动断开')}</div><div class="note-box warn" style="margin:18px 0">${icon('alert')}<div>达到额度后，后端会先确认当前连接的正是这个网络，再执行断开并复核结果。</div></div><div class="form-error" id="networkFormError" role="alert"></div><button class="btn primary" type="submit" style="width:100%">${icon('check')}保存网络设置</button></form>`;
}
function renderDrawer(){
 if(!ui.drawer){$('#drawerRoot').innerHTML='';return;}
 const n=getNetwork(ui.drawer.id);if(!n){closeDrawer();return;}
 const tab=ui.drawer.tab;
 $('#drawerRoot').innerHTML=`<div class="backdrop" data-action="close-drawer"></div><section class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle"><header class="drawer-head"><div class="between"><div class="flex gap8"><h2 id="drawerTitle">${esc(networkName(n))}</h2>${isConnected(n.id)?'<span class="pill"><i class="dot"></i>已连接</span>':''}</div><button class="icon-btn" data-action="close-drawer" id="closeDrawer" aria-label="关闭网络详情">${icon('close')}</button></div><div class="drawer-sub"><span>SSID · ${esc(n.ssid)}</span><button class="icon-btn small-icon" data-action="copy-ssid" data-id="${n.id}" aria-label="复制 SSID">${icon('copy')}</button></div></header><div class="drawer-tabs" role="tablist" aria-label="网络详情分类">${[['usage','用量明细'],['apps','应用分布'],['settings','网络设置']].map(([id,label])=>`<button class="drawer-tab ${tab===id?'active':''}" role="tab" aria-selected="${tab===id}" data-action="drawer-tab" data-tab="${id}">${label}</button>`).join('')}</div><div class="drawer-content" role="tabpanel">${tab==='usage'?drawerUsage(n):tab==='apps'?drawerApps(n):drawerSettings(n)}</div><footer class="drawer-footer">数据来自本机采集 · 网络身份不受备注更改影响</footer></section>`;
 syncInert();
}
let modalReturnFocus=null;
function showModal(title,body,actions='',onShow=null){
 modalReturnFocus=document.activeElement;
 ui.modal={title};$('#modalRoot').innerHTML=`<div class="modal-shell" data-modal-shell="1"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div class="between"><h2 id="modalTitle">${esc(title)}</h2><button class="icon-btn" data-action="close-modal" aria-label="关闭对话框">${icon('close')}</button></div>${body}${actions?`<div class="modal-actions">${actions}</div>`:''}</section></div>`;
 syncInert();setTimeout(()=>{const e=$('[autofocus]', $('#modalRoot'))||$('button', $('#modalRoot'));e?.focus();onShow?.();},0);
}
function closeModal(){ui.modal=null;$('#modalRoot').innerHTML='';syncInert();if(modalReturnFocus?.isConnected)modalReturnFocus.focus();}
let pendingConfirm=null;
function confirmModal(title,text,label,fn,danger=false,requireText=false){
 pendingConfirm=fn;
 showModal(title,`<p class="modal-desc">${esc(text)}</p>${requireText?'<div class="field"><label for="confirmText">输入“清空”确认</label><input id="confirmText" class="input" autocomplete="off" autofocus><div class="field-hint">该操作无法撤销。建议先导出备份。</div></div>':''}`,button('close-modal','取消')+button('confirm',label,'',danger?'danger':'primary',requireText?'id="confirmAction" disabled':''));
}
function exportModal(networkId=null){
 const id=networkId||ui.networkId;
 showModal('导出流量记录',`<p class="modal-desc">导出当前筛选范围内的本机记录。包含原始字节数，便于后续核对。</p><form id="exportForm"><div class="field"><label for="exportNetwork">网络范围</label><select id="exportNetwork" class="input" name="networkId">${networkOptions(id)}</select></div><div class="field-row"><div class="field"><label for="exportStart">开始日期</label><input class="input" id="exportStart" name="start" type="date" value="${getRange().start}" required></div><div class="field"><label for="exportEnd">结束日期</label><input class="input" id="exportEnd" name="end" type="date" value="${getRange().end}" max="${today()}" required></div></div><div class="field"><label for="exportFormat">文件格式</label><select class="input" id="exportFormat" name="format">${option('csv','CSV · 可用表格软件打开','csv')}${option('json','JSON · 精确字节数','csv')}</select></div><div class="form-error" id="exportError" role="alert"></div><div class="modal-actions">${button('close-modal','取消','','','type="button"')}<button class="btn primary" type="submit">${icon('export')}导出记录</button></div></form>`);
}
function demoModal(){
 const labels={connected:['已连接','正在读取当前网络与速率'],disconnected:['未连接 Wi-Fi','有无线网卡但没有关联网络'],permission:['权限不足','无法确定网络身份，未见过的流量不会记到上一个网络'],offline:['采集器不可用','读不到网卡信息，下方记录可能已过期'],loading:['正在启动','正在连接本机采集后端']};
 const [title,detail]=labels[data.live.state]??['未知状态',''];
 const interfaces=data.live.connections.length?data.live.connections.map(c=>`<div class="check-row">${icon('wifi')}<span>${esc(c.adapterAlias)} · ${esc(networkName(getNetwork(c.networkId)))} · 信号 ${c.signal}%</span></div>`).join(''):`<div class="check-row">${icon('offline')}<span>当前没有已关联的无线网卡</span></div>`;
 const gaps=(data.gaps??[]).length;
 showModal('采集状态',`<p class="modal-desc">数据由本机后端进程读取网卡计数器后写入本机数据库，不经过网络。</p><div class="check-row">${icon('database')}<span>采集器：${data.live.collector==='running'?'运行中':data.live.collector==='paused'?'已暂停':'不可用'} · ${title}</span></div><div class="check-row">${icon('info')}<span>${esc(detail)}</span></div>${interfaces}${gaps?`<div class="check-row">${icon('alert')}<span>有 ${gaps} 段区间没有采集到数据，已单独记录，不会显示成 0。</span></div>`:''}<div class="note-box" style="margin-top:18px">${icon('info')}<div>备注、额度、导出与备份都写入本机数据库；开机启动、托盘与真实断网属于系统级设置。</div></div>`,button('close-modal','完成','','primary'));
}
function helpModal(){showModal('统计口径与使用说明',`<div class="modal-desc"><strong>总量 = 下载 + 上传</strong><br>首页和网络明细展示采集器记录的网卡流量；用量自动选择单位，设置中可切换十进制或二进制。<br><br><strong>历史与实时分开</strong><br>日期筛选仅影响历史用量。连接卡片显示当前选中网卡的实时状态，额度使用独立日 / 月周期。<br><br><strong>缺失记录不会伪装成零流量</strong><br>断网、暂停、计数器重置与身份不明期间的覆盖情况，由后端记录并说明。<br><br><strong>应用用量独立统计</strong><br>应用分布按当前网络与时段展示已采集的应用记录。启用应用采集后从新的基线开始，暂停和停止不会删除历史；是否可采集以及缺失区间会在页面说明。<br><br><strong>数据来源</strong><br>页面读取本机后端进程的采集结果，数据存放在本机 SQLite 数据库，不上传任何内容。</div>`,button('close-modal','知道了','','primary'));}
function permissionModal(){showModal('无法确定网络身份',`<p class="modal-desc">采集器读不到当前连接的网络名。无法归属的流量不会被记到上一次连接的网络。</p><div class="note-box">${icon('shield')}<div>常见原因是 NetworkManager 未运行或当前用户无权查询连接信息。恢复后采集会从新的基线继续，中间区间会记为覆盖空档。</div></div><p class="field-hint" style="margin-top:15px">可以用 <code>nmcli dev status</code> 确认 NetworkManager 是否正常。</p>`,button('close-modal','关闭')+button('demo','查看采集状态','','primary'));}
async function dataDownload(filename,body){
 const result=await window.desktop.saveFile({filename,body});
 if(result.error)throw Error(result.error);
 return !result.canceled;
}
function csvCell(value){let text=String(value??'');if(/^[\s]*[=+\-@]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}
async function doExport(values){
 const {networkId,start,end,format}=values;
 if(!validDate(start)||!validDate(end)||start>end||end>today())throw Error('请选择有效日期，结束日期不能早于开始日期或晚于今天。');
 const rows=data.records.filter(r=>r.date>=start&&r.date<=end&&(networkId==='all'||r.networkId===networkId)).sort((a,b)=>a.date.localeCompare(b.date));if(!rows.length)throw Error('所选范围没有可导出的流量记录。');
 let saved;
 if(format==='json')saved=await dataDownload(`WiFiMeter_${start}_${end}.json`,JSON.stringify({version:1,type:'usage-export',source:data.source,start,end,records:rows.map(r=>{const n=getNetwork(r.networkId);return {...r,ssid:n?.ssid??'',alias:n?.alias??''};})},null,2),'application/json;charset=utf-8');
 else {const header=['日期','网络备注','SSID','下载字节','上传字节','总计字节',`下载_${data.settings.unit}`,`上传_${data.settings.unit}`,`总计_${data.settings.unit}`,'数据来源'];const lines=[header,...rows.map(r=>{const n=getNetwork(r.networkId);return [r.date,networkName(n),n.ssid,r.rxBytes,r.txBytes,(B(r.rxBytes)+B(r.txBytes)).toString(),fmtExport(r.rxBytes,6).replaceAll(',',''),fmtExport(r.txBytes,6).replaceAll(',',''),fmtExport(B(r.rxBytes)+B(r.txBytes),6).replaceAll(',',''),'本机采集'];})];saved=await dataDownload(`WiFiMeter_${start}_${end}.csv`,'\uFEFF'+lines.map(row=>row.map(csvCell).join(',')).join('\r\n'),'text/csv;charset=utf-8');}
 if(!saved)return;
 closeModal();toast(`已导出 ${rows.length} 条记录。`);
}
async function backup(){
 // 备份内容由后端从数据库导出，界面只负责把文件写到用户选择的位置。
 const document=await store.backup();
 if(await dataDownload(`WiFiMeter_backup_${today()}.json`,JSON.stringify(document,null,2)))toast('已导出完整数据备份。');
}
async function restore(){
 const result=await window.desktop.openBackup();
 if(result.canceled)return;
 if(result.error)throw Error(result.error);
 let document;
 try{document=JSON.parse(result.body);}catch{throw Error('这个文件不是有效的备份文件。');}
 if(document?.backupType!=='wifimeter-backend-backup')throw Error('请选择“备份”功能生成的完整文件，而不是流量导出文件。');
 confirmModal('恢复这份备份？',`包含 ${document.networks?.length??0} 个网络和 ${document.records?.length??0} 条每日记录。当前数据将被替换。`,'确认恢复',async()=>{
  await store.restore(document);
  ui.networkId='all';ui.search='';ui.historyPage=1;
  restartSampler();closeDrawer();renderMain();toast('已恢复备份，采集已暂停。');
 });
}
function clearRecords(){confirmModal('清空全部用量记录？','此操作删除每日与小时记录、覆盖说明，并重置当前额度计数；保留网络备注与提醒设置。不能撤销。','清空记录',async()=>{await store.clearRecords();restartSampler();renderMain();toast('记录已清空，采集已暂停。');},true,true);}
async function saveSettings(form){
 const f=new FormData(form),next={unit:f.get('unit'),speedUnit:f.get('speedUnit'),interval:Number(f.get('interval')),retention:Number(f.get('retention')),autoStart:f.has('autoStart'),minimizeToTray:f.has('minimizeToTray'),notifications:f.has('notifications')};
 const previous=data.settings.retention,cutoff=next.retention?shiftDay(today(),1-next.retention):null,removed=cutoff?data.records.filter(r=>r.date<cutoff).length:0;
 const apply=async()=>{
  const {system}=await store.updateSettings(next);
  // 缩短保留期时立刻按新设置裁剪，而不是等到下一次采样。
  if(next.retention&&next.retention<previous)await store.pruneUsage();
  if(cutoff)await store.reload();
  restartSampler();renderMain();settingsDirty=false;
  if(next.autoStart&&system&&!system.autoStart)toast('偏好已保存，但写入开机启动项失败，请检查用户目录权限。',true);
  else toast('已保存偏好。');
 };
 if(removed)confirmModal('应用新的保留时长？',`将删除 ${cutoff} 之前的 ${removed} 条每日记录及相应明细。建议先备份；这不会改变当前额度策略。`,'确认保存',apply,true);else await apply();
}
async function saveNetwork(form){
 const n=getNetwork(form.dataset.id),f=new FormData(form),patch={alias:String(f.get('alias')||'').trim(),capGb:Number(f.get('capGb')||0),quotaPeriod:f.get('quotaPeriod'),warnPercent:Number(f.get('warnPercent')),notify:f.has('notify'),autoDisconnect:f.has('autoDisconnect')};
 if(!Number.isFinite(patch.capGb)||patch.capGb<0||patch.capGb>100000)throw Error('请输入 0 到 100000 之间的额度。');
 if(!patch.capGb&&(patch.autoDisconnect||patch.notify))throw Error('请先设置大于 0 的额度，或关闭该网络的提醒与自动断网。');
 const apply=async()=>{await store.updateNetwork(n.id,patch);networkDirty=false;renderMain();renderDrawer();toast('已保存网络设置。');};
 if(patch.autoDisconnect&&!n.autoDisconnect)confirmModal('启用自动断开规则？',`达到所设额度后，应用会断开当前连接的网络：“${networkName(n)}”。断开只在确认连的正是这个网络时执行。`,'确认启用',apply,true);else await apply();
}
function refreshAfterTick(){
 renderChrome();
 const c=getConnection(),ok=data.live.state==='connected'&&data.live.collector==='running';
 if($('[data-live-rx]'))$('[data-live-rx]').textContent=ok&&c?speed(c.rxPerSecond):'—';
 if($('[data-live-tx]'))$('[data-live-tx]').textContent=ok&&c?speed(c.txPerSecond):'—';
 const active=document.activeElement;
 // Do not recreate forms, dialogs, focused charts, or inputs during background refresh.
 if(!ui.modal&&!ui.drawer&&ui.page==='overview'&&(active===document.body||active===document.documentElement||active===$('#main')))$('#content').innerHTML=overview();
}
// 采集由后端进程按设置的间隔进行，并通过事件推送状态；界面只需要重绘。
function refreshLive(){refreshAfterTick();if(!ui.modal)renderAppList();}
function showAlert(alert){
 if(alert.kind==='quotaWarn')toast(`额度提醒：${alert.alias||alert.ssid} 已用 ${Number(alert.percent).toFixed(0)}%。`);
 else if(alert.kind==='quotaDisconnect')toast(alert.outcome===0?`已达到额度上限，已断开 ${alert.alias||alert.ssid}。`:`已达到额度上限，但未能断开 ${alert.alias||alert.ssid}：${alert.detail||'请检查系统状态'}`,true);
}
function restartSampler(){clearInterval(samplerTimer);lastTick=performance.now();if(params.get('still')!=='1')samplerTimer=setInterval(refreshAfterTick,data.settings.interval*1000);}
async function pauseCollector(){
 const paused=data.live.collector==='paused';
 await store.pause(!paused);
 if(paused)await store.reload();
 restartSampler();renderMain();
 toast(paused?'已恢复统计，从新的基线继续。':'已暂停统计。暂停期间不会补记到任何网络。');
}
function customRangeModal(){const r=getRange();showModal('选择日期范围',`<p class="modal-desc">开始和结束日期均包含在统计范围内，最多查看连续 366 天。</p><form id="rangeForm"><div class="field-row"><div class="field"><label for="rangeStart">开始日期</label><input class="input" id="rangeStart" name="start" type="date" value="${r.start}" max="${today()}" required autofocus></div><div class="field"><label for="rangeEnd">结束日期</label><input class="input" id="rangeEnd" name="end" type="date" value="${r.end}" max="${today()}" required></div></div><div class="form-error" id="rangeError" role="alert"></div><div class="modal-actions">${button('close-modal','取消','','','type="button"')}<button class="btn primary" type="submit">应用筛选</button></div></form>`);}
let networkDirty=false;
function requestCloseDrawer(){if(networkDirty){confirmModal('放弃未保存的网络设置？','网络备注与额度的更改尚未保存。','放弃更改',()=>{networkDirty=false;closeDrawer();});}else closeDrawer();}
async function copySsid(id){const text=getNetwork(id)?.ssid||'';try{await navigator.clipboard.writeText(text);toast('已复制原始 SSID。');}catch(e){showModal('复制网络名称',`<p class="modal-desc">浏览器不允许直接写入剪贴板。可以选中下方名称复制。</p><input class="input" value="${esc(text)}" readonly autofocus>`,button('close-modal','完成','','primary'),()=>$('.modal input')?.select());}}
const actions={
 navigate:e=>navigate(e.dataset.page),
 period:e=>{if(e.dataset.value==='custom')customRangeModal();else{ui.period=e.dataset.value;ui.historyPage=1;renderMain();}},
 detail:e=>{networkDirty=false;openDrawer(e.dataset.id,e.dataset.tab||'usage');},
 'close-drawer':requestCloseDrawer,
 'drawer-tab':e=>{const change=()=>{networkDirty=false;ui.drawer.tab=e.dataset.tab;renderDrawer();$(`.drawer-tab[data-tab="${e.dataset.tab}"]`)?.focus();};if(networkDirty)confirmModal('放弃未保存的网络设置？','切换标签页将放弃当前表单中的更改。','放弃更改',change);else change();},
 'apps-expand':()=>{ui.drawer.appAll=!ui.drawer.appAll;renderAppList();$('#appListRegion [data-action="apps-expand"]')?.focus();},
 'app-collection':()=>setAppCollection(!data.appCollection?.enabled),
 'app-collection-retry':()=>setAppCollection(true),
 'app-processes':e=>appProcessesModal(e.dataset.appId),
 'close-modal':closeModal,
 confirm:async()=>{const fn=pendingConfirm;pendingConfirm=null;closeModal();if(fn)await fn();},
 export:()=>exportModal(), 'export-network':e=>exportModal(e.dataset.id),
 demo:demoModal,
 help:helpModal, 'permission-help':permissionModal,
 pause:pauseCollector,
 'history-prev':()=>{ui.historyPage=Math.max(1,ui.historyPage-1);renderMain();},
 'history-next':()=>{ui.historyPage++;renderMain();},
 backup,restore,
 'clear-records':clearRecords,
 'discard-settings':()=>{settingsDirty=false;renderMain();toast('已恢复上次保存的设置。');},
 'copy-ssid':e=>copySsid(e.dataset.id),
 connections:()=>showModal('选择要查看的无线网卡',`<p class="modal-desc">实时速度按网卡显示；历史用量按网络聚合，不重复累加。</p><div class="demo-options">${data.live.connections.map(c=>`<button data-action="select-interface" data-id="${esc(c.interfaceId)}">${esc(c.adapterAlias)}<small>${esc(networkName(getNetwork(c.networkId)))}</small></button>`).join('')}</div>`),
 'select-interface':e=>{ui.activeInterfaceId=e.dataset.id;closeModal();renderMain();}
};
document.addEventListener('click',async event=>{
 const target=event.target.closest('[data-action]');if(!target||target.disabled)return;
 const handler=actions[target.dataset.action];if(!handler)return;
 try{await handler(target);}catch(e){toast(e.message||'操作失败，请重试。',true);}
});
document.addEventListener('submit',async event=>{
 const form=event.target;event.preventDefault();
 if(form.dataset.busy)return;
 form.dataset.busy='true';
 try{
  if(form.id==='settingsForm')await saveSettings(form);
  else if(form.id==='networkForm')await saveNetwork(form);
  else if(form.id==='exportForm')await doExport(Object.fromEntries(new FormData(form)));
  else if(form.id==='rangeForm'){
   const {start,end}=Object.fromEntries(new FormData(form));
   if(!validDate(start)||!validDate(end)||start>end||end>today())throw Error('请确认开始、结束日期有效，且结束日期不晚于今天。');
   if((+dateOf(end)-+dateOf(start))/86400000>365)throw Error('一次最多查看连续 366 天，请缩小范围。');
   ui.start=start;ui.end=end;ui.period='custom';ui.historyPage=1;closeModal();renderMain();
  }
 }catch(e){const errorBox=$('.form-error',form);if(errorBox)errorBox.textContent=e.message;else toast(e.message,true);}
 finally{delete form.dataset.busy;}
});
document.addEventListener('change',async event=>{
 const e=event.target;
 if(e.id==='networkFilter'){ui.networkId=e.value;ui.historyPage=1;renderMain();}
 if(e.id==='networkSort'){ui.sort=e.value;$('#networkTableRegion').innerHTML=networkTable(true);}
 if(e.id==='appSort'){ui.drawer.appSort=e.value;renderAppList();}
 if(e.closest('#settingsForm')){settingsDirty=true;$('#settingsSaveHint').textContent='有尚未保存的更改。';}
 if(e.closest('#networkForm'))networkDirty=true;

});
document.addEventListener('input',event=>{
 const e=event.target;
 if(e.id==='networkSearch'){ui.search=e.value;$('#networkTableRegion').innerHTML=networkTable(true);}
 if(e.id==='appSearch'){ui.drawer.appSearch=e.value;ui.drawer.appAll=false;renderAppList();}
 if(e.id==='confirmText')$('#confirmAction').disabled=e.value!=='清空';
 if(e.closest('#settingsForm')){settingsDirty=true;if($('#settingsSaveHint'))$('#settingsSaveHint').textContent='有尚未保存的更改。';}
 if(e.closest('#networkForm'))networkDirty=true;
});
document.addEventListener('keydown',event=>{
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
 const tooltip=$('#tooltip');tooltip.innerHTML=`<strong>${esc(point.dataset.key)}</strong><br>${point.dataset.missing==='1'?'<span>此时段没有记录</span>':`<span>下载</span>　${fmtWithUnit(point.dataset.rx)}<br><span>上传</span>　${fmtWithUnit(point.dataset.tx)}`}`;
 tooltip.style.display='block';tooltip.style.left=Math.max(8,Math.min(innerWidth-195,x+12))+'px';tooltip.style.top=Math.max(8,Math.min(innerHeight-100,y-88))+'px';
}
document.addEventListener('pointermove',e=>{const point=e.target.closest('[data-chart-point]');if(point)showTooltip(point,e.clientX,e.clientY);else $('#tooltip').style.display='none';});
document.addEventListener('focusin',e=>{const point=e.target.closest('[data-chart-point]');if(point){const r=point.getBoundingClientRect();showTooltip(point,r.left+r.width/2,r.top+40);}else $('#tooltip').style.display='none';});
window.addEventListener('blur',()=>$('#tooltip').style.display='none');
window.addEventListener('beforeunload',event=>{if(settingsDirty||networkDirty){event.preventDefault();event.returnValue='';}});
window.addEventListener('hashchange',()=>{const p=location.hash.slice(1);if(['overview','networks','history','settings'].includes(p))navigate(p);});
// 启动：先取一份快照再渲染；后端不可用时给出明确提示而不是显示空数据。
renderMain();
store.start().then(()=>{
 storageFailed=false;restartSampler();renderMain();
 if(data.live.state==='disconnected')setTimeout(()=>toast('当前没有已连接的 Wi-Fi，连接后会从新的基线开始统计。'),300);
}).catch(error=>{
 storageFailed=true;renderMain();
 toast(`无法连接采集后端：${error.message}`,true);
});
