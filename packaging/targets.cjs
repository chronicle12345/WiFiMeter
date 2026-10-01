'use strict';

const fs = require('node:fs');
const path = require('node:path');

function buildOptions(platform, args = [], host = process) {
    if (!['win32', 'linux'].includes(platform)) throw new Error(`不支持的平台：${platform}。`);
    const arches = platform === 'win32' ? ['x64', 'arm64', 'ia32'] : ['x64', 'arm64'];
    const allowed = platform === 'win32' ? ['nsis', 'portable', 'dir'] : ['deb', 'rpm', 'AppImage', 'dir'];
    let arch = host.arch;
    let skipRebuild = false;
    let formats = platform === 'win32' ? ['nsis', 'portable'] : ['deb'];
    for (let i = 0; i < args.length; i += 2) {
        if (args[i] === '--skip-rebuild') { skipRebuild = true; i--; continue; }
        if (!['--arch', '--formats'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) {
            throw new Error(`不支持的参数：${args[i]}；使用 --arch 和 --formats。`);
        }
        if (args[i] === '--arch') arch = args[i + 1];
        else formats = [...new Set(args[i + 1].split(','))];
    }
    if (!arches.includes(arch)) throw new Error(`不支持 ${platform}/${arch}。`);
    if (formats.some(format => !allowed.includes(format))) throw new Error(`不支持的格式：${formats.join(',')}。`);
    if (platform === 'linux' && (host.platform !== 'linux' || host.arch !== arch)) {
        throw new Error('Linux 打包需要对应架构的 Linux 本机工具链，不支持跨架构编译。');
    }
    if (platform === 'win32' && host.platform !== 'win32' && !(host.platform === 'linux' && host.arch === 'x64' && arch === 'x64')) {
        throw new Error('现有 Zig/Wine 交叉工具链仅支持 Linux x64 到 Windows x64；其他目标需要 Windows Visual Studio 工具链。');
    }
    return { platform, arch, formats, skipRebuild };
}

function buildPaths(platform, arch) {
    const name = platform === 'win32' ? 'windows' : 'linux';
    const suffix = arch === 'x64' ? '' : `-${arch}`;
    return {
        backend: platform === 'linux' && arch === 'x64' ? 'build' : `build/${name}${suffix}`,
        output: `dist/${name}${suffix}`,
        unpacked: platform === 'win32' ? (arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`) : (arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`)
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

function checkPackaged(directory, platform, arch) {
    assertArchitecture(path.join(directory, platform === 'win32' ? 'WiFiMeter.exe' : 'wifimeter'), platform, arch);
    checkBackend(path.join(directory, 'resources'), platform, arch);
}

function packagingConfig({ platform, arch }) {
    const root = path.resolve(__dirname, '..');
    const base = require(platform === 'win32' ? './windows/electron-builder.cjs' : './linux/electron-builder.cjs');
    const paths = buildPaths(platform, arch);
    let installedVersion = '';
    try { installedVersion = require('../apps/desktop/node_modules/electron/package.json').version; } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    const selectedVersion = platform === 'win32' && arch === 'ia32' ? '43.7.7' : require('../apps/desktop/package.json').devDependencies.electron;
    const localRuntime = path.join(root, 'apps/desktop/node_modules/electron/dist');
    let runtime = {};
    const localExecutable = path.join(localRuntime, platform === 'win32' ? 'electron.exe' : 'electron');
    if (platform === process.platform && installedVersion === selectedVersion && fs.existsSync(localExecutable)) {
        const actual = binaryArchitecture(localExecutable);
        if (actual.platform === platform && actual.arch === arch) runtime = { electronDist: localRuntime };
    }
    return {
        ...base,
        ...runtime,
        // Electron 44 no longer publishes Windows ia32; use the maintained 43 branch for that target.
        ...(platform === 'win32' && arch === 'ia32' ? { electronVersion: '43.7.7' } : {}),
        directories: { ...base.directories, output: path.join(root, paths.output) },
        extraResources: base.extraResources.map(resource => ({
            ...resource,
            from: resource.from.startsWith('../../build/')
                ? path.join(root, paths.backend, 'app', path.basename(resource.from)) : resource.from
        })),
        afterPack: async context => checkPackaged(context.appOutDir, platform, arch)
    };
}

module.exports = { buildOptions, buildPaths, binaryArchitecture, assertArchitecture, checkBackend, checkPackaged, packagingConfig };
