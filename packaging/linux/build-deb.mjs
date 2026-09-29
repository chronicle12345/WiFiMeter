import { cp, mkdir, readFile, writeFile, chmod, symlink, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const appRoot = path.join(root, 'apps/desktop');
const metadata = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
const stage = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-deb-'));
const output = path.join(root, 'dist/linux', `WiFiMeter-${metadata.version}-linux-amd64.deb`);

try {
    const installDir = path.join(stage, 'opt/WiFiMeter');
    await cp(path.join(root, 'dist/linux/linux-unpacked'), installDir, { recursive: true, verbatimSymlinks: true });
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
Architecture: amd64
Maintainer: WiFiMeter contributors <noreply@wifimeter.local>
Homepage: ${metadata.homepage}
Depends: libgtk-3-0, libnss3, libxss1, libxtst6, libgbm1, libasound2, libatspi2.0-0, libuuid1, libsecret-1-0, libsqlite3-0, xdg-utils
Description: WiFiMeter Wi-Fi traffic meter for Linux
 Per-network Wi-Fi traffic collection, history, quotas and exports.
 Traffic is collected locally and stored in a local SQLite database.
`);
    execFileSync('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', stage, output], { stdio: 'inherit' });
    console.log(`Created ${output}`);
} finally {
    await rm(stage, { recursive: true, force: true });
}
