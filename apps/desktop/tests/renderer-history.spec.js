import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHarness } from './support/backend-harness.mjs';

let app,page,profile,harness,errors;
test.beforeEach(async({},testInfo)=>{
    profile=await mkdtemp(path.join(os.tmpdir(),'wifimeter-renderer-'));
    harness=await createHarness();errors=[];
    const env={...process.env,WIFIMETER_USER_DATA:profile,...harness.env};delete env.ELECTRON_RUN_AS_NODE;
    const args=['.'];if(testInfo.title==='生成 v1.2 合成数据验收截图')args.push('--force-device-scale-factor=1');
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
        globalThis.rendererFixture={snapshot,calls:[],failRange:false,imports:0};
        ipcMain.removeHandler('backend:request');ipcMain.handle('backend:request',(_event,{method,params={}})=>{
            const f=globalThis.rendererFixture;f.calls.push({method,params});
            if(f.failSave===method)return {ok:false,error:{message:'autosave denied'}};
            if(method==='updateNetwork'){const network=f.snapshot.networks.find(n=>n.id===params.key);Object.assign(network,params);return {ok:true,result:{network}};}
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
    await page.reload();await expect(page).toHaveTitle(/流量总览/);await expect(page.locator('#pageHead')).toHaveCount(0);await expect(page.locator('h1, .breadcrumbs')).toHaveCount(0);
});
test.afterEach(async()=>{if(app){await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.webContents.on('will-prevent-unload',event=>event.preventDefault());});await app.close();}harness?.cleanup();if(profile)await rm(profile,{recursive:true,force:true});expect(errors).toEqual([]);});

async function allHistory(){await page.locator('[data-action="period"][data-value="all"]').click();await expect(page.locator('.date-text')).toHaveText('全部已保留历史');}
async function apps(){await page.locator('.nav [data-page="networks"]').click();await page.locator('button.network-name').first().click();await page.getByRole('tab',{name:'应用分布'}).click();}

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
    await page.keyboard.press('Escape');
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
    await allHistory();await apps();await page.locator('[data-action="application-control"]').click();
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
    await page.locator('.nav [data-page="settings"]').click();await page.locator('[data-category="data"]').click();await page.locator('[data-action="legacy-status"]').click();
    await expect(page.locator('#legacyRegion')).toContainText('发现旧版数据');
    await page.locator('[data-action="legacy-import"]').click();await expect(page.locator('#legacyRegion')).toContainText('C:\\Backup');
    const calls=await app.evaluate(()=>globalThis.rendererFixture.calls);
    expect(calls.filter(c=>c.method==='updateSettings')).toHaveLength(0);
    expect(await app.evaluate(()=>globalThis.rendererFixture.imports)).toBe(1);
    await expect(page.locator('select[name="unit"]')).toHaveValue('GiB');
    await expect(page.locator('select[name="retention"]')).toHaveValue('45');
    expect(calls.filter(c=>c.method==='snapshot').length).toBeGreaterThan(1);
});

 test('偏好自动保存并在重载后恢复，无变化刷新不替换导航节点',async()=>{
    await page.locator('.nav [data-page="settings"]').click();
    await page.locator('[data-category="display"]').click();
    await page.locator('select[name="unit"]').selectOption('GiB');
    await expect.poll(()=>app.evaluate(()=>globalThis.rendererFixture.snapshot.settings.unit)).toBe('GiB');
    await page.reload();
    await page.locator('[data-category="display"]').click();
    await expect(page.locator('select[name="unit"]')).toHaveValue('GiB');
    await page.evaluate(()=>{window.savedNav=document.querySelector('#nav button');});
    await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].webContents.send('backend:event',{event:'live',...globalThis.rendererFixture.snapshot.live});});
    expect(await page.evaluate(()=>window.savedNav===document.querySelector('#nav button'))).toBe(true);
});

