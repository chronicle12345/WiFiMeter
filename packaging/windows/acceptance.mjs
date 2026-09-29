// 打包产物的自动验收：在 Windows 上一条命令跑完所有机器能验的部分。
//
// 用法（在仓库根目录，先跑一次 npm run dist:windows 与 npm run test:windows）：
//   node packaging/windows/acceptance.mjs
//
// 这个脚本刻意**不重新实现协议测试**：那些断言已经在 backend_process_test 里，
// 并且同一份用例在 Linux、Wine 与 Windows 实机上都验过。这里只负责：
//
//   1. 检查打包产物存在、类型与体积合理；
//   2. 运行真机只读自检 windows_smoke_test（WLAN API 与 IP Helper 的真实行为）；
//   3. 运行端到端用例 backend_process_test（真子进程 + 真协议 + 真 SQLite）；
//   4. 在真实网卡上跑一轮只读采样，确认能看到当前网络。
//
// 结果分三类：通过 / 失败 / 跳过（缺少尚未构建的文件时跳过，不算失败）。
// 退出码非零表示有失败项。

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const unpacked = path.join(repositoryRoot, 'dist/windows/win-unpacked');
const appBinary = path.join(unpacked, 'WiFiMeter Demo.exe');
const bundledBackend = path.join(unpacked, 'resources/wifimeter-backend.exe');
const devBackend = path.join(repositoryRoot, 'build/windows/app/wifimeter-backend.exe');
const smokeTest = path.join(repositoryRoot, 'build/windows/tests/windows_smoke_test.exe');
const processTest = path.join(repositoryRoot, 'build/windows/tests/backend_process_test.exe');
const installer = path.join(repositoryRoot, 'dist/windows/WiFiMeter-Demo-0.1.0-x64-Setup.exe');

const results = [];
const record = (status, name, detail = '') => {
    results.push({ status, name, detail });
    const mark = status === 'pass' ? '  OK  ' : status === 'fail' ? ' 失败 ' : ' 跳过 ';
    console.log(`${mark} ${name}${detail ? `：${detail}` : ''}`);
};
const check = (name, condition, detail = '') => {
    record(condition ? 'pass' : 'fail', name, detail);
    return condition;
};

// PE 文件的头两个字节是 "MZ"；只读前两个字节，安装包有 100 MB 以上。
function startsWithMz(file) {
    const descriptor = openSync(file, 'r');
    try {
        const header = Buffer.alloc(2);
        readSync(descriptor, header, 0, 2, 0);
        return header.toString('ascii') === 'MZ';
    } finally {
        closeSync(descriptor);
    }
}

// 运行一个测试可执行文件，并回报它最后一行输出（通常是“N 项检查，M 项失败”）。
function runTest(name, executable, environment = {}) {
    if (!existsSync(executable)) {
        record('skip', name, `未构建 ${path.relative(repositoryRoot, executable)}`);
        return false;
    }
    const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 300000, env: { ...process.env, ...environment } });
    // 只取“N 项检查，M 项失败”这一行：Wine 与本机都会往 stderr 写启动噪声。
    const summary = `${result.stdout ?? ''}${result.stderr ?? ''}`
        .split('\n')
        .map(line => line.trim())
        .find(line => line.includes('项检查'));
    check(name, result.status === 0, summary ?? `退出码 ${result.status}`);
    return result.status === 0;
}

