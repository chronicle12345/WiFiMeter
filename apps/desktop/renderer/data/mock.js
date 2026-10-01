import { B, dayKey, dateOf, shiftDay, monthStart, defaults, totalOf, validateSnapshot, quotaFor } from './model.js';

function generateDemo(now = new Date()) {
 const key=dayKey(now), start=shiftDay(key,-41);
 const networks=[
  {id:'home',ssid:'Habitat_5G',alias:'家里的 Wi-Fi',type:'home',target:42.68,ratio:0.931,capGb:120,warnPercent:80,quotaPeriod:'month',notify:true,autoDisconnect:false},
  {id:'office',ssid:'Studio_Network',alias:'工作室',type:'office',target:22.31,ratio:0.866,capGb:0,warnPercent:80,quotaPeriod:'month',notify:false,autoDisconnect:false},
  {id:'phone',ssid:'Personal_Hotspot',alias:'手机热点',type:'phone',target:8.24,ratio:0.944,capGb:10,warnPercent:80,quotaPeriod:'month',notify:true,autoDisconnect:false},
  {id:'cafe',ssid:'Slow_Coffee',alias:'常去的咖啡店',type:'coffee',target:1.32,ratio:0.958,capGb:0,warnPercent:80,quotaPeriod:'month',notify:false,autoDisconnect:false}
 ];
 const records=[];
 networks.forEach((n,ni)=>{
  const groups={};
  for(let k=start;k<=key;k=shiftDay(k,1)){
   const d=dateOf(k),day=d.getDate();let w=0.35+(Math.sin(day*1.8+ni*2)+1)*.8;
   if(ni===1&&(d.getDay()===0||d.getDay()===6))w*=.08;
   if(ni===2&&day%3!==1)w*=.08;if(ni===3&&day%6!==0)w=0;
   (groups[k.slice(0,7)]??=[]).push({date:k,w});
  }
  for(const [month,days] of Object.entries(groups)){
   const sum=days.reduce((a,d)=>a+d.w,0),target=Math.round(n.target*1e9*(month===key.slice(0,7)?1:.56));let assigned=0;
   if(!sum)continue;
   days.forEach((d,i)=>{let amount=i===days.length-1?target-assigned:Math.floor(target*d.w/sum);assigned+=amount;if(amount===0)return;const rx=Math.floor(amount*n.ratio);records.push({date:d.date,networkId:n.id,rxBytes:String(rx),txBytes:String(amount-rx)});});
  }
  delete n.target;delete n.ratio;
 });
 const hourly=[];
 for(const r of records.filter(r=>r.date===key)){
  const hour=now.getHours(),weights=Array.from({length:hour+1},(_,i)=>i<7?.04:.7+(Math.sin(i*1.4)+1)*.7),sum=weights.reduce((a,b)=>a+b,0);let rx=0n,tx=0n;
  weights.forEach((w,h)=>{const last=h===weights.length-1,a=last?B(r.rxBytes)-rx:B(r.rxBytes)*BigInt(Math.floor(w/sum*1000000))/1000000n,b=last?B(r.txBytes)-tx:B(r.txBytes)*BigInt(Math.floor(w/sum*1000000))/1000000n;rx+=a;tx+=b;hourly.push({date:key,networkId:r.networkId,hour:h,rxBytes:a.toString(),txBytes:b.toString()});});
 }
 // Independent mock application history. Never distribute interface counters to apps.
 const apps=[['firefox','Firefox',380000000],['syncthing','Syncthing',235000000],['code','Visual Studio Code',94000000],['system','系统服务',59000000],['unattributed','未归属流量',34000000]],appRecords=[];
 for(let k=start;k<=key;k=shiftDay(k,1))for(let ni=0;ni<networks.length;ni++){
  if(!records.some(r=>r.date===k&&r.networkId===networks[ni].id))continue;
  apps.forEach(([appId,name,base],a)=>{const rx=Math.floor(base*(.55+.45*Math.abs(Math.sin(dateOf(k).getDate()*.6+a)))/(1+ni*2));appRecords.push({date:k,networkId:networks[ni].id,appId,name,rxBytes:String(rx),txBytes:String(Math.floor(rx*(a===1?.31:.048)))});});
 }
 for(const n of networks)n.quotaLedger={periodKey:key.slice(0,7),usedBytes:totalOf(records.filter(r=>r.networkId===n.id&&r.date>=monthStart(key))).total.toString()};
 return {version:1,source:'demo',networks,records,hourly,appRecords,settings:{...defaults},live:{state:'connected',collector:'running',updatedAt:now.toISOString(),skippedIntervals:2,connections:[{networkId:'home',interfaceId:'demo-wifi-01',adapterAlias:'Wi-Fi',band:'5 GHz',signal:94,rxPerSecond:'4280000',txPerSecond:'286000',since:new Date(+now-4470000).toISOString()}]}};
}
const STORE = 'wifimeter-linux-demo-v1';

