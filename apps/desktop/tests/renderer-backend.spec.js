import { test, expect } from '@playwright/test';
import { desktop } from './support/browser-desktop.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHarness } from './support/backend-harness.mjs';

// 只在临时数据库播种旧日期；查询、保存偏好与导出均使用真实 IPC / SQLite。
test('真实后端查询旧日期并导出，语言偏好在页面重载后恢复',async()=>{
    const profile=await mkdtemp(path.join(os.tmpdir(),'wifimeter-history-backend-'));
    const harness=await createHarness();let app;
    try{
        const env={...process.env,WIFIMETER_USER_DATA:profile,...harness.env};
        app=await desktop.launch({env});const page=await app.firstWindow(),errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
        const response=await page.evaluate(async()=>{
            await window.desktop.backend.request('setPaused',{paused:true});
            const {result}=await window.desktop.backend.request('backup');const backup=result.backup;
            const networkId=backup.networks[0].key;
            backup.settings={...backup.settings,language:'zh-CN',retention:0};
            backup.records=[{date:'2020-01-01',networkId,rxBytes:'520000',txBytes:'1'},{date:'2020-02-01',networkId,rxBytes:'1000',txBytes:'2'}];
            backup.appRecords=[{date:'2020-01-01',networkId,appId:'browser',name:'Browser',rxBytes:'520000',txBytes:'1'}];
            backup.hourlyRecords=[{date:'2020-01-01',networkId,hour:'7',rxBytes:'500000',txBytes:'0'},
                {date:'2020-01-01',networkId,hour:'8',rxBytes:'20000',txBytes:'1'},
                {date:'2020-02-01',networkId,hour:'9',rxBytes:'1000',txBytes:'2'}];
            backup.minuteRecords=[];backup.appMinuteRecords=[];
            return window.desktop.backend.request('restore',{backup});
        });
        expect(response.ok).toBe(true);await page.reload();
        await page.locator('[data-value="all"]').click();await expect(page.locator('.metric.featured')).toContainText('521');
        await page.locator('[data-value="custom"]').click();
        await page.locator('#rangeStart').fill('2020-01-01');await page.locator('#rangeEnd').fill('2020-01-31');
        await page.getByRole('button',{name:'应用筛选',exact:true}).click();await expect(page.locator('.modal')).toHaveCount(0);
        await expect(page.locator('.metric.featured')).toContainText('520');
        const file=path.join(profile,'old-history.csv');
        await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},file);
        await page.getByRole('button',{name:'导出数据',exact:true}).click();
        await expect(page.locator('#exportGrouping')).toHaveValue('day');
        await page.getByRole('button',{name:'导出记录',exact:true}).click();
        await expect(page.locator('.modal')).toHaveCount(0);const csv=await readFile(file,'utf8');
        expect(csv).toContain('"2020-01-01"');expect(csv).toContain('"520000","1","520001"');expect(csv).not.toContain('2020-02-01');
        const hoursFile=path.join(profile,'old-hours.json');
        await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},hoursFile);
        await page.getByRole('button',{name:'导出数据',exact:true}).click();
        await page.locator('#exportGrouping').selectOption('hour');await page.locator('#exportFormat').selectOption('json');
        await page.getByRole('button',{name:'导出记录',exact:true}).click();
        await expect(page.locator('.modal')).toHaveCount(0);
        const hours=JSON.parse(await readFile(hoursFile,'utf8'));
        expect(hours.records.map(row=>[row.date,row.time,row.minute,row.rxBytes,row.txBytes])).toEqual([
            ['2020-01-01','07:00',0,'500000','0'],['2020-01-01','08:00',0,'20000','1']]);
        expect(hours.records.every(row=>row.ssid&&row.alias!==undefined)).toBe(true);
        const minutesRestored=await page.evaluate(async()=>{
            const {result}=await window.desktop.backend.request('backup');const backup=result.backup,networkId=backup.networks[0].key;
            backup.minuteRecords=[14,15,16,17].map(minute=>({date:'2020-01-01',networkId,hour:'8',minute:String(minute),
                rxBytes:minute===15?'10':minute===16?'20':'999',txBytes:minute===15?'1':minute===16?'2':'99'}));
            return window.desktop.backend.request('restore',{backup});
        });
        expect(minutesRestored.ok).toBe(true);
        const partialFile=path.join(profile,'partial-hour.json');
        await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},partialFile);
        await page.getByRole('button',{name:'导出数据',exact:true}).click();
        await page.locator('#exportEnd').fill('2020-01-01');
        await page.locator('#exportStartTime').fill('08:15');await page.locator('#exportEndTime').fill('08:16');
        await page.locator('#exportGrouping').selectOption('hour');await page.locator('#exportFormat').selectOption('json');
        await page.getByRole('button',{name:'导出记录',exact:true}).click();
        await expect(page.locator('.modal')).toHaveCount(0);
        const partial=JSON.parse(await readFile(partialFile,'utf8'));
        expect(partial.records.map(row=>[row.date,row.time,row.minute,row.rxBytes,row.txBytes])).toEqual([
            ['2020-01-01','08:00',0,'30','3']]);
        await page.locator('.nav [data-page="settings"]').click();await page.locator('select[name="language"]').selectOption('en');
        await expect.poll(() => page.evaluate(async () => (await window.desktop.backend.request('snapshot')).result.settings.language)).toBe('en');await expect(page).toHaveTitle(new RegExp('Preferences'));
        await page.reload();await expect(page).toHaveTitle(new RegExp('Preferences'));
        expect((await page.evaluate(()=>window.desktop.backend.request('snapshot'))).result.settings.language).toBe('en');
        expect(errors).toEqual([]);
    }finally{
        if(app)await app.close();
        harness.cleanup();await rm(profile,{recursive:true,force:true});
    }
});

test('refresh beside export reloads backend values without changing the selected range', async () => {
    const harness = await createHarness(); let app;
    try {
        const env = { ...process.env, ...harness.env };
        app = await desktop.launch({ env });
        const page = await app.firstWindow();
        await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
        const refresh = page.locator('.toolbar-actions [data-action="refresh"]');
        await expect(refresh).toBeVisible();
        await expect(page.locator('.toolbar-actions [data-action="export"]')).toBeVisible();
        await page.evaluate(async () => {
            const { result } = await window.desktop.backend.request('snapshot');
            await window.desktop.backend.request('updateNetwork', { key: result.networks[0].id, alias: 'Refreshed fixture' });
        });
        await refresh.click();
        await expect(page.locator('.connection-title')).toContainText('Refreshed fixture');
        await expect(page.locator('[data-action="period"][data-value="month"]')).toHaveClass(/active/);
    } finally { if (app) await app.close(); harness.cleanup(); }
});
