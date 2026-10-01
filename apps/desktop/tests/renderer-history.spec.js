import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHarness } from './support/backend-harness.mjs';

let app,page,profile,harness,errors;
test.beforeEach(async()=>{
    profile=await mkdtemp(path.join(os.tmpdir(),'wifimeter-renderer-'));
    harness=await createHarness();errors=[];
    const env={...process.env,WIFIMETER_USER_DATA:profile,...harness.env};delete env.ELECTRON_RUN_AS_NODE;
    app=await electron.launch({args:['.'],env});page=await app.firstWindow();
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
        globalThis.rendererFixture={snapshot,calls:[],failRange:false,imports:0};
        ipcMain.removeHandler('backend:request');ipcMain.handle('backend:request',(_event,{method,params={}})=>{
            const f=globalThis.rendererFixture;f.calls.push({method,params});
            if(method==='updateProxyConfig'){Object.assign(f.snapshot.proxy,params);return {ok:true,result:{proxy:f.snapshot.proxy}};}
            if(method==='updateTotalQuota'){Object.assign(f.snapshot.totalQuota,params);return {ok:true,result:{totalQuota:f.snapshot.totalQuota}};}
            if(method==='updateSettings'){Object.assign(f.snapshot.settings,params.settings);return {ok:true,result:{settings:f.snapshot.settings}};}
            if(method!=='snapshot')return {ok:true,result:{}};
            if(f.failRange)return {ok:false,error:{message:'range query failed'}};
            const from=params.from||'2026-01-01',to=params.to||'2026-12-31';
            return {ok:true,result:{...f.snapshot,range:{from,to},records:f.snapshot.records.filter(r=>r.date>=from&&r.date<=to),appRecords:f.snapshot.appRecords.filter(r=>r.date>=from&&r.date<=to)}};
        });
        ipcMain.removeHandler('app-control:choose');ipcMain.handle('app-control:choose',()=>({ok:true,result:{path:'C:\\Apps\\Browser.exe',state:{Blocked:false,Throttled:false}}}));
        ipcMain.removeHandler('app-control:request');ipcMain.handle('app-control:request',(_event,input)=>{
            globalThis.rendererFixture.calls.push({method:'app-control',params:input});
            return input.action==='throttle'?{ok:false,error:{message:'partial failure'},result:{path:input.path,state:{Blocked:null,QosError:'readback failed'}}}:{ok:true,result:{path:input.path,state:{Blocked:false,Throttled:false}}};
        });
        ipcMain.removeHandler('legacy:status');ipcMain.handle('legacy:status',()=>({found:true}));
        ipcMain.removeHandler('legacy:import');ipcMain.handle('legacy:import',()=>{globalThis.rendererFixture.imports++;globalThis.rendererFixture.snapshot.settings.unit='GiB';globalThis.rendererFixture.snapshot.settings.retention=45;return {imported:true,backupDirectory:'C:\\Backup'};});
    },snapshot);
    await page.reload();await expect(page.locator('h1')).toHaveText('流量总览');
});
test.afterEach(async()=>{if(app){await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.webContents.on('will-prevent-unload',event=>event.preventDefault());});await app.close();}harness?.cleanup();if(profile)await rm(profile,{recursive:true,force:true});expect(errors).toEqual([]);});

async function allHistory(){await page.locator('[data-action="period"][data-value="all"]').click();await expect(page.locator('.date-text')).toHaveText('全部已保留历史');}
async function apps(){await page.locator('button.network-name').first().click();await page.getByRole('tab',{name:'应用分布'}).click();}

