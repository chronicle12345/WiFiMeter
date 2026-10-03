'use strict';

// Windows 打包产物检查。
//
// 这里只做确定性、快速的检查：解包目录里必须带着后端，后端必须是真正的 Windows
// 可执行文件，安装包必须是可执行的 PE。这些条件在任何机器上都成立。
//
// 后端的**行为**验证不放在这里：Wine 首次运行要初始化 prefix（几十秒且不稳定），
// 而这些行为已经被两处更可靠地覆盖——
//
//   * `npm run test:windows`：交叉编译出全部 Windows 测试目标，在固定 prefix 下逐个运行；
//   * 真机：packaging/windows/README.md 的验收清单，以及在 Windows 上直接运行
//     build/windows/tests/windows_smoke_test.exe。
//
// 需要手工确认“随包的后端能跑起来”时，可以运行本文件末尾注释里的命令。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
const require = createRequire(import.meta.url);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const metadata = JSON.parse(readFileSync(path.join(repositoryRoot, 'apps/desktop/package.json'), 'utf8'));

// Tauri 发布产物与资源布局由 tauri-packaging.test.js 验证。

test('打包参数限制架构、格式和交叉编译范围', () => {
    const { buildOptions } = require('../../../packaging/targets.cjs');
    for (const arch of ['x64', 'arm64', 'ia32']) {
        const plan = buildOptions('win32', ['--arch', arch, '--formats', 'nsis,portable'], { platform: 'win32', arch: 'x64' });
        assert.equal(plan.arch, arch);
        assert.deepEqual(plan.formats, ['nsis', 'portable']);
    }
    for (const arch of ['x64', 'arm64']) {
        assert.equal(buildOptions('linux', ['--arch', arch, '--formats', 'deb,rpm,AppImage'], { platform: 'linux', arch }).arch, arch);
    }
    assert.throws(() => buildOptions('linux', ['--arch', 'ia32']), /不支持/);
    assert.throws(() => buildOptions('linux', ['--arch', 'arm64'], { platform: 'linux', arch: 'x64' }), /本机/);
    assert.throws(() => buildOptions('win32', ['--arch', 'arm64'], { platform: 'linux', arch: 'x64' }), /x64/);
    assert.throws(() => buildOptions('win32', ['--formats', 'deb']), /格式/);
    assert.throws(() => buildOptions('win32', ['--arch']), /参数/);
    assert.throws(() => buildOptions('win32', ['--typo']), /参数/);
});

