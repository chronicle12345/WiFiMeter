'use strict';

// 验证打包后的主进程自行查找 resources 后端，不依赖界面默认语言。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const { assertElectronRuntime } = require('./ci.cjs');
const { _electron: electron } = require(require.resolve('@playwright/test', { paths: [path.join(root, 'apps/desktop')] }));

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'wifimeter-ci-discovery-'));
    let app;
    try {
        const env = { ...process.env, WIFIMETER_TEST_ISOLATION: '1', WIFIMETER_USER_DATA: profile };
        for (const key of ['WIFIMETER_BACKEND', 'WIFIMETER_FAKE_ADAPTER', 'WIFIMETER_FAKE_COUNTERS', 'WIFIMETER_FAKE_APPS', 'ELECTRON_RUN_AS_NODE']) delete env[key];
        const executablePath = path.join(process.env.UNPACKED_DIR, process.platform === 'win32' ? 'WiFiMeter.exe' : 'wifimeter');
        app = await electron.launch({ executablePath, args: [], env, timeout: 60000 });
        assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
        const runtime = await app.evaluate(() => ({ platform: process.platform, arch: process.arch, electron: process.versions.electron }));
        assertElectronRuntime(runtime, process.platform, process.env.WIFIMETER_PACKAGE_ARCH);
        console.log(`Packaged Electron ${runtime.electron} / ${runtime.platform}-${runtime.arch}`);
        const page = await app.firstWindow();
        await page.waitForFunction(() => Boolean(window.desktop?.backend), undefined, { timeout: 30000 });
        const hello = await page.evaluate(() => window.desktop.backend.request('hello'));
        assert.equal(hello.ok, true);
        assert.equal(hello.result.application, 'wifimeter-backend');
        assert.equal(hello.result.protocol, 1);
        console.log('Packaged backend discovery and IPC handshake passed');
    } finally {
        if (app) await app.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
