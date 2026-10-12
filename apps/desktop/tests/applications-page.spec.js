import { test, expect } from '@playwright/test';
import { desktop } from './support/browser-desktop.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHarness } from './support/backend-harness.mjs';

let app,page,profile,harness,errors;
test.beforeEach(async({},testInfo)=>{
    profile=await mkdtemp(path.join(os.tmpdir(),'wifimeter-renderer-'));
    harness=await createHarness();errors=[];
    const env={...process.env,WIFIMETER_BACKGROUND_TEST:'1',WIFIMETER_USER_DATA:profile,...harness.env};
    app=await desktop.launch({env});page=await app.firstWindow();
    page.on('pageerror',error=>errors.push(error.message));
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
    await page.evaluate(()=>window.desktop.backend.request('setPaused',{paused:true}));
    const {result:snapshot}=await page.evaluate(()=>window.desktop.backend.request('snapshot'));
    const id=snapshot.networks[0].id;
    snapshot.settings.language='zh-CN';
    snapshot.proxy={ports:[],processNames:[],available:true,status:'ready',detail:''};snapshot.live.proxy=snapshot.proxy;snapshot.proxyEstimatedRecords=[];
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
            if(method==='updateSettings'){
                Object.assign(f.snapshot.settings,params.settings);
                return {ok:true,result:{settings:f.snapshot.settings,...(Object.hasOwn(params.settings,'autoStart')&&f.autoStartSystem?{system:f.autoStartSystem}:{})}};
            }
            if(method==='setAppCollection'){if(f.failCollection)return {ok:false,error:{message:'collection denied'}};f.snapshot.appCollection={available:true,enabled:params.enabled,state:params.enabled?'running':'disabled'};return {ok:true,result:{appCollection:f.snapshot.appCollection}};}
            if(method!=='snapshot')return {ok:true,result:{}};
            if(f.failRange)return {ok:false,error:{message:'range query failed'}};
            const from=params.from||'2026-01-01',to=params.to||'2026-12-31';
            return {ok:true,result:{...f.snapshot,range:{from,to},records:f.snapshot.records.filter(r=>r.date>=from&&r.date<=to),appRecords:f.snapshot.appRecords.filter(r=>r.date>=from&&r.date<=to)}};
        });
        ipcMain.removeHandler('app-control:choose');ipcMain.handle('app-control:choose',()=>{
            globalThis.rendererFixture.calls.push({method:'app-control:choose'});
            return {ok:true,result:{path:'C:\\Apps\\Browser.exe',state:{Blocked:false,Throttled:false}}};
        });
        ipcMain.removeHandler('app-control:list');ipcMain.handle('app-control:list',()=>{
            globalThis.rendererFixture.calls.push({method:'app-control:list'});
            return {ok:true,records:globalThis.rendererFixture.rules||[]};
        });
        ipcMain.removeHandler('app-control:request');ipcMain.handle('app-control:request',(_event,input)=>{
            globalThis.rendererFixture.calls.push({method:'app-control',params:input});
            return input.action==='throttle'?{ok:false,error:{message:'partial failure'},result:{path:input.path,state:{Blocked:null,QosError:'readback failed'}}}:{ok:true,result:{path:input.path,state:{Blocked:input.action==='block',Throttled:false}}};
        });
    },snapshot);
    await page.reload();await expect(page).toHaveTitle(/流量总览/);await expect(page.locator('#pageHead')).toHaveCount(0);await expect(page.locator('h1, .breadcrumbs')).toHaveCount(0);
});
test.afterEach(async()=>{if(app){await app.evaluate(({app:fixtureApp,BrowserWindow})=>{fixtureApp.removeAllListeners('window-all-closed');for(const window of BrowserWindow.getAllWindows())window.destroy();});await app.close();}harness?.cleanup();if(profile)await rm(profile,{recursive:true,force:true});expect(errors).toEqual([]);});


async function openApplications(){
    await page.locator('.nav [data-page="apps"]').click();
    await expect(page).toHaveTitle(new RegExp('应用流量'));
    await page.getByRole('tab',{name:'应用用量记录',exact:true}).click();
    await page.locator('[data-action="period"][data-value="all"]').click();
    await expect(page.locator('.date-text')).toHaveText('全部已保留历史');
}

async function openLiveApplications(){
    await page.locator('.nav [data-page="apps"]').click();
    await expect(page.getByRole('tab',{name:'实时流量排行',exact:true})).toHaveAttribute('aria-selected','true');
}

