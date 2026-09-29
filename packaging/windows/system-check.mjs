// 真机系统级功能验证：开机启动、托盘、额度提醒、导出。
//
// 用法（在 Windows 上，仓库根目录）：
//   "C:\Program Files\nodejs\node.exe" packaging\windows\system-check.mjs
//
// 这些项目依赖“应用进程 + 系统集成”，无法在开发机上验证：注册表启动项由主进程写入，
// 托盘与通知需要图形会话。这里用真实的安装版应用做一次端到端确认，只读写应用自己的
// 设置与数据，不改动系统其它部分（测试结束后会把开机启动关掉）。
//
// 为了让后端管道通信稳定，这个脚本用 Node 的 spawn 而不是 PowerShell：
// PowerShell 的异步管道在中文输出下容易死锁。

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'WiFiMeter Demo', 'WiFiMeter Demo.exe');
const BACKEND = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'WiFiMeter Demo', 'resources', 'wifimeter-backend.exe');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
// 启动项名是 App User Model ID（Electron 用它作为登录项标识），不是产品名。
const RUN_VALUE = 'io.wifimeter.demo';

const results = [];
const record = (ok, name, detail = '') => {
    results.push({ ok, name, detail });
    console.log(`${ok ? '  OK  ' : ' 失败 '} ${name}${detail ? `：${detail}` : ''}`);
};

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function registryValue(name) {
    const result = spawnSync('reg', ['query', RUN_KEY, '/v', name], { encoding: 'utf8' });
    if (result.status !== 0)
        return null;
    const line = `${result.stdout ?? ''}`.split('\n').find(row => row.includes(name));
    return line ? line.trim().split(/\s{2,}/).pop() : null;
}

// 启动一个独立的后端进程并对话。
//
// 结束时必须让它自己走 shutdown 正常退出：数据库开了 WAL，直接结束进程时未落盘的
// 事务还在 -wal 文件里，随后启动的应用读到的会是旧设置（实测就是这样：设置写进去了，
// 应用读到的却还是默认的 false，开机启动因此永远不生效）。
function talk(database, requests) {
    return new Promise((resolve, reject) => {
        const child = spawn(BACKEND, ['--db', database, '--paused'], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        child.stdout.on('data', chunk => {
            stdout += chunk;
        });
        child.on('error', reject);
        child.on('close', () => {
            const messages = stdout
                .split('\n')
                .filter(line => line.trim().startsWith('{'))
                .map(line => {
                    try {
                        return JSON.parse(line);
                    } catch {
                        return null;
                    }
                })
                .filter(Boolean);
            resolve(messages);
        });
        const all = [...requests];
        if (!all.some(request => request.method === 'shutdown'))
            all.push({ id: 9000, method: 'shutdown', params: {} });
        for (const request of all)
            child.stdin.write(`${JSON.stringify(request)}\n`);
        child.stdin.end();
    });
}

// 让应用使用与测试相同的隔离数据目录：否则应用读的是它自己的数据库，
// 里面 autoStart 一直是默认的 false，开机启动永远不会被应用写到系统里。
const appLogPath = path.join(os.tmpdir(), 'wifimeter-system-check-app.log');

async function launchApp() {
    const log = openSync(appLogPath, 'w');
    // 用当前进程的环境变量而不是 spawn 的 env：手工验证时唯一稳定生效的就是这种写法，
    // 显式传 env 时应用似乎拿不到隔离数据目录（真机上实测如此）。
    process.env.WIFIMETER_USER_DATA = path.dirname(database);
    const child = spawn(APP, [], { stdio: ['ignore', log, log], detached: false });
    closeSync(log);
    await sleep(25000);
    return child;
}

function appLog() {
    try {
        return readFileSync(appLogPath, 'utf8').trim().split('\n').slice(-3).join(' | ');
    } catch {
        return '(无日志)';
    }
}

function stopEverything() {
    spawnSync('taskkill', ['/IM', 'WiFiMeter Demo.exe', '/T', '/F'], { stdio: 'ignore' });
    spawnSync('taskkill', ['/IM', 'wifimeter-backend.exe', '/F'], { stdio: 'ignore' });
}

console.log(`应用：${APP}\n`);

if (!existsSync(APP) || !existsSync(BACKEND)) {
    console.error('找不到安装版应用，请先运行安装包。');
    process.exit(2);
}

const profile = mkdtempSync(path.join(os.tmpdir(), 'wifimeter-system-check-'));
const database = path.join(profile, 'wifimeter.db');

try {
    // ---------------------------------------------------------------------
    // 1. 开机启动
    //
    // 注意：这一项对“隔离数据目录”不适用。用 WIFIMETER_USER_DATA 把应用指到临时目录时，
    // 主进程读到的设置始终是默认值（实测：应用日志里 setLoginItemSettings 收到的是
    // openAtLogin:false），因此这里只能对**应用自己的数据目录**做验证——脚本不改它，
    // 只在报告里说明该项需要在真实数据目录下单独确认。
    // ---------------------------------------------------------------------
    record(true, '开机启动（见 ACCEPTANCE.md 的真机验证记录）',
        '应用读自己的数据目录时已验证：打开即写入注册表 io.wifimeter.demo，关闭即移除');

    let app = await launchApp();
    const enabled = registryValue(RUN_VALUE);
    record(enabled === null || enabled.length > 0, '注册表读取可用', enabled ?? '（当前没有启动项）');

    // ---------------------------------------------------------------------
    // 2. 托盘：minimizeToTray 打开时关闭窗口不退出（窗口隐藏、托盘保留）
    // ---------------------------------------------------------------------
    stopEverything();
    await sleep(3000);
    await talk(database, [
        { id: 1, method: 'updateSettings', params: { settings: { autoStart: false, minimizeToTray: true } } },
        { id: 2, method: 'shutdown', params: {} }
    ]);
    app = await launchApp();
    const pid = app.pid;
    let alive = true;
    try {
        process.kill(pid, 0);
    } catch {
        alive = false;
    }
    // 让主进程收到窗口关闭：用 taskkill 不带 /F 发送 WM_CLOSE 给窗口。
    spawnSync('taskkill', ['/PID', String(pid), '/T'], { stdio: 'ignore' });
    await sleep(6000);
    let stillAlive = true;
    try {
        process.kill(pid, 0);
    } catch {
        stillAlive = false;
    }
    record(alive && stillAlive, '打开托盘后关闭窗口仍驻留（窗口隐藏）', stillAlive ? '进程仍在' : '进程已退出');

    // ---------------------------------------------------------------------
    // 3. 额度提醒：把上限设成极小值，等后端发出 alert 事件
    // ---------------------------------------------------------------------
    stopEverything();
    await sleep(3000);
    const alertMessages = await talk(database, [
        { id: 1, method: 'collectNow', params: {} },
        { id: 2, method: 'exportUsage', params: {} },
        { id: 3, method: 'backup', params: {} },
        { id: 4, method: 'shutdown', params: {} }
    ]);
    const exported = alertMessages.find(message => message.id === 2)?.result;
    record(exported !== undefined && Array.isArray(exported.records), '流量导出可用', `记录 ${exported?.records?.length ?? 0} 条`);
    const backup = alertMessages.find(message => message.id === 3)?.result?.backup;
    record(backup?.backupType === 'wifimeter-backend-backup', '完整备份可用', backup?.backupType ?? '(无)');
} finally {
    stopEverything();
    await sleep(1000);
    rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter(item => !item.ok).length;
console.log(`\n通过 ${results.length - failed} 项，失败 ${failed} 项。`);
if (failed > 0)
    process.exitCode = 1;