test('全部与旧日期实际查询；失败保留上次结果和筛选',async()=>{
    await allHistory();await expect(page.locator('.metric.featured')).toContainText('1.57');
    const calls=await app.evaluate(()=>globalThis.rendererFixture.calls);
    expect(calls.some(c=>c.method==='snapshot'&&c.params.from==='0001-01-01')).toBeTruthy();
    await page.locator('[data-value="custom"]').click();
    await page.locator('#rangeStart').fill('2020-01-01');await page.locator('#rangeEnd').fill('2020-01-31');
    await page.getByRole('button',{name:'应用筛选',exact:true}).click();await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.locator('.metric.featured')).toContainText('520');
    await app.evaluate(()=>{globalThis.rendererFixture.failRange=true;});
    await page.locator('[data-value="month"]').click();
    await expect(page.locator('.toast').last()).toContainText('range query failed');
    await expect(page.locator('[data-value="custom"]')).toHaveAttribute('aria-pressed','true');
    await expect(page.locator('.metric.featured')).toContainText('520');
});

test('应用月表排序与导出一致，未变化事件保留表格节点与选择',async()=>{
    await allHistory();await apps();await page.locator('#appGrouping').selectOption('month');
    await expect(page.locator('#appListRegion tbody tr')).toHaveCount(2);
    await page.locator('[data-action="app-history-sort"][data-key="total"]').click();
    await page.locator('[data-action="select-app-row"]').first().click();
    if(process.platform==='win32')await expect(page.locator('[data-selected-app-path]')).toHaveText('C:\\Apps\\Browser.exe');
    else await expect(page.locator('#appControlRegion')).toContainText('当前平台暂不支持应用防火墙与上传限速。');
    await page.evaluate(()=>{window.savedAppRow=document.querySelector('#appListRegion tbody tr');});
    await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].webContents.send('backend:event',{event:'live',...globalThis.rendererFixture.snapshot.live});});
    await expect.poll(()=>page.evaluate(()=>window.savedAppRow===document.querySelector('#appListRegion tbody tr'))).toBe(true);
    await expect(page.locator('[data-action="select-app-row"]').first()).toHaveAttribute('aria-pressed','true');
    const file=path.join(profile,'apps.csv');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({filePath:file,canceled:false});},file);
    await page.locator('[data-action="export-apps"]').click();await expect(page.locator('.toast').last()).toContainText('已导出 2 条记录');
    const csv=await readFile(file,'utf8');expect(csv).toContain('"520010","2","520012"');expect(csv.indexOf('2020-01')).toBeLessThan(csv.indexOf('2020-02'));
    await page.locator('#appGrouping').selectOption('day');await expect(page.locator('#appListRegion tbody tr')).toHaveCount(3);
});

test('应用控制展示失败回读，上传 KB/s 原样传桥且无后台轮询',async()=>{
    await allHistory();await apps();
    if(process.platform!=='win32'){
        await expect(page.locator('#appControlRegion')).toContainText('当前平台暂不支持应用防火墙与上传限速。');
        await expect(page.locator('[data-action="choose-program"]')).toHaveCount(0);
        await expect(page.locator('#appThrottleForm')).toHaveCount(0);
        expect(await app.evaluate(()=>globalThis.rendererFixture.calls.filter(c=>c.method==='app-control'))).toEqual([]);
        return;
    }
    await page.locator('[data-action="choose-program"]').click();
    await expect(page.locator('[data-selected-app-path]')).toHaveText('C:\\Apps\\Browser.exe');
    await page.locator('#uploadKBps').fill('0.125');await page.getByRole('button',{name:'设置上传限速',exact:true}).click();
    await expect(page.locator('#appControlRegion')).toContainText('partial failure');await expect(page.locator('#appControlRegion')).toContainText('readback failed');
    const calls=await app.evaluate(()=>globalThis.rendererFixture.calls.filter(c=>c.method==='app-control'));
    expect(calls).toEqual([{method:'app-control',params:{action:'throttle',path:'C:\\Apps\\Browser.exe',uploadKBps:0.125}}]);
});

