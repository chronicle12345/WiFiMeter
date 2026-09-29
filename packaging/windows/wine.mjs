// 定位 Wine：已有则复用，没有则下载一份便携版到 .cross-build/。
//
// 为什么需要 Wine：Windows 目标上的测试（编码、时区、SQLite、协议往返）可以在 Linux 上跑，
// 但需要一个能执行 PE 可执行文件的运行时。便携版来自 Kron4ek/Wine-Builds（不带安装器，
// 解压即用），刻意不依赖发行版包管理器，避免引入 root 权限要求。

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WINE_VERSION = '11.18';

const DOWNLOADS = {
    'linux-x64': {
        url: `https://github.com/Kron4ek/Wine-Builds/releases/download/${WINE_VERSION}/wine-${WINE_VERSION}-amd64-wow64.tar.xz`,
        directory: `wine-${WINE_VERSION}-amd64-wow64`,
        sha256: 'f899879b8c37e0b20adca19d147cf77436f3f1a37bf16d08d27fa7137a52b9ba'
    }
};

function toolchainRoot(repositoryRoot) {
    return path.join(repositoryRoot, '.cross-build', 'toolchain');
}

// 已经在 PATH 里就直接用（发行版包更省事）。
function fromPath() {
    if (process.env.WIFIMETER_WINE) return process.env.WIFIMETER_WINE;
    for (const candidate of ['wine', 'wine64']) {
        const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
        if (probe.status === 0) return candidate;
    }
    return null;
}

// 返回可执行文件路径；优先 PATH，其次已下载的便携版，最后下载。
export function ensureWine(repositoryRoot, { logger = console.log } = {}) {
    const existing = fromPath();
    if (existing) return existing;

    if (process.platform !== 'linux') {
        throw new Error('只在 Linux 上需要 Wine 来运行 Windows 测试目标；当前系统请直接运行 .exe。');
    }
    const download = DOWNLOADS[`${process.platform}-${process.arch}`];
    if (!download) throw new Error(`没有为 ${process.platform}-${process.arch} 准备 Wine。`);

    const root = toolchainRoot(repositoryRoot);
    const executable = path.join(root, download.directory, 'bin', 'wine');
    if (fs.existsSync(executable)) return executable;

    fs.mkdirSync(root, { recursive: true });
    const archive = path.join(root, path.basename(new URL(download.url).pathname));
    logger(`下载 Wine ${WINE_VERSION}（约 95 MB，只需一次）：${download.url}`);
    execFileSync('curl', ['-fsSL', '-o', archive, download.url], { stdio: 'inherit' });

    if (download.sha256) {
        const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
        if (digest !== download.sha256) {
            fs.rmSync(archive, { force: true });
            throw new Error(`Wine 下载校验失败：期望 ${download.sha256}，实际 ${digest}。`);
        }
    }

    logger('解压 Wine…');
    execFileSync('tar', ['-xf', archive, '-C', root], { stdio: 'inherit' });
    fs.rmSync(archive, { force: true });

    if (!fs.existsSync(executable)) throw new Error(`解压后没有找到 ${executable}。`);
    return executable;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    try {
        console.log(ensureWine(repositoryRoot));
    } catch (error) {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    }
}