test('应用视图切换只显示当前列表，分别保存搜索排序和历史分组 @application-views',async()=>{
    await openLiveApplications();
    await expect(page.locator('#content [role="tabpanel"]')).toHaveCount(1);
    await expect(page.locator('#appViewPanel')).toHaveAttribute('aria-labelledby','appViewPanel-live');
    await expect(page.locator('#appSearch, #appSort, #appListRegion')).toHaveCount(3);
    await expect(page.locator('#liveRankingRegion')).toHaveCount(1);
    await expect(page.locator('#appGrouping, #appDataSource, #appTotal, .toolbar [data-action="period"], [data-action="export-apps"]')).toHaveCount(0);
    await page.locator('#appSearch').fill('Live Browser');
    await page.locator('#appSort').selectOption('tx');
    await page.getByRole('tab',{name:'应用用量记录',exact:true}).click();
    await expect(page.locator('#content [role="tabpanel"]')).toHaveCount(1);
    await expect(page.locator('#appViewPanel')).toHaveAttribute('aria-labelledby','appViewPanel-history');
    await expect(page.getByRole('tab',{name:'实时流量排行',exact:true})).toHaveAttribute('aria-selected','false');
    await expect(page.locator('#liveRankingRegion, #proxyClientsRegion')).toHaveCount(0);
    await expect(page.locator('#appSearch')).toHaveValue('');
    await expect(page.locator('#appSort')).toHaveValue('total');
    await expect(page.locator('[data-action="export-apps"]')).toHaveCount(1);
    await expect(page.locator('[data-action="export-apps"]')).toBeVisible();
    await expect(page.locator('#appGrouping option[value="live"]')).toHaveCount(0);
    await page.locator('[data-action="period"][data-value="all"]').click();
    await page.locator('#appSearch').fill('Browser');
    await page.locator('#appSort').selectOption('rx');
    await page.locator('#appGrouping').selectOption('month');
    await expect(page.locator('#appListRegion tbody tr')).toHaveCount(2);
    await page.getByRole('tab',{name:'实时流量排行',exact:true}).click();
    await expect(page.locator('#appSearch')).toHaveValue('Live Browser');
    await expect(page.locator('#appSort')).toHaveValue('tx');
    await page.locator('.nav [data-page="overview"]').click();
    await page.locator('.nav [data-page="apps"]').click();
    await expect(page.getByRole('tab',{name:'实时流量排行',exact:true})).toHaveAttribute('aria-selected','true');
    await expect(page.locator('#appSearch')).toHaveValue('Live Browser');
    await page.getByRole('tab',{name:'应用用量记录',exact:true}).click();
    await expect(page.locator('#appSearch')).toHaveValue('Browser');
    await expect(page.locator('#appSort')).toHaveValue('rx');
    await expect(page.locator('#appGrouping')).toHaveValue('month');
    await page.locator('.nav [data-page="networks"]').click();
    await page.locator('button.network-name').first().click();
    await page.getByRole('tab',{name:'应用分布',exact:true}).click();
    await expect(page.getByRole('tab',{name:'应用用量记录',exact:true})).toHaveAttribute('aria-selected','true');
    await expect(page.locator('#liveRankingRegion')).toHaveCount(0);
});

test('实时列表保留 95 项，按网络和 scope 选择详情并在重排后恢复焦点 @application-views',async({},testInfo)=>{
    await app.evaluate(()=>{const s=globalThis.rendererFixture.snapshot,id=s.networks[0].id;
        s.appCollection={available:true,enabled:true,state:'running'};
        s.appProcesses=Array.from({length:93},(_,i)=>({networkId:id,appId:`C:\\Apps\\Tool${i}.exe`,name:`Tool ${i}`,processId:i+100,scope:'wifi',rxPerSecond:String(i+1),txPerSecond:'0'}));
        s.appProcesses.push({networkId:id,appId:'C:\\Apps\\Browser.exe',name:'Browser',processId:42,scope:'wifi',rxPerSecond:'100000',txPerSecond:'1000'},
            {networkId:'',appId:'C:\\Apps\\Browser.exe',name:'Browser',processId:43,scope:'loopback',rxPerSecond:'3000',txPerSecond:'1000',measurementAvailable:true});
        s.appRecords=Array.from({length:95},(_,i)=>({networkId:id,date:'2020-01-01',appId:`C:\\Apps\\History${i}.exe`,name:`History ${i}`,rxBytes:String((i+1)*1000),txBytes:'0'}));
    });
    await page.reload();await openLiveApplications();
    await expect(page.locator('#liveRankingRegion tbody tr')).toHaveCount(95);
    await page.screenshot({path:testInfo.outputPath('applications-live.png')});
    await page.locator('#appSearch').fill('Browser');
    await expect(page.locator('#liveRankingRegion tbody tr')).toHaveCount(2);
    const localRow=page.locator('#liveRankingRegion tbody tr').filter({hasText:'本地 TCP'});
    const localButton=localRow.locator('[data-action="select-live-app"]');
    const key=await localButton.getAttribute('data-live-key');
    expect(key).toBeTruthy();
    await localButton.click();
    await expect(page.locator('.application-summary')).toContainText('43');
    await expect(page.locator('.application-summary')).not.toContainText('42');
    await expect(page.locator('.application-summary')).toContainText('3.0 KB/s');
    await app.evaluate(({BrowserWindow})=>{const s=globalThis.rendererFixture.snapshot;
        s.appProcesses=s.appProcesses.map(p=>p.scope==='loopback'?{...p,rxPerSecond:'900000'}:p).reverse();
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...s.live,appCollection:s.appCollection,appProcesses:s.appProcesses});
    });
    await expect(page.locator('.application-summary')).toContainText('900.0 KB/s');
    await expect(page.locator('.application-summary')).toContainText('43');
    await page.keyboard.press('Escape');
    await expect(localButton).toBeFocused();
    await expect(localButton).toHaveAttribute('data-live-key',key);
    await page.locator('[data-action="refresh"]').click();
    await expect(page.locator('#appSearch')).toHaveValue('Browser');
    await expect(localButton).toHaveAttribute('data-live-key',key);
    await localButton.focus();
    await app.evaluate(({BrowserWindow})=>{const s=globalThis.rendererFixture.snapshot;
        s.appProcesses=s.appProcesses.map(p=>p.scope==='loopback'?{...p,txPerSecond:'2000'}:p);
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...s.live,appCollection:s.appCollection,appProcesses:s.appProcesses});
    });
    await expect(localButton).toBeFocused();
    await page.getByRole('tab',{name:'应用用量记录',exact:true}).click();
    await page.locator('[data-action="period"][data-value="all"]').click();
    await expect(page.locator('.application-table-row')).toHaveCount(95);
    await page.screenshot({path:testInfo.outputPath('applications-history.png')});
});

