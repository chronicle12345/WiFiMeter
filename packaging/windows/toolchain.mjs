// 下载并解压交叉编译所需的工具链（目前只有 Zig）。
//
// 为什么用 Zig 而不是 mingw-w64：Zig 自带 clang 与 MinGW 兼容的头文件/运行库，
// 一个压缩包即可完成 x86_64-windows-gnu 的编译与链接，不必在开发机上装整套交叉工具链，
// 也不需要在 Windows 机器上装 Visual Studio。
//
// 下载位置固定在 .cross-build/toolchain/（已忽略提交），重复执行不会重复下载。

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 与 packaging/windows/README.md 中记录的一致；升级时同时更新两处。
export const ZIG_VERSION = '0.14.1';

const DOWNLOADS = {
    'linux-x64': {
        url: `https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz`,
        directory: `zig-x86_64-linux-${ZIG_VERSION}`,
        sha256: '24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c'
    },
    'win32-x64': {
        url: `https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-windows-${ZIG_VERSION}.zip`,
        directory: `zig-x86_64-windows-${ZIG_VERSION}`,
        sha256: '554f5378228923ffd558eac35e21af020c73789d87afeabf4bfd16f2e6feed2c'
    }
};

export function toolchainDirectory(repositoryRoot) {
    return path.join(repositoryRoot, '.cross-build', 'toolchain');
}

function zigExecutableName() {
    return process.platform === 'win32' ? 'zig.exe' : 'zig';
}

function extract(archive, root) {
    if (archive.endsWith('.zip')) {
        execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${root}' -Force`], { stdio: 'inherit' });
        return;
    }
    execFileSync('tar', ['-xf', archive, '-C', root], { stdio: 'inherit' });
}

// 返回可用的 zig 可执行文件路径；已经下载过就直接复用。
export function ensureZig(repositoryRoot, { logger = console.log } = {}) {
    const key = `${process.platform}-${process.arch}`;
    const download = DOWNLOADS[key];
    if (!download) {
        throw new Error(`没有为 ${key} 准备 Zig 工具链；请自行安装 zig 并设置 WIFIMETER_ZIG 环境变量。`);
    }

    const root = toolchainDirectory(repositoryRoot);
    const executable = path.join(root, download.directory, zigExecutableName());
    if (fs.existsSync(executable)) return executable;

    fs.mkdirSync(root, { recursive: true });
    const archive = path.join(root, path.basename(new URL(download.url).pathname));
    logger(`下载 Zig ${ZIG_VERSION}（约 50–80 MB，只需一次）：${download.url}`);
    execFileSync('curl', ['-fsSL', '-o', archive, download.url], { stdio: 'inherit' });

    const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    if (digest !== download.sha256) {
        fs.rmSync(archive, { force: true });
        throw new Error(`Zig 下载校验失败：期望 ${download.sha256}，实际 ${digest}。`);
    }

    logger('解压工具链…');
    extract(archive, root);
    fs.rmSync(archive, { force: true });

    if (!fs.existsSync(executable)) throw new Error(`解压后没有找到 ${executable}。`);
    return executable;
}

// 以脚本方式直接运行时（node packaging/windows/toolchain.mjs）只做下载与解压，便于排查。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    console.log(ensureZig(repositoryRoot));
}
