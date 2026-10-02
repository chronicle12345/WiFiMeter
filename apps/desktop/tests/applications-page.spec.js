import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHarness } from './support/backend-harness.mjs';

let app,page,profile,harness,errors;
test.beforeEach(async({},testInfo)=>{
    profile=await mkdtemp(path.join(os.tmpdir(),'wifimeter-renderer-'));
    harness=await createHarness();errors=[];
    const env={...process.env,WIFIMETER_BACKGROUND_TEST:'1',WIFIMETER_USER_DATA:profile,...harness.env};delete env.ELECTRON_RUN_AS_NODE;
    const args=['.','--disable-renderer-backgrounding'];
    app=await electron.launch({args,env});page=await app.firstWindow();
    page.on('pageerror',error=>errors.push(error.message));
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
    await page.evaluate(()=>window.desktop.backend.request('setPaused',{paused:true}));
    const {result:snapshot}=await page.evaluate(()=>window.desktop.backend.request('snapshot'));
    const id=snapshot.networks[0].id;
    snapshot.settings.language='zh-CN';
    snapshot.proxy={ports:[],processNames:[],available:true,status:'ready',detail:''};snapshot.proxyEstimatedRecords=[];
    snapshot.totalQuota={capGb:2,warnPercent:80,period:'all',notify:true,autoDisconnect:false,usedBytes:'1500000000',periodKey:'all'};
    snapshot.appCollection={available:true,enabled:false,state:'disabled'};
    snapshot.records=[{networkId:id,date:'2020-01-01',rxBytes:'520000',txBytes:'1'},{networkId:id,date:'2020-02-01',rxBytes:'1048576',txBytes:'1024'}];
    snapshot.appRecords=[
        {networkId:id,date:'2020-01-01',appId:'C:\\Apps\\Browser.exe',name:'Browser',rxBytes:'520000',txBytes:'1'},
        {networkId:id,date:'2020-01-31',appId:'C:\\Apps\\Browser.exe',name:'Browser',rxBytes:'10',txBytes:'1'},
        {networkId:id,date:'2020-02-01',appId:'C:\\Apps\\Browser.exe',name:'Browser',rxBytes:'100',txBytes:'2'}
    ];
    await app.evaluate(({ipcMain},snapshot)=>{
        globalThis.rendererFixture={snapshot,calls:[],failRange:false};
        ipcMain.removeHandler('backend:request');ipcMain.handle('backend:request',(_event,{method,params={}})=>{
            const f=globalThis.rendererFixture;f.calls.push({method,params});
            if(method==='updateProxyConfig'){Object.assign(f.snapshot.proxy,params);return {ok:true,result:{proxy:f.snapshot.proxy}};}
            if(method==='updateTotalQuota'){Object.assign(f.snapshot.totalQuota,params);return {ok:true,result:{totalQuota:f.snapshot.totalQuota}};}
            if(method==='updateSettings'){Object.assign(f.snapshot.settings,params.settings);return {ok:true,result:{settings:f.snapshot.settings}};}
            if(method==='setAppCollection'){if(f.failCollection)return {ok:false,error:{message:'collection denied'}};f.snapshot.appCollection={available:true,enabled:params.enabled,state:params.enabled?'running':'disabled'};return {ok:true,result:{appCollection:f.snapshot.appCollection}};}
            if(method!=='snapshot')return {ok:true,result:{}};
            if(f.failRange)return {ok:false,error:{message:'range query failed'}};
            const from=params.from||'2026-01-01',to=params.to||'2026-12-31';
            return {ok:true,result:{...f.snapshot,range:{from,to},records:f.snapshot.records.filter(r=>r.date>=from&&r.date<=to),appRecords:f.snapshot.appRecords.filter(r=>r.date>=from&&r.date<=to)}};
        });
        ipcMain.removeHandler('app-control:choose');ipcMain.handle('app-control:choose',()=>({ok:true,result:{path:'C:\\Apps\\Browser.exe',state:{Blocked:false,Throttled:false}}}));
        ipcMain.removeHandler('app-control:request');ipcMain.handle('app-control:request',(_event,input)=>{
            globalThis.rendererFixture.calls.push({method:'app-control',params:input});
            return input.action==='throttle'?{ok:false,error:{message:'partial failure'},result:{path:input.path,state:{Blocked:null,QosError:'readback failed'}}}:{ok:true,result:{path:input.path,state:{Blocked:input.action==='block',Throttled:false}}};
        });
    },snapshot);
    await page.reload();await expect(page).toHaveTitle(/流量总览/);await expect(page.locator('#pageHead')).toHaveCount(0);await expect(page.locator('h1, .breadcrumbs')).toHaveCount(0);
});
test.afterEach(async()=>{if(app){await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.webContents.on('will-prevent-unload',event=>event.preventDefault());});await app.close();}harness?.cleanup();if(profile)await rm(profile,{recursive:true,force:true});expect(errors).toEqual([]);});