test('旧版目录导入显示备份位置并刷新，不提交偏好表单',async()=>{
    await page.locator('[data-page="settings"]').click();await page.locator('[data-action="legacy-status"]').click();
    await expect(page.locator('#legacyRegion')).toContainText('发现旧版数据');
    await page.locator('[data-action="legacy-import"]').click();await expect(page.locator('#legacyRegion')).toContainText('C:\\Backup');
    const calls=await app.evaluate(()=>globalThis.rendererFixture.calls);
    expect(calls.filter(c=>c.method==='updateSettings')).toHaveLength(0);
    expect(await app.evaluate(()=>globalThis.rendererFixture.imports)).toBe(1);
    await expect(page.locator('select[name="unit"]')).toHaveValue('GiB');
    await expect(page.locator('select[name="retention"]')).toHaveValue('45');
    expect(calls.filter(c=>c.method==='snapshot').length).toBeGreaterThan(1);
});

 test('取消偏好编辑恢复已保存值，无变化刷新不替换导航节点',async()=>{
    await page.locator('[data-page="settings"]').click();
    await page.locator('select[name="unit"]').selectOption('GiB');
    await page.locator('[data-action="discard-settings"]').click();
    await expect(page.locator('select[name="unit"]')).toHaveValue('GB');
    await page.evaluate(()=>{window.savedNav=document.querySelector('#nav button');});
    await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].webContents.send('backend:event',{event:'live',...globalThis.rendererFixture.snapshot.live});});
    expect(await page.evaluate(()=>window.savedNav===document.querySelector('#nav button'))).toBe(true);
});

test('完整中英切换随偏好保存，重载恢复，用户名称不翻译',async({},testInfo)=>{
    await page.locator('[data-page="settings"]').click();
    await page.locator('select[name="language"]').selectOption('en');
    await page.locator('#settingsForm button[type="submit"]').click();
    await expect(page.locator('h1')).toHaveText('Preferences');
    await expect(page.locator('#settingsForm')).toContainText('History retention');
    await expect(page.locator('#totalQuotaForm')).toContainText('Disconnect all Wi-Fi');
    await page.screenshot({path:testInfo.outputPath('settings-en.png'),fullPage:true});
    const text=await page.locator('#content').innerText();
    expect(text.replaceAll('简体中文','')).not.toMatch(/[\u4e00-\u9fff]/);
    await page.reload();await expect(page.locator('h1')).toHaveText('Preferences');
    await page.locator('[data-page="overview"]').click();
    await expect(page.locator('h1')).toHaveText('Usage overview');
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
    await page.locator('[data-action="help"]').click();
    await expect(page.locator('.modal')).toContainText('Missing records are not zero usage');
    expect(await page.locator('.modal').innerText()).not.toMatch(/[\u4e00-\u9fff]/);
    await page.keyboard.press('Escape');await page.locator('[data-page="settings"]').click();
    await page.locator('select[name="language"]').selectOption('zh-CN');await page.locator('#settingsForm button[type="submit"]').click();
    await expect(page.locator('h1')).toHaveText('偏好设置');
});

test('总WiFi额度独立保存且概览接收账本更新，单网络支持累计',async()=>{
    await expect(page.locator('.total-quota-card')).toContainText('1.5 GB');
    await page.locator('[data-page="settings"]').click();
    await page.locator('#totalCap').fill('3');await page.locator('#totalPeriod').selectOption('all');
    await page.locator('#totalQuotaForm button[type="submit"]').click();
    await expect(page.locator('.toast').last()).toContainText('总额度已保存');
    const calls=await app.evaluate(()=>globalThis.rendererFixture.calls);
    expect(calls.filter(c=>c.method==='updateTotalQuota').at(-1).params).toEqual({capGb:3,warnPercent:80,period:'all',notify:true,autoDisconnect:false});
    expect(calls.filter(c=>c.method==='updateSettings')).toHaveLength(0);
    await page.locator('[data-page="overview"]').click();await page.locator('#main').focus();
    await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].webContents.send('backend:event',{event:'usage',day:'2026-10-01',networks:[],totalQuota:{...globalThis.rendererFixture.snapshot.totalQuota,usedBytes:'1800000000'}});});
    await expect(page.locator('.total-quota-card')).toContainText('1.8 GB');
    await page.locator('button.network-name').first().click();await page.getByRole('tab',{name:'网络设置'}).click();
    await page.locator('#quotaPeriod').selectOption('all');await expect(page.locator('#quotaPeriod')).toHaveValue('all');
    await page.keyboard.press('Escape');await page.getByRole('button',{name:'放弃更改',exact:true}).click();
});