// Replace this local store when connecting a backend. The UI consumes snapshots;
// byte counts remain decimal strings at the data boundary.
class DemoStore {
    constructor(storage, clock = () => new Date()) {
        this.storage = storage;
        this.clock = clock;
        this.storageFailed = false;
        this.tickCount = 0;
        this.notified = new Set();
        try {
            const raw = storage.getItem(STORE);
            if (raw) this.snapshot = validateSnapshot(JSON.parse(raw));
        } catch {
            this.storageFailed = true;
        }
        this.snapshot ??= generateDemo(clock());
        for (const n of this.snapshot.networks) {
            if (n.capGb && quotaFor(this.snapshot, n, clock()).percent >= n.warnPercent) {
                this.notified.add(this.noticeKey(n));
            }
        }
    }

    persist() {
        try {
            this.storage.setItem(STORE, JSON.stringify(this.snapshot));
            this.storageFailed = false;
        } catch {
            this.storageFailed = true;
        }
    }

    reset() {
        this.snapshot = generateDemo(this.clock());
        this.notified.clear();
        this.persist();
        return this.snapshot;
    }

    validateBackup(body) {
        const raw = JSON.parse(body);
        if (raw?.backupType !== 'wifimeter-ui-demo') {
            throw Error('请选择“备份”功能生成的完整文件，而不是流量导出文件。');
        }
        return validateSnapshot(raw);
    }

    restore(snapshot) {
        this.snapshot = validateSnapshot(snapshot);
        this.snapshot.live.collector = 'paused';
        this.notified.clear();
        this.persist();
        return this.snapshot;
    }

    updateSettings(settings) {
        const next = validateSnapshot({ ...this.snapshot, settings });
        this.snapshot.settings = next.settings;
        const cutoff = settings.retention ? shiftDay(dayKey(this.clock()), 1 - settings.retention) : null;
        if (cutoff) {
            for (const key of ['records', 'hourly', 'appRecords']) {
                this.snapshot[key] = this.snapshot[key].filter(row => row.date >= cutoff);
            }
        }
        this.persist();
    }

    updateNetwork(id, patch) {
        const network = this.snapshot.networks.find(n => n.id === id);
        if (!network) throw Error('网络不存在。');
        validateSnapshot({ ...this.snapshot, networks: this.snapshot.networks.map(n => n.id === id ? { ...n, ...patch } : n) });
        const changed = network.quotaPeriod !== patch.quotaPeriod;
        Object.assign(network, patch);
        if (changed) {
            delete network.quotaLedger;
            network.quotaLedger = { periodKey: this.periodKey(network), usedBytes: quotaFor(this.snapshot, network, this.clock()).used.toString() };
        }
        this.persist();
    }

    clearRecords() {
        for (const key of ['records', 'hourly', 'appRecords']) this.snapshot[key] = [];
        for (const n of this.snapshot.networks) n.quotaLedger = { periodKey: this.periodKey(n), usedBytes: '0' };
        this.snapshot.live.collector = 'paused';
        this.snapshot.live.skippedIntervals = 0;
        this.persist();
    }

