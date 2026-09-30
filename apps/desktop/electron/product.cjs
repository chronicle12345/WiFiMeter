'use strict';

// 产品身份：应用名、App User Model ID 与用户数据目录。
//
// 为什么单独成一个模块：这三样东西决定“应用把数据写到哪里”，改名或改路径会让
// 老用户的数据看起来消失（旧目录还在，但新版本不再读它）。它们又是纯平台判断，
// 不需要真的启动 Electron 就能验证，因此从主进程里抽出来并加测试。
//
// 名称与路径与打包文档一致（packaging/windows/README.md、apps/desktop/README.md）：
//   * 应用名 / 产品名：各平台统一为 "WiFiMeter"；
//   * App User Model ID：io.wifimeter.demo（Windows 通知与任务栏分组用）；
//   * 数据目录：沿用 %APPDATA%\WiFiMeter Demo，升级后继续读取已有数据，卸载默认保留。

const path = require('node:path');

const WINDOWS_PRODUCT_NAME = 'WiFiMeter';
const DEFAULT_PRODUCT_NAME = 'WiFiMeter';
const WINDOWS_APP_ID = 'io.wifimeter.demo';
const WINDOWS_DATA_DIRECTORY = 'WiFiMeter Demo';

function productNameFor(platform) {
    return platform === 'win32' ? WINDOWS_PRODUCT_NAME : DEFAULT_PRODUCT_NAME;
}

// 应用在系统里的身份。返回值里的 userDataPath 为 null 表示沿用 Electron 的默认目录。
function productIdentityFor(platform, appDataPath) {
    if (platform !== 'win32') {
        return { productName: DEFAULT_PRODUCT_NAME, appUserModelId: null, userDataPath: null };
    }
    return {
        productName: WINDOWS_PRODUCT_NAME,
        appUserModelId: WINDOWS_APP_ID,
        userDataPath: path.join(appDataPath, WINDOWS_DATA_DIRECTORY)
    };
}

// 把身份写入 Electron 的 app 对象。测试可以传一个假的 app。
function applyProductIdentity(app, platform, appDataPath) {
    const identity = productIdentityFor(platform, appDataPath);
    app.setName(identity.productName);
    if (identity.appUserModelId) app.setAppUserModelId(identity.appUserModelId);
    if (identity.userDataPath) app.setPath('userData', identity.userDataPath);
    return identity;
}

module.exports = { applyProductIdentity, productIdentityFor, productNameFor, WINDOWS_APP_ID, WINDOWS_DATA_DIRECTORY };