test('实时详情匹配多个代理，历史估算按字节展示且 TCP 速度不改变用量 @application-views',async()=>{
    await app.evaluate(()=>{const s=globalThis.rendererFixture.snapshot,id=s.networks[0].id,base={networkId:id,date:'2020-01-01',txBytes:'0'};
        s.appCollection={available:true,enabled:true,state:'running'};
        s.appRecords=[{...base,appId:'C:\\Proxy\\East.exe',name:'Proxy East',rxBytes:'1000'},{...base,appId:'C:\\Proxy\\West.exe',name:'Proxy West',rxBytes:'2000'},{...base,appId:'C:\\Apps\\Browser.exe',name:'Browser',rxBytes:'5'}];
        s.proxyEstimatedRecords=[{...base,proxyAppId:'C:\\Proxy\\East.exe',appId:'C:\\Apps\\Browser.exe',name:'Browser',rxBytes:'600',estimated:true},{...base,proxyAppId:'C:\\Proxy\\East.exe',appId:'C:\\Apps\\Chat.exe',name:'Chat',rxBytes:'400',estimated:true},{...base,proxyAppId:'C:\\Proxy\\West.exe',appId:'C:\\Apps\\Browser.exe',name:'Browser',rxBytes:'1800',estimated:true},{...base,proxyAppId:'C:\\Proxy\\West.exe',appId:'unknown',name:'Unattributed',rxBytes:'200',estimated:true,unattributed:true}];
        s.proxy.clients=[{appId:'C:\\Apps\\Browser.exe',name:'Browser',proxyAppId:'C:\\Proxy\\East.exe',proxyName:'Proxy East',connections:2,measurementAvailable:true,rxPerSecond:'6000',txPerSecond:'2000'},
            {appId:'C:\\Apps\\Browser.exe',name:'Browser',proxyAppId:'C:\\Proxy\\West.exe',proxyName:'Proxy West',connections:1,measurementAvailable:true,rxPerSecond:'7000',txPerSecond:'1000'},
            {appId:'C:\\Apps\\Chat.exe',name:'Chat',proxyAppId:'C:\\Proxy\\East.exe',proxyName:'Proxy East',connections:1,measurementAvailable:true,rxPerSecond:'3000',txPerSecond:'0'}];
        s.appProcesses=[{networkId:id,appId:'C:\\Apps\\Browser.exe',name:'Browser',processId:42,scope:'wifi',rxPerSecond:'50',txPerSecond:'0'},
            {networkId:id,appId:'C:\\Proxy\\East.exe',name:'Proxy East',processId:60,scope:'wifi',rxPerSecond:'100',txPerSecond:'0'}];
        s.live.proxy=s.proxy;
    });
    await page.reload();await openApplications();
    const originalTotal=await page.locator('#appTotal').textContent();
    await expect(page.locator('#appTotal')).toHaveText('3.01KB');
    await page.getByRole('tab',{name:'实时流量排行',exact:true}).click();
    await page.locator('#liveRankingRegion tbody tr').filter({hasText:'Browser'}).locator('[data-action="select-live-app"]').click();
    await expect(page.locator('.application-proxy-details.proxy-live-connections')).toContainText('Proxy East');
    await expect(page.locator('.application-proxy-details.proxy-live-connections')).toContainText('Proxy West');
    await expect(page.locator('.application-proxy-details.proxy-live-connections')).not.toContainText('Chat');
    await expect(page.locator('.application-proxy-details.proxy-history-estimates .proxy-detail-item')).toHaveCount(2);
    await expect(page.locator('.application-proxy-details.proxy-history-estimates')).toContainText('600 B');
    await expect(page.locator('.application-proxy-details.proxy-history-estimates')).toContainText('1.8 KB');
    await expect(page.locator('.application-proxy-details.proxy-history-estimates')).toContainText('代理估算');
    await expect(page.locator('.application-proxy-details.proxy-history-estimates')).not.toContainText('/s');
    await page.keyboard.press('Escape');
    await page.locator('#liveRankingRegion tbody tr').filter({hasText:'Proxy East'}).locator('[data-action="select-live-app"]').click();
    await expect(page.locator('.application-proxy-details.proxy-live-connections')).toContainText('Browser');
    await expect(page.locator('.application-proxy-details.proxy-live-connections')).toContainText('Chat');
    await expect(page.locator('.application-proxy-details.proxy-live-connections')).not.toContainText('Proxy West');
    await page.keyboard.press('Escape');
    await page.getByRole('tab',{name:'应用用量记录',exact:true}).click();
    await page.locator('#appDataSource').selectOption('estimated');
    await expect(page.locator('#appTotal')).toHaveText(originalTotal);
    const browserRows=page.locator('.application-table-row').filter({hasText:'Browser'});
    await expect(browserRows).toHaveCount(2);
    await expect(browserRows.filter({has:page.locator('.application-source-badge.estimated')})).toContainText('2.4 KB');
    await expect(browserRows.filter({hasText:'原生记录'})).toContainText('5 B');
});

test('英文深色 125% 缩放下切换视图无横向溢出，代理无效草稿保留 @application-views',async({},testInfo)=>{
    await app.evaluate(()=>{globalThis.rendererFixture.snapshot.settings.language='en';});
    await page.reload();
    await page.evaluate(()=>window.desktop.windowPreferences.update({theme:'dark'}));
    await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
    await page.setViewportSize({width:900,height:650});
    await page.evaluate(()=>{document.documentElement.style.zoom='1.25';});
    await page.locator('.nav [data-page="apps"]').click();
    await expect(page).toHaveTitle(/Application usage/);
    await page.locator('.app-proxy-panel summary').click();
    await page.locator('#proxyPorts').fill('not-a-port');
    await expect(page.locator('#proxyConfigForm .form-error')).not.toBeEmpty();
    const original=await page.locator('#proxyConfigForm').elementHandle();
    for(const view of ['history','live','history']){
        await page.locator(`[data-action="application-view"][data-view="${view}"]`).click();
        await expect(page.locator('#proxyPorts')).toHaveValue('not-a-port');
        expect(await original.evaluate(element=>element.isConnected)).toBe(true);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        await page.screenshot({path:testInfo.outputPath(`applications-en-dark-125-${view}.png`),fullPage:true});
    }
    expect(await app.evaluate(()=>globalThis.rendererFixture.snapshot.proxy.ports)).toEqual([]);
});