async function openApplications(){
    await page.locator('.nav [data-page="apps"]').click();
    await expect(page).toHaveTitle(new RegExp('应用流量'));
    await page.locator('[data-action="period"][data-value="all"]').click();
    await expect(page.locator('.date-text')).toHaveText('全部已保留历史');
}

test('独立应用页跨网络汇总、历史筛选及深链接',async()=>{
    await app.evaluate(()=>{const s=globalThis.rendererFixture.snapshot;
        s.networks.push({...s.networks[0],id:'second',alias:'Second'});
        s.appRecords.push({...s.appRecords[0],networkId:'second',rxBytes:'1000',txBytes:'0'});
    });
    await openApplications();
    await expect(page.locator('#appTotal')).toContainText('521.11KB');
    await expect(page.locator('.app-row')).toHaveCount(1);
    await page.locator('#appGrouping').selectOption('month');
    await expect(page.locator('#appListRegion tbody tr')).toHaveCount(2);
    await page.locator('#networkFilter').selectOption('second');
    await expect(page.locator('#appTotal')).toHaveText('1KB');
    await expect(page.locator('#appListRegion tbody tr')).toHaveCount(1);
    await page.locator('#appSearch').fill('missing');
    await expect(page.locator('#appListRegion tbody tr')).toHaveCount(0);
    await page.reload();await expect(page).toHaveTitle(new RegExp('应用流量'));
});

test('应用断网入口复用原生选择、阻止、解除及上传限速失败回读',async()=>{
    await openApplications();await page.locator('[data-action="application-control"]').click();
    if(process.platform!=='win32'){
        await expect(page.locator('.application-control')).toContainText('当前平台暂不支持应用防火墙与上传限速。');
        await expect(page.locator('[data-action="choose-program"], [data-operation], #uploadKBps')).toHaveCount(0);
        expect(await app.evaluate(()=>globalThis.rendererFixture.calls.filter(c=>c.method==='app-control'))).toEqual([]);
        return;
    }
    await page.locator('[data-action="choose-program"]').click();
    await expect(page.locator('[data-selected-app-path]')).toHaveText('C:\\Apps\\Browser.exe');
    await page.locator('[data-operation="block"]').click();
    await expect(page.locator('#appControlRegion dt').filter({hasText:'防火墙规则'}).locator('+ dd')).toHaveText('已配置');
    await page.locator('[data-operation="unblock"]').click();
    await expect(page.locator('#appControlRegion dt').filter({hasText:'防火墙规则'}).locator('+ dd')).toHaveText('未配置');
    await page.locator('#uploadKBps').fill('0.125');
    await page.locator('#appThrottleForm button').click();
    await expect(page.locator('#appControlRegion')).toContainText('partial failure');
    await expect(page.locator('#appControlRegion')).toContainText('readback failed');
    const calls=await app.evaluate(()=>globalThis.rendererFixture.calls.filter(c=>c.method==='app-control'));
    expect(calls.map(c=>c.params.action)).toEqual(['block','unblock','throttle']);
    expect(calls.at(-1).params.uploadKBps).toBe(0.125);
});

