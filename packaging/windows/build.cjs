const path = require('node:path');

if (process.platform !== 'win32') {
    console.error('请在 Windows 10/11 x64 机器上运行 npm run dist:windows。此构建入口不使用 Docker。');
    process.exitCode = 1;
} else {
    const appDir = path.resolve(__dirname, '../../apps/desktop');
    const { build, Platform, Arch } = require(require.resolve('electron-builder', { paths: [appDir] }));
    // This is an unsigned demo build. Do not discover signing credentials or publish releases.
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete process.env[key];
    build({
        projectDir: appDir,
        config: path.join(__dirname, 'electron-builder.cjs'),
        targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
        publish: 'never'
    }).catch(error => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}