test('完整中英切换随偏好保存，重载恢复，用户名称不翻译',async({},testInfo)=>{
    await page.locator('.nav [data-page="settings"]').click();
    await page.locator('select[name="language"]').selectOption('en');
    await expect.poll(() => page.evaluate(async () => (await window.desktop.backend.request('snapshot')).result.settings.language)).toBe('en');
    await expect(page).toHaveTitle(new RegExp('Preferences'));
    await expect(page.locator('#settingsForm')).toContainText('History retention');
    await expect(page.locator('#totalQuotaForm')).toContainText('Disconnect all Wi-Fi');
    await page.screenshot({path:testInfo.outputPath('settings-en.png'),fullPage:true});
    const text=await page.locator('#content').innerText();
    expect(text.replaceAll('简体中文','').replaceAll('Language / 语言','')).not.toMatch(/[\u4e00-\u9fff]/);
    await page.reload();await expect(page).toHaveTitle(new RegExp('Preferences'));
    await page.locator('.nav [data-page="overview"]').click();
    await expect(page).toHaveTitle(new RegExp('Usage overview'));
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
    await page.locator('.nav [data-page="settings"]').click();
    await page.locator('[data-category="status"]').click();
    await page.locator('.status-guide summary').click();await page.locator('[data-action="help"]').click();
    await expect(page.locator('.modal')).toContainText('Missing records are not zero usage');
    expect(await page.locator('.modal').innerText()).not.toMatch(/[\u4e00-\u9fff]/);
    await page.keyboard.press('Escape');await page.locator('.nav [data-page="settings"]').click();await page.locator('[data-category="general"]').click();
    await page.locator('select[name="language"]').selectOption('zh-CN');await expect.poll(() => page.evaluate(async () => (await window.desktop.backend.request('snapshot')).result.settings.language)).toBe('zh-CN');
    await expect(page).toHaveTitle(new RegExp('偏好设置'));
});

test('总WiFi额度独立保存且概览接收账本更新，单网络支持累计',async()=>{
    await expect(page.locator('.total-quota-card')).toContainText('1.5 GB');
    await page.locator('.nav [data-page="settings"]').click();
    await page.locator('[data-category="quota"]').click();
    await page.locator('#totalCap').fill('3');await page.locator('#totalPeriod').selectOption('all');
    await expect.poll(()=>app.evaluate(()=>globalThis.rendererFixture.snapshot.totalQuota.capGb)).toBe(3);
    const calls=await app.evaluate(()=>globalThis.rendererFixture.calls);
    expect(await app.evaluate(()=>globalThis.rendererFixture.snapshot.totalQuota)).toMatchObject({capGb:3,period:'all',notify:true,autoDisconnect:false});
    expect(calls.some(c=>c.method==='updateTotalQuota'&&c.params.capGb===3)).toBe(true);
    expect(calls.filter(c=>c.method==='updateSettings')).toHaveLength(0);
    await page.locator('.nav [data-page="overview"]').click();await page.locator('#main').focus();
    await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].webContents.send('backend:event',{event:'usage',day:'2026-10-01',networks:[],totalQuota:{...globalThis.rendererFixture.snapshot.totalQuota,usedBytes:'1800000000'}});});
    await expect(page.locator('.total-quota-card')).toContainText('1.8 GB');
    await page.locator('.nav [data-page="networks"]').click();await page.locator('button.network-name').first().click();await page.getByRole('tab',{name:'网络设置'}).click();
    await page.locator('#quotaPeriod').selectOption('all');await expect(page.locator('#quotaPeriod')).toHaveValue('all');
    await expect.poll(()=>app.evaluate(()=>globalThis.rendererFixture.snapshot.networks[0].quotaPeriod)).toBe('all');
    await page.keyboard.press('Escape');await expect(page.locator('.drawer')).toHaveCount(0);await expect(page.locator('.modal')).toHaveCount(0);
});