test('实时进程响应后台事件，保留限速输入并展示采集失败',async()=>{
    await openApplications();
    await page.locator('[data-action="app-collection"]').click();
    await expect(page.locator('#appStatusRegion')).toContainText('应用采集中');
    await page.locator('#appGrouping').selectOption('live');
    await expect(page.locator('#appListRegion')).toContainText('当前没有应用进程数据。');

    await app.evaluate(({BrowserWindow})=>{
        const s=globalThis.rendererFixture.snapshot;
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...s.live,appCollection:s.appCollection,appProcesses:[{networkId:s.networks[0].id,appId:'C:\\Apps\\Browser.exe',name:'Live Browser',processId:42,rxPerSecond:'1000000',txPerSecond:'125000'}]});
    });
    await expect(page.locator('#appListRegion')).toContainText('Live Browser');
    await expect(page.locator('#appListRegion')).toContainText('42');
    await page.locator('[data-action="select-live-app"]').click();
    await expect(page.locator('.drawer .application-summary')).toContainText('42');
    if(process.platform==='win32'){
        await page.locator('#uploadKBps').fill('96');
        await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...globalThis.rendererFixture.snapshot.live});});
        await expect(page.locator('#uploadKBps')).toHaveValue('96');
    }
    await page.keyboard.press('Escape');
    await app.evaluate(()=>{globalThis.rendererFixture.failCollection=true;});
    await page.locator('[data-action="app-collection"]').click();
    await expect(page.locator('.toast').last()).toContainText('collection denied');
    await expect(page.locator('[data-action="app-collection"]')).toBeEnabled();
});

test('缺少路径和采集覆盖提示保留，后台事件更新应用总量',async()=>{
    await app.evaluate(()=>{const s=globalThis.rendererFixture.snapshot;
        s.appRecords=[{...s.appRecords[0],appId:'unknown',name:'Unknown'}];
        s.appGaps=[{startedAt:'2020-01-01T00:00:00Z',endedAt:'2020-01-02T00:00:00Z',networkId:s.networks[0].id}];
    });
    await openApplications();await expect(page.locator('#appStatusRegion')).not.toContainText('缺失区间');
    await expect(page.locator('#content #appControlRegion')).toHaveCount(0);
    await page.locator('[data-action="select-app"]').click();
    if(process.platform==='win32')await expect(page.locator('#appControlRegion')).toContainText('缺少程序路径，请选择程序。');
    await app.evaluate(({BrowserWindow})=>{const s=globalThis.rendererFixture.snapshot;
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'appUsage',records:[{...s.appRecords[0],rxBytes:'1000000',txBytes:'0'}]});
    });
    await page.keyboard.press('Escape');
    await expect(page.locator('#appTotal')).toContainText('1.52');
});


test('所有导航往返、跨网络空状态及断网入口布局',async({},testInfo)=>{
    expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isFocused()&&!w.isFocusable()))).toBe(true);
    for(const [pageId,title] of [['apps','应用流量'],['networks','我的网络'],['history','历史记录'],['settings','偏好设置'],['overview','流量总览'],['apps','应用流量']]){
        await page.locator(`.nav [data-page="${pageId}"]`).click();
        await expect(page).toHaveTitle(new RegExp(title));
        await expect(page.locator('#pageHead')).toHaveCount(0);
        await expect(page.locator('h1, .breadcrumbs')).toHaveCount(0);
        if(pageId!=='settings'){await expect(page.locator('.toolbar [data-action="refresh"]')).toBeVisible();await expect(page.locator('.toolbar [data-action="export"]')).toBeVisible();}
        await expect(page.locator(`.nav [data-page="${pageId}"]`)).toHaveAttribute('aria-current','page');
    }
    await expect(page.locator('#appListRegion')).toContainText('所选时段没有应用记录');
    await expect(page.locator('#appTotal')).toHaveText('—');
    await app.evaluate(()=>{const s=globalThis.rendererFixture.snapshot;
        s.networks.push({...s.networks[0],id:'empty-network',alias:'Empty Network'});
    });
    await page.locator('[data-action="period"][data-value="all"]').click();
    await expect(page.locator('.app-row')).toHaveCount(1);
    await page.locator('#networkFilter').selectOption('empty-network');
    await expect(page.locator('#appListRegion')).toContainText('所选时段没有应用记录');
    await expect(page.locator('#appTotal')).toHaveText('—');
    await expect(page.locator('[data-action="application-control"]')).toBeVisible();
    await page.locator('#networkFilter').selectOption('all');
    await expect(page.locator('.app-row')).toHaveCount(1);
    for(const width of [1248,900]){
        await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setContentSize(width,900),width);
        const entry=page.locator('[data-action="application-control"]');
        await expect(entry).toBeVisible();
        const box=await entry.boundingBox();expect(box.width).toBeGreaterThan(60);expect(box.height).toBeGreaterThan(24);
        expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
        await entry.click();
        await expect(page.locator('#closeDrawer')).toBeFocused();
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        await page.screenshot({path:testInfo.outputPath(`applications-${width}.png`),fullPage:true});
        await page.keyboard.press('Escape');
    }
    await page.locator('.nav [data-page="networks"]').click();
    await page.locator('button.network-name').first().click();
    await page.getByRole('tab',{name:'应用分布'}).click();
    await expect(page.locator('#appListRegion')).toContainText('Browser');
    await page.getByRole('tab',{name:'用量明细'}).click();
    await page.getByRole('tab',{name:'网络设置'}).click();
    await page.locator('#closeDrawer').click();
    await page.locator('.nav [data-page="apps"]').click();
    await expect(page.locator('.app-row')).toHaveCount(1);
});

