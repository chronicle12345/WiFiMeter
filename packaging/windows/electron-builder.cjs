const { build } = require('../../apps/desktop/package.json');

module.exports = {
    ...build,
    appId: 'io.wifimeter.demo',
    productName: 'WiFiMeter Demo',
    directories: { ...build.directories, output: '../../dist/windows' },
    extraMetadata: { name: 'wifimeter-demo', productName: 'WiFiMeter Demo' },
    win: {
        target: [{ target: 'nsis', arch: ['x64'] }],
        executableName: 'WiFiMeter Demo',
        icon: 'assets/icon.ico',
        requestedExecutionLevel: 'asInvoker'
    },
    nsis: {
        oneClick: false,
        perMachine: false,
        selectPerMachineByDefault: false,
        allowElevation: true,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: 'WiFiMeter Demo',
        uninstallDisplayName: 'WiFiMeter Demo',
        runAfterFinish: true,
        installerLanguages: ['zh_CN', 'en_US'],
        artifactName: 'WiFiMeter-Demo-${version}-${arch}-Setup.${ext}'
    }
};
