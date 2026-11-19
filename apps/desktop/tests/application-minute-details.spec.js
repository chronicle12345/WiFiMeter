import { test, expect } from '@playwright/test';
import { desktop } from './support/browser-desktop.mjs';
import { createHarness } from './support/backend-harness.mjs';

const clientId = String.raw`C:\Apps\Browser.exe`, proxyId = String.raw`C:\Proxy\Proxy.exe`;
let app, page, harness, errors;

test.beforeEach(async () => {
    app = null; harness = null; errors = [];
    harness = await createHarness();
    app = await desktop.launch({ env: { ...process.env, ...harness.env, WIFIMETER_BACKGROUND_TEST: '1' } });
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
    await page.evaluate(() => window.desktop.backend.request('setPaused', { paused: true }));
    const { result: snapshot } = await page.evaluate(() => window.desktop.backend.request('snapshot'));
    const networkId = snapshot.networks[0].id;
    const slots = [['2020-01-01', '10:00'], ['2020-01-01', '10:01'], ['2020-01-01', '10:59'], ['2020-01-01', '11:00'],
        ['2020-01-01', '23:57'], ['2020-01-01', '23:58'], ['2020-01-01', '23:59'], ['2020-01-02', '12:00'],
        ['2020-01-03', '00:00'], ['2020-01-03', '00:01'], ['2020-01-03', '00:02']];
    snapshot.settings = { ...snapshot.settings, language: 'zh-CN', speedUnit: 'auto', unit: 'GB' };
    snapshot.appCollection = { available: true, enabled: true, state: 'running' };
    snapshot.live.collector = 'running';
    snapshot.appRecords = ['2020-01-01', '2020-01-02', '2020-01-03'].flatMap(date => [
        { networkId, date, appId: proxyId, name: 'Proxy Minute', rxBytes: '900000', txBytes: '400000' },
        { networkId, date, appId: clientId, name: 'Browser', rxBytes: '10', txBytes: '2' }
    ]);
    snapshot.proxyEstimatedRecords = snapshot.appRecords.filter(row => row.appId === proxyId).flatMap(row => [
        { ...row, appId: clientId, name: 'Browser', proxyAppId: proxyId, proxyName: 'Proxy Daily', rxBytes: '600000', txBytes: '300000', estimated: true },
        { ...row, appId: String.raw`C:\Apps\Other.exe`, name: 'Other', proxyAppId: proxyId, proxyName: 'Proxy Daily', rxBytes: '300000', txBytes: '100000', estimated: true }
    ]);
    snapshot.appMinuteRecords = slots.flatMap(([date, time]) => {
        const base = { networkId, date, time, hour: Number(time.slice(0, 2)), minute: Number(time.slice(3)) };
        return [{ ...base, appId: proxyId, name: 'Proxy Minute', rxBytes: '1000', txBytes: '400' },
            { ...base, appId: clientId, name: 'Browser', rxBytes: '10', txBytes: '2' }];
    });
    snapshot.proxyEstimatedMinuteRecords = snapshot.appMinuteRecords.filter(row => row.appId === proxyId).flatMap(row => [
        { ...row, appId: clientId, name: 'Browser', proxyAppId: proxyId, proxyName: 'Proxy Minute', rxBytes: '600', txBytes: '300', estimated: true },
        { ...row, appId: String.raw`C:\Apps\Other.exe`, name: 'Other', proxyAppId: proxyId, proxyName: 'Proxy Minute', rxBytes: '400', txBytes: '100', estimated: true }
    ]);
    snapshot.minuteRecords = slots.map(([date, time]) => ({ networkId, date, time, hour: Number(time.slice(0, 2)), minute: Number(time.slice(3)), rxBytes: '4000', txBytes: '1000' }));
    snapshot.proxy = { available: true, ports: [7890], processNames: ['proxy.exe'], status: 'ready', detail: '', clients: [
        { appId: clientId, name: 'Browser', proxyAppId: proxyId, proxyName: 'Proxy Minute', connections: 1, measurementAvailable: true, rxPerSecond: '50000', txPerSecond: '40000' },
        { appId: String.raw`C:\Apps\Other.exe`, name: 'Other', proxyAppId: proxyId, proxyName: 'Proxy Minute', connections: 3, measurementAvailable: false }
    ] };
    snapshot.live.proxy = snapshot.proxy;
    snapshot.appProcesses = [{ networkId, appId: clientId, name: 'Browser', scope: 'wifi', processId: 42, rxPerSecond: '7', txPerSecond: '5' },
        { networkId, appId: proxyId, name: 'Proxy Minute', scope: 'wifi', processId: 60, rxPerSecond: '9000', txPerSecond: '3000' }];
    await app.evaluate(({ ipcMain }, snapshot) => {
        globalThis.minuteDetailsFixture = { snapshot };
        ipcMain.removeHandler('backend:request');
        ipcMain.handle('backend:request', (_event, { method, params = {} }) => {
            const current = globalThis.minuteDetailsFixture.snapshot;
            if (method !== 'snapshot') return { ok: true, result: {} };
            const from = params.from || '0001-01-01', to = params.to || '9999-12-31';
            const selected = rows => rows.filter(row => row.date >= from && row.date <= to);
            const includeMinutes = params.includeMinutes === true || params.fromTime != null || params.toTime != null;
            return { ok: true, result: { ...current, range: { from, to },
                records: selected(current.records), appRecords: selected(current.appRecords), proxyEstimatedRecords: selected(current.proxyEstimatedRecords),
                minuteRecordsIncluded: includeMinutes, minuteRecords: includeMinutes ? selected(current.minuteRecords) : [],
                appMinuteRecords: includeMinutes ? selected(current.appMinuteRecords) : [],
                proxyEstimatedMinuteRecords: includeMinutes ? selected(current.proxyEstimatedMinuteRecords) : [] } };
        });
        ipcMain.removeHandler('app-control:request');
        ipcMain.handle('app-control:request', (_event, input) => ({ ok: true, result: { path: input.path, state: { Blocked: false, Throttled: false } } }));
    }, snapshot);
    await page.reload();
    await expect(page).toHaveTitle(/流量总览/);
});

