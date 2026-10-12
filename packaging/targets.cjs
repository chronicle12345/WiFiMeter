'use strict';

const fs = require('node:fs');
const path = require('node:path');

function validateNativeTarget(platform, arch, host = process) {
    if (!['win32', 'linux'].includes(platform)) throw new Error(`不支持的平台：${platform}。`);
    const arches = platform === 'win32' ? ['x64', 'arm64', 'ia32'] : ['x64', 'arm64'];
    if (!arches.includes(arch)) throw new Error(`不支持 ${platform}/${arch}。`);
    if (platform === 'linux' && (host.platform !== 'linux' || host.arch !== arch)) {
        throw new Error('Linux 构建需要对应架构的 Linux 本机工具链。');
    }
    if (platform === 'win32' && host.platform !== 'win32') {
        throw new Error('Windows 构建需要 Windows 本机工具链；跨架构编译需要 Visual Studio 或显式工具链配置。');
    }
    return { platform, arch };
}

function buildPaths(platform, arch) {
    const name = platform === 'win32' ? 'windows' : 'linux';
    const suffix = arch === 'x64' ? '' : `-${arch}`;
    return {
        backend: platform === 'linux' && arch === 'x64' ? 'build' : `build/${name}${suffix}`,
        output: `dist/${name}${suffix}`
    };
}

function binaryArchitecture(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const header = Buffer.alloc(64);
        if (fs.readSync(fd, header, 0, 64, 0) !== 64) throw new Error(`文件头不完整：${file}`);
        if (header.toString('ascii', 0, 2) === 'MZ') {
            const offset = header.readUInt32LE(0x3c);
            const pe = Buffer.alloc(6);
            if (offset < 64 || fs.readSync(fd, pe, 0, 6, offset) !== 6 || pe.toString('ascii', 0, 4) !== 'PE\0\0') {
                throw new Error(`PE 文件格式无效：${file}`);
            }
            const arch = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' }[pe.readUInt16LE(4)];
            if (!arch) throw new Error(`不支持的 PE 架构：${file}`);
            return { platform: 'win32', arch };
        }
        if (header.toString('binary', 0, 4) === '\x7fELF') {
            const arch = { 62: 'x64', 183: 'arm64' }[header.readUInt16LE(18)];
            if (header[4] !== 2 || header[5] !== 1 || !arch) throw new Error(`不支持的 ELF 架构：${file}`);
            return { platform: 'linux', arch };
        }
        throw new Error(`不支持的文件格式：${file}`);
    } finally {
        fs.closeSync(fd);
    }
}

function assertArchitecture(file, platform, arch) {
    const actual = binaryArchitecture(file);
    if (actual.platform !== platform || actual.arch !== arch) {
        throw new Error(`架构不匹配：${file} 为 ${actual.platform}/${actual.arch}，目标为 ${platform}/${arch}。`);
    }
}

function checkBackend(directory, platform, arch) {
    for (const name of ['wifimeter-backend', 'wifimeter-app-capture']) {
        assertArchitecture(path.join(directory, name + (platform === 'win32' ? '.exe' : '')), platform, arch);
    }
}

module.exports = { validateNativeTarget, buildPaths, binaryArchitecture, assertArchitecture, checkBackend };
