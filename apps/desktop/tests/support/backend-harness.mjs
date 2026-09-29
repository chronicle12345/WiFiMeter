// UI 测试用的后端夹具。
//
// 用真实的 wifimeter-backend 可执行文件，配上假的 nmcli 与假的 /proc/net/dev，
// 因此测试既确定又不脱离真实实现：进程、协议、SQLite 与页面全都是真的，
// 只有“网卡报什么”是假的。

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(here, '../../../..');
export const backendBinary = path.join(repositoryRoot, 'build', 'app', 'wifimeter-backend');

// 假的 nmcli：固定报告 wlan0 已关联到 Habitat_5G。
const FAKE_NMCLI = `#!/bin/sh
case "$*" in
  *"dev show"*)
    printf 'GENERAL.DEVICE:wlan0\\nGENERAL.TYPE:wifi\\nGENERAL.STATE:100 (connected)\\nGENERAL.CONNECTION:Habitat_5G\\nGENERAL.CON-UUID:21f995e7-fe3b-41a1-ae3a-6468c6918397\\nGENERAL.VENDOR:AICSemi\\nGENERAL.PRODUCT:AIC8800DC\\n\\n'
    ;;
  *"802-11-wireless.ssid"*) printf '802-11-wireless.ssid:Habitat_5G\\n' ;;
  *"dev wifi list"*) printf '*:Habitat_5G:82:5180 MHz\\n' ;;
  *"dev disconnect"*) printf 'Device %s successfully disconnected.\\n' "$4" ;;
  *) exit 1 ;;
esac
exit 0
`;

function counters(rx, tx) {
    return `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
wlan0: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0
`;
}

// 与后端对话的最小客户端：按行写请求，按行读响应（事件直接忽略）。
function createSession(executable, databasePath, nmcliPath, procPath) {
    const child = spawn(executable, ['--db', databasePath, '--nmcli', nmcliPath, '--proc-net-dev', procPath], { stdio: ['pipe', 'pipe', 'ignore'] });
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
    const nmcliPath = path.join(directory, 'fake-nmcli');
    const procPath = path.join(directory, 'fake-dev');
    const databasePath = path.join(directory, 'wifimeter.db');
    const wrapperPath = path.join(directory, 'backend-wrapper');

    writeFileSync(nmcliPath, FAKE_NMCLI);
    chmodSync(nmcliPath, 0o755);
    writeFileSync(procPath, counters(5000000, 900000));

    // 用两次采样造出一条真实记录：第一次建立基线，第二次产生增量。
    const session = createSession(backendBinary, databasePath, nmcliPath, procPath);
    await session.request('collectNow');
    writeFileSync(procPath, counters(5000000 + rxStep, 900000 + txStep));
    await session.request('collectNow');
    await session.request('updateNetwork', { key: '21f995e7-fe3b-41a1-ae3a-6468c6918397', alias: '家里的 Wi-Fi', capGb: 5, warnPercent: 80, quotaPeriod: 'month', notify: true });
    await session.close();

    // 应用由主进程拉起后端；包一层脚本注入假网卡数据，并让 --db 指到播种好的库。
    writeFileSync(wrapperPath, `#!/bin/sh\nexec "${backendBinary}" --nmcli "${nmcliPath}" --proc-net-dev "${procPath}" "$@" --db "${databasePath}"\n`);
    chmodSync(wrapperPath, 0o755);

    return {
        directory,
        databasePath,
        procPath,
        nmcliPath,
        seedRx: rxStep,
        seedTx: txStep,
        env: { WIFIMETER_BACKEND: wrapperPath },
        // 让采集器按秒级间隔工作，测试不必等太久。
        slowDownCounters(rx, tx) {
            writeFileSync(procPath, counters(rx, tx));
        },
        cleanup() {
            rmSync(directory, { recursive: true, force: true });
        },
    };
}
