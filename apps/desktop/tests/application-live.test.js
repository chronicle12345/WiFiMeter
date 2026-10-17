import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationLiveRows, measuredRate } from '../renderer/data/application-live.js';
import { proxyLiveProcesses } from '../renderer/data/proxy-live.mjs';

test('live application grouping separates loopback from Wi-Fi and groups process sockets',()=>{
 const base={appId:'client',name:'Client',scope:'loopback',networkId:'',rxPerSecond:'3000',txPerSecond:'500',measurementAvailable:true};
 const rows=applicationLiveRows([{...base,processId:1},{...base,processId:2},{...base,scope:'wifi',networkId:'home',processId:1}]);
 assert.equal(rows.length,2);assert.equal(rows[0].rxPerSecond,'6000');assert.deepEqual(rows[0].processIds,[1,2]);
 assert.equal(applicationLiveRows(rows,{networkId:'home'}).length,1);
 assert.equal(applicationLiveRows(rows,{search:'missing'}).length,0);
});
test('warming connections remain missing rather than zero and formatting retains units',()=>{
 const rows=applicationLiveRows([{appId:'client',networkId:'',scope:'loopback',rxPerSecond:null,txPerSecond:null,measurementAvailable:false}]);
 assert.equal(rows[0].rxPerSecond,null);assert.equal(measuredRate(rows[0].rxPerSecond,'auto'),'—');
 assert.equal(measuredRate('6000','auto'),'6.0 KB/s');
});

test('port estimates redistribute the measured proxy rate without duplicating direct or loopback traffic',()=>{
 const processes=[
  {appId:'C:\\Proxy\\Proxy.exe',name:'Proxy',networkId:'home',scope:'wifi',processId:1,rxPerSecond:'100',txPerSecond:'10'},
  {appId:'client',name:'Client',networkId:'home',scope:'wifi',processId:2,rxPerSecond:'5',txPerSecond:'1'},
  {appId:'client',name:'Client',networkId:'',scope:'loopback',processId:2,rxPerSecond:'100',txPerSecond:'10'}
 ];
 const proxy={available:true,clients:[{appId:'client',name:'Client',proxyAppId:'c:/proxy/PROXY.exe',connections:2},
  {appId:'other',name:'Other',proxyAppId:'C:\\Proxy\\Proxy.exe',connections:1}]};
 const original=structuredClone(processes),result=proxyLiveProcesses(processes,proxy,true);
 assert.equal(result.filter(row=>row.scope==='wifi').reduce((sum,row)=>sum+BigInt(row.rxPerSecond),0n),105n);
 assert.ok(!result.some(row=>row.appId===processes[0].appId));
 assert.equal(result.find(row=>row.appId==='client'&&row.estimated).rxPerSecond,'66');
 assert.equal(result.find(row=>row.unattributed).rxPerSecond,'1');
 assert.equal(result.find(row=>row.appId==='client'&&!row.estimated&&row.scope==='wifi').rxPerSecond,'5');
 assert.equal(result.find(row=>row.scope==='loopback').rxPerSecond,'100');
 assert.deepEqual(processes,original);
 const rows=applicationLiveRows(result);
 assert.equal(rows.filter(row=>row.appId==='client'&&row.scope==='wifi').length,2);
 assert.equal(rows.find(row=>row.estimated&&row.appId==='client').processIds.length,0);
});

test('port estimates need current identified proxy observations and measured network bytes',()=>{
 const process={appId:'proxy',name:'Proxy',networkId:'home',scope:'wifi',rxPerSecond:'9007199254740993',txPerSecond:'3'};
 const proxy={available:true,clients:[{appId:'client',name:'Client',proxyAppId:'proxy',connections:1}]};
 assert.equal(proxyLiveProcesses([process],proxy,true)[0].rxPerSecond,'9007199254740993');
 for(const value of [{...process,rxPerSecond:null},{...process,measurementAvailable:false},{...process,networkId:''}])
  assert.deepEqual(proxyLiveProcesses([value],proxy,true),[value]);
 for(const value of [{...proxy,available:false},{...proxy,status:'paused'},{...proxy,status:'failed'},{...proxy,clients:[]},{...proxy,clients:[{...proxy.clients[0],proxyAppId:''}]},
  {...proxy,clients:[{...proxy.clients[0],connections:0}]},{...proxy,clients:[{...proxy.clients[0],connections:1.5}]}])
  assert.deepEqual(proxyLiveProcesses([process],value,true),[process]);
 assert.deepEqual(proxyLiveProcesses([process],proxy,false),[process]);
});