    pause(paused) {
        this.snapshot.live.collector = paused ? 'paused' : 'running';
        this.persist();
    }

    setState(state) {
        if (!['connected', 'disconnected', 'permission', 'offline'].includes(state)) throw Error('未知演示状态。');
        const data = this.snapshot;
        data.live.state = state;
        data.live.updatedAt = this.clock().toISOString();
        data.live.collector = state === 'offline' ? 'offline' : 'running';
        if (state === 'connected' && !data.live.connections.length && data.networks.length) {
            data.live.connections = [{ networkId: data.networks[0].id, interfaceId: 'demo-wifi-01', adapterAlias: 'Wi-Fi', band: '5 GHz', signal: 94, rxPerSecond: '4280000', txPerSecond: '286000', since: this.clock().toISOString() }];
        }
        this.persist();
    }

    periodKey(network) {
        const key = dayKey(this.clock());
        return network.quotaPeriod === 'day' ? key : key.slice(0, 7);
    }

    noticeKey(network) {
        return `${network.id}|${this.periodKey(network)}|${network.warnPercent}`;
    }

    tick(elapsed) {
        const data = this.snapshot, messages = [];
        if (data.live.collector !== 'running' || data.live.state !== 'connected') return messages;
        if (!Number.isFinite(elapsed) || elapsed <= 0) return messages;
        const now = this.clock(), key = dayKey(now), hour = now.getHours();
        this.tickCount++;
        if (elapsed > 15) {
            data.live.skippedIntervals++;
        } else {
            for (const [index, connection] of data.live.connections.entries()) {
                const rx = Math.round((3.3 + 1.25 * Math.sin(this.tickCount * .7 + index)) * 1e6);
                const tx = Math.round((.22 + .09 * Math.cos(this.tickCount * .55)) * 1e6);
                connection.rxPerSecond = String(rx);
                connection.txPerSecond = String(tx);
                const addRx = BigInt(Math.round(rx * elapsed)), addTx = BigInt(Math.round(tx * elapsed));
                const network = data.networks.find(n => n.id === connection.networkId);
                const periodKey = this.periodKey(network);
                if (network.quotaLedger?.periodKey !== periodKey) {
                    network.quotaLedger = { periodKey, usedBytes: quotaFor(data, network, now).used.toString() };
                }
                network.quotaLedger.usedBytes = (B(network.quotaLedger.usedBytes) + addRx + addTx).toString();
                for (const [rows, extra] of [[data.records, {}], [data.hourly, { hour }]]) {
                    let row = rows.find(r => r.date === key && r.networkId === network.id && (!('hour' in extra) || r.hour === hour));
                    if (!row) {
                        row = { date: key, networkId: network.id, ...extra, rxBytes: '0', txBytes: '0' };
                        rows.push(row);
                    }
                    row.rxBytes = (B(row.rxBytes) + addRx).toString();
                    row.txBytes = (B(row.txBytes) + addTx).toString();
                }
            }
            for (const n of data.networks) {
                const q = quotaFor(data, n, now), noticeKey = this.noticeKey(n);
                if (n.capGb && n.notify && data.settings.notifications && q.percent >= n.warnPercent && !this.notified.has(noticeKey)) {
                    this.notified.add(noticeKey);
                    messages.push(`演示提醒：${n.alias || n.ssid}${q.period}已用 ${q.percent.toFixed(0)}%。`);
                }
                if (n.capGb && n.autoDisconnect && q.percent >= 100 && data.live.connections.some(c => c.networkId === n.id)) {
                    data.live.state = 'disconnected';
                    messages.push('已模拟超额断开。电脑的真实 Wi-Fi 未被修改。');
                }
            }
        }
        data.live.updatedAt = now.toISOString();
        this.persist();
        return messages;
    }
}

export { generateDemo, DemoStore };
