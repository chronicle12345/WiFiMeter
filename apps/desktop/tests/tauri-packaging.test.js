import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { targetTriple, bundleConfig, checkDistribution } = require('../../../packaging/tauri.cjs');
const { buildOptions, buildPaths } = require('../../../packaging/targets.cjs');
const root = path.resolve(import.meta.dirname, '../../..');

test('Linux 打包计划覆盖 Windows x64 与 Linux 本机架构，资源匹配宿主查找路径', () => {
    assert.equal(targetTriple('win32', 'x64'), 'x86_64-pc-windows-gnu');
    assert.equal(targetTriple('linux', 'arm64'), 'aarch64-unknown-linux-gnu');
    assert.throws(() => targetTriple('win32', 'arm64'), /暂不支持/);
    for (const platform of ['win32', 'linux']) {
        const options = buildOptions(platform, [], { platform: 'linux', arch: 'x64' });
        const config = bundleConfig(options);
        const destinations = Object.values(config.bundle.resources);
        assert.ok(destinations.includes(`wifimeter-backend${platform === 'win32' ? '.exe' : ''}`));
        assert.ok(destinations.includes(`wifimeter-app-capture${platform === 'win32' ? '.exe' : ''}`));
        assert.ok(destinations.every(name => !name.startsWith('resources/')));
        assert.ok(!JSON.stringify(config).includes('electron'));
        for (const source of Object.keys(config.bundle.resources)) {
            if (source.includes(`${path.sep}build${path.sep}`)) continue;
            assert.ok(existsSync(source), source);
        }
        assert.deepEqual(config.bundle.targets, platform === 'win32' ? ['nsis'] : ['deb']);
        if (platform === 'linux') {
            assert.ok(destinations.includes('wifimeter-app-capture.bpf.o'));
            assert.ok(config.bundle.linux.deb.conflicts.includes('wifimeter-linux'));
        }
    }
});

test('Windows 发布目录必须同时包含主程序、采集器和同架构 WebView2 加载器', t => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tauri-package-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const pe = machine => {
        const header = Buffer.alloc(256);
        header.write('MZ'); header.writeUInt32LE(128, 0x3c);
        header.write('PE\0\0', 128); header.writeUInt16LE(machine, 132);
        return header;
    };
    for (const name of ['WiFiMeter.exe', 'wifimeter-backend.exe', 'wifimeter-app-capture.exe']) {
        writeFileSync(path.join(directory, name), pe(0x8664));
    }
    assert.throws(() => checkDistribution(directory, 'win32', 'x64'), /WebView2Loader/);
    writeFileSync(path.join(directory, 'WebView2Loader.dll'), pe(0xaa64));
    assert.throws(() => checkDistribution(directory, 'win32', 'x64'), /架构不匹配/);
    writeFileSync(path.join(directory, 'WebView2Loader.dll'), pe(0x8664));
    checkDistribution(directory, 'win32', 'x64');
});

test('Linux 发布目录校验安装布局和 eBPF 资源', t => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tauri-linux-package-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const elf = Buffer.alloc(64);
    elf.write('\x7fELF', 0, 'binary'); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18);
    for (const name of ['bin/wifimeter', 'lib/WiFiMeter/wifimeter-backend', 'lib/WiFiMeter/wifimeter-app-capture']) {
        mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
        writeFileSync(path.join(directory, name), elf);
    }
    assert.throws(() => checkDistribution(directory, 'linux', 'x64'), /bpf/);
    writeFileSync(path.join(directory, 'lib/WiFiMeter/wifimeter-app-capture.bpf.o'), 'bpf');
    checkDistribution(directory, 'linux', 'x64');
});

for (const platform of ['win32', 'linux']) {
    const paths = buildPaths(platform, 'x64');
    const directory = path.join(root, paths.output, paths.unpacked);
    const binary = path.join(directory, platform === 'win32' ? 'WebView2Loader.dll' : 'bin/wifimeter');
    test(`Tauri ${platform} 实际发布资源`, { skip: !existsSync(binary) && '尚未生成 Tauri 包' }, () => {
        checkDistribution(directory, platform, 'x64');
        assert.ok(!existsSync(path.join(directory, 'resources/app.asar')));
        const resources = platform === 'win32' ? directory : path.join(directory, 'lib/WiFiMeter');
        for (const [source, target] of Object.entries(bundleConfig(buildOptions(platform, [], { platform: 'linux', arch: 'x64' })).bundle.resources)) {
            assert.deepEqual(readFileSync(path.join(resources, target)), readFileSync(source));
        }
    });
}