test.afterEach(async () => {
    if (app) {
        await app.evaluate(({ app: fixtureApp, BrowserWindow }) => { fixtureApp.removeAllListeners('window-all-closed'); for (const window of BrowserWindow.getAllWindows()) window.destroy(); });
        await app.close();
    }
    harness?.cleanup();
    expect(errors).toEqual([]);
});

async function openHistory(grouping = 'minute') {
    await page.locator('.nav [data-page="apps"]').click();
    await page.getByRole('tab', { name: '应用用量记录', exact: true }).click();
    await page.locator('[data-action="period"][data-value="all"]').click();
    await expect(page.locator('.date-text')).toHaveText('全部已保留历史');
    await page.locator('#appGrouping').selectOption(grouping);
}

async function customRange(start, startTime, end, endTime) {
    await page.locator('[data-action="period"][data-value="custom"]').click();
    await page.locator('#rangeStart').fill(start); await page.locator('#rangeStartTime').fill(startTime);
    await page.locator('#rangeEnd').fill(end); await page.locator('#rangeEndTime').fill(endTime);
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
}

const history = () => page.locator('.proxy-history-estimates');
const estimatedRows = () => page.locator('#appListRegion tbody tr').filter({ has: page.locator('.application-source-badge.estimated') }).filter({ hasText: 'Browser' });

async function openEstimatedRow(date) {
    const row = date ? estimatedRows().filter({ has: page.locator('td:first-child', { hasText: date }) }) : estimatedRows();
    await row.locator('[data-action="select-app"], [data-action="select-app-row"]').click();
}

test('所选分钟代理明细显示同一分钟，实时 TCP 速度变化不改变历史字节 @application-minute-details', async () => {
    await openHistory();
    await page.locator('#appDataSource').selectOption('estimated');
    await openEstimatedRow('2020-01-01 10:01');
    await expect(history().locator('.proxy-detail-item')).toHaveCount(1);
    await expect(history()).toContainText('2020-01-01 10:01');
    await expect(history()).toContainText('600 B'); await expect(history()).toContainText('300 B');
    await expect(history()).not.toContainText('Proxy Daily');
    await expect(page.locator('.application-summary > .kv-grid')).toContainText('900 B');
    await expect(page.locator('.proxy-live-connections')).toContainText('50.0 KB/s');
    await app.evaluate(({ BrowserWindow }) => {
        const current = globalThis.minuteDetailsFixture.snapshot;
        current.proxy.clients[0].rxPerSecond = '70000';
        BrowserWindow.getAllWindows()[0].webContents.send('backend:event', { event: 'live', ...current.live, proxy: current.proxy, appCollection: current.appCollection, appProcesses: current.appProcesses });
    });
    await expect(page.locator('.proxy-live-connections')).toContainText('70.0 KB/s');
    await expect(history().locator('.proxy-detail-item')).toHaveCount(1);
    await expect(history()).toContainText('600 B'); await expect(history()).toContainText('300 B');
});

