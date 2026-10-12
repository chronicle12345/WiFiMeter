import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
const require = createRequire(import.meta.url);

test('后台后端构建的工具发现、配置和编译均隐藏 Windows 控制台', () => {
    const calls = [];
    const module = { exports: {} };
    const script = require.resolve('../../../packaging/build-backend.cjs');
    const host = { platform: 'win32', arch: 'x64', env: {}, argv: [] };
    const targets = require('../../../packaging/targets.cjs');
    const context = vm.createContext({ module, exports: module.exports,
        __dirname: path.dirname(script),
        process: host,
        require: name => {
            if (name === 'node:fs') return { existsSync: () => false };
            if (name === 'node:child_process') return { execFileSync: (command, args, options) => {
                calls.push({ command, args, options });
                return JSON.stringify({ generators: [{ name: 'Visual Studio 17 2022' }] });
            } };
            return name === './targets.cjs' ? { ...targets,
                validateNativeTarget: (platform, arch) => targets.validateNativeTarget(platform, arch, host)
            } : require(name);
        }
    });
    new vm.Script(readFileSync(script, 'utf8')).runInContext(context);
    module.exports.buildBackend({ arch: 'x64' });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(call => call.args[0]), ['-E', '-S', '--build']);
    for (const call of calls) assert.equal(call.options.windowsHide, true, `${call.args[0]} must hide its console`);
});

test('后端构建拒绝跨系统目标，Windows 本机仍可选择 Visual Studio 支持的架构', () => {
    const { validateNativeTarget } = require('../../../packaging/targets.cjs');
    const linux = { platform: 'linux', arch: 'x64' };
    const windows = { platform: 'win32', arch: 'x64' };
    assert.throws(() => validateNativeTarget('win32', 'x64', linux), /Windows/);
    assert.throws(() => validateNativeTarget('linux', 'x64', windows), /Linux/);
    assert.throws(() => validateNativeTarget('linux', 'arm64', linux), /Linux/);
    assert.deepEqual(validateNativeTarget('linux', 'x64', linux), { platform: 'linux', arch: 'x64' });
    for (const arch of ['x64', 'ia32', 'arm64']) {
        assert.deepEqual(validateNativeTarget('win32', arch, windows), { platform: 'win32', arch });
    }
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