test('应用流量页展示全部实时排行并按下载、上传速度排序',async()=>{
    await expect(page.locator('#liveRankingRegion')).toHaveCount(0);
    await openLiveApplications();
    await app.evaluate(({BrowserWindow})=>{
        const s=globalThis.rendererFixture.snapshot;
        s.appCollection={available:true,enabled:true,state:'running'};
        const processes=Array.from({length:12},(_,i)=>({networkId:s.networks[0].id,appId:`C:\\Apps\\App${i}.exe`,name:`App${i}`,processId:i+1,rxPerSecond:String((12-i)*1000),txPerSecond:String(i*2000)}));
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...s.live,appCollection:s.appCollection,appProcesses:processes});
    });
    await expect(page.locator('#liveRankingRegion tbody tr')).toHaveCount(12);
    await expect(page.locator('#liveRankingRegion tbody tr').first()).toContainText('App11');
    await page.locator('#appSort').selectOption('rx');
    await expect(page.locator('#liveRankingRegion tbody tr').first()).toContainText('App0');
    await expect(page.locator('#appListRegion tbody tr')).toHaveCount(12);
    await page.locator('#appSort').selectOption('tx');await expect(page.locator('#appListRegion tbody tr').first()).toContainText('App11');
});

test('已设置的应用限制可从列表查询并进入调整，无需应用正在运行',async()=>{
    await app.evaluate(()=>{globalThis.rendererFixture.rules=[{
        path:'C:\\Apps\\OfflineTool.exe',name:'OfflineTool.exe',savedAt:'2026-10-12T00:00:00.000Z',
        state:{Blocked:true,Throttled:true,UploadKbps:1024,DownloadThrottled:false}
    }];});
    await openApplications();
    if(process.platform!=='win32'){
        await expect(page.locator('.app-rules-panel, .app-rule-row, [data-action="app-rules-refresh"]')).toHaveCount(0);
        await page.locator('[data-action="application-control"]').click();
        await expect(page.locator('.application-control')).toContainText('当前平台暂不支持应用防火墙与上传、下载限速。');
        await expect(page.locator('[data-action="choose-program"], [data-operation], #uploadKBps, #downloadKBps')).toHaveCount(0);
        expect(await app.evaluate(()=>globalThis.rendererFixture.calls.filter(c=>c.method.startsWith('app-control')))).toEqual([]);
        await page.keyboard.press('Escape');
        await page.reload();
        await expect(page.locator('.app-rules-panel, .app-rule-row')).toHaveCount(0);
        expect(await app.evaluate(()=>globalThis.rendererFixture.calls.filter(c=>c.method.startsWith('app-control')))).toEqual([]);
        return;
    }
    await page.locator('[data-action="app-rules-refresh"]').click();
    const row=page.locator('.app-rule-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('OfflineTool.exe');
    await expect(row).toContainText('128 KB/s');
    await row.locator('[data-action="select-controlled-app"]').click();
    await expect(page.locator('[data-selected-app-path]')).toHaveText('C:\\Apps\\OfflineTool.exe');
    expect(await app.evaluate(()=>globalThis.rendererFixture.calls.filter(c=>c.method==='app-control').at(-1).params)).toMatchObject({action:'read',path:'C:\\Apps\\OfflineTool.exe'});
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.locator('.app-rule-row')).toContainText('OfflineTool.exe');
});

test('采集控制位于时间工具栏，启停状态明显且代理设置保留草稿',async()=>{
    await openApplications();
    const capture=page.locator('.toolbar [data-action="app-collection"]');
    await expect(capture).toHaveText('开启应用采集');
    await expect(capture).toHaveClass(/capture-start/);
    const startColor=await capture.evaluate(el=>getComputedStyle(el).backgroundColor);
    await capture.click();
    await expect(capture).toHaveText('停止应用采集');
    await expect(capture).toHaveClass(/capture-stop/);
    expect(await capture.evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe(startColor);
    await expect(page.locator('#appCaptureRegion')).toContainText('应用采集中');
    await expect(page.locator('[data-action="app-collection"]')).toHaveCount(1);
    await page.locator('.app-proxy-panel summary').click();
    await page.locator('#proxyPorts').fill('7890, 1080');
    await app.evaluate(({BrowserWindow})=>{
        const s=globalThis.rendererFixture.snapshot;
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...s.live,appCollection:s.appCollection});
    });
    await expect(page.locator('#proxyPorts')).toHaveValue('7890, 1080');
    await page.locator('#appSort').selectOption('rx');
    await expect(page.locator('#proxySaveStatus')).toContainText('已自动保存');
    expect(await app.evaluate(()=>globalThis.rendererFixture.snapshot.proxy.ports)).toEqual([7890,1080]);
    await capture.click();
    await expect(capture).toHaveText('开启应用采集');
    await expect(page.locator('#appCaptureRegion')).toContainText('应用采集未启用');
    await page.locator('[data-action="period"][data-value="custom"]').click();
    await expect(page.locator('#rangeStartTime')).toBeVisible();
    await expect(page.locator('#rangeEndTime')).toBeVisible();
    await expect(page.locator('.modal .modal-desc')).toHaveCount(0);
    await page.locator('.modal [data-action="close-modal"]').first().click();
    await app.evaluate(({BrowserWindow})=>{
        const s=globalThis.rendererFixture.snapshot;
        s.appCollection={available:true,enabled:true,state:'permission',detail:'permission denied'};
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...s.live,appCollection:s.appCollection});
    });
    await expect(page.locator('#appStatusRegion')).toContainText('permission denied');
    await page.locator('.toolbar [data-action="app-collection-retry"]').click();
    await expect(page.locator('#appCaptureRegion')).toContainText('应用采集中');
    await page.locator('.nav [data-page="networks"]').click();
    await page.locator('button.network-name').first().click();
    await page.getByRole('tab',{name:'应用分布'}).click();
    const drawerCapture=page.locator('.drawer [data-action="app-collection"]');
    await drawerCapture.click();
    await expect(drawerCapture).toHaveText('开启应用采集');
    await expect(drawerCapture).toBeEnabled();
    await drawerCapture.click();
    await expect(drawerCapture).toHaveText('停止应用采集');
    await expect(drawerCapture).toBeEnabled();
    await page.locator('#closeDrawer').click();
});