test('所选小时明细列出该小时的分钟估算并排除相邻小时 @application-minute-details', async () => {
    await openHistory('hour');
    await page.locator('#appDataSource').selectOption('estimated');
    await openEstimatedRow('2020-01-01 10:00');
    await expect(history().locator('.proxy-detail-item')).toHaveCount(3);
    for (const time of ['10:00', '10:01', '10:59']) await expect(history()).toContainText('2020-01-01 ' + time);
    await expect(history()).not.toContainText('2020-01-01 11:00');
    await expect(history()).not.toContainText('Proxy Daily');
    await expect(page.locator('.application-summary > .kv-grid')).toContainText('2.7 KB');
});

test('跨日部分时段的汇总与每日代理明细使用分钟估算并保留直接用量 @application-minute-details', async () => {
    await openHistory('summary');
    await customRange('2020-01-01', '23:58', '2020-01-03', '00:01');
    const nativeTotal = await page.locator('#appTotal').textContent();
    await page.locator('#appDataSource').selectOption('estimated');
    await expect(page.locator('#appTotal')).toHaveText(nativeTotal);
    await expect(page.locator('#appListRegion tbody tr').filter({ hasText: 'Browser' }).filter({ hasText: '原生记录' })).toContainText('60 B');
    await openEstimatedRow();
    await expect(history().locator('.proxy-detail-item')).toHaveCount(5);
    for (const timestamp of ['2020-01-01 23:58', '2020-01-01 23:59', '2020-01-02 12:00', '2020-01-03 00:00', '2020-01-03 00:01']) await expect(history()).toContainText(timestamp);
    await expect(history()).not.toContainText('2020-01-01 23:57'); await expect(history()).not.toContainText('2020-01-03 00:02');
    await expect(history()).not.toContainText('Proxy Daily');
    await expect(page.locator('.application-summary > .kv-grid')).toContainText('4.5 KB');
    await page.keyboard.press('Escape');
    await page.locator('#appGrouping').selectOption('day');
    await openEstimatedRow('2020-01-02');
    await expect(history().locator('.proxy-detail-item')).toHaveCount(1);
    await expect(history()).toContainText('2020-01-02 12:00');
});

test('分钟上传合计不匹配时保留原生代理记录，估算撤销后详情及时更新 @application-minute-details', async () => {
    await openHistory();
    await customRange('2020-01-01', '10:01', '2020-01-01', '10:01');
    const nativeTotal = await page.locator('#appTotal').textContent();
    await page.locator('#appDataSource').selectOption('estimated');
    await openEstimatedRow('2020-01-01 10:01');
    await expect(history().locator('.proxy-detail-item')).toHaveCount(1);
    await app.evaluate(({ BrowserWindow }) => {
        const current = globalThis.minuteDetailsFixture.snapshot;
        const records = current.proxyEstimatedMinuteRecords.filter(row => row.date === '2020-01-01' && row.time === '10:01').map(row => ({ ...row, txBytes: row.name === 'Browser' ? '301' : row.txBytes }));
        BrowserWindow.getAllWindows()[0].webContents.send('backend:event', { event: 'live', ...current.live, proxy: current.proxy, appCollection: current.appCollection,
            proxyEstimatedMinuteUpdates: [{ networkId: records[0].networkId, date: '2020-01-01', time: '10:01', proxyAppId: records[0].proxyAppId, records }] });
    });
    await expect(history()).toHaveCount(0);
    await expect(page.locator('.application-summary')).toContainText('所选时段没有应用记录');
    await page.keyboard.press('Escape');
    await expect(page.locator('#appTotal')).toHaveText(nativeTotal);
    await expect(page.locator('#appListRegion tbody tr').filter({ hasText: 'Proxy Minute' })).toContainText('1.4 KB');
    await expect(estimatedRows()).toHaveCount(0);
});
