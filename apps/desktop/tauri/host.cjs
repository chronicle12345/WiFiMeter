'use strict';

const path = require('node:path');
const readline = require('node:readline');
const fs = require('node:fs');
const { createNativeAdapter } = require('./native-adapter.cjs');
const options = new Map();
for (let i = 2; i < process.argv.length - 1; i += 2) options.set(process.argv[i], process.argv[i + 1]);
const resourcePath = options.get('--resources-path') || process.env.WIFIMETER_RESOURCES_PATH || path.resolve(__dirname, '../..');
const versionFile = path.join(resourcePath, 'runtime', 'package.json');
const metadata = JSON.parse(fs.readFileSync(fs.existsSync(versionFile) ? versionFile : path.resolve(__dirname, '../package.json'), 'utf8'));
const initialScreen = process.env.WIFIMETER_SCREEN ? JSON.parse(process.env.WIFIMETER_SCREEN) : undefined;
const configuration = {
    userData: options.get('--user-data') || process.env.WIFIMETER_HOST_USER_DATA,
    appExe: options.get('--app-exe') || process.env.WIFIMETER_APP_EXE,
    isPackaged: options.get('--packaged') === 'true' || process.env.WIFIMETER_IS_PACKAGED === 'true',
    version: metadata.version,
    displays: initialScreen?.displays || initialScreen
};
if (!configuration.userData || !configuration.appExe) throw Error('桌面宿主没有提供数据目录或可执行文件路径。');
// 标准输出只传协议；业务日志转到标准错误，避免破坏 JSON 行。
console.log = (...args) => console.error(...args);
process.resourcesPath = resourcePath;
process.env.WIFIMETER_APP_EXE = configuration.appExe;
let outputClosed = false, disconnectStarted = false;
const send = message => { if (!outputClosed) process.stdout.write(JSON.stringify(message) + '\n'); };
const runtime = createNativeAdapter({ configuration, send });
function disconnect() {
    if (disconnectStarted) return;
    disconnectStarted = true;
    outputClosed = true;
    runtime.disconnect();
    // 后端停机包含响应等待与退出等待，给两段 3 秒等待及清理留足时间。
    setTimeout(() => process.exit(process.exitCode || 0), 10000).unref();
}
process.stdout.on('error', error => { if (error.code === 'EPIPE') disconnect(); else throw error; });
const packaged = path.join(resourcePath, 'runtime', 'host', 'main.cjs');
const main = fs.existsSync(packaged) ? packaged : path.resolve(__dirname, '../host/main.cjs');
require(path.join(path.dirname(main), 'desktop-runtime.cjs')).configureDesktopRuntime(runtime.api);
require(main);

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
    try { runtime.receive(JSON.parse(line)).catch(error => console.error('[host]', error.message)); }
    catch (error) { console.error('[host] 无效的宿主消息：', error.message); }
});
input.on('close', disconnect);
process.on('uncaughtException', error => { console.error(error); send({ type: 'fatal', message: error.message }); process.exitCode = 1; runtime.app.quit(); });
process.on('unhandledRejection', error => { console.error(error); send({ type: 'fatal', message: error?.message || String(error) }); process.exitCode = 1; runtime.app.quit(); });
