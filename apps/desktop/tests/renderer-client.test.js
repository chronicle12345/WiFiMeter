import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataClient } from '../renderer/data/backend-client.js';

test('清空真实后端记录后，同步移除页面的应用历史', async t => {
    const original = globalThis.window;
    t.after(() => { if (original === undefined) delete globalThis.window; else globalThis.window = original; });
    const methods = [];
    globalThis.window = { desktop: { backend: {
        request: async method => {
            methods.push(method);
            return { ok: true, result: method === 'snapshot' ? {
                records: [{ date: '2026-09-30', networkId: 'home', rxBytes: '100', txBytes: '10' }],
                appRecords: [{ date: '2026-09-30', networkId: 'home', appId: 'browser', name: '浏览器', rxBytes: '80', txBytes: '5' }]
            } : {} };
        },
        onEvent: () => () => {}
    } } };
    const client = createDataClient();
    await client.start();
    assert.equal(client.snapshot.appRecords.length, 1);
    await client.clearRecords();
    assert.deepEqual(client.snapshot.appRecords, []);
    assert.deepEqual(client.snapshot.records, []);
    assert.equal(client.snapshot.live.collector, 'paused');
    assert.deepEqual(methods, ['hello', 'snapshot', 'clearUsage']);
});

test('应用事件独立累计，状态和进程更新不会改变网卡总量', async t => {
    const original = globalThis.window;
    t.after(() => { if (original === undefined) delete globalThis.window; else globalThis.window = original; });
    let receive;
    globalThis.window = { desktop: { backend: {
        request: async method => ({ ok: true, result: method === 'snapshot' ? { records: [{ date: '2026-09-30', networkId: 'home', rxBytes: '1000', txBytes: '100' }] } : {} }),
        onEvent: handler => { receive = handler; return () => {}; }
    } } };
    const client = createDataClient();
    await client.start();
    const row = { date: '2026-09-30', networkId: 'home', appId: 'browser', name: '浏览器', rxBytes: '9007199254740993', txBytes: '5' };
    receive({ event: 'appUsage', records: [row, { ...row, rxBytes: '2' }] });
    assert.equal(client.snapshot.appRecords[0].rxBytes, '9007199254740995');
    assert.equal(client.snapshot.appRecords[0].txBytes, '10');
    assert.equal(client.snapshot.records[0].rxBytes, '1000');
    const appCollection = { state: 'permission', enabled: true, available: true };
    receive({ event: 'live', state: 'connected', collector: 'running', appCollection, appProcesses: [] });
    assert.deepEqual(client.snapshot.appCollection, appCollection);
    assert.deepEqual(client.snapshot.appProcesses, []);
    client.stop();
});

 test('区间查询透传日期，乱序响应不能覆盖最新选择，reload 保留当前区间', async t => {
    const original = globalThis.window;
    t.after(() => { globalThis.window = original; });
    const pending = [], calls = [];
    globalThis.window = { desktop: { backend: {
        request: (method, params) => {
            calls.push({ method, params });
            if (method === 'snapshot') return new Promise(resolve => pending.push({ params, resolve }));
            return Promise.resolve({ ok: true, result: {} });
        }, onEvent: () => () => {}
    } } };
    const client = createDataClient();
    const old = client.queryRange({ from: '2020-01-01', to: '2020-01-31' });
    const current = client.queryRange({ from: '2021-01-01', to: '2021-01-31' });
    pending[1].resolve({ ok: true, result: { range: pending[1].params, records: [{ date: '2021-01-01' }] } });
    await current;
    pending[0].resolve({ ok: true, result: { records: [{ date: '2020-01-01' }] } });
    await old;
    assert.equal(client.snapshot.records[0].date, '2021-01-01');
    const reload = client.reload();
    assert.deepEqual(pending[2].params, { from: '2021-01-01', to: '2021-01-31' });
    pending[2].resolve({ ok: true, result: { records: [] } });
    await reload;
    assert.deepEqual(calls[0].params, { from: '2020-01-01', to: '2020-01-31' });
});

