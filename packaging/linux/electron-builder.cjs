const { build } = require('../../apps/desktop/package.json');

module.exports = {
    ...build,
    directories: { ...build.directories, output: '../../dist/linux' },
    electronDist: 'node_modules/electron/dist',
    linux: {
        target: ['dir'], executableName: 'wifimeter', category: 'Network',
        icon: 'assets/icon.png', syncDesktopName: true,
        desktop: { entry: { Name: 'WiFiMeter', Comment: 'Wi-Fi traffic demo', 'Comment[zh_CN]': 'Wi-Fi 流量管理演示版' } }
    }
};