test('代理配置独立保存，估算替换代理原始行并保留客户端直接流量及导出标识',async()=>{
 await page.locator('[data-page="settings"]').click();await page.locator('#proxyPorts').fill('7890,1080');await page.locator('#proxyProcesses').fill('Clash.exe');
 await page.locator('#proxyConfigForm button[type="submit"]').click();await expect(page.locator('.toast').last()).toContainText('代理配置已保存');
 expect((await app.evaluate(()=>globalThis.rendererFixture.calls.filter(c=>c.method==='updateProxyConfig')))[0].params).toEqual({ports:[7890,1080],processNames:['Clash.exe']});
 await app.evaluate(()=>{const s=globalThis.rendererFixture.snapshot,id=s.networks[0].id,base={date:'2020-01-01',networkId:id,txBytes:'0'};
  s.appRecords=[{...base,appId:'proxy',name:'Proxy',rxBytes:'100'},{...base,appId:'client',name:'Client',rxBytes:'5'}];
  s.proxyEstimatedRecords=[{...base,proxyAppId:'proxy',appId:'client',name:'Client',rxBytes:'70',estimated:true,unattributed:false},{...base,proxyAppId:'proxy',appId:'unknown',name:'Unattributed',rxBytes:'30',estimated:true,unattributed:true}];});
 await page.locator('[data-page="overview"]').click();await allHistory();await apps();await page.locator('#appGrouping').selectOption('day');
 await expect(page.locator('#appDataSource')).toHaveValue('native');await expect(page.locator('#appListRegion tbody tr')).toHaveCount(2);
 await page.locator('#appDataSource').selectOption('estimated');await expect(page.locator('#appListRegion tbody tr')).toHaveCount(3);await expect(page.locator('#appTotal')).toContainText('105');
 await expect(page.locator('#appListRegion')).toContainText('估算 · 未归属');await expect(page.locator('#appListRegion')).not.toContainText('Proxy');
 const file=path.join(profile,'proxy-estimates.csv');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({filePath:file,canceled:false});},file);
 await page.locator('[data-action="export-apps"]').click();await expect(page.locator('.toast').last()).toContainText('已导出 3 条记录');
 const csv=await readFile(file,'utf8');expect(csv).toContain('估算 / 未归属');expect(csv).toContain('"5","0","5","原生记录"');
 await page.locator('#appDataSource').selectOption('native');await expect(page.locator('#appListRegion tbody tr')).toHaveCount(2);await expect(page.locator('#appTotal')).toContainText('105');
});

test('不支持代理估算时仍允许原生采集与历史展示',async()=>{
 await app.evaluate(()=>{globalThis.rendererFixture.snapshot.proxy.available=false;});await page.reload();await allHistory();await apps();
 await expect(page.locator('#appDataSource option[value="estimated"]')).toBeDisabled();
 await expect(page.locator('.drawer')).toContainText('原生应用采集不受影响');
 await expect(page.locator('[data-action="app-collection"]')).toBeEnabled();
 await page.keyboard.press('Escape');await page.locator('[data-page="settings"]').click();await expect(page.locator('#proxyConfigForm')).toHaveCount(0);
 await expect(page.locator('#content')).toContainText('当前平台不支持代理流量估算');
});

test('有线名称与身份分开显示，无频段信号或无线自动断开',async()=>{
 await app.evaluate(()=>{const s=globalThis.rendererFixture.snapshot,n=s.networks[0];n.type='ethernet';n.alias='';n.ssid='Ethernet:original-identity';for(const c of s.live.connections){c.type='ethernet';c.adapterAlias='Ethernet Office';delete c.band;delete c.signal;}});
 await page.reload();await expect(page.locator('.connection-title')).toContainText('Ethernet Office');
 await expect(page.locator('.connection-details')).not.toContainText('信号');await expect(page.locator('.connection-details')).not.toContainText('GHz');
 await allHistory();await page.locator('button.network-name').first().click();
 await expect(page.locator('.drawer')).toContainText('Ethernet:original-identity');await expect(page.locator('.drawer')).not.toContainText('频段 / 信号');
 await page.getByRole('tab',{name:'网络设置'}).click();await expect(page.locator('input[name="autoDisconnect"]')).toHaveCount(0);
 await expect(page.locator('.drawer')).toContainText('有线网络不支持无线断开操作');
 await page.keyboard.press('Escape');
 await app.evaluate(()=>{const s=globalThis.rendererFixture.snapshot;s.live.connections=[];s.live.state='disconnected';});await page.reload();
 await expect(page.locator('button.network-name').first()).toHaveText('有线网络');
 await page.locator('button.network-name').first().click();await expect(page.locator('.drawer')).toContainText('Ethernet:original-identity');
});