test('区间查询失败保留原有记录及已加载区间', async t => {
    const original = globalThis.window;
    t.after(() => { globalThis.window = original; });
    let fail = false;
    globalThis.window = { desktop: { backend: {
        request: async (method, params) => fail ? { ok: false, error: { message: 'read failed' } } :
            { ok: true, result: { range: params, records: [{ date: '2020-01-01' }] } },
        onEvent: () => () => {}
    } } };
    const client = createDataClient();
    await client.queryRange({ from: '2020-01-01', to: '2020-01-31' });
    fail = true;
    await assert.rejects(client.queryRange({ from: '2022-01-01', to: '2022-01-31' }), /read failed/);
    assert.equal(client.snapshot.records[0].date, '2020-01-01');
    assert.equal(client.snapshot.range.from, '2020-01-01');
});

test('导出单独查询实际日期，不依赖页面缓存，也不替换当前筛选', async t => {
    const original=globalThis.window;t.after(()=>{globalThis.window=original;});
    const calls=[];
    globalThis.window={desktop:{backend:{request:async(method,params)=>{
        calls.push({method,params});return {ok:true,result:{networks:[{id:'home',ssid:'Original',alias:'Home'}],records:[{date:params.from,networkId:'home',rxBytes:'520000',txBytes:'1'}]}};
    },onEvent:()=>()=>{}}}};
    const client=createDataClient();
    await client.queryRange({from:'2026-10-01',to:'2026-10-01'});
    const result=await client.exportUsage({from:'2020-01-01',to:'2020-01-31',networkKey:'home'});
    assert.deepEqual(calls[1],{method:'snapshot',params:{from:'2020-01-01',to:'2020-01-31',networkKey:'home'}});
    assert.equal(result.records[0].date,'2020-01-01');
    assert.equal(result.records[0].ssid,'Original');
    assert.equal(client.snapshot.records[0].date,'2026-10-01');
});

test('语言偏好透传并随快照恢复，总额度更新独立于网络设置',async t=>{
    const original=globalThis.window;t.after(()=>{globalThis.window=original;});
    const calls=[],settings={language:'zh-CN'},totalQuota={capGb:1,period:'all',warnPercent:80,notify:true,autoDisconnect:false,usedBytes:'50',periodKey:'all'};
    globalThis.window={desktop:{backend:{request:async(method,params)=>{
        calls.push({method,params});
        if(method==='updateSettings'){Object.assign(settings,params.settings);return {ok:true,result:{settings:{...settings}}};}
        return {ok:true,result:method==='updateTotalQuota'?{totalQuota:{...totalQuota,...params}}:{settings:{...settings},totalQuota}};
    },onEvent:()=>()=>{}}}};
    const client=createDataClient();await client.start();
    await client.updateSettings({language:'en'});await client.reload();assert.equal(client.snapshot.settings.language,'en');
    await client.updateTotalQuota({capGb:2,period:'month',warnPercent:90,notify:false,autoDisconnect:false});
    assert.equal(client.snapshot.totalQuota.capGb,2);
    assert.deepEqual(calls.at(-1),{method:'updateTotalQuota',params:{capGb:2,period:'month',warnPercent:90,notify:false,autoDisconnect:false}});
});

test('代理配置独立透传，估算快照与原生记录分开，清空同步移除估算',async t=>{
 const original=globalThis.window;t.after(()=>{globalThis.window=original;});
 const calls=[],native=[{appId:'proxy',rxBytes:'100'}],estimated=[{appId:'client',proxyAppId:'proxy',estimated:true,rxBytes:'100'}];
 globalThis.window={desktop:{backend:{request:async(method,params)=>{calls.push({method,params});return {ok:true,result:method==='snapshot'?{appRecords:native,proxyEstimatedRecords:estimated,proxy:{available:true,ports:[],processNames:[]}}:method==='updateProxyConfig'?{proxy:{...params,available:true,status:'ready'}}:{}};},onEvent:()=>()=>{}}}};
 const client=createDataClient();await client.start();await client.updateProxyConfig({ports:[7890],processNames:['Clash.exe']});
 assert.deepEqual(calls.at(-1),{method:'updateProxyConfig',params:{ports:[7890],processNames:['Clash.exe']}});
 assert.deepEqual(client.snapshot.appRecords,native);assert.deepEqual(client.snapshot.proxyEstimatedRecords,estimated);
 assert.equal(client.snapshot.proxy.status,'ready');await client.clearRecords();assert.deepEqual(client.snapshot.proxyEstimatedRecords,[]);
});

