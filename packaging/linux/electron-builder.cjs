const { build } = require('../../apps/desktop/package.json');

module.exports = {
    ...build,
    electronLanguages: ['en-US', 'zh-CN'],
    directories: { ...build.directories, output: '../../dist/linux' },
    // 采集后端随包分发；主进程通过 resources/wifimeter-backend 找到它。
    extraResources: [
        { from: '../../build/app/wifimeter-backend', to: 'wifimeter-backend' },
        { from: '../../build/app/wifimeter-app-capture', to: 'wifimeter-app-capture' },
        { from: '../../build/app/wifimeter-app-capture.bpf.o', to: 'wifimeter-app-capture.bpf.o' },
        { from: '../../backend/third_party/libbpf/LICENSE.BSD-2-Clause', to: 'licenses/libbpf.BSD-2-Clause' },
        { from: '../../backend/platform/linux/COPYING.BPF', to: 'licenses/wifimeter-app-capture.GPL-2.0' }
    ],
    rpm: { depends: ['gtk3', 'nss', 'libXScrnSaver', 'libXtst', 'mesa-libgbm', 'alsa-lib', 'at-spi2-core', 'libuuid', 'libsecret', 'sqlite-libs', 'elfutils-libelf', 'zlib', 'polkit', 'xdg-utils'] },
    rpm: {
        depends: ['gtk3', 'nss', 'libXScrnSaver', 'libXtst', 'mesa-libgbm', 'alsa-lib',
            'at-spi2-core', 'libuuid', 'libsecret', 'sqlite-libs', 'xdg-utils', 'elfutils-libelf', 'polkit']
    },
    linux: {
        artifactName: 'WiFiMeter-${version}-linux-${arch}.${ext}',
        target: ['dir'], executableName: 'wifimeter', category: 'Network',
        icon: 'assets/icon.png', syncDesktopName: true,
        desktop: { entry: { Name: 'WiFiMeter', Comment: 'Network traffic monitor', 'Comment[zh_CN]': '网络流量统计' } }
    }
};