test('历史应用详情随用量事件刷新，保留限速输入和日期分组',async()=>{
    await openApplications();
    await page.locator('[data-action="select-app"]').click();
    const total=page.locator('.drawer .application-summary dt').filter({hasText:/^总用量$/}).locator('+ dd');
    await expect(total).toHaveText('520.11 KB');
    let input;
    if(process.platform==='win32'){
        await expect(page.locator('#uploadKBps')).toBeEnabled();
        await page.locator('#uploadKBps').fill('96');
        input=await page.locator('#uploadKBps').elementHandle();
    }
    await app.evaluate(({BrowserWindow})=>{const s=globalThis.rendererFixture.snapshot;
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'appUsage',records:[{...s.appRecords[0],rxBytes:'1000000',txBytes:'0'}]});
    });
    await expect(total).toHaveText('1.52 MB');
    if(input){
        expect(await input.evaluate(element=>element.isConnected)).toBe(true);
        await expect(page.locator('#uploadKBps')).toHaveValue('96');
    }
    await page.keyboard.press('Escape');
    await page.locator('#appGrouping').selectOption('day');
    await page.locator('#appListRegion tbody tr').filter({hasText:'2020-01-01'}).getByRole('button',{name:'Browser',exact:true}).click();
    await expect(total).toHaveText('1.52 MB');
    await app.evaluate(({BrowserWindow})=>{const s=globalThis.rendererFixture.snapshot;
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'appUsage',records:[
            {...s.appRecords[2],rxBytes:'2000000',txBytes:'0'},
            {...s.appRecords[0],rxBytes:'1000000',txBytes:'0'}
        ]});
    });
    await expect(total).toHaveText('2.52 MB');
    await expect(page.locator('.drawer .application-summary')).toContainText('2020-01-01');
});

test('代理采样失败和恢复后保留无效草稿，修正后可以保存并离开',async()=>{
    await openApplications();
    await page.locator('.app-proxy-panel summary').click();
    const original=await page.locator('#proxyConfigForm').elementHandle();
    await page.locator('#proxyPorts').fill('not-a-port');
    await expect(page.locator('#proxyConfigForm .form-error')).toContainText('代理端口须为 1 到 65535 的整数');
    await app.evaluate(({BrowserWindow})=>{const s=globalThis.rendererFixture.snapshot;
        Object.assign(s.proxy,{available:false,status:'failed',detail:'TCP query failed'});
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...s.live,proxy:s.proxy});
    });
    await page.locator('[data-action="period"][data-value="today"]').click();
    await expect(page.locator('[data-action="period"][data-value="today"]')).toHaveAttribute('aria-pressed','true');
    await expect(page.locator('#proxyPorts')).toHaveValue('not-a-port');
    expect(await original.evaluate(element=>element.isConnected)).toBe(true);
    await app.evaluate(({BrowserWindow})=>{const s=globalThis.rendererFixture.snapshot;
        Object.assign(s.proxy,{available:true,status:'ready',detail:''});
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...s.live,proxy:s.proxy});
    });
    await page.locator('[data-action="period"][data-value="all"]').click();
    await expect(page.locator('#proxyPorts')).toHaveValue('not-a-port');
    expect(await original.evaluate(element=>element.isConnected)).toBe(true);
    await page.locator('#proxyPorts').fill('7890');
    await page.locator('#appSort').selectOption('rx');
    await expect(page.locator('#proxySaveStatus')).toContainText('已自动保存');
    expect(await app.evaluate(()=>globalThis.rendererFixture.snapshot.proxy.ports)).toEqual([7890]);
    await page.locator('.nav [data-page="networks"]').click();
    await expect(page).toHaveTitle(/我的网络/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.locator('.nav [data-page="settings"]').click();
    await page.locator('[data-action="settings-category"][data-category="proxy"]').click();
    const settingsForm=await page.locator('#proxyConfigForm').elementHandle();
    await page.locator('#proxyPorts').fill('not-a-port');
    await expect(page.locator('#proxyConfigForm .form-error')).toContainText('代理端口须为 1 到 65535 的整数');
    await app.evaluate(({BrowserWindow})=>{const s=globalThis.rendererFixture.snapshot;
        Object.assign(s.proxy,{available:false,status:'failed',detail:'TCP query failed'});
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...s.live,proxy:s.proxy});
    });
    await page.locator('.sidebar [data-action="pause"]').click();
    await expect(page.locator('#settings-proxy')).toContainText('TCP query failed');
    await expect(page.locator('#proxyPorts')).toHaveValue('not-a-port');
    expect(await settingsForm.evaluate(element=>element.isConnected)).toBe(true);
    await app.evaluate(({BrowserWindow})=>{const s=globalThis.rendererFixture.snapshot;
        Object.assign(s.proxy,{available:true,status:'ready',detail:''});
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...s.live,proxy:s.proxy});
    });
    await page.locator('.sidebar [data-action="pause"]').click();
    await expect(page.locator('#proxyPorts')).toHaveValue('not-a-port');
    expect(await settingsForm.evaluate(element=>element.isConnected)).toBe(true);
    await page.locator('#proxyPorts').fill('1080');
    await page.locator('[data-action="settings-category"][data-category="general"]').click();
    await expect(page.locator('#proxySaveStatus')).toContainText('已自动保存');
    expect(await app.evaluate(()=>globalThis.rendererFixture.snapshot.proxy.ports)).toEqual([1080]);
    await page.locator('.nav [data-page="apps"]').click();
    await expect(page).toHaveTitle(/应用流量/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('应用采集重试按钮在无变化和状态变化的实时刷新后保留键盘焦点',async()=>{
    await openApplications();
    await app.evaluate(({BrowserWindow})=>{const s=globalThis.rendererFixture.snapshot;
        s.appCollection={available:true,enabled:true,state:'permission',detail:'permission denied'};
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...s.live,appCollection:s.appCollection});
    });
    const retry=page.locator('#appCaptureRegion [data-action="app-collection-retry"]');
    await expect(retry).toBeVisible();
    await retry.focus();
    await expect(retry).toBeFocused();
    const original=await retry.elementHandle();
    await app.evaluate(({BrowserWindow})=>{const s=globalThis.rendererFixture.snapshot;
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...s.live,collector:'running',appCollection:s.appCollection});
    });
    await expect(page.locator('.collector-title')).toHaveText('正在采集');
    expect(await original.evaluate(element=>element.isConnected)).toBe(true);
    await expect(retry).toBeFocused();
    await app.evaluate(({BrowserWindow})=>{const s=globalThis.rendererFixture.snapshot;
        s.appCollection={available:true,enabled:true,state:'unavailable',detail:'helper unavailable'};
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...s.live,collector:'running',appCollection:s.appCollection});
    });
    await expect(page.locator('#appCaptureRegion')).toContainText('应用采集暂不可用');
    expect(await original.evaluate(element=>element.isConnected)).toBe(false);
    await expect(retry).toBeFocused();
});