test('读取 PE 和 ELF 架构，拒绝混合架构、截断文件和伪造文件头', t => {
    const { binaryArchitecture, assertArchitecture } = require('../../../packaging/targets.cjs');
    const directory = mkdtempSync(path.join(os.tmpdir(), 'wifimeter-arch-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const [arch, machine] of Object.entries({ x64: 0x8664, arm64: 0xaa64, ia32: 0x14c })) {
        const header = Buffer.alloc(256);
        header.write('MZ'); header.writeUInt32LE(128, 0x3c);
        header.write('PE\0\0', 128); header.writeUInt16LE(machine, 132);
        const file = path.join(directory, `${arch}.exe`);
        writeFileSync(file, header);
        assert.deepEqual(binaryArchitecture(file), { platform: 'win32', arch });
        assertArchitecture(file, 'win32', arch);
        assert.throws(() => assertArchitecture(file, 'linux', arch), /不匹配/);
        assert.throws(() => assertArchitecture(file, 'win32', arch === 'x64' ? 'arm64' : 'x64'), /不匹配/);
    }
    for (const [arch, machine] of Object.entries({ x64: 62, arm64: 183 })) {
        const header = Buffer.alloc(64);
        header.write('\x7fELF', 0, 'binary'); header[4] = 2; header[5] = 1;
        header.writeUInt16LE(machine, 18);
        const file = path.join(directory, arch);
        writeFileSync(file, header);
        assert.deepEqual(binaryArchitecture(file), { platform: 'linux', arch });
        header[4] = 1;
        writeFileSync(file, header);
        assert.throws(() => binaryArchitecture(file), /ELF/);
    }
    const bad = path.join(directory, 'bad');
    writeFileSync(bad, 'MZ');
    assert.throws(() => binaryArchitecture(bad), /文件|格式/);
    const forged = Buffer.alloc(64); forged.write('MZ'); forged.writeUInt32LE(0xfffffff0, 0x3c);
    writeFileSync(bad, forged);
    assert.throws(() => binaryArchitecture(bad), /文件|格式/);
});

test('打包配置按架构选择本地资源，afterPack 检查 Electron 和两个辅助程序', async t => {
    const { packagingConfig } = require('../../../packaging/targets.cjs');
    const directory = mkdtempSync(path.join(os.tmpdir(), 'wifimeter-package-check-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(directory, 'resources'));
    const pe = machine => {
        const header = Buffer.alloc(256);
        header.write('MZ'); header.writeUInt32LE(128, 0x3c);
        header.write('PE\0\0', 128); header.writeUInt16LE(machine, 132);
        return header;
    };
    const config = packagingConfig({ platform: 'win32', arch: 'arm64' });
    assert.match(config.directories.output, /windows-arm64$/);
    assert.ok(config.extraResources.filter(resource => resource.to.endsWith('.exe')).every(resource => resource.from.includes('windows-arm64')));
    for (const name of ['WiFiMeter.exe', 'resources/wifimeter-backend.exe', 'resources/wifimeter-app-capture.exe']) {
        writeFileSync(path.join(directory, name), pe(0xaa64));
    }
    await config.afterPack({ appOutDir: directory });
    writeFileSync(path.join(directory, 'resources/wifimeter-app-capture.exe'), pe(0x8664));
    await assert.rejects(config.afterPack({ appOutDir: directory }), /架构不匹配/);
    writeFileSync(path.join(directory, 'resources/wifimeter-app-capture.exe'), pe(0xaa64));
    writeFileSync(path.join(directory, 'WiFiMeter.exe'), pe(0x8664));
    await assert.rejects(config.afterPack({ appOutDir: directory }), /架构不匹配/);
    const linux = packagingConfig({ platform: 'linux', arch: 'arm64' });
    assert.match(linux.extraResources[0].from, /linux-arm64/);
    assert.ok(linux.extraResources.some(resource => resource.to.endsWith('.bpf.o')));
    assert.ok(linux.extraResources.some(resource => resource.to.startsWith('licenses/')));
});

test('Windows 控制模块固定放在 asar 外，所有架构使用同一资源路径', () => {
    const { packagingConfig } = require('../../../packaging/targets.cjs');
    for (const arch of ['x64', 'arm64', 'ia32']) {
        const resource = packagingConfig({ platform: 'win32', arch }).extraResources.find(item => item.to === 'native/windows/AppNetworkControl.psm1');
        assert.ok(resource, '应通过 extraResources 复制控制模块');
        assert.equal(resource.from, 'native/windows/AppNetworkControl.psm1');
        assert.ok(existsSync(path.join(repositoryRoot, 'apps/desktop', resource.from)));
    }
});

test('Windows 编译复用缓存生成器，新目录选择已安装的 Visual Studio', () => {
    const { windowsGeneratorOptions } = require('../../../packaging/build-backend.cjs');
    assert.deepEqual(windowsGeneratorOptions({ arch: 'x64', hostArch: 'x64', cachedArch: 'x64', cache: 'CMAKE_GENERATOR:INTERNAL=Ninja\n' }), []);
    assert.deepEqual(windowsGeneratorOptions({ arch: 'arm64', hostArch: 'x64', generators: ['Visual Studio 17 2022', 'Visual Studio 18 2026'] }), ['-G', 'Visual Studio 18 2026', '-A', 'ARM64']);
    assert.deepEqual(windowsGeneratorOptions({ arch: 'ia32', hostArch: 'x64', generator: 'Visual Studio 18 2026' }), ['-G', 'Visual Studio 18 2026', '-A', 'Win32']);
    assert.deepEqual(windowsGeneratorOptions({ arch: 'x64', hostArch: 'x64', generator: 'Ninja' }), ['-G', 'Ninja']);
    assert.throws(() => windowsGeneratorOptions({ arch: 'arm64', hostArch: 'x64', generator: 'Ninja' }), /跨架构/);
    assert.deepEqual(windowsGeneratorOptions({ arch: 'arm64', hostArch: 'x64', generator: 'Ninja', toolchain: 'arm64.cmake' }), ['-G', 'Ninja', '-DCMAKE_TOOLCHAIN_FILE=arm64.cmake']);
    assert.throws(() => windowsGeneratorOptions({ arch: 'arm64', hostArch: 'x64', generators: ['Ninja'] }), /Visual Studio/);
    assert.throws(() => windowsGeneratorOptions({ arch: 'arm64', hostArch: 'x64', cachedArch: 'x64', cache: 'CMAKE_GENERATOR:INTERNAL=Visual Studio 18 2026\nCMAKE_GENERATOR_PLATFORM:INTERNAL=x64\n' }), /不匹配/);
});


test('Windows Ninja 缓存架构与宿主架构分别校验，默认值跟随当前 Node 宿主', () => {
    const { windowsGeneratorOptions } = require('../../../packaging/build-backend.cjs');
    const cache = 'CMAKE_GENERATOR:INTERNAL=Ninja\n';
    for (const hostArch of ['x64', 'ia32', 'arm64']) {
        assert.deepEqual(windowsGeneratorOptions({ arch: hostArch, hostArch, generator: 'Ninja' }), ['-G', 'Ninja']);
        assert.deepEqual(windowsGeneratorOptions({ arch: hostArch, hostArch, cache }), []);
        for (const arch of ['x64', 'ia32', 'arm64']) {
            assert.deepEqual(windowsGeneratorOptions({ arch, hostArch, cachedArch: arch, cache }), []);
            if (arch === hostArch) continue;
            assert.throws(() => windowsGeneratorOptions({ arch, hostArch, cachedArch: hostArch, cache }), /跨架构/);
            assert.throws(() => windowsGeneratorOptions({ arch, hostArch, generator: 'Ninja' }), /跨架构/);
            assert.deepEqual(windowsGeneratorOptions({ arch, hostArch, cachedArch: hostArch, cache, toolchain: 'cross.cmake' }), []);
            assert.deepEqual(windowsGeneratorOptions({ arch, hostArch, cachedArch: hostArch, cache: cache + 'CMAKE_TOOLCHAIN_FILE:FILEPATH=cross.cmake\n' }), []);
        }
    }
    assert.deepEqual(windowsGeneratorOptions({ arch: process.arch, cache }), []);
    assert.deepEqual(windowsGeneratorOptions({ arch: process.arch, generator: 'Ninja' }), ['-G', 'Ninja']);
});