test('首次加载仅查询指定区间一次，reload沿用区间，All仍显式查询',async t=>{
 const original=globalThis.window;t.after(()=>{globalThis.window=original;});
 const calls=[];
 globalThis.window={desktop:{backend:{request:async(method,params)=>{calls.push({method,params});return {ok:true,result:method==='snapshot'?{range:params,records:[]}: {}};},onEvent:()=>()=>{}}}};
 const client=createDataClient(),range={from:'2026-10-01',to:'2026-10-15'};
 await client.start(range);
 assert.deepEqual(calls,[{method:'hello',params:{}},{method:'snapshot',params:range}]);
 assert.equal(client.ready,true);assert.deepEqual(client.snapshot.range,range);
 await client.reload();assert.deepEqual(calls.at(-1),{method:'snapshot',params:range});
 await client.queryRange({from:'0001-01-01',to:'2026-10-15'});
 assert.equal(calls.at(-1).params.from,'0001-01-01');
});

test('连续应用缺失事件合并相邻同语义区间，保留原因差异且不重载历史',async t=>{
 const original=globalThis.window;t.after(()=>{globalThis.window=original;});
 let receive;const calls=[];
 globalThis.window={desktop:{backend:{request:async method=>{calls.push(method);return {ok:true,result:{}};},onEvent:handler=>{receive=handler;return ()=>{};}}}};
 const client=createDataClient();await client.start();
 const base=Date.parse('2026-10-01T00:00:00Z'),at=seconds=>new Date(base+seconds*1000).toISOString();
 const gap=(start,end,patch={})=>({networkId:'home',reason:'permission',scope:'application',detail:'access denied',startedAt:at(start),endedAt:at(end),spanSeconds:end-start,...patch});
 for(let i=0;i<1000;i++)receive({event:'appUsage',gaps:[gap(i*5,(i+1)*5)]});
 assert.equal(client.snapshot.appGaps.length,1);
 assert.deepEqual(client.snapshot.appGaps[0],gap(0,5000));
 receive({event:'appUsage',gaps:[gap(5000,5005,{reason:'offline'})]});
 receive({event:'appUsage',gaps:[gap(5005,5010,{reason:'offline'})]});
 assert.equal(client.snapshot.appGaps.length,2);assert.equal(client.snapshot.appGaps[1].spanSeconds,10);
 for(const patch of [{networkId:'office'},{scope:'network'},{detail:'different error'}])receive({event:'appUsage',gaps:[gap(5010,5015,patch)]});
 receive({event:'appUsage',gaps:[gap(5020,5025)]});
 receive({event:'appUsage',gaps:[gap(5025,5030,{endedAt:'',spanSeconds:0})]});
 assert.equal(client.snapshot.appGaps.length,7);
 assert.deepEqual(client.snapshot.appRecords,[]);
 assert.deepEqual(calls,['hello','snapshot']);
});

test('交错网络缺失各自合并，不修改事件对象或跨越实际空档',async t=>{
 const original=globalThis.window;t.after(()=>{globalThis.window=original;});let receive;
 globalThis.window={desktop:{backend:{request:async()=>({ok:true,result:{}}),onEvent:handler=>{receive=handler;return ()=>{};}}}};
 const client=createDataClient();await client.start();
 const gap=(networkId,start,end)=>({networkId,reason:'offline',startedAt:`2026-10-01T00:00:${start}Z`,endedAt:`2026-10-01T00:00:${end}Z`,spanSeconds:5});
 const first=gap('home','00','05');receive({event:'appUsage',gaps:[first,gap('office','00','05')]});
 receive({event:'appUsage',gaps:[gap('home','05','10'),gap('office','05','10')]});
 assert.equal(client.snapshot.appGaps.length,2);assert.equal(client.snapshot.appGaps[0].spanSeconds,10);
 assert.equal(first.endedAt,'2026-10-01T00:00:05Z');
 receive({event:'appUsage',gaps:[gap('home','15','20')]});assert.equal(client.snapshot.appGaps.length,3);
});

