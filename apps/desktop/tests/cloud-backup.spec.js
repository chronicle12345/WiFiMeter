// 云备份端到端：真实后端 + 本地内存 WebDAV 服务。
import { test, expect } from '@playwright/test';
import { desktop } from './support/browser-desktop.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { createHarness } from './support/backend-harness.mjs';

let app, page, profile, harness, server, files, requests;

// Just enough WebDAV for one collection: MKCOL, PROPFIND, PUT, GET and DELETE with Basic authentication.
function startWebdav() {
    files = new Map(); requests = [];
    server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const name = decodeURIComponent(request.url.replace(/^\/dav\//, ''));
            requests.push(`${request.method} ${name}`);
            if (request.headers.authorization !== 'Basic ' + Buffer.from('me:secret').toString('base64')) { response.writeHead(401).end(); return; }
            if (request.method === 'MKCOL') response.writeHead(405).end();
            else if (request.method === 'PUT') { files.set(name, Buffer.concat(chunks)); response.writeHead(201).end(); }
            else if (request.method === 'GET') files.has(name) ? response.writeHead(200).end(files.get(name)) : response.writeHead(404).end();
            else if (request.method === 'DELETE') { files.delete(name); response.writeHead(204).end(); }
            else if (request.method === 'PROPFIND') {
                const rows = [...files].map(([file, bytes]) => `<D:response><D:href>/dav/${encodeURIComponent(file)}</D:href><D:propstat><D:prop><D:getcontentlength>${bytes.length}</D:getcontentlength></D:prop></D:propstat></D:response>`);
                response.writeHead(207, { 'Content-Type': 'application/xml' }).end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>${rows.join('')}</D:multistatus>`);
            } else response.writeHead(405).end();
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/dav`)));
}

test.beforeEach(async () => {
    profile = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-cloud-'));
    harness = await createHarness();
    app = await desktop.launch({ env: { ...process.env, WIFIMETER_BACKGROUND_TEST: '1', WIFIMETER_USER_DATA: profile, ...harness.env } });
    page = await app.firstWindow();
    await expect(page.locator('.connection-title')).not.toHaveText('等待本机采集器');
});
test.afterEach(async () => {
    if (app) await app.close();
    harness?.cleanup();
    await new Promise(resolve => (server ? server.close(resolve) : resolve()));
    server = null;
    if (profile) await rm(profile, { recursive: true, force: true });
});

test('云备份保存设置、按所选内容备份、列出、恢复并删除远端备份', async ({}, testInfo) => {
    const url = await startWebdav();
    await page.locator('.nav [data-page="settings"]').click();
    await page.locator('[data-category="cloud"]').click();
    const form = page.locator('#cloudBackupForm'), status = page.locator('.cloud-status');
    await expect(form.locator('[name="sections"]:checked')).toHaveCount(4);
    await page.locator('[data-action="cloud-backup"]').click();
    await expect(form.locator('.form-error')).toContainText('请先填写 WebDAV 地址');

    await form.locator('#cloudUrl').fill(url);
    await form.locator('#cloudUser').fill('me');
    await form.locator('#cloudPassword').fill('wrong');
    await page.locator('[data-action="cloud-test"]').click();
    await expect(form.locator('.form-error')).toContainText('用户名或密码不正确');
    await expect(form.locator('#cloudUrl')).toHaveValue(url);

    await form.locator('#cloudPassword').fill('secret');
    await form.locator('[name="sections"][value="apps"]').uncheck();
    await form.locator('[name="sections"][value="logs"]').check();
    await form.locator('#cloudDays').selectOption('30');
    await expect(page.locator('#content button[type="submit"]')).toHaveCount(0);
    await expect(status).toContainText('云备份设置已保存');
    await expect(form.locator('#cloudPassword')).toHaveValue('');
    await expect(form.locator('#cloudPassword')).toHaveAttribute('placeholder', /已保存/);
    await page.screenshot({ path: testInfo.outputPath('cloud-backup.png'), fullPage: true });

    await page.locator('[data-action="cloud-test"]').click();
    await expect(status).toContainText('连接成功，远端有 0 份备份');
    await page.locator('[data-action="cloud-estimate"]').click();
    await expect(status).toContainText('预计上传');
    expect(files.size).toBe(0);
    await page.locator('[data-action="cloud-backup"]').click();
    await expect(status).toContainText('已备份');
    expect(files.size).toBe(1);
    const [[name, bytes]] = [...files];
    const document = JSON.parse(zlib.gunzipSync(bytes).toString());
    expect(name).toMatch(/^wifimeter_.+_\d{8}T\d{6}Z\.json\.gz$/);
    expect(document.backupType).toBe('wifimeter-cloud-backup');
    expect(document.sections).toEqual(['settings', 'networks', 'daily', 'logs']);
    expect(document.appRecords).toBeUndefined();
    expect(document.networks.length).toBeGreaterThan(0);
    expect(document.logs).toContain('[app]');
    expect(JSON.stringify(document)).not.toContain('secret');

    await page.locator('[data-action="cloud-list"]').click();
    const row = page.locator('.cloud-files li');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('本机');
    await row.locator('[data-action="cloud-restore"]').click();
    await page.locator('.modal [data-action="confirm"]').click();
    await expect(page.locator('.toast').last()).toContainText('已恢复备份，采集已暂停。');
    await expect(page.locator('.sidebar')).toContainText('统计已暂停');

    await page.locator('.nav [data-page="settings"]').click();
    await page.locator('[data-category="cloud"]').click();
    await page.locator('[data-action="cloud-list"]').click();
    await page.locator('.cloud-files [data-action="cloud-remove"]').click();
    await page.locator('.modal [data-action="confirm"]').click();
    await expect(page.locator('#cloudFilesRegion')).toContainText('远端还没有备份');
    expect(files.size).toBe(0);
    expect(requests.filter(line => line.startsWith('GET ')).length).toBe(1);

    await page.locator('.nav [data-page="logs"]').click();
    await expect(page.locator('.log-table')).toContainText('已上传云备份');
    await expect(page.locator('.log-table')).toContainText('恢复');
});
