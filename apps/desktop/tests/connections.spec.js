import { test, expect } from '@playwright/test';
import { desktop } from './support/browser-desktop.mjs';
import { createHarness } from './support/backend-harness.mjs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

let app, page, harness, controller;
const secret = 'synthetic-controller-secret';

async function createController() {
    const started = new Date(Date.now() - 1000).toISOString();
    const fixture = { failed: false, polls: 0, requests: [], rows: [
        { id: 'proxied', metadata: { host: 'cdn.example.test', destinationIP: '192.0.2.10', destinationPort: '443', sourceIP: '127.0.0.1', sourcePort: '42001', network: 'tcp', type: 'Mixed', process: 'browser.exe', processPath: 'C:/Apps/browser.exe' }, chains: ['node-alpha', 'ProxyGroup'], rule: 'DomainSuffix', rulePayload: 'example.test', download: '__RAW_COUNTER__', upload: 1200, start: started },
        { id: 'direct', metadata: { host: 'updates.example.test', destinationIP: '192.0.2.20', destinationPort: '443', network: 'tcp', process: 'updater.exe', processPath: 'C:/Apps/updater.exe' }, chains: ['DIRECT'], rule: 'Domain', rulePayload: 'updates.example.test', download: 1500, upload: 100, start: started },
        { id: 'unknown', metadata: { destinationIP: '192.0.2.30', destinationPort: '853', network: 'udp' }, chains: ['MysteryGroup'], rule: 'Match', rulePayload: '', download: 500, upload: 25, start: started }
    ] };
    const server = http.createServer((request, response) => {
        fixture.requests.push({ path: request.url, authorization: request.headers.authorization });
        if (request.headers.authorization !== 'Bearer ' + secret) { response.writeHead(401).end(); return; }
        if (fixture.failed) { response.writeHead(503).end(); return; }
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/proxies') {
            response.end(JSON.stringify({ proxies: { 'node-alpha': { type: 'Shadowsocks' }, ProxyGroup: { type: 'Selector' }, DIRECT: { type: 'Direct' }, MysteryGroup: { type: 'Selector' } } }));
        } else if (request.url === '/connections') {
            fixture.polls++;
            const rows = fixture.rows.map(row => ({ ...row, upload: row.upload + fixture.polls * 17 }));
            const raw = String(9007199254740993n + BigInt(fixture.polls) * 1000n);
            response.end(JSON.stringify({ connections: rows }).replaceAll('"__RAW_COUNTER__"', raw));
        } else response.writeHead(404).end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { ...fixture, url: `http://127.0.0.1:${server.address().port}`, fixture,
        close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

async function launch() {
    app = await desktop.launch({ env: { ...process.env, ...harness.env, WIFIMETER_BACKGROUND_TEST: '1' } });
    page = await app.firstWindow();
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
}

async function configureMonitor() {
    await page.locator('.nav [data-page="settings"]').click();
    await page.locator('[data-category="proxy"]').click();
    const form = page.locator('#connectionMonitorForm');
    await expect(form).toBeVisible();
    await form.locator('[name="controllerUrl"]').fill(controller.url);
    await form.locator('[name="secret"]').fill(secret);
    await form.locator('[name="intervalMs"]').fill('250');
    await form.locator('[name="enabled"]').check();
    await form.locator('[type="submit"]').click();
    await expect.poll(() => page.evaluate(() => window.desktop.connections.status())).toMatchObject({ enabled: true, hasSecret: true, state: 'connected' });
    await expect(form.locator('[name="secret"]')).toHaveValue('');
    return form;
}

test.beforeEach(async () => {
    app = null; controller = await createController(); harness = await createHarness(); await launch();
});
test.afterEach(async () => {
    if (app) await app.close();
    await controller?.close(); harness?.cleanup(); app = null;
});

test('connection monitor configures securely, filters new applications, shows routes and exports exact raw counters', async ({}, testInfo) => {
    const form = await configureMonitor();
    await expect(form.locator('[name="secret"]')).toHaveAttribute('placeholder', /已保存/);
    expect(await page.evaluate(() => window.desktop.connections.status())).not.toHaveProperty('secret');
    expect(controller.fixture.requests.every(request => request.authorization === 'Bearer ' + secret)).toBe(true);
    await page.locator('.nav [data-page="connections"]').click();
    await expect(page.locator('tr[data-connection-id]')).toHaveCount(3);
    await expect(page.locator('#connectionApplication option').filter({ hasText: 'browser.exe' })).toHaveCount(1);
    await expect(page.locator('[data-connection-id="proxied"] [data-route="proxy"]')).toHaveText('代理');
    await expect(page.locator('[data-connection-id="direct"] [data-route="direct"]')).toHaveText('直连');
    await expect(page.locator('[data-connection-id="unknown"] [data-route="unknown"]')).toHaveText('未知');
    await page.locator('#connectionSearch').fill('cdn.example');
    await expect(page.locator('tr[data-connection-id]')).toHaveCount(1);
    await page.locator('[data-action="connection-detail"]').click();
    await expect(page.locator('.drawer-content')).toContainText('node-alpha → ProxyGroup');
    await expect(page.locator('.drawer-content')).toContainText('DomainSuffix · example.test');
    await expect(page.locator('.drawer-content')).toContainText('192.0.2.10:443');
    await page.locator('#closeDrawer').click();
    await page.locator('#connectionSearch').fill('');
    controller.fixture.rows.push({ id: 'new-client', metadata: { host: 'api.example.test', destinationIP: '192.0.2.40', destinationPort: '443', network: 'tcp', process: 'curl.exe', processPath: 'C:/Apps/curl.exe' }, chains: ['DIRECT'], rule: 'Match', upload: 10, download: 100, start: new Date().toISOString() });
    await expect(page.locator('#connectionApplication option').filter({ hasText: 'curl.exe' })).toHaveCount(1);
    await page.locator('#connectionApplication').selectOption({ label: 'curl.exe' });
    await expect(page.locator('tr[data-connection-id]')).toHaveCount(1);
    await expect(page.locator('tr[data-connection-id]')).toHaveAttribute('data-connection-id', 'new-client');
    await page.locator('#connectionApplication').selectOption('all');
    await page.locator('#connectionRoute').selectOption('direct');
    await expect(page.locator('tr[data-connection-id]')).toHaveCount(2);
    await page.locator('#connectionRoute').selectOption('all');
    await expect(page.locator('tr[data-connection-id]')).toHaveCount(4);
    const file = path.join(harness.directory, 'observed-connections.csv');
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file);
    await page.locator('[data-action="connection-export"]').click();
    await expect.poll(async () => { try { return await readFile(file, 'utf8'); } catch { return ''; } }).toContain('cdn.example.test');
    const csv = await readFile(file, 'utf8');
    const counters = [...csv.matchAll(/"(90071992547\d+)"/g)].map(match => BigInt(match[1]));
    expect(counters.length).toBeGreaterThan(0);
    expect(counters[0] % 1000n).toBe(993n);
    expect(csv).not.toContain(secret);
    await page.screenshot({ path: testInfo.outputPath('connections.png'), fullPage: true });
});

test('status updates preserve configuration drafts and controller failures mark observations interrupted', async () => {
    await configureMonitor();
    const form = page.locator('#connectionMonitorForm');
    await form.locator('[name="controllerUrl"]').fill('http://127.0.0.1:12345');
    await form.locator('[name="secret"]').fill('unsaved-draft-secret');
    const before = controller.fixture.polls;
    await expect.poll(() => controller.fixture.polls).toBeGreaterThan(before + 1);
    await expect(form.locator('[name="controllerUrl"]')).toHaveValue('http://127.0.0.1:12345');
    await expect(form.locator('[name="secret"]')).toHaveValue('unsaved-draft-secret');
    await page.locator('.nav [data-page="connections"]').click();
    await expect(page.locator('tr[data-connection-id]')).toHaveCount(3);
    controller.fixture.failed = true;
    await expect(page.locator('.connection-monitor-error')).not.toHaveText('');
    await expect(page.locator('[data-connection-id="proxied"]')).toContainText('观测已中断');
    await expect(page.locator('[data-connection-id="proxied"]')).not.toContainText('已结束');
    await page.locator('[data-connection-id="proxied"] [data-action="connection-detail"]').click();
    await expect(page.locator('.drawer-content')).toContainText('控制连接中断');
    await expect(page.locator('.drawer-content')).toContainText('观测结束时间');
});

test('same-name applications remain distinguishable and active-filtered details follow a connection closure', async () => {
    await configureMonitor();
    controller.fixture.rows.push({
        id: 'another-browser', metadata: { host: 'second.example.test', destinationIP: '192.0.2.50',
            destinationPort: '443', network: 'tcp', process: 'browser.exe', processPath: 'C:/OtherApps/browser.exe' },
        chains: ['DIRECT'], rule: 'Match', upload: 10, download: 100, start: new Date().toISOString()
    });
    await page.locator('.nav [data-page="connections"]').click();
    await expect(page.locator('tr[data-connection-id]')).toHaveCount(4);
    const browserOptions = page.locator('#connectionApplication option').filter({ hasText: 'browser.exe' });
    await expect(browserOptions).toHaveCount(2);
    await expect(browserOptions.filter({ hasText: 'C:/Apps/browser.exe' })).toHaveCount(1);
    await expect(browserOptions.filter({ hasText: 'C:/OtherApps/browser.exe' })).toHaveCount(1);
    await page.locator('#connectionApplication').selectOption('c:\\apps\\browser.exe');
    await page.locator('#connectionState').selectOption('active');
    await expect(page.locator('tr[data-connection-id]')).toHaveCount(1);
    await page.locator('[data-connection-id="proxied"] [data-action="connection-detail"]').click();
    controller.fixture.rows = controller.fixture.rows.filter(row => row.id !== 'proxied');
    await expect(page.locator('tr[data-connection-id]')).toHaveCount(0);
    await expect(page.locator('.drawer-content')).toContainText('连接已关闭');
    await expect(page.locator('.drawer-content')).toContainText('已结束');
    await expect(page.locator('.drawer-content')).toContainText('观测结束时间');
    await expect(page.locator('#connectionApplication option:checked')).toContainText('browser.exe');
});

test('connection list, details and configuration translate all product text into English', async ({}, testInfo) => {
    await configureMonitor();
    await page.evaluate(() => window.desktop.backend.request('updateSettings', { settings: { language: 'en' } }));
    await page.reload();
    await page.locator('.nav [data-page="connections"]').click();
    await expect(page.locator('tr[data-connection-id]')).toHaveCount(3);
    await expect(page.locator('.connections-panel')).not.toContainText(/[\u3400-\u9fff]/);
    await page.locator('[data-connection-id="proxied"] [data-action="connection-detail"]').click();
    await expect(page.locator('.drawer-content')).not.toContainText(/[\u3400-\u9fff]/);
    await page.locator('#closeDrawer').click();
    await page.locator('[data-action="connection-settings"]').click();
    await expect(page.locator('.connection-settings')).not.toContainText(/[\u3400-\u9fff]/);
    const strings = await page.locator('.connection-settings [aria-label],.connection-settings [placeholder]').evaluateAll(elements => elements.map(element => [element.getAttribute('aria-label'), element.getAttribute('placeholder')].filter(Boolean).join(' ')).join(' '));
    expect(strings).not.toMatch(/[\u3400-\u9fff]/);
    await expect(page.locator('#connectionSecret')).toHaveValue('');
    await page.screenshot({ path: testInfo.outputPath('connections-settings-en.png'), fullPage: true });
});

test('recent traffic opens clearly dated daily application history and links that application to its observed domains', async () => {
    await configureMonitor();
    const response = await page.evaluate(async () => {
        await window.desktop.backend.request('setPaused', { paused: true });
        const { result } = await window.desktop.backend.request('backup'), backup = result.backup;
        const now = new Date(), date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
        backup.appRecords = [{ networkId: backup.networks[0].key, date, appId: 'C:/Apps/browser.exe', name: 'browser.exe', rxBytes: '4000000', txBytes: '1000000' }];
        backup.appMinuteRecords = [];
        return window.desktop.backend.request('restore', { backup });
    });
    expect(response.ok).toBe(true);
    await page.reload();
    await page.locator('.nav [data-page="overview"]').click();
    await page.locator('[data-action="period"][data-value="recent"]').click();
    await expect(page.locator('#recentMetricsRegion')).toBeVisible();
    await page.locator('.connection-right [data-action="detail"]').click();
    await expect(page.locator('.drawer-content')).toContainText('今日');
    await expect(page.locator('.drawer-content')).not.toContainText('最近 5 分钟');
    await expect(page.locator('[data-action="period"][data-value="today"]')).toHaveClass(/active/);
    await page.getByRole('tab', { name: '应用分布', exact: true }).click();
    await expect(page.getByRole('tab', { name: '应用用量记录', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.application-table')).toContainText('browser.exe');
    await expect(page.locator('.application-table')).toContainText('5 MB');
    await page.locator('.application-name[data-app-id="C:/Apps/browser.exe"]').click();
    await expect(page.locator('.application-summary')).toContainText('5 MB');
    await expect(page.locator('.drawer-content')).not.toContainText('最近 5 分钟');
    await page.locator('[data-action="application-connections"]').click();
    await expect(page.locator('.connections-panel')).toBeVisible();
    await expect(page.locator('tr[data-connection-id]')).toHaveCount(1);
    await expect(page.locator('tr[data-connection-id]')).toHaveAttribute('data-connection-id', 'proxied');
    await expect(page.locator('#connectionApplication option:checked')).toHaveText('browser.exe');
});
