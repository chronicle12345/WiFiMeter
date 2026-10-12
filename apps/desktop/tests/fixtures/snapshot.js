import { B, dayKey, dateOf, shiftDay, monthStart, defaults, totalOf } from '../../renderer/data/model.js';

// 固定时钟下生成测试快照；不模拟采集、存储或系统操作。
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

export { generateDemo };
