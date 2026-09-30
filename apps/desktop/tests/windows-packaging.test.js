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
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const unpacked = path.join(repositoryRoot, 'dist/windows/win-unpacked');
const applicationBinary = path.join(unpacked, 'WiFiMeter Demo.exe');
const bundledBackend = path.join(unpacked, 'resources/wifimeter-backend.exe');
const bundledCapture = path.join(unpacked, 'resources/wifimeter-app-capture.exe');
const installer = path.join(repositoryRoot, 'dist/windows/WiFiMeter-Demo-0.1.0-x64-Setup.exe');

// PE 文件的头两个字节是 "MZ"。
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

test('Windows 打包产物', { skip: !existsSync(applicationBinary) && '未构建 Windows 产物，先运行 npm run dist:windows' }, () => {
    assert.ok(existsSync(applicationBinary), '解包目录里应当有应用可执行文件');
    assert.ok(existsSync(bundledBackend), '解包目录里应当有随包分发的后端');
    assert.ok(existsSync(bundledCapture), '解包目录里应当有应用流量采集辅助进程');

    // 主进程按 resources/wifimeter-backend.exe 查找后端，路径写死在这里以防改名。
    assert.equal(path.basename(bundledBackend), 'wifimeter-backend.exe');

    // 后端必须是真正的 Windows 可执行文件，而不是误打包进去的 Linux 二进制。
    assert.ok(startsWithMz(bundledBackend), '后端应当是 Windows 可执行文件');
    assert.ok(statSync(bundledBackend).size > 100 * 1024, '后端体积明显偏小，可能复制失败');
    assert.ok(startsWithMz(bundledCapture), '应用流量采集辅助进程应当是 Windows 可执行文件');

    // 安装包同样要自报为可执行文件；完整安装与卸载留给 Windows 实机验收。
    // 只读头两个字节：安装包有 100 MB 以上。
    if (existsSync(installer)) {
        assert.ok(startsWithMz(installer), '安装包应当是 Windows 可执行文件');
    }
});

// 手工确认随包后端可用（需要 Wine 或 Windows）：
//
//   wine dist/windows/win-unpacked/resources/wifimeter-backend.exe --version
//   echo '{"id":1,"protocol":1,"method":"hello","params":{}}' | wine dist/windows/win-unpacked/resources/wifimeter-backend.exe --paused
