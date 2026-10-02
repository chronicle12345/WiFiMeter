import test from 'node:test';
import assert from 'node:assert/strict';
import { proxyConfigPatch, proxyUsageRecords } from '../renderer/data/proxy.js';
import { applicationRows, applicationCsv } from '../renderer/data/history.js';

const raw=(networkId,date,appId,rxBytes)=>({networkId,date,appId,name:appId,rxBytes,txBytes:'0'});
const native=[raw('home','2020-01-01','proxy','100'),raw('home','2020-01-01','client','5'),raw('office','2020-01-01','proxy','200'),raw('home','2020-01-02','proxy','300')];
const estimates=[{...raw('home','2020-01-01','client','70'),proxyAppId:'proxy',estimated:true,unattributed:false},{...raw('home','2020-01-01','unknown','30'),proxyAppId:'proxy',estimated:true,unattributed:true}];

test('代理估算只替换对应网络日期的代理原始行，客户端直接流量保留且总字节不重复',()=>{
 const before=structuredClone(native);
 assert.deepEqual(proxyUsageRecords(native,estimates,false),native);
 const result=proxyUsageRecords(native,estimates,true);
 assert.equal(result.reduce((sum,row)=>sum+BigInt(row.rxBytes),0n),605n);
 assert.equal(result.filter(row=>row.appId==='client').length,2);
 assert.ok(result.some(row=>row.networkId==='office'&&row.appId==='proxy'));
 assert.ok(result.some(row=>row.date==='2020-01-02'&&row.appId==='proxy'));
 assert.deepEqual(native,before);
 assert.deepEqual(proxyUsageRecords(native,[],true),native);
 const rows=applicationRows(result,{networkId:'home',start:'2020-01-01',end:'2020-01-31',grouping:'month'});
 assert.equal(rows.filter(row=>row.estimated).length,2);
 assert.equal(rows.filter(row=>row.unattributed).length,1);
 const csv=applicationCsv(rows,'en');
 assert.ok(csv.includes('Estimated'));assert.ok(csv.includes('Unattributed'));
 assert.ok(csv.includes('"70"'));assert.ok(csv.includes('"5"'));
});

test('代理配置解析多个端口与可选进程，拒绝非法端口并去重',()=>{
 const values=(ports,processNames)=>new Map([['ports',ports],['processNames',processNames]]);
 assert.deepEqual(proxyConfigPatch(values('7890, 1080；7890','Clash.exe; v2ray.exe; clash.EXE')),{ports:[7890,1080],processNames:['Clash.exe','v2ray.exe']});
 assert.deepEqual(proxyConfigPatch(values('','')),{ports:[],processNames:[]});
 for(const ports of ['0','65536','1.5','abc'])assert.throws(()=>proxyConfigPatch(values(ports,'')));
 assert.throws(()=>proxyConfigPatch(values('7890','invalid\u0000name')));
});

import { proxyForm, proxyClientsView } from '../renderer/ui/proxy.js';
test('proxy settings configure only; clients and aligned live rates belong to application views',()=>{
 const proxy={available:true,status:'ready',ports:[7897],clients:[{name:'Client',appId:'C:\\Apps\\Client.exe',proxyName:'Local proxy',connections:2,measurementAvailable:true,rxPerSecond:'2500',txPerSecond:'0'}]};
 assert.doesNotMatch(proxyForm(proxy),/proxy-client-table|select-proxy-app/);
 const html=proxyClientsView(proxy);
 assert.match(html,/2.5 KB\/s/);assert.match(html,/0 B\/s/);
 assert.equal((html.match(/<th class="right">/g)||[]).length,3);
 assert.equal((html.match(/<td class="right num">/g)||[]).length,3);
});