test('生成 v1.2 合成数据验收截图',async()=>{
 const directory=path.resolve('../..','artifacts');await mkdir(directory,{recursive:true});
 await app.evaluate(({BrowserWindow})=>{
  BrowserWindow.getAllWindows()[0].setSize(1440,1080);
  const s=globalThis.rendererFixture.snapshot,stamp=new Date(),today=`${stamp.getFullYear()}-${String(stamp.getMonth()+1).padStart(2,'0')}-${String(stamp.getDate()).padStart(2,'0')}`;
  const day=Number(today.slice(-2)),first=today.slice(0,8);
  s.networks=[
   {id:'demo-wifi',ssid:'Demo_WiFi_5G',alias:'演示无线网络',type:'wifi',capGb:20,warnPercent:80,quotaPeriod:'month',notify:true,autoDisconnect:false,quotaLedger:{periodKey:today.slice(0,7),usedBytes:'3600000000'}},
   {id:'demo-ethernet',ssid:'Ethernet:synthetic-adapter',alias:'演示有线网络',type:'ethernet',capGb:0,warnPercent:80,quotaPeriod:'month',notify:false,autoDisconnect:false}
  ];
  s.records=Array.from({length:day},(_,i)=>({date:first+String(i+1).padStart(2,'0'),networkId:'demo-wifi',rxBytes:String(Math.floor(3100000000/day)),txBytes:String(Math.floor(500000000/day))}));
  s.records.push({date:today,networkId:'demo-ethernet',rxBytes:'800000000',txBytes:'100000000'});
  s.hourly=[{date:today,networkId:'demo-wifi',hour:9,rxBytes:'3100000000',txBytes:'500000000'}];
  s.appRecords=[{date:today,networkId:'demo-wifi',appId:'demo-browser',name:'演示浏览器',rxBytes:'2000000000',txBytes:'100000000'}];
  s.appProcesses=[];s.gaps=[];s.appGaps=[];s.proxyEstimatedRecords=[];
  s.settings={language:'zh-CN',unit:'GB',speedUnit:'MB/s',interval:5,retention:90,notifications:true,autoStart:false,minimizeToTray:false};
  s.live={state:'connected',collector:'paused',updatedAt:today+'T09:30:00Z',skippedIntervals:0,connections:[{networkId:'demo-wifi',interfaceId:'demo-adapter',adapterAlias:'演示无线网卡',type:'wifi',band:'5 GHz',signal:82,since:today+'T09:00:00Z',rxPerSecond:'0',txPerSecond:'0'}]};
  s.totalQuota={capGb:30,warnPercent:80,period:'month',notify:true,autoDisconnect:false,usedBytes:'3600000000',periodKey:today.slice(0,7)};
  s.proxy={available:true,ports:[7890],processNames:['demo-proxy.exe'],status:'ready',detail:''};
 });
 await page.reload();await expect(page.locator('.connection-title')).toContainText('演示无线网络');await page.evaluate(()=>window.scrollTo(0,0));
 await page.screenshot({path:path.join(directory,'ui-1.2-overview.png'),fullPage:true});
 await page.locator('[data-page="settings"]').click();await expect(page.locator('#totalQuotaForm')).toBeVisible();await page.evaluate(()=>window.scrollTo(0,0));
 await page.screenshot({path:path.join(directory,'settings.png'),fullPage:true});
});
