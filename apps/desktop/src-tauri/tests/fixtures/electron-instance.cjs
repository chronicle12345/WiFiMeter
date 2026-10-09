'use strict';

const fs = require('node:fs');

function fail(error) {
    const details = error instanceof Error ? error.stack || error.message : String(error);
    try {
        fs.writeSync(2, `Electron 测试基础设施错误：${details}\n`);
    } finally {
        process.exit(1);
    }
}

// Electron 发现自定义处理器后会跳过默认的 JavaScript 错误弹窗。
// https://github.com/electron/electron/blob/v44.4.5/lib/browser/init.ts
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

// 只创建 Electron 的单实例资源，不加载业务、采集器或真实用户配置。
const path = require('node:path');
const { app } = require('electron');

const directory = process.argv[2];
const control = process.argv[3];
if (!directory || !path.isAbsolute(directory)) throw Error('测试需要独立的绝对数据目录。');
if (!control || !path.isAbsolute(control) || !fs.statSync(control).isDirectory()) {
    throw Error('测试需要独立的绝对控制目录。');
}

function publish(name, state) {
    // 先写临时文件再改名，让 Rust 只读取完整响应。
    const temporary = path.join(control, `${name}.tmp`);
    fs.writeFileSync(temporary, `${state} ${process.pid}\n`, { flag: 'wx' });
    fs.renameSync(temporary, path.join(control, name));
}

function requireLock() {
    if (!app.hasSingleInstanceLock()) throw Error('Electron 测试夹具已失去单实例锁。');
}

app.setName('WiFiMeter');
app.setPath('userData', directory);
app.disableHardwareAcceleration();
if (!app.requestSingleInstanceLock()) {
    publish('state', 'DENIED');
    app.quit();
} else {
    let nextPing = 1;
    const poll = setInterval(() => {
        if (fs.existsSync(path.join(control, 'exit'))) {
            clearInterval(poll);
            app.quit();
            return;
        }
        if (fs.existsSync(path.join(control, `ping-${nextPing}`))) {
            requireLock();
            publish(`pong-${nextPing}`, 'ALIVE');
            nextPing += 1;
        }
    }, 25);
    app.whenReady().then(() => {
        requireLock();
        publish('state', 'READY');
    }).catch(fail);
}
