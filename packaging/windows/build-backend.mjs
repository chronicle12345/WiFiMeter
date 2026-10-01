// 在 Linux 上把 C++ 后端交叉编译成 Windows 可执行文件。
//
// 产物：build/windows/app/wifimeter-backend.exe（由打包脚本复制进安装包）。
//
// 为什么要交叉编译：Windows 平台层只能在 Windows 上运行验证，但编译与单元测试大多不需要
// Windows —— 平台无关的判断都在 platform/windows 下，Windows 专属代码集中在 platform/win32。
// 因此这里在 Linux 上完成编译，并可选择用 Wine 跑一遍 Windows 目标上的测试目标。
//
// 用法：
//   node packaging/windows/build-backend.mjs              # 只编译后端
//   node packaging/windows/build-backend.mjs --tests      # 同时编译测试目标
//   node packaging/windows/build-backend.mjs --tests --run # 再用 Wine 跑一遍测试

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureZig, toolchainDirectory } from './toolchain.mjs';

const packagingDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(packagingDirectory, '../..');
const buildDirectory = path.join(repositoryRoot, 'build', 'windows');
const cacheDirectory = path.join(repositoryRoot, '.cross-build', 'zig-cache');

function run(command, args, options = {}) {
    console.log(`$ ${command} ${args.join(' ')}`);
    execFileSync(command, args, { stdio: 'inherit', cwd: repositoryRoot, ...options });
}

// 交叉编译需要的环境：编译器包装脚本要能找到 zig，zig 又要有一个可写的缓存目录
// （开发机或 CI 的 HOME 可能是只读的）。
function crossEnvironment(zigExecutable) {
    return {
        ...process.env,
        WIFIMETER_ZIG: zigExecutable,
        WIFIMETER_ZIG_CACHE_DIR: cacheDirectory,
        WIFIMETER_ZIG_CC: path.join(packagingDirectory, 'zig-cc.sh'),
        WIFIMETER_ZIG_CXX: path.join(packagingDirectory, 'zig-cxx.sh'),
        ZIG_GLOBAL_CACHE_DIR: path.join(cacheDirectory, 'global'),
        ZIG_LOCAL_CACHE_DIR: path.join(cacheDirectory, 'local')
    };
}

export function buildWindowsBackend({ tests = false, run: runTests = false, logger = console.log } = {}) {
    const zigExecutable = ensureZig(repositoryRoot, { logger });
    const environment = crossEnvironment(zigExecutable);

    const configureArgs = [
        '-S', 'backend',
        '-B', path.relative(repositoryRoot, buildDirectory),
        `-DCMAKE_TOOLCHAIN_FILE=${path.join(packagingDirectory, 'toolchain-mingw.cmake')}`,
        '-DCMAKE_BUILD_TYPE=Release'
    ];
    if (tests) configureArgs.push('-DWIFIMETER_BUILD_TESTS=ON');

    fs.mkdirSync(cacheDirectory, { recursive: true });
    run('cmake', configureArgs, { env: environment });
    run('cmake', ['--build', path.relative(repositoryRoot, buildDirectory), '--target', 'wifimeter-backend'], { env: environment });
    if (tests) run('cmake', ['--build', path.relative(repositoryRoot, buildDirectory)], { env: environment });

    const executable = path.join(buildDirectory, 'app', 'wifimeter-backend.exe');
    if (!fs.existsSync(executable)) throw new Error(`交叉编译没有产出 ${executable}。`);
    logger(`后端已生成：${path.relative(repositoryRoot, executable)}`);

    if (tests && runTests) {
        run(process.execPath, [path.join(packagingDirectory, 'run-windows-tests.mjs')], { env: environment });
    }
    return executable;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const flags = new Set(process.argv.slice(2));
    try {
        buildWindowsBackend({ tests: flags.has('--tests') || flags.has('--run'), run: flags.has('--run') });
    } catch (error) {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    }
}

export { repositoryRoot, buildDirectory, toolchainDirectory };