test('proxy clients remain visible without invented traffic and can be selected for control',async()=>{
 await app.evaluate(()=>{globalThis.rendererFixture.snapshot.proxy.clients=[{appId:'C:\\Apps\\Browser.exe',name:'Browser',proxyName:'Proxy',connections:3}];});
 await openApplications();
 await expect(page.locator('#proxyClientsRegion')).toContainText('Browser');
 await expect(page.locator('#proxyClientsRegion')).toContainText('3');
 await page.locator('[data-action="select-proxy-app"]').click();
 if(process.platform==='win32')await expect(page.locator('[data-selected-app-path]')).toHaveText('C:\\Apps\\Browser.exe');
 await expect(page.locator('#proxyClientsRegion')).not.toContainText('KB');
});

test('应用抽屉支持焦点循环、遮罩关闭并保留应用筛选',async()=>{
    await openApplications();
    await page.locator('#appSearch').fill('Browser');
    await page.locator('#appSort').selectOption('rx');
    await page.locator('[data-action="select-app"]').click();
    await expect(page.getByRole('dialog')).toHaveAccessibleName('Browser');
    await expect(page.locator('.application-summary')).toContainText('原生记录');
    await expect(page.locator('#closeDrawer')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(()=>document.querySelector('.drawer').contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Tab');
    await expect(page.locator('#closeDrawer')).toBeFocused();
    await page.locator('.backdrop').click({position:{x:5,y:5}});
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('#appSearch')).toHaveValue('Browser');
    await expect(page.locator('#appSort')).toHaveValue('rx');
    await expect(page.locator('[data-action="select-app"]')).toBeFocused();
});

test('measured proxy live rates appear without adding loopback bytes to history',async()=>{
 await openApplications();await page.locator('#appGrouping').selectOption('live');
 const historyTotal=await page.locator('#appTotal').textContent();
 await app.evaluate(({BrowserWindow})=>{
  const s=globalThis.rendererFixture.snapshot;
  const base={appId:'C:\\Apps\\Browser.exe',name:'Browser',networkId:'',scope:'loopback',source:'WindowsTcpEStats',measurementAvailable:true,rxPerSecond:'3000',txPerSecond:'1000'};
  const proxy={...s.proxy,clients:[{...base,proxyName:'Port 7897',connections:2,rxPerSecond:'6000',txPerSecond:'2000'}]};
  for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...s.live,proxy,appCollection:{enabled:true,available:true,state:'running'},appProcesses:[{...base,processId:42},{...base,processId:43}]});
 });
 await expect(page.locator('#appListRegion tbody tr')).toHaveCount(1);
 await expect(page.locator('#appListRegion')).toContainText('6.0 KB/s');await expect(page.locator('#appListRegion')).toContainText('本地 TCP');
 await expect(page.locator('#proxyClientsRegion')).toContainText('6.0 KB/s');
 await expect(page.locator('#appTotal')).toHaveText(historyTotal);
 await page.locator('[data-action="select-live-app"]').click();await expect(page.locator('.application-summary')).toContainText('6.0 KB/s');
 if(process.platform==='win32')await page.locator('#uploadKBps').fill('96');
 else{
  await expect(page.locator('#uploadKBps')).toHaveCount(0);
  await expect(page.locator('.application-control')).toContainText('当前平台暂不支持应用防火墙与上传限速。');
 }
 await app.evaluate(({BrowserWindow})=>{const s=globalThis.rendererFixture.snapshot;for(const win of BrowserWindow.getAllWindows())win.webContents.send('backend:event',{event:'live',...s.live,appCollection:{enabled:true,available:true,state:'running'},appProcesses:[{appId:'C:\\Apps\\Browser.exe',name:'Browser',processId:42,networkId:'',scope:'loopback',rxPerSecond:'9000',txPerSecond:'1000',measurementAvailable:true}]});});
 await expect(page.locator('.application-summary')).toContainText('9.0 KB/s');
 await expect(page.locator('#appTotal')).toHaveText(historyTotal);
 if(process.platform==='win32')await expect(page.locator('#uploadKBps')).toHaveValue('96');
 else await expect(page.locator('#uploadKBps')).toHaveCount(0);
});

