// 用 Wine 运行交叉编译出来的 Windows 测试目标。
//
// 这一步验证的是“Windows 目标上的行为”，不是“Windows 实机上的行为”：系统调用（WLAN API、
// IP Helper）在 Wine 下与真实 Windows 不同，因此需要真机验证的部分由 packaging/windows/README.md
// 的手工验收清单覆盖。这里能挡住的错误很实在：编码、代理对、时区、计数器位宽、
// SQLite 在 Windows 上的行为、以及协议层的往返。
//
// Wine 位置：WIFIMETER_WINE 指定 > PATH 中的 wine/wine64 > 自动下载便携版（见 wine.mjs）。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureWine } from './wine.mjs';

const packagingDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(packagingDirectory, '../..');
const testsDirectory = path.join(repositoryRoot, 'build', 'windows', 'tests');
const winePrefix = path.join(repositoryRoot, '.cross-build', 'wine-prefix');
const wineHome = path.join(repositoryRoot, '.cross-build', 'wine-home');

function wineEnvironment() {
    // Wine 需要可写的 HOME 与独立的 prefix；仓库内的目录都不参与提交。
    fs.mkdirSync(winePrefix, { recursive: true });
    fs.mkdirSync(wineHome, { recursive: true });
    return { ...process.env, WINEPREFIX: winePrefix, HOME: wineHome, WINEDEBUG: '-all' };
}

export function runWindowsTests({ logger = console.log } = {}) {
    if (process.platform === 'win32') {
        return runNatively({ logger });
    }

    const wine = ensureWine(repositoryRoot, { logger });
    if (!fs.existsSync(testsDirectory)) {
        throw new Error(`没有找到 ${testsDirectory}：请先运行 node packaging/windows/build-backend.mjs --tests。`);
    }

    const executables = fs.readdirSync(testsDirectory).filter(name => name.endsWith('.exe')).sort();
    if (executables.length === 0) throw new Error(`${testsDirectory} 下没有测试可执行文件。`);

    const environment = wineEnvironment();
    const failures = [];
    for (const name of executables) {
        const result = spawnSync(wine, [path.join(testsDirectory, name)], { env: environment, encoding: 'utf8' });
        // Wine 的启动噪声（fixme/err）混在 stderr 里，只保留用例自己的输出。
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
            .split('\n')
            .filter(line => !/^(fixme|err|wine|winediag):/.test(line))
            .join('\n')
            .trim();
        if (result.status === 0) {
            logger(`通过 ${name}：${output}`);
        } else {
            logger(`失败 ${name}：\n${output}`);
            failures.push(name);
        }
    }

    if (failures.length > 0) throw new Error(`${failures.length} 个 Windows 测试目标失败：${failures.join('、')}`);
    logger(`全部 ${executables.length} 个 Windows 测试目标通过。`);
}

// 在 Windows 机器上直接运行（不走 Wine）。
function runNatively({ logger }) {
    const executables = fs.readdirSync(testsDirectory).filter(name => name.endsWith('.exe')).sort();
    const failures = [];
    for (const name of executables) {
        try {
            const output = execFileSync(path.join(testsDirectory, name), { encoding: 'utf8' });
            logger(`通过 ${name}：${output.trim()}`);
        } catch (error) {
            logger(`失败 ${name}：\n${error.stdout ?? error.message}`);
            failures.push(name);
        }
    }
    if (failures.length > 0) throw new Error(`${failures.length} 个测试目标失败：${failures.join('、')}`);
    logger(`全部 ${executables.length} 个测试目标通过。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        runWindowsTests();
    } catch (error) {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    }
}
