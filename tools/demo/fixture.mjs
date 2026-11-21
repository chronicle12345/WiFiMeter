import { generateDemo } from '../../apps/desktop/tests/fixtures/snapshot.js';

export const DEMO_TIME = '2026-11-21T12:00:00+08:00';

export function createDemoFixture(language = 'zh-CN') {
    if (!['zh-CN', 'en'].includes(language)) throw Error('Unsupported demo language');
    const snapshot = generateDemo(new Date(2026, 10, 21, 12));
    snapshot.settings.language = language;
    snapshot.live.updatedAt = DEMO_TIME;
    snapshot.live.connections[0].since = '2026-11-21T10:45:00+08:00';
    snapshot.live.skippedIntervals = 0;
    const aliases = language === 'en'
        ? ['Home Wi-Fi', 'Studio', 'Phone hotspot', 'Coffee shop']
        : ['家里的 Wi-Fi', '工作室', '手机热点', '咖啡店'];
    snapshot.networks.forEach((network, index) => { network.alias = aliases[index]; });
    snapshot.totalQuota = { capGb: 100, warnPercent: 80, period: 'month', notify: true,
        autoDisconnect: false, usedBytes: '74550000000', periodKey: '2026-11' };
    snapshot.appCollection = { available: true, enabled: true, state: 'running' };
    snapshot.proxy = { available: true, status: 'ready', ports: [], processNames: [], clients: [] };
    snapshot.appGaps = [];
    snapshot.gaps = [];
    snapshot.proxyEstimatedRecords = [];
    snapshot.proxyEstimatedMinuteRecords = [];
    snapshot.appProcesses = [
        ['firefox', 'Firefox', 3600000, 220000],
        ['syncthing', 'Syncthing', 240000, 680000],
        ['code', 'Visual Studio Code', 380000, 48000],
        ['system', language === 'en' ? 'System services' : '系统服务', 60000, 18000]
    ].map(([appId, name, rx, tx], index) => ({ appId, name, processId: 2000 + index,
        networkId: 'home', scope: 'wifi', measurementAvailable: true,
        rxPerSecond: String(rx), txPerSecond: String(tx) }));
    if (language === 'en') {
        for (const row of snapshot.appRecords) {
            if (row.appId === 'system') row.name = 'System services';
            if (row.appId === 'unattributed') row.name = 'Unattributed traffic';
        }
    }
    return { snapshot, preferences: { theme: 'light', promptAppCollection: false,
        closeAction: 'tray', miniWindow: false, miniShape: 'rectangle', miniPalette: 'blue',
        miniPinned: true, miniAutoHide: false, miniExcludeProxy: false } };
}