test('明确开启和关闭自启动被拒绝时自动保存显示失败，重试后恢复',async()=>{
    await app.evaluate(()=>{const f=globalThis.rendererFixture;
        f.snapshot.settings.autoStart=true;
        f.autoStartSystem={autoStart:false,autoStartError:'删除被拒绝'};
    });
    await page.reload();
    await page.locator('.nav [data-page="settings"]').click();
    const setting=page.locator('#settingsForm [name="autoStart"]');
    const status=page.locator('#settingsSaveHint');
    const retry=page.locator('#settingsForm [data-action="retry-autosave"]');
    await expect(setting).toBeChecked();
    await setting.uncheck();
    await expect(status).toContainText('保存失败');
    await expect(status).toContainText('删除被拒绝');
    await expect(setting).not.toBeChecked();
    await expect(retry).toBeVisible();
    await app.evaluate(()=>{globalThis.rendererFixture.autoStartSystem={autoStart:false};});
    await retry.click();
    await expect(status).toContainText('已自动保存');
    await expect(retry).toBeHidden();
    await app.evaluate(()=>{globalThis.rendererFixture.autoStartSystem={autoStart:true,autoStartError:'写入被拒绝'};});
    await setting.check();
    await expect(status).toContainText('保存失败');
    await expect(status).toContainText('写入被拒绝');
    await expect(setting).toBeChecked();
    await expect(retry).toBeVisible();
    await app.evaluate(()=>{globalThis.rendererFixture.autoStartSystem={autoStart:true};});
    await retry.click();
    await expect(status).toContainText('已自动保存');
    await expect(retry).toBeHidden();
});

test('下载限速提交和取消使用独立方向',async()=>{
    await openApplications();await page.locator('[data-action="application-control"]').click();
    if(process.platform!=='win32'){
        await expect(page.locator('.application-control')).toContainText('当前平台暂不支持应用防火墙与上传、下载限速。');
        await expect(page.locator('#downloadKBps, #appDownloadThrottleForm, [data-direction="download"]')).toHaveCount(0);
        expect(await app.evaluate(()=>globalThis.rendererFixture.calls.filter(c=>c.method==='app-control'))).toEqual([]);
        return;
    }
    await page.locator('[data-action="choose-program"]').click();
    await page.locator('#downloadKBps').fill('256');await page.locator('#appDownloadThrottleForm button[type="submit"]').click();
    await expect(page.locator('#appControlRegion')).toContainText('partial failure');
    await page.locator('[data-operation="unthrottle"][data-direction="download"]').click();
    const calls=await app.evaluate(()=>globalThis.rendererFixture.calls.filter(c=>c.method==='app-control'));
    expect(calls[0].params).toMatchObject({action:'throttle',downloadKBps:256});
    expect(calls[0].params.uploadKBps).toBeUndefined();
    expect(calls[1].params).toMatchObject({action:'unthrottle',direction:'download'});
});

test('独立应用页跨网络汇总、历史筛选及深链接',async()=>{
    await app.evaluate(()=>{const s=globalThis.rendererFixture.snapshot;
        s.networks.push({...s.networks[0],id:'second',alias:'Second'});
        s.appRecords.push({...s.appRecords[0],networkId:'second',rxBytes:'1000',txBytes:'0'});
    });
    await openApplications();
    await expect(page.locator('#appTotal')).toContainText('521.11KB');
    await expect(page.locator('.application-table-row')).toHaveCount(1);
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
        await expect(page.locator('.application-control')).toContainText('当前平台暂不支持应用防火墙与上传、下载限速。');
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
    await page.locator('#appThrottleForm button[type="submit"]').click();
    await expect(page.locator('#appControlRegion')).toContainText('partial failure');
    await expect(page.locator('#appControlRegion')).toContainText('readback failed');
    const calls=await app.evaluate(()=>globalThis.rendererFixture.calls.filter(c=>c.method==='app-control'));
    expect(calls.map(c=>c.params.action)).toEqual(['block','unblock','throttle']);
    expect(calls.at(-1).params.uploadKBps).toBe(0.125);
});

