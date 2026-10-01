import { t, getLocale } from '../i18n.js';
const clone = value => JSON.parse(JSON.stringify(value));
// 与主分支及后端一致：0 不限额，非零额度至少为一个字节。
export const MAX_QUOTA_GB = 9000000000;
export function validQuotaGb(value) {
    return Number.isFinite(value) && value >= 0 && value <= MAX_QUOTA_GB && (value === 0 || value >= 1e-9);
}
const GB = 1000000000n, GiB = 1073741824n;
const B = value => BigInt(value ?? '0');
function byteUnitFor(bytes, preference = 'GB') {
    const value = B(bytes), base = preference === 'GiB' ? 1024n : 1000n;
    const units = preference === 'GiB'
        ? ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB']
        : ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
    let divisor = 1n, index = 0;
    while (index < units.length - 1 && value >= divisor * base) { divisor *= base; index++; }
    // 舍入后达到进位阈值时继续提升单位，避免显示 1000 KB 或 1024 KiB。
    if (index < units.length - 1 && (value * 100n + divisor / 2n) / divisor >= base * 100n) {
        divisor *= base; index++;
    }
    return { unit: units[index], divisor };
}
function formatByteParts(bytes, preference = 'GB') {
    const { unit, divisor } = byteUnitFor(bytes, preference);
    const scaled = (B(bytes) * 100n + divisor / 2n) / divisor;
    const integer = (scaled / 100n).toLocaleString('en-US');
    const fraction = String(scaled % 100n).padStart(2, '0').replace(/0+$/, '');
    return { value: integer + (fraction ? '.' + fraction : ''), unit, divisor };
}
const dayKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const dateOf = key => new Date(`${key}T12:00:00`);
const shiftDay = (key, n) => {const d=dateOf(key);d.setDate(d.getDate()+n);return dayKey(d);};
const today = () => dayKey(new Date());
const monthStart = key => key.slice(0,7)+'-01';
const niceDate = key => new Intl.DateTimeFormat(getLocale(),{month:'short',day:'numeric'}).format(dateOf(key));
const defaults = {unit:'GB', speedUnit:'MB/s', interval:5, retention:90, autoStart:false, minimizeToTray:false, notifications:true};
function totalOf(rows) {let rx=0n,tx=0n;for(const r of rows){rx+=B(r.rxBytes);tx+=B(r.txBytes);}return {rx,tx,total:rx+tx};}
function validDate(key){return typeof key==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(key)&&!Number.isNaN(+dateOf(key))&&dayKey(dateOf(key))===key;}
function validateSnapshot(input, mode='demo') {
 if(!input||typeof input!=='object'||input.version!==1)throw Error(t('不支持的数据版本。'));
 if(!Array.isArray(input.networks)||input.networks.length>64||!Array.isArray(input.records)||input.records.length>100000)throw Error(t('数据结构不正确或记录数量超出限制。'));
 const data=clone(input), ids=new Set();
 const validString=(v,max)=>typeof v==='string'&&v.length<=max;
 const byteString=v=>typeof v==='string'&&/^(0|[1-9]\d{0,19})$/.test(v)&&B(v)<=18446744073709551615n;
 for(const n of data.networks){
  if(!validString(n.id,64)||!/^[-a-zA-Z0-9_]+$/.test(n.id)||ids.has(n.id)||!validString(n.ssid,256)||!validString(n.alias,128))throw Error(t('网络标识或名称不合法。'));
  ids.add(n.id);
  if(!['home','office','phone','coffee','wifi','ethernet'].includes(n.type))n.type='wifi';
  if(!validQuotaGb(n.capGb)||!Number.isFinite(n.warnPercent)||n.warnPercent<1||n.warnPercent>100)throw Error(t('额度或提醒阈值不合法。'));
  if(!['month','day','all'].includes(n.quotaPeriod))throw Error(t('额度周期不合法。'));
  if(n.quotaLedger&&(!/^(all|\d{4}-\d{2}|\d{4}-\d{2}-\d{2})$/.test(n.quotaLedger.periodKey)||!byteString(n.quotaLedger.usedBytes)))throw Error(t('额度计数不合法。'));
  n.notify=n.notify===true;n.autoDisconnect=n.autoDisconnect===true;
 }
 const seen=new Set();
 for(const r of data.records){
  if(!ids.has(r.networkId)||!validDate(r.date)||!byteString(r.rxBytes)||!byteString(r.txBytes))throw Error(t('流量记录不合法。'));
  const k=r.date+'|'+r.networkId;if(seen.has(k))throw Error(t('包含重复的每日网络记录。'));seen.add(k);
 }
 if(!Array.isArray(data.hourly))data.hourly=[];if(!Array.isArray(data.appRecords))data.appRecords=[];
 if(data.hourly.length>50000||data.appRecords.length>50000)throw Error(t('明细记录过多。'));
 const hoursSeen=new Set();
 for(const r of data.hourly){
  if(!ids.has(r.networkId)||!validDate(r.date)||!Number.isInteger(r.hour)||r.hour<0||r.hour>23||!byteString(r.rxBytes)||!byteString(r.txBytes))throw Error(t('小时记录不合法。'));
  const k=r.networkId+'|'+r.date+'|'+r.hour;if(hoursSeen.has(k))throw Error(t('小时记录重复。'));hoursSeen.add(k);
 }
 for(const r of data.appRecords){if(!ids.has(r.networkId)||!validDate(r.date)||!validString(r.appId,1024)||!validString(r.name,256)||!byteString(r.rxBytes)||!byteString(r.txBytes))throw Error(t('应用记录不合法。'));}
 data.settings={...defaults,...data.settings};
 const s=data.settings;
 if((s.language!==undefined&&!['en','zh-CN'].includes(s.language))||!['GB','GiB'].includes(s.unit)||!['MB/s','Mbps'].includes(s.speedUnit)||![2,5,10].includes(s.interval)||(!Number.isInteger(s.retention)||s.retention<0||s.retention>36500))throw Error(t('设置值不合法。'));
 for(const key of ['autoStart','minimizeToTray','notifications'])if(typeof s[key]!=='boolean')throw Error(t('开关值不合法。'));
 if(!data.live||!['connected','disconnected','permission','offline','loading'].includes(data.live.state)||!['running','paused','offline'].includes(data.live.collector))throw Error(t('采集器状态不合法。'));
 if(!Array.isArray(data.live.connections)||data.live.connections.length>64)throw Error(t('连接信息不合法。'));
 const ifaces=new Set();
 for(const c of data.live.connections){
  if(!ids.has(c.networkId)||!validString(c.interfaceId,128)||ifaces.has(c.interfaceId)||!validString(c.adapterAlias,256)||((c.type!=='ethernet'&&data.networks.find(n=>n.id===c.networkId)?.type!=='ethernet')&&(!validString(c.band,64)||!Number.isFinite(c.signal)||c.signal<0||c.signal>100))||!byteString(c.rxPerSecond)||!byteString(c.txPerSecond)||!Number.isFinite(Date.parse(c.since)))throw Error(t('网卡状态不合法。'));
  ifaces.add(c.interfaceId);
 }
 if(!Number.isFinite(Date.parse(data.live.updatedAt)))throw Error(t('更新时间不合法。'));
 if(!Number.isSafeInteger(data.live.skippedIntervals)||data.live.skippedIntervals<0)throw Error(t('缺失区间数量不合法。'));
 data.source=mode;
 return data;
}
function quotaFor(data, network, now = new Date()) {
    const key = dayKey(now);
    const periodKey = network.quotaPeriod === 'all' ? 'all' : network.quotaPeriod === 'day' ? key : key.slice(0, 7);
    const start = network.quotaPeriod === 'all' ? '0001-01-01' : network.quotaPeriod === 'day' ? key : monthStart(key);
    const used = network.quotaLedger?.periodKey === periodKey
        ? B(network.quotaLedger.usedBytes)
        : totalOf(data.records.filter(row => row.networkId === network.id && row.date >= start && row.date <= key)).total;
    const cap = BigInt(Math.round(network.capGb * 1e9));
    return { used, cap, remaining: cap > used ? cap - used : 0n,
        percent: cap > 0n ? Number(used) * 100 / Number(cap) : 0,
        period: network.quotaPeriod === 'all' ? t('累计') : network.quotaPeriod === 'day' ? t('今日') : t('本月') };
}