test('代理配置独立保存，估算替换代理原始行并保留客户端直接流量及导出标识',async()=>{
 await page.locator('.nav [data-page="settings"]').click();await page.locator('[data-category="proxy"]').click();await page.locator('#proxyPorts').fill('7890,1080');await page.locator('#proxyProcesses').fill('Clash.exe');
 await expect.poll(()=>app.evaluate(()=>({ports:globalThis.rendererFixture.snapshot.proxy.ports,processNames:globalThis.rendererFixture.snapshot.proxy.processNames}))).toEqual({ports:[7890,1080],processNames:['Clash.exe']});
 expect((await app.evaluate(()=>globalThis.rendererFixture.calls.filter(c=>c.method==='updateProxyConfig'))).length).toBeGreaterThan(0);
 await app.evaluate(()=>{const s=globalThis.rendererFixture.snapshot,id=s.networks[0].id,base={date:'2020-01-01',networkId:id,txBytes:'0'};
  s.appRecords=[{...base,appId:'proxy',name:'Proxy',rxBytes:'100'},{...base,appId:'client',name:'Client',rxBytes:'5'}];
  s.proxyEstimatedRecords=[{...base,proxyAppId:'proxy',appId:'client',name:'Client',rxBytes:'70',estimated:true,unattributed:false},{...base,proxyAppId:'proxy',appId:'unknown',name:'Unattributed',rxBytes:'30',estimated:true,unattributed:true}];});
 await page.locator('.nav [data-page="overview"]').click();await allHistory();await apps();await page.locator('#appGrouping').selectOption('day');
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
 await expect(page.locator('#appDataSource option[value="estimated"]')).toHaveAttribute('disabled','');
 await expect(page.locator('#appDataSource')).toHaveValue('native');
 await expect(page.locator('[data-action="app-collection"]')).toBeEnabled();
 await page.keyboard.press('Escape');await page.locator('.nav [data-page="settings"]').click();await page.locator('[data-category="general"]').click();await expect(page.locator('#proxyConfigForm')).toHaveCount(0);
 await expect(page.locator('#content')).toContainText('当前平台不支持代理流量估算');
});

test('有线名称与身份分开显示，无频段信号或无线自动断开',async()=>{
 await app.evaluate(()=>{const s=globalThis.rendererFixture.snapshot,n=s.networks[0];n.type='ethernet';n.alias='';n.ssid='Ethernet:original-identity';for(const c of s.live.connections){c.type='ethernet';c.adapterAlias='Ethernet Office';delete c.band;delete c.signal;}});
 await page.reload();await expect(page.locator('.connection-title')).toContainText('Ethernet Office');
 await expect(page.locator('.connection-details')).not.toContainText('信号');await expect(page.locator('.connection-details')).not.toContainText('GHz');
 await allHistory();await page.locator('.nav [data-page="networks"]').click();await page.locator('button.network-name').first().click();
 await expect(page.locator('.drawer')).toContainText('Ethernet:original-identity');await expect(page.locator('.drawer')).not.toContainText('频段 / 信号');
 await page.getByRole('tab',{name:'网络设置'}).click();await expect(page.locator('input[name="autoDisconnect"]')).toHaveCount(0);
 await expect(page.locator('.drawer')).toContainText('有线网络不支持无线断开操作');
 await page.keyboard.press('Escape');
 await app.evaluate(()=>{const s=globalThis.rendererFixture.snapshot;s.live.connections=[];s.live.state='disconnected';});await page.reload();
 await expect(page.locator('button.network-name').first()).toHaveText('有线网络');
 await page.locator('button.network-name').first().click();await expect(page.locator('.drawer')).toContainText('Ethernet:original-identity');
});