test('实时进程响应后台事件，保留限速输入并展示采集失败',async()=>{
    await openLiveApplications();
    await page.locator('[data-action="app-collection"]').click();
    await expect(page.locator('#appStatusRegion')).toContainText('应用采集中');
    await expect(page.locator('#appListRegion')).toContainText('当前没有应用进程数据。');

    await app.evaluate(({BrowserWindow})=>{
        const s=globalThis.rendererFixture.snapshot;
        for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...s.live,appCollection:s.appCollection,appProcesses:[{networkId:s.networks[0].id,appId:'C:\\Apps\\Browser.exe',name:'Live Browser',processId:42,rxPerSecond:'1000000',txPerSecond:'125000'}]});
    });
    await expect(page.locator('#appListRegion')).toContainText('Live Browser');
    await expect(page.locator('#appListRegion')).toContainText('42');
    await page.locator('#appListRegion [data-action="select-live-app"]').click();
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
        if(pageId!=='settings')await expect(page.locator('.toolbar [data-action="refresh"]')).toBeVisible();
        if(pageId!=='settings'&&pageId!=='apps')await expect(page.locator('.toolbar [data-action="export"]')).toBeVisible();
        if(pageId==='apps')await expect(page.locator('.toolbar [data-action="export"]')).toHaveCount(0);
        await expect(page.locator(`.nav [data-page="${pageId}"]`)).toHaveAttribute('aria-current','page');
    }
    await page.getByRole('tab',{name:'应用用量记录',exact:true}).click();
    await expect(page.locator('[data-action="export-apps"]')).toBeVisible();
    await expect(page.locator('#appListRegion')).toContainText('所选时段没有应用记录');
    await expect(page.locator('#appTotal')).toHaveText('—');
    await app.evaluate(()=>{const s=globalThis.rendererFixture.snapshot;
        s.networks.push({...s.networks[0],id:'empty-network',alias:'Empty Network'});
    });
    await page.locator('[data-action="period"][data-value="all"]').click();
    await expect(page.locator('.application-table-row')).toHaveCount(1);
    await page.locator('#networkFilter').selectOption('empty-network');
    await expect(page.locator('#appListRegion')).toContainText('所选时段没有应用记录');
    await expect(page.locator('#appTotal')).toHaveText('—');
    await expect(page.locator('[data-action="application-control"]')).toBeVisible();
    await page.locator('#networkFilter').selectOption('all');
    await expect(page.locator('.application-table-row')).toHaveCount(1);
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
    await expect(page.locator('.application-table-row')).toHaveCount(1);
});

test('proxy clients remain visible without invented traffic and can be selected for control',async()=>{
 await app.evaluate(()=>{globalThis.rendererFixture.snapshot.proxy.clients=[{appId:'C:\\Apps\\Browser.exe',name:'Browser',proxyName:'Proxy',connections:3}];});
 await page.reload();await openLiveApplications();
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
 await openApplications();
 const historyTotal=await page.locator('#appTotal').textContent();
 await page.getByRole('tab',{name:'实时流量排行',exact:true}).click();
 await app.evaluate(({BrowserWindow})=>{
  const s=globalThis.rendererFixture.snapshot;
  const base={appId:'C:\\Apps\\Browser.exe',name:'Browser',networkId:'',scope:'loopback',source:'WindowsTcpEStats',measurementAvailable:true,rxPerSecond:'3000',txPerSecond:'1000'};
  const proxy={...s.proxy,clients:[{...base,proxyName:'Port 7897',connections:2,rxPerSecond:'6000',txPerSecond:'2000'}]};
  for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...s.live,collector:'running',proxy,appCollection:{enabled:true,available:true,state:'running'},appProcesses:[{...base,processId:42},{...base,processId:43}]});
 });
 await expect(page.locator('#appListRegion tbody tr')).toHaveCount(1);
 await expect(page.locator('#appListRegion')).toContainText('6.0 KB/s');await expect(page.locator('#appListRegion')).toContainText('本地 TCP');
 await expect(page.locator('#proxyClientsRegion')).toContainText('6.0 KB/s');
 await expect(page.locator('#appTotal')).toHaveCount(0);
 await page.locator('#appListRegion [data-action="select-live-app"]').click();await expect(page.locator('.application-summary')).toContainText('6.0 KB/s');
 if(process.platform==='win32')await page.locator('#uploadKBps').fill('96');
 else{
  await expect(page.locator('#uploadKBps')).toHaveCount(0);
  await expect(page.locator('.application-control')).toContainText('当前平台暂不支持应用防火墙与上传、下载限速。');
 }
 await app.evaluate(({BrowserWindow})=>{const s=globalThis.rendererFixture.snapshot;for(const win of BrowserWindow.getAllWindows())win.webContents.send('backend:event',{event:'live',...s.live,collector:'running',appCollection:{enabled:true,available:true,state:'running'},appProcesses:[{appId:'C:\\Apps\\Browser.exe',name:'Browser',processId:42,networkId:'',scope:'loopback',rxPerSecond:'9000',txPerSecond:'1000',measurementAvailable:true}]});});
 await expect(page.locator('.application-summary')).toContainText('9.0 KB/s');
 if(process.platform==='win32')await expect(page.locator('#uploadKBps')).toHaveValue('96');
 else await expect(page.locator('#uploadKBps')).toHaveCount(0);
 await page.keyboard.press('Escape');
 await page.getByRole('tab',{name:'应用用量记录',exact:true}).click();
 await expect(page.locator('#appTotal')).toHaveText(historyTotal);
});