// 应用统计使用独立记录；搜索和排序不改变占比的分母。
function appUsageInRange(records, networkId, start, end) {
    const apps = new Map();
    for (const row of records) {
        if (row.networkId !== networkId || row.date < start || row.date > end) continue;
        const app = apps.get(row.appId) ?? { id: row.appId, name: row.name, rx: 0n, tx: 0n };
        app.name = row.name;
        app.rx += B(row.rxBytes); app.tx += B(row.txBytes);
        apps.set(row.appId, app);
    }
    return [...apps.values()].map(app => ({ ...app, total: app.rx + app.tx }));
}
function bytePercent(value, total) {
    return total > 0n ? Number(value * 1000n / total) / 10 : 0;
}
function sortApps(apps, sort = 'total', search = '') {
    const needle = search.trim().toLocaleLowerCase();
    const key = ['rx', 'tx'].includes(sort) ? sort : 'total';
    return apps.filter(app => app.name.toLocaleLowerCase().includes(needle)).sort((a, b) =>
        a[key] > b[key] ? -1 : a[key] < b[key] ? 1 : a.name.localeCompare(b.name, getLocale()) || a.id.localeCompare(b.id));
}

export { GB, GiB, B, byteUnitFor, formatByteParts, dayKey, dateOf, shiftDay, today, monthStart, niceDate, defaults,
    totalOf, validDate, validateSnapshot, quotaFor, appUsageInRange, bytePercent, sortApps };
