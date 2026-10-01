import { cp, mkdir, readFile, writeFile, chmod, symlink, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import targets from '../targets.cjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const appRoot = path.join(root, 'apps/desktop');
const metadata = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
const options = targets.buildOptions('linux', process.argv.slice(2));
const paths = targets.buildPaths('linux', options.arch);
const debArch = { x64: 'amd64', arm64: 'arm64' }[options.arch];
const unpacked = path.join(root, paths.output, paths.unpacked);
targets.checkPackaged(unpacked, 'linux', options.arch);
const stage = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-deb-'));
const output = path.join(root, paths.output, `WiFiMeter-${metadata.version}-linux-${debArch}.deb`);

try {
    const installDir = path.join(stage, 'opt/WiFiMeter');
    await cp(unpacked, installDir, { recursive: true, verbatimSymlinks: true });
    const capture = path.join(installDir, 'resources/wifimeter-app-capture');
    const dependencies = execFileSync('readelf', ['-d', capture], { encoding: 'utf8' });
    if (dependencies.includes('libbpf.so.')) throw Error('采集辅助进程应静态链接 libbpf。');
    // dpkg-deb assigns root ownership; Chromium's installed sandbox helper needs this mode.
    await chmod(path.join(installDir, 'chrome-sandbox'), 0o4755);
    await mkdir(path.join(stage, 'usr/bin'), { recursive: true });
    await symlink('/opt/WiFiMeter/wifimeter', path.join(stage, 'usr/bin/wifimeter'));
    await mkdir(path.join(stage, 'usr/share/applications'), { recursive: true });
    await writeFile(path.join(stage, 'usr/share/applications/wifimeter.desktop'), `[Desktop Entry]
Name=WiFiMeter
Comment=Wi-Fi traffic meter
Comment[zh_CN]=Wi-Fi 流量管理
Exec=/opt/WiFiMeter/wifimeter
Terminal=false
Type=Application
Icon=wifimeter
StartupWMClass=wifimeter
Categories=Network;
`);
    const icons = path.join(stage, 'usr/share/icons/hicolor/512x512/apps');
    await mkdir(icons, { recursive: true });
    await cp(path.join(appRoot, 'assets/icon.png'), path.join(icons, 'wifimeter.png'));
    await mkdir(path.join(stage, 'DEBIAN'));
    await writeFile(path.join(stage, 'DEBIAN/control'), `Package: ${metadata.name}
Version: ${metadata.version}
Section: net
Priority: optional
Architecture: ${debArch}
Maintainer: WiFiMeter contributors <noreply@wifimeter.local>
Homepage: ${metadata.homepage}
Depends: libc6 (>= 2.35), libstdc++6 (>= 11), libgtk-3-0 | libgtk-3-0t64, libnss3, libxss1, libxtst6, libgbm1, libasound2 | libasound2t64, libatspi2.0-0 | libatspi2.0-0t64, libuuid1, libsecret-1-0, libsqlite3-0, xdg-utils, libelf1 | libelf1t64, zlib1g, pkexec | policykit-1
Description: WiFiMeter Wi-Fi traffic meter for Linux
 Per-network Wi-Fi traffic collection, history, quotas and exports.
 Traffic is collected locally and stored in a local SQLite database.
`);
    execFileSync('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', stage, output], { stdio: 'inherit' });
    console.log(`Created ${output}`);
} finally {
    await rm(stage, { recursive: true, force: true });
}