test('proxy clients appear only on applications and live changes replace zero rates',async()=>{
 await app.evaluate(()=>{globalThis.rendererFixture.snapshot.proxy={available:true,status:'ready',ports:[7897],clients:[{appId:'C:\\Apps\\Browser.exe',name:'Browser',proxyName:'Port 7897',connections:2,measurementAvailable:true,rxPerSecond:'0',txPerSecond:'0'}]};});
 await page.reload();await page.locator('.nav [data-page="settings"]').click();
 await expect(page.locator('.proxy-client-table')).toHaveCount(0);
 await openApplications();await expect(page.locator('.proxy-client-table')).toContainText('0 B/s');
 await app.evaluate(({BrowserWindow})=>{const f=globalThis.rendererFixture;const proxy={...f.snapshot.proxy,clients:[{...f.snapshot.proxy.clients[0],rxPerSecond:'24000',txPerSecond:'6000'}]};for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...f.snapshot.live,proxy});});
 await expect(page.locator('.proxy-client-table')).toContainText('24.0 KB/s');await expect(page.locator('.proxy-client-table')).toContainText('6.0 KB/s');
 const aligned=await page.locator('.proxy-client-table').evaluate(table=>[...table.querySelectorAll('tr')].every(row=>[...row.children].slice(2).every(cell=>getComputedStyle(cell).textAlign==='right')));
 expect(aligned).toBe(true);
});

test('live estimates refresh displayed clients while preserving upload and download totals',async()=>{
 await app.evaluate(()=>{const f=globalThis.rendererFixture;const id=f.snapshot.networks[0].id;f.snapshot.appRecords=[{networkId:id,date:'2020-01-01',appId:'C:\\Proxy\\Proxy.exe',name:'Proxy',rxBytes:'1000',txBytes:'3000'}];f.snapshot.proxyEstimatedRecords=[];});
 await openApplications();
 const originalSource=await page.locator('#appDataSource').elementHandle();
 await page.locator('#appDataSource').selectOption('estimated');
 await expect.poll(()=>originalSource.evaluate(element=>element.isConnected)).toBe(false);
 await expect(page.locator('#appDataSource')).toHaveValue('estimated');
 await expect(page.locator('.app-row')).toContainText('Proxy');
 await app.evaluate(({BrowserWindow})=>{const s=globalThis.rendererFixture.snapshot;const rows=[{networkId:s.networks[0].id,date:'2020-01-01',appId:'C:\\Apps\\Browser.exe',name:'Browser',proxyAppId:'C:\\Proxy\\Proxy.exe',estimated:true,rxBytes:'600',txBytes:'1800'},{networkId:s.networks[0].id,date:'2020-01-01',appId:'C:\\Apps\\Chat.exe',name:'Chat',proxyAppId:'C:\\Proxy\\Proxy.exe',estimated:true,rxBytes:'400',txBytes:'1200'}];for(const win of BrowserWindow.getAllWindows())win.webContents.send('backend:event',{event:'live',...s.live,proxyEstimatedUpdates:[{networkId:s.networks[0].id,date:'2020-01-01',proxyAppId:'C:\\Proxy\\Proxy.exe',records:rows}]});});
 await expect(page.locator('.app-row')).toHaveCount(2);await expect(page.locator('.app-row').filter({hasText:'Browser'})).toContainText('2.4 KB');await expect(page.locator('.app-row').filter({hasText:'Chat'})).toContainText('1.6 KB');await expect(page.locator('#appTotal')).toHaveText('4KB');
});
