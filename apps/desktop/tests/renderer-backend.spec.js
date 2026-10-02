import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHarness } from './support/backend-harness.mjs';

// 只在临时数据库播种旧日期；查询、保存偏好与导出均使用真实 IPC / SQLite。
test('真实后端查询旧日期并导出，语言偏好在页面重载后恢复',async()=>{
    const profile=await mkdtemp(path.join(os.tmpdir(),'wifimeter-history-backend-'));
    const harness=await createHarness();let app;
    try{
        const env={...process.env,WIFIMETER_USER_DATA:profile,...harness.env};delete env.ELECTRON_RUN_AS_NODE;
        app=await electron.launch({args:['.'],env});const page=await app.firstWindow(),errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
        const response=await page.evaluate(async()=>{
            await window.desktop.backend.request('setPaused',{paused:true});
            const {result}=await window.desktop.backend.request('backup');const backup=result.backup;
            const networkId=backup.networks[0].key;
            backup.settings={...backup.settings,language:'zh-CN',retention:0};
            backup.records=[{date:'2020-01-01',networkId,rxBytes:'520000',txBytes:'1'},{date:'2020-02-01',networkId,rxBytes:'1000',txBytes:'2'}];
            backup.appRecords=[{date:'2020-01-01',networkId,appId:'browser',name:'Browser',rxBytes:'520000',txBytes:'1'}];
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
        await page.getByRole('button',{name:'导出数据',exact:true}).click();await page.getByRole('button',{name:'导出记录',exact:true}).click();
        await expect(page.locator('.modal')).toHaveCount(0);const csv=await readFile(file,'utf8');
        expect(csv).toContain('"2020-01-01"');expect(csv).toContain('"520000","1","520001"');expect(csv).not.toContain('2020-02-01');
        await page.locator('.nav [data-page="settings"]').click();await page.locator('select[name="language"]').selectOption('en');
        await expect.poll(() => page.evaluate(async () => (await window.desktop.backend.request('snapshot')).result.settings.language)).toBe('en');await expect(page).toHaveTitle(new RegExp('Preferences'));
        await page.reload();await expect(page).toHaveTitle(new RegExp('Preferences'));
        expect((await page.evaluate(()=>window.desktop.backend.request('snapshot'))).result.settings.language).toBe('en');
        expect(errors).toEqual([]);
    }finally{
        if(app){await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.webContents.on('will-prevent-unload',event=>event.preventDefault());});await app.close();}
        harness.cleanup();await rm(profile,{recursive:true,force:true});
    }
});

test('refresh beside export reloads backend values without changing the selected range', async () => {
    const harness = await createHarness(); let app;
    try {
        const env = { ...process.env, ...harness.env }; delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ args: ['.'], env });
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
