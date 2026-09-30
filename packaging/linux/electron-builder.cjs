const { build } = require('../../apps/desktop/package.json');

module.exports = {
    ...build,
    directories: { ...build.directories, output: '../../dist/linux' },
    // 采集后端随包分发；主进程通过 resources/wifimeter-backend 找到它。
    extraResources: [
        { from: '../../build/app/wifimeter-backend', to: 'wifimeter-backend' },
        { from: '../../build/app/wifimeter-app-capture', to: 'wifimeter-app-capture' },
        { from: '../../build/app/wifimeter-app-capture.bpf.o', to: 'wifimeter-app-capture.bpf.o' },
        { from: '../../backend/third_party/libbpf/LICENSE.BSD-2-Clause', to: 'licenses/libbpf.BSD-2-Clause' }
    ],
    electronDist: 'node_modules/electron/dist',
    linux: {
        target: ['dir'], executableName: 'wifimeter', category: 'Network',
        icon: 'assets/icon.png', syncDesktopName: true,
        desktop: { entry: { Name: 'WiFiMeter', Comment: 'Wi-Fi traffic demo', 'Comment[zh_CN]': 'Wi-Fi 流量管理演示版' } }
    }
};
