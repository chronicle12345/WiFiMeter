const { build } = require('../../apps/desktop/package.json');

module.exports = {
    ...build,
    electronLanguages: ['en-US', 'zh-CN'],
    appId: 'io.wifimeter.demo',
    productName: 'WiFiMeter',
    directories: { ...build.directories, output: '../../dist/windows' },
    extraMetadata: { name: 'wifimeter', productName: 'WiFiMeter' },
    // 采集后端随包分发；主进程通过 resources/wifimeter-backend.exe 找到它。
    // 本机构建与交叉编译都产出到 build/windows/app/。
    extraResources: [
        { from: '../../build/windows/app/wifimeter-backend.exe', to: 'wifimeter-backend.exe' },
        { from: '../../build/windows/app/wifimeter-app-capture.exe', to: 'wifimeter-app-capture.exe' },
        { from: 'native/windows/AppNetworkControl.psm1', to: 'native/windows/AppNetworkControl.psm1' }
    ],
    win: {
        target: [{ target: 'nsis', arch: ['x64'] }],
        executableName: 'WiFiMeter',
        icon: 'assets/icon.ico',
        requestedExecutionLevel: 'asInvoker'
    },
    portable: { artifactName: 'WiFiMeter-${version}-${arch}-Portable.${ext}' },
    nsis: {
        include: '../../packaging/windows/installer.nsh',
        oneClick: false,
        perMachine: false,
        selectPerMachineByDefault: false,
        allowElevation: true,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: 'WiFiMeter',
        uninstallDisplayName: 'WiFiMeter',
        runAfterFinish: true,
        installerLanguages: ['zh_CN', 'en_US'],
        artifactName: 'WiFiMeter-${version}-${arch}-Setup.${ext}'
    }
};