// 与后端按协议对话一次；只用于“真实网卡上跑一轮采样”这一个只读检查。
function talk(backend, requests) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'wifimeter-acceptance-'));
    try {
        const result = spawnSync(backend, ['--db', path.join(directory, 'meter.db')], {
            input: `${requests.map(request => JSON.stringify(request)).join('\n')}\n`,
            encoding: 'utf8',
            timeout: 120000
        });
        return `${result.stdout ?? ''}`
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
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

console.log(`仓库：${repositoryRoot}\n`);

// ---------------------------------------------------------------------------
// 1. 打包产物
// ---------------------------------------------------------------------------
if (!existsSync(appBinary) && !existsSync(installer)) {
    record('skip', '打包产物', '未找到 dist/windows，先运行 npm run dist:windows');
} else {
    check('应用可执行文件存在', existsSync(appBinary), path.relative(repositoryRoot, appBinary));
    if (check('随包后端存在', existsSync(bundledBackend), path.relative(repositoryRoot, bundledBackend))) {
        check('随包后端是 Windows 可执行文件', startsWithMz(bundledBackend));
        check('随包后端体积合理', statSync(bundledBackend).size > 100 * 1024, `${(statSync(bundledBackend).size / 1024).toFixed(0)} KB`);
    }
    if (existsSync(installer)) {
        check('安装包是 Windows 可执行文件', startsWithMz(installer));
        check('安装包体积合理', statSync(installer).size > 50 * 1024 * 1024, `${(statSync(installer).size / 1048576).toFixed(0)} MB`);
    } else {
        record('skip', '安装包', '未找到，先运行 npm run dist:windows');
    }
}

// ---------------------------------------------------------------------------
// 2. 真机只读自检：WLAN API 与 IP Helper 的真实行为
// ---------------------------------------------------------------------------
runTest('真机只读自检（WLAN 与计数）', smokeTest);

// ---------------------------------------------------------------------------
// 3. 端到端用例：真子进程 + 真协议 + 真 SQLite（与 Linux 共用同一份断言的 Windows 版）
// ---------------------------------------------------------------------------
const testBackend = existsSync(bundledBackend) ? bundledBackend : devBackend;
if (existsSync(processTest)) {
    if (existsSync(testBackend)) {
        // WIFIMETER_BACKEND_BINARY 覆盖构建时写入的路径（交叉编译出来的是构建机路径）。
        runTest('端到端用例（协议、采集、导出、备份恢复）', processTest, { WIFIMETER_BACKEND_BINARY: testBackend });
    } else {
        record('skip', '端到端用例', '找不到可用的后端可执行文件');
    }
} else {
    record('skip', '端到端用例', '未构建 build/windows/tests/backend_process_test.exe');
}

// ---------------------------------------------------------------------------
// 4. 启动打包后的应用：确认它能自己拉起随包后端并创建数据库
// ---------------------------------------------------------------------------
// 这一项是补上来的：之前所有检查都直接运行后端二进制，而真机上第一次安装时
// 后端只在“由 Electron 拉起”时启动失败（无法创建数据目录），界面因此完全没有数据。
// 直接跑后端永远发现不了这类问题，所以这里真的把应用启动一次。
async function launchesThePackagedApplication() {
    if (process.platform !== 'win32') {
        record('skip', '启动打包后的应用', '只在 Windows 上运行');
        return;
    }
    if (!existsSync(appBinary)) {
        record('skip', '启动打包后的应用', '未找到解包目录里的应用');
        return;
    }

    const setupLog = path.join(os.tmpdir(), `wifimeter-app-${process.pid}.log`);

    // 用隔离的数据目录启动：不碰用户真实记录（与界面测试用同一套环境变量）。
    const profile = mkdtempSync(path.join(os.tmpdir(), 'wifimeter-app-profile-'));
    const child = spawn(appBinary, [], {
        stdio: ['ignore', openSync(setupLog, 'w'), 'ignore'],
        env: { ...process.env, WIFIMETER_USER_DATA: profile }
    });

    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    try {
        // Electron 启动 + 后端拉起：这台机器上实测十秒内完成，留出余量。
        await sleep(20000);

        const profileDatabase = path.join(profile, 'wifimeter.db');
        const created = existsSync(profileDatabase);
        let backendRunning = false;
        if (process.platform === 'win32') {
            const listed = spawnSync('tasklist', ['/FI', 'IMAGENAME eq wifimeter-backend.exe', '/NH'], { encoding: 'utf8' });
            backendRunning = `${listed.stdout ?? ''}`.toLowerCase().includes('wifimeter-backend.exe');
        }

        const log = existsSync(setupLog) ? readFileSync(setupLog, 'utf8') : '';
        check('应用能拉起随包后端', backendRunning || created, backendRunning ? '后端进程存活' : '数据库已创建');
        check('应用能创建数据目录与数据库', created, created ? path.basename(profileDatabase) : log.trim().split('\n').slice(-2).join(' / ') || '（无日志）');
    } catch (error) {
        record('fail', '启动打包后的应用', error.message);
    } finally {
        // 应用会派生多个子进程，因此按进程树结束（taskkill /T 不需要管理员权限）。
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        rmSync(profile, { recursive: true, force: true });
        rmSync(setupLog, { force: true });
    }
}

await launchesThePackagedApplication();

// ---------------------------------------------------------------------------
// 5. 真实网卡上跑一轮只读采样
// ---------------------------------------------------------------------------
if (!existsSync(testBackend)) {
    record('skip', '真实网卡采样', '没有可用的后端可执行文件');
} else {
    try {
        const messages = talk(testBackend, [
            { id: 1, method: 'collectNow', params: {} },
            { id: 2, method: 'snapshot', params: {} },
            { id: 3, method: 'shutdown', params: {} }
        ]);
        const live = messages.find(message => message.id === 2)?.result?.live;
        const state = live?.state ?? '(无)';
        // 这台机器可能没连 Wi-Fi（虚拟机、无线关闭），因此只要求状态是已知取值。
        check('真实网卡采样返回已知状态', ['connected', 'disconnected', 'offline'].includes(state), state);
        if (state === 'connected') {
            const connection = live.connections?.[0];
            check('已连接时能看到网络身份', Boolean(connection?.networkId && connection?.adapterAlias), connection?.adapterAlias ?? '(无)');
        } else {
            record('skip', '网络身份', `当前状态为 ${state}`);
        }
    } catch (error) {
        record('fail', '真实网卡采样', error.message);
    }
}

// ---------------------------------------------------------------------------
const failed = results.filter(item => item.status === 'fail').length;
const skipped = results.filter(item => item.status === 'skip').length;
console.log(`\n通过 ${results.length - failed - skipped} 项，跳过 ${skipped} 项，失败 ${failed} 项。`);
if (failed > 0) {
    console.log('失败项需要人工排查。所有检查都是只读的，不会改动系统网络状态。');
    process.exitCode = 1;
}
