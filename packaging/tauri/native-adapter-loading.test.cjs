'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('打包目录中的真实适配器能够加载共享自启动模块', () => {
    const temporaryRoot = path.join(root, 'del');
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'native-adapter-loading-'));
    const runtime = path.join(directory, 'runtime');
    fs.mkdirSync(path.join(runtime, 'host'), { recursive: true });
    fs.copyFileSync(path.join(root, 'apps/desktop/tauri/native-adapter.cjs'), path.join(runtime, 'native-adapter.cjs'));
    fs.copyFileSync(path.join(root, 'apps/desktop/host/windows-autostart.cjs'), path.join(runtime, 'host/windows-autostart.cjs'));

    const { createNativeAdapter } = require(path.join(runtime, 'native-adapter.cjs'));
    const appExe = 'C:\\Program Files\\WiFiMeter\\WiFiMeter.exe';
    const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    const approvedKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
    const queries = [];
    const native = createNativeAdapter({
        configuration: { platform: 'win32', appExe, isPackaged: true, userData: path.join(directory, 'profile') },
        send() { assert.fail('模块加载测试不得调用原生窗口、通知或对话框'); },
        execute(executable, args, options) {
            assert.equal(executable, 'reg.exe');
            assert.equal(options.windowsHide, true);
            assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
            assert.equal(args[0], 'query');
            assert.ok([runKey, approvedKey].includes(args[1]));
            assert.equal(args[2], '/v');
            assert.ok(['WiFiMeter', 'io.wifimeter.demo'].includes(args[3]));
            assert.equal(args.length, 4);
            queries.push(args);
            if (args[1] === runKey && args[3] === 'WiFiMeter') {
                return Buffer.from(`\r\n${runKey}\r\n    WiFiMeter    REG_SZ    "${appExe}"\r\n`);
            }
            throw Object.assign(Error('Registry value does not exist.'), {
                status: 1, stderr: Buffer.from('ERROR: The system was unable to find the specified registry key or value.')
            });
        },
        executeAsync() { assert.fail('模块加载测试不得启动其他外部进程'); }
    });
    assert.deepEqual(native.app.getLoginItemSettings(), { openAtLogin: true, executableWillLaunchAtLogin: true });
    assert.equal(queries.length, 3);
});