test('authoritative quota ledgers are neither double-counted nor retained across a period rollover', async t => {
    const original = globalThis.window; t.after(() => { globalThis.window = original; });
    let receive;
    globalThis.window = { desktop: { backend: {
        request: async method => ({ ok: true, result: method === 'snapshot' ? { networks: [], records: [] } : {} }),
        onEvent: handler => { receive = handler; return () => {}; }
    } } };
    const client = createDataClient(); await client.start();
    const network = { id: 'sample', ssid: 'Sample', quotaLedger: { periodKey: '2026-09', usedBytes: '150' } };
    receive({ event: 'usage', day: '2026-09-30', networks: [{ networkId: 'sample', rxBytes: '100', txBytes: '50', network }], totalQuota: { usedBytes: '150' } });
    assert.equal(client.snapshot.networks[0].quotaLedger.usedBytes, '150');
    receive({ event: 'usage', day: '2026-10-01', networks: [{ networkId: 'sample', rxBytes: '2', txBytes: '3', network: { ...network, quotaLedger: { periodKey: '2026-10', usedBytes: '5' } } }], totalQuota: { usedBytes: '5' } });
    assert.equal(client.snapshot.networks[0].quotaLedger.usedBytes, '5');
    assert.equal(client.snapshot.networks[0].quotaLedger.periodKey, '2026-10');
    assert.equal(client.snapshot.totalQuota.usedBytes, '5');
    client.stop();
});

 test('live hourly rows advance with usage events without reloading history', async t => {
    const original = globalThis.window; t.after(() => { globalThis.window = original; });
    let receive;
    globalThis.window = { desktop: { backend: {
        request: async method => ({ ok: true, result: method === 'snapshot' ? {
            records: [{date:'2026-10-01',networkId:'home',rxBytes:'100',txBytes:'10'}],
            hourly: [{date:'2026-10-01',hour:8,networkId:'home',rxBytes:'100',txBytes:'10'}]
        } : {} }), onEvent: handler => { receive = handler; return () => {}; }
    } } };
    const client = createDataClient(); await client.start();
    receive({event:'usage',day:'2026-10-01',hour:8,networks:[{networkId:'home',rxBytes:'5',txBytes:'2'}]});
    assert.equal(client.snapshot.hourly[0].rxBytes,'105');
    receive({event:'usage',day:'2026-10-01',hour:9,networks:[{networkId:'home',rxBytes:'7',txBytes:'3'}]});
    assert.equal(client.snapshot.hourly.length,2); assert.equal(client.snapshot.hourly[1].hour,9);
    assert.equal(client.snapshot.hourly[1].rxBytes,'7');
    receive({event:'usage',day:'2026-10-01',networks:[{networkId:'home',rxBytes:'1',txBytes:'0'}]});
    assert.equal(client.snapshot.hourly.length,2,'Older events without an hour must not invent hourly attribution');
    client.stop();
});

test('live row lookup never retains rows replaced by reload, clearing, or another day', async t => {
    const original = globalThis.window; t.after(() => { globalThis.window = original; });
    let receive, total = '100';
    globalThis.window = { desktop: { backend: {
        request: async method => ({ ok: true, result: method === 'snapshot' ? {appRecords:[{date:'2026-10-01',networkId:'sample',appId:'app',name:'Example',rxBytes:total,txBytes:'0'}]} : {} }),
        onEvent: handler => {receive=handler;return()=>{};}
    } } };
    const client=createDataClient(); await client.start();
    const event=date=>({event:'appUsage',records:[{date,networkId:'sample',appId:'app',name:'Example',rxBytes:'5',txBytes:'1'}]});
    receive(event('2026-10-01')); const old=client.snapshot.appRecords[0];
    total='200'; await client.reload(); receive(event('2026-10-01'));
    assert.equal(old.rxBytes,'105'); assert.equal(client.snapshot.appRecords[0].rxBytes,'205');
    receive(event('2026-10-02')); assert.equal(client.snapshot.appRecords[1].rxBytes,'5');
    receive(event('2026-10-01')); assert.equal(client.snapshot.appRecords[0].rxBytes,'210');
    await client.clearRecords(); receive(event('2026-10-01'));
    assert.equal(client.snapshot.appRecords.length,1); assert.equal(client.snapshot.appRecords[0].rxBytes,'5');
    client.stop();
});