test('proxy clients appear only on applications and live changes replace zero rates',async()=>{
 await app.evaluate(()=>{const s=globalThis.rendererFixture.snapshot;s.appCollection={enabled:true,available:true,state:'running'};s.live.collector='running';s.live.appCollection=s.appCollection;s.proxy={available:true,status:'ready',ports:[7897],clients:[{appId:'C:\\Apps\\Browser.exe',name:'Browser',proxyName:'Port 7897',connections:2,measurementAvailable:true,rxPerSecond:'0',txPerSecond:'0'}]};});
 await page.reload();await page.locator('.nav [data-page="settings"]').click();
 await expect(page.locator('.proxy-client-table')).toHaveCount(0);
 await openLiveApplications();await expect(page.locator('.proxy-client-table')).toContainText('0 B/s');
 await app.evaluate(({BrowserWindow})=>{const f=globalThis.rendererFixture;const proxy={...f.snapshot.proxy,clients:[{...f.snapshot.proxy.clients[0],rxPerSecond:'24000',txPerSecond:'6000'}]};for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'live',...f.snapshot.live,proxy});});
 await expect(page.locator('.proxy-client-table')).toContainText('24.0 KB/s');await expect(page.locator('.proxy-client-table')).toContainText('6.0 KB/s');
 const aligned=await page.locator('.proxy-client-table').evaluate(table=>[...table.querySelectorAll('tr')].every(row=>[...row.children].slice(2).every(cell=>getComputedStyle(cell).textAlign==='right')));
 expect(aligned).toBe(true);
 await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.webContents.send('backend:event',{event:'collectorStatus',collector:'paused',appCollection:{enabled:true,available:true,state:'paused'}});});
 await expect(page.locator('.proxy-client-table')).not.toContainText('24.0 KB/s');
 await expect(page.locator('.proxy-client-table tbody td').nth(3)).toHaveText('—');
 await page.locator('[data-action="select-proxy-app"]').click();
 await expect(page.locator('.proxy-live-connections')).toContainText('不可测');
 await expect(page.locator('.proxy-live-connections')).not.toContainText('24.0 KB/s');
});

test('延迟代理来源查询不能覆盖更新的原生选择，等待时不导出旧口径',async()=>{
 await openApplications();
 await app.evaluate(({ipcMain})=>{
  const original=ipcMain.getHandler('backend:request');let delayed=true;
  ipcMain.removeHandler('backend:request');
  ipcMain.handle('backend:request',(event,input)=>{
   if(input.method==='snapshot'&&delayed){delayed=false;return new Promise(resolve=>{globalThis.rendererFixture.releaseSource=async()=>resolve(await original(event,input));});}
   return original(event,input);
  });
 });
 await page.locator('#appDataSource').selectOption('estimated');
 await expect(page.locator('[data-action="export-apps"]')).toBeDisabled();
 await expect.poll(()=>app.evaluate(()=>!!globalThis.rendererFixture.releaseSource)).toBe(true);
 await page.locator('#appDataSource').selectOption('native');
 await app.evaluate(()=>globalThis.rendererFixture.releaseSource());
 await expect(page.locator('#appDataSource')).toHaveValue('native');
 await expect(page.locator('[data-action="export-apps"]')).toBeEnabled();
 await expect(page.locator('.application-source-badge.estimated')).toHaveCount(0);
});

test('代理来源等待期间修改历史分组，两项独立选择都保留',async()=>{
 await openApplications();
 await app.evaluate(({ipcMain})=>{
  const original=ipcMain.getHandler('backend:request');let delayed=true;
  ipcMain.removeHandler('backend:request');
  ipcMain.handle('backend:request',(event,input)=>{
   if(input.method==='snapshot'&&delayed){delayed=false;return new Promise(resolve=>{globalThis.rendererFixture.releaseIndependent=async()=>resolve(await original(event,input));});}
   return original(event,input);
  });
 });
 await page.locator('#appDataSource').selectOption('estimated');
 await expect.poll(()=>app.evaluate(()=>!!globalThis.rendererFixture.releaseIndependent)).toBe(true);
 await page.locator('#appGrouping').selectOption('day');
 await expect(page.locator('[data-action="export-apps"]')).toBeDisabled();
 await app.evaluate(()=>globalThis.rendererFixture.releaseIndependent());
 await expect(page.locator('#appDataSource')).toHaveValue('estimated');
 await expect(page.locator('#appGrouping')).toHaveValue('day');
 await expect(page.locator('[data-action="export-apps"]')).toBeEnabled();
 await page.locator('#appSort').selectOption('rx');
 await expect(page.locator('th[aria-sort="descending"]')).toContainText('下载');
 await page.locator('[data-action="app-history-sort"][data-key="date"]').click();
 await expect(page.locator('#appSort')).toHaveValue('date');
});

test('live estimates refresh displayed clients while preserving upload and download totals',async()=>{
 await app.evaluate(()=>{const f=globalThis.rendererFixture;const id=f.snapshot.networks[0].id;f.snapshot.appRecords=[{networkId:id,date:'2020-01-01',appId:'C:\\Proxy\\Proxy.exe',name:'Proxy',rxBytes:'1000',txBytes:'3000'}];f.snapshot.proxyEstimatedRecords=[];});
 await openApplications();
 const originalSource=await page.locator('#appDataSource').elementHandle();
 await page.locator('#appDataSource').selectOption('estimated');
 await expect.poll(()=>originalSource.evaluate(element=>element.isConnected)).toBe(true);
 await expect(page.locator('#appDataSource')).toHaveValue('estimated');
 await expect(page.locator('.application-table-row')).toContainText('Proxy');
 await app.evaluate(({BrowserWindow})=>{const s=globalThis.rendererFixture.snapshot;const rows=[{networkId:s.networks[0].id,date:'2020-01-01',appId:'C:\\Apps\\Browser.exe',name:'Browser',proxyAppId:'C:\\Proxy\\Proxy.exe',estimated:true,rxBytes:'600',txBytes:'1800'},{networkId:s.networks[0].id,date:'2020-01-01',appId:'C:\\Apps\\Chat.exe',name:'Chat',proxyAppId:'C:\\Proxy\\Proxy.exe',estimated:true,rxBytes:'400',txBytes:'1200'}];for(const win of BrowserWindow.getAllWindows())win.webContents.send('backend:event',{event:'live',...s.live,proxy:s.proxy,proxyEstimatedUpdates:[{networkId:s.networks[0].id,date:'2020-01-01',proxyAppId:'C:\\Proxy\\Proxy.exe',records:rows}]});});
 await expect(page.locator('.application-table-row')).toHaveCount(2);await expect(page.locator('.application-table-row').filter({hasText:'Browser'})).toContainText('2.4 KB');await expect(page.locator('.application-table-row').filter({hasText:'Chat'})).toContainText('1.6 KB');await expect(page.locator('#appTotal')).toHaveText('4KB');
});
