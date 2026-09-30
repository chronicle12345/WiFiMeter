// UI 测试用的后端夹具。
//
// 用真实的 wifimeter-backend 可执行文件，配上两端共用的 JSON 网卡与计数夹具，
// 因此测试既确定又不脱离真实实现：进程、协议、SQLite 与页面全都是真的，
// 只有“网卡报什么”是假的。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveExecutable } from '../../electron/backend.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(here, '../../../..');
export const backendBinary = resolveExecutable({ repositoryRoot });

function counters(rx, tx) {
    return JSON.stringify({ interfaces: [{ name: 'wlan0', rx, tx }] });
}

// 与后端对话的最小客户端：按行写请求，按行读响应（事件直接忽略）。
function createSession(executable, databasePath, adapterPath, countersPath) {
    const child = spawn(executable, ['--db', databasePath, '--fake-adapter', adapterPath, '--fake-counters', countersPath], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    const waiters = new Map();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
            if (!line) continue;
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                continue;
            }
            const waiter = waiters.get(message.id);
            if (waiter) {
                waiters.delete(message.id);
                waiter(message);
            }
        }
    });

    let nextId = 1;
    const request = (method, params = {}) => new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`后端没有响应 ${method}`)), 20000);
        waiters.set(id, message => {
            clearTimeout(timer);
            if (message.ok) resolve(message.result ?? {});
            else reject(new Error(message.error?.message ?? '后端返回失败'));
        });
        child.stdin.write(`${JSON.stringify({ id, protocol: 1, method, params })}\n`);
    });

    return {
        request,
        async close() {
            try {
                await request('shutdown');
            } catch {
                // 后端可能已经退出
            }
            child.stdin.end();
            await new Promise(resolve => child.once('exit', resolve));
        },
        child,
    };
}

/**
 * 准备一个已经播种数据的环境。
 * 返回的对象里 env 供 Playwright 启动应用时使用，清理用 cleanup()。
 */
// 默认造出 3.60 GB（3.1 GB 下载 + 0.5 GB 上传）的用量，量级贴近真实使用。
export async function createHarness({ rxStep = 3100000000, txStep = 500000000 } = {}) {
    if (!existsSync(backendBinary)) throw new Error(`未找到后端可执行文件：${backendBinary}，请先构建后端。`);

    const directory = mkdtempSync(path.join(os.tmpdir(), 'wifimeter-ui-'));
    const adapterPath = path.join(directory, 'adapters.json');
    const countersPath = path.join(directory, 'counters.json');
    const databasePath = path.join(directory, 'wifimeter.db');
    const appsPath = path.join(directory, 'apps.json');
    const appCounters = (rx, tx) => writeFileSync(appsPath, JSON.stringify({ state: 'running', generation: 'one', samples: [{
        interfaceId: 'wlan0', appId: '/opt/browser', name: '浏览器', processId: 42, instanceId: '42:100', rxBytes: String(rx), txBytes: String(tx)
    }] }));
    appCounters(0, 0);
    writeFileSync(adapterPath, JSON.stringify({ adapters: [{
        name: 'wlan0', description: 'AICSemi AIC8800DC', connected: true,
        mode: 1, profile: 'Habitat_5G', ssid: 'Habitat_5G', signal: 82, frequency: 5180
    }] }));
    writeFileSync(countersPath, counters(5000000, 900000));

    // 用两次采样造出一条真实记录：第一次建立基线，第二次产生增量。
    const session = createSession(backendBinary, databasePath, adapterPath, countersPath);
    await session.request('collectNow');
    writeFileSync(countersPath, counters(5000000 + rxStep, 900000 + txStep));
    await session.request('collectNow');
    const snapshot = await session.request('snapshot');
    await session.request('updateNetwork', { key: snapshot.networks[0].id, alias: '家里的 Wi-Fi', capGb: 5, warnPercent: 80, quotaPeriod: 'month', notify: true });
    await session.close();

    return {
        directory,
        databasePath,
        countersPath,
        adapterPath,
        appsPath,
        appCounters,
        seedRx: rxStep,
        seedTx: txStep,
        env: {
            WIFIMETER_BACKEND: backendBinary,
            WIFIMETER_USER_DATA: directory,
            WIFIMETER_FAKE_ADAPTER: adapterPath,
            WIFIMETER_FAKE_COUNTERS: countersPath,
            WIFIMETER_FAKE_APPS: appsPath
        },
        // 让采集器按秒级间隔工作，测试不必等太久。
        slowDownCounters(rx, tx) {
            writeFileSync(countersPath, counters(rx, tx));
        },
        cleanup() {
            rmSync(directory, { recursive: true, force: true });
        },
    };
}
