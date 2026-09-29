// 打包产物检查：确认 .deb 与解包目录里都带上了采集后端，并且打包后的应用真的能把它跑起来。
//
// 与 desktop.spec.js 不同，这里不注入假网卡数据：用真实系统状态验证“随包分发的后端
// 能被主进程找到并启动”，这是打包才可能出问题的地方。

import { test, expect, _electron as electron } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const unpacked = path.join(repositoryRoot, 'dist/linux/linux-unpacked');
const packagedBinary = path.join(unpacked, 'wifimeter');
const bundledBackend = path.join(unpacked, 'resources/wifimeter-backend');
const deb = path.join(repositoryRoot, 'dist/linux/WiFiMeter-0.1.0-linux-amd64.deb');

test.describe('打包产物', () => {
    test.skip(!existsSync(packagedBinary), '未构建 Linux 产物，先运行 npm run dist:linux');

    test('deb 与解包目录都包含后端可执行文件', () => {
        expect(existsSync(bundledBackend)).toBe(true);
        // 随包的后端必须能独立运行并自报版本。
        const version = execFileSync(bundledBackend, ['--version'], { encoding: 'utf8' });
        expect(version).toContain('wifimeter-backend');
        expect(version).toContain('协议版本 1');

        if (existsSync(deb)) {
            const contents = execFileSync('dpkg-deb', ['-c', deb], { encoding: 'utf8' });
            expect(contents).toContain('resources/wifimeter-backend');
            // 后端链接系统 SQLite，deb 必须声明这个依赖。
            const control = execFileSync('dpkg-deb', ['-f', deb, 'Depends'], { encoding: 'utf8' });
            expect(control).toContain('libsqlite3-0');
        }
    });

    test('打包后的应用能自己启动后端并展示采集状态', async () => {
        const profile = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-packaged-'));
        const env = { ...process.env, WIFIMETER_USER_DATA: profile };
        // 不设置 WIFIMETER_BACKEND：必须由应用自己找到 resources/wifimeter-backend。
        delete env.WIFIMETER_BACKEND;
        delete env.ELECTRON_RUN_AS_NODE;

        const app = await electron.launch({ executablePath: packagedBinary, args: [], env });
        try {
            const page = await app.firstWindow();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await expect(page.locator('h1')).toHaveText('流量总览', { timeout: 30000 });

            // 采集器处于运行状态，说明后端已经起来并通过了协议握手。
            await expect(page.locator('#collector')).toContainText('正在采集', { timeout: 30000 });
            await expect(page.locator('#footer')).toContainText('本机采集');
            // 采集状态弹窗能列出真实网卡状态（这台机器上可能没有已关联的网卡）。
            await page.getByRole('button', { name: '采集状态' }).click();
            await expect(page.locator('.modal')).toContainText('采集器：运行中');
            expect(errors).toEqual([]);

            // 后端在用户数据目录里创建了数据库。
            await expect.poll(() => existsSync(path.join(profile, 'wifimeter.db')), { timeout: 20000 }).toBe(true);
        } finally {
            await app.close();
            await rm(profile, { recursive: true, force: true });
        }
    });
});