// Set WIFIMETER_CAPTURE_README=1 only after the final renderer changes are ready.
// Ordinary UI runs write previews to artifacts, never overwrite published README assets.
test('生成 v1.2 合成数据验收截图',async()=>{
 const directory=path.resolve('../..',process.env.WIFIMETER_CAPTURE_README==='1'?'docs/assets':'artifacts');
 await mkdir(directory,{recursive:true});
 // Screenshot records use a fixed local calendar date; the runner's timezone must not shift it.
 const clockSession=await page.context().newCDPSession(page);
 await clockSession.send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'});
 await page.clock.setFixedTime(new Date('2026-09-18T12:00:00+08:00'));
 expect(await page.evaluate(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;})).toBe('2026-09-18');
 await app.evaluate(({BrowserWindow})=>{
  BrowserWindow.getAllWindows()[0].setContentSize(1440,1000);
  const s=globalThis.rendererFixture.snapshot,today='2026-09-18';
  s.networks=[
   {id:'demo-wifi',ssid:'Demo_WiFi_5G',alias:'演示无线网络',type:'wifi',capGb:20,warnPercent:80,quotaPeriod:'month',notify:true,autoDisconnect:false,quotaLedger:{periodKey:'2026-09',usedBytes:'3600000000'}},
   {id:'demo-ethernet',ssid:'Ethernet:synthetic-adapter',alias:'演示有线网络',type:'ethernet',capGb:0,warnPercent:80,quotaPeriod:'month',notify:false,autoDisconnect:false}
  ];
  // Integer weights sum to 100, keeping the chart and quota totals consistent.
  const weights=[3,5,4,6,3,8,7,4,6,5,8,3,5,7,6,4,8,8];
  s.records=weights.map((weight,i)=>({date:'2026-09-'+String(i+1).padStart(2,'0'),networkId:'demo-wifi',rxBytes:String(31000000*weight),txBytes:String(5000000*weight)}));
  s.records.push({date:today,networkId:'demo-ethernet',rxBytes:'800000000',txBytes:'100000000'});
  s.hourly=[{date:today,networkId:'demo-wifi',hour:9,rxBytes:'248000000',txBytes:'40000000'}];
  s.appRecords=[
   {name:'Demo Browser',appId:'C:\\DemoApps\\Browser.exe',rxBytes:'1800000000',txBytes:'100000000'},
   {name:'Demo Cloud',appId:'C:\\DemoApps\\Cloud.exe',rxBytes:'600000000',txBytes:'280000000'},
   {name:'Demo Meeting',appId:'C:\\DemoApps\\Meeting.exe',rxBytes:'400000000',txBytes:'100000000'},
   {name:'Demo Updater',appId:'C:\\DemoApps\\Updater.exe',rxBytes:'300000000',txBytes:'20000000'}
  ].map(record=>({...record,date:today,networkId:'demo-wifi'}));
  s.appProcesses=[];s.gaps=[];s.appGaps=[];s.proxyEstimatedRecords=[];
  s.appCollection={available:true,enabled:true,state:'paused'};
  s.settings={language:'zh-CN',unit:'GB',speedUnit:'MB/s',interval:5,retention:90,notifications:true,autoStart:false,minimizeToTray:false};
  s.live={state:'connected',collector:'paused',updatedAt:today+'T04:00:00Z',skippedIntervals:0,connections:[{networkId:'demo-wifi',interfaceId:'demo-adapter',adapterAlias:'Demo Wi-Fi Adapter',type:'wifi',band:'5 GHz',signal:82,since:today+'T01:00:00Z',rxPerSecond:'0',txPerSecond:'0'}]};
  s.totalQuota={capGb:30,warnPercent:80,period:'month',notify:true,autoDisconnect:false,usedBytes:'3600000000',periodKey:'2026-09'};
  s.proxy={available:true,ports:[7890],processNames:['demo-proxy.exe'],status:'ready',detail:''};
 });
 for(const language of ['zh-CN','en']){
  const english=language==='en';
  await app.evaluate((_electron,language)=>{
   const s=globalThis.rendererFixture.snapshot;s.settings.language=language;
   s.networks[0].alias=language==='en'?'Demo Wi-Fi':'演示无线网络';
   s.networks[1].alias=language==='en'?'Demo Ethernet':'演示有线网络';
  },language);
  await page.reload();
  await page.locator('.nav [data-page="overview"]').click();
  await page.locator('[data-action="period"][data-value="month"]').click();
  await expect(page.locator('#content')).not.toHaveAttribute('aria-busy','true');
  await expect(page.locator('.date-text')).toContainText('09 / 18');
  await expect(page).toHaveTitle(new RegExp(english?'Usage overview':'流量总览'));
  await expect(page.locator('.connection-title')).toContainText(english?'Demo Wi-Fi':'演示无线网络');
  await expect(page.locator('#brandMark img')).toHaveAttribute('src','../assets/icon.png');
  await expect.poll(()=>page.locator('#brandMark img').evaluate(image=>image.complete&&image.naturalWidth>0)).toBe(true);
  await page.evaluate(async()=>{await document.fonts.ready;window.scrollTo(0,0);});
  await page.mouse.move(0,0);
  await page.setViewportSize({width:1440,height:1000});
  expect(await page.evaluate(()=>({width:innerWidth,height:innerHeight}))).toEqual({width:1440,height:1000});
  await page.screenshot({path:path.join(directory,english?'screenshot-en.png':'screenshot.png'),animations:'disabled',scale:'css'});
  await page.locator('.nav [data-page="networks"]').click();
  await page.locator('button.network-name').first().click();
  await page.locator('[data-action="drawer-tab"][data-tab="apps"]').click();
  await page.locator('#appGrouping').selectOption('month');
  await expect(page.locator('#appListRegion tbody tr')).toHaveCount(4);
  await expect(page.locator('#appListRegion')).toContainText('Demo Browser');
  await page.locator('#appListRegion').scrollIntoViewIfNeeded();
  await page.mouse.move(0,0);
  await page.screenshot({path:path.join(directory,english?'applications-en.png':'applications-zh-CN.png'),animations:'disabled',scale:'css'});
  await page.keyboard.press('Escape');
 }
});

 test('unreadable connection displays the raw diagnostic rather than disconnected',async()=>{
 await app.evaluate(()=>{globalThis.rendererFixture.snapshot.live={...globalThis.rendererFixture.snapshot.live,state:'unreadable',message:'WlanQueryInterface <denied> 5',connections:[]};});
 await page.locator('[data-action="refresh"]').click();
 await expect(page.locator('.connection-title')).toHaveText('无法读取 Wi-Fi 信息');
 await expect(page.locator('.connection-details')).toContainText('WlanQueryInterface <denied> 5');
 await page.locator('.nav [data-page="settings"]').click();await page.locator('[data-category="status"]').click();await page.locator('.status-guide summary').click();await page.locator('[data-action="demo"]').click();
 await expect(page.locator('.modal')).toContainText('无法确认连接信息');
 await expect(page.locator('.modal')).not.toContainText('当前没有已关联的无线网卡');
 });

