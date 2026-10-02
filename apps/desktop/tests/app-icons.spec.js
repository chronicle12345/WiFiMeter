import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHarness } from './support/backend-harness.mjs';

test('executable logo or nativeImage fixture updates only its avatar and preserves fallbacks', async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-icons-'));
    const harness = await createHarness();
    const env = { ...process.env, WIFIMETER_BACKGROUND_TEST: '1', WIFIMETER_USER_DATA: profile, ...harness.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let app;
    try {
        app = await electron.launch({ args: ['.'], env });
        const page = await app.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        const url = await app.evaluate(async ({ app, nativeImage }) => {
            // Linux 桌面环境未必提供可执行文件图标，用真实 PNG 验证异步解码。
            const image = process.platform === 'linux'
                ? nativeImage.createFromBitmap(Buffer.from([0x40, 0x80, 0xc0, 0xff]), { width: 1, height: 1 })
                : await app.getFileIcon(process.execPath, { size: 'normal' });
            return image.toDataURL();
        });
        expect(url).toMatch(/^data:image\/png;base64,/);
        await page.evaluate(async url => {
            const { createAppIconLoader } = await import('./ui/app-icons.js');
            const root = document.createElement('div'); root.id = 'icon-test';
            root.innerHTML = '<button id="icon-focus">Keep focus</button><span data-app-icon="known">K</span><span data-app-icon="missing">M</span>';
            document.body.append(root);
            window.iconTest = { calls: 0, root, button: root.firstChild, missing: root.lastChild };
            const loader = createAppIconLoader({ request: async ({ appId }) => { window.iconTest.calls++; if (appId === 'missing') throw Error('missing'); return url; } });
            window.iconTest.loader = loader;
            root.firstChild.focus(); loader.hydrate(root); loader.hydrate(root);
        }, url);
        await expect(page.locator('#icon-test [data-app-icon="known"] img')).toBeVisible();
        await expect(page.locator('#icon-test [data-app-icon="missing"]')).toHaveText('M');
        expect(await page.evaluate(() => ({ calls: iconTest.calls, sameButton: iconTest.root.firstChild === iconTest.button, sameFallback: iconTest.root.lastChild === iconTest.missing, focused: document.activeElement === iconTest.button })))
            .toEqual({ calls: 2, sameButton: true, sameFallback: true, focused: true });
        expect(await page.locator('#icon-test img').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
        await page.evaluate(async url => {
            const { createAppIconLoader } = await import('./ui/app-icons.js');
            const batch = document.createElement('div'); batch.id = 'icon-batch'; document.body.append(batch);
            for (let i = 0; i < 20; i++) {
                const avatar = document.createElement('span'); avatar.className = 'app-avatar'; avatar.dataset.appIcon = 'app-' + i; avatar.textContent = 'A'; batch.append(avatar);
            }
            window.iconBatch = { active: 0, peak: 0, completed: 0 };
            const loader = createAppIconLoader({ request: async () => {
                iconBatch.active++; iconBatch.peak = Math.max(iconBatch.peak, iconBatch.active);
                if (iconBatch.active > 8) { iconBatch.active--; return null; }
                await new Promise(resolve => setTimeout(resolve, 10)); iconBatch.active--; iconBatch.completed++; return url;
            } });
            loader.hydrate(batch);
        }, url);
        await expect(page.locator('#icon-batch img')).toHaveCount(20);
        expect(await page.locator('#icon-batch img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
        expect(await page.evaluate(() => iconBatch.peak)).toBeLessThanOrEqual(4);
        await page.evaluate(async () => {
            const { createAppIconLoader } = await import('./ui/app-icons.js');
            let finish; const result = new Promise(resolve => { finish = resolve; });
            const node = document.createElement('span'); node.dataset.appIcon = 'late'; node.textContent = 'L'; iconTest.root.append(node);
            const loader = createAppIconLoader({ request: () => result }); loader.hydrate(iconTest.root); loader.stop();
            finish(iconTest.root.querySelector('img').src); await Promise.resolve();
        });
        await expect(page.locator('#icon-test [data-app-icon="late"]')).toHaveText('L');
    } finally {
        if (app) await app.close();
        harness.cleanup();
        await rm(profile, { recursive: true, force: true });
    }
});

test('application page resolves a known backend executable through the icon bridge',async()=>{
 const harness=await createHarness();let app;
 try{
  const env={...process.env,...harness.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:['.'],env});const page=await app.firstWindow();await expect(page.locator('.connection-title')).toBeVisible();
  const executable=await app.evaluate(()=>process.execPath);
  const result=await page.evaluate(async executable=>{
   await window.desktop.backend.request('setPaused',{paused:true});const r=await window.desktop.backend.request('backup');const backup=r.result.backup;
   backup.appRecords=[{networkId:backup.networks[0].key,date:new Date().toLocaleDateString('en-CA'),appId:executable,name:'Electron',rxBytes:'100',txBytes:'10'}];
   return window.desktop.backend.request('restore',{backup});
  },executable);expect(result.ok).toBe(true);
  await page.reload();await page.locator('.nav [data-page="apps"]').click();
  const icon=await page.evaluate(appId=>window.desktop.appIcons.get({appId}),executable);
  if(process.platform==='linux' && icon===null){
   await expect(page.locator('.app-row .app-avatar')).toHaveText('E');
   await expect(page.locator('.app-row .app-avatar img')).toHaveCount(0);
   await page.locator('[data-action="select-app"]').click();
   await expect(page.locator('#drawerTitle .app-avatar')).toHaveText('E');
   await expect(page.locator('#drawerTitle .app-avatar img')).toHaveCount(0);
   // 继续走真实 IPC 和后端路径查验，仅替换系统图标提取结果。
   await app.evaluate(({app,nativeImage})=>{
    app.getFileIcon=async()=>nativeImage.createFromBitmap(Buffer.from([0x40,0x80,0xc0,0xff]),{width:1,height:1});
   });
   await page.reload();
  }else expect(icon).toMatch(/^data:image\/png;base64,/);
  await expect(page.locator('.app-row .app-avatar img')).toBeVisible();
  expect(await page.locator('.app-row .app-avatar img').evaluate(image=>image.naturalWidth)).toBeGreaterThan(0);
  await page.locator('[data-action="select-app"]').click();await expect(page.locator('#drawerTitle .app-avatar img')).toBeVisible();
 }finally{if(app)await app.close();harness.cleanup();}
});