test('各设置分类无保存取消按钮，独立表单自动保存并在重载后恢复',async({},testInfo)=>{
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1248,768));
 await page.locator('.nav [data-page="settings"]').click();
 await page.locator('[name="interval"]').selectOption('10');
 await expect.poll(()=>app.evaluate(()=>globalThis.rendererFixture.snapshot.settings.interval)).toBe(10);
 for(const category of ['general','display','quota','proxy','data','status','about']){
  await page.locator(`[data-category="${category}"]`).click();
  await expect(page.locator('#content button[type="submit"]')).toHaveCount(0);
  await expect(page.locator('[data-action^="discard-"]')).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`settings-${category}.png`)});
 }
 await page.locator('[data-category="quota"]').click();await page.locator('#totalCap').fill('42');
 await expect.poll(()=>app.evaluate(()=>globalThis.rendererFixture.snapshot.totalQuota.capGb)).toBe(42);
 await page.locator('[data-category="proxy"]').click();await page.locator('#proxyPorts').fill('8080');
 await expect.poll(()=>app.evaluate(()=>globalThis.rendererFixture.snapshot.proxy.ports)).toEqual([8080]);
 await page.reload();
 await page.locator('[data-category="proxy"]').click();await expect(page.locator('#proxyPorts')).toHaveValue('8080');
 await page.locator('[data-category="quota"]').click();await expect(page.locator('#totalCap')).toHaveValue('42');
 await page.locator('[data-category="general"]').click();await expect(page.locator('[name="interval"]')).toHaveValue('10');
});

test('代理文本自动保存合并快速输入，失败后保留输入并允许重试',async()=>{
 await page.locator('.nav [data-page="settings"]').click();await page.locator('[data-category="proxy"]').click();
 await app.evaluate(()=>{globalThis.rendererFixture.failSave='updateProxyConfig';});
 await page.locator('#proxyPorts').fill('808');await page.locator('#proxyPorts').fill('8080');
 await expect.poll(()=>app.evaluate(()=>globalThis.rendererFixture.calls.filter(c=>c.method==='updateProxyConfig').length)).toBe(1);
 expect(await app.evaluate(()=>globalThis.rendererFixture.snapshot.proxy.ports)).toEqual([]);
 await expect(page.locator('#proxyPorts')).toHaveValue('8080');
 await expect(page.locator('#proxySaveStatus')).toHaveAttribute('data-state','error');
 await expect(page.locator('#proxySaveStatus')).toContainText('autosave denied');
 await app.evaluate(()=>{globalThis.rendererFixture.failSave=null;});
 await page.locator('#proxyConfigForm [data-action="retry-autosave"]').click();
 await expect.poll(()=>app.evaluate(()=>globalThis.rendererFixture.snapshot.proxy.ports)).toEqual([8080]);
 await expect(page.locator('#proxySaveStatus')).toHaveAttribute('data-state','saved');
 await page.reload();await page.locator('[data-category="proxy"]').click();await expect(page.locator('#proxyPorts')).toHaveValue('8080');
});
