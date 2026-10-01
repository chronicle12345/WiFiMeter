'use strict';

// 系统级功能：开机启动、托盘、系统通知。
//
// 这些能力与窗口生命周期耦合，因此集中在一个模块里，主进程只负责在启动、
// 设置变更与退出时调用 applySettings / dispose。
//
// 开机启动按平台分两条路：
//
//   * Windows：Electron 的 setLoginItemSettings 在系统的登录启动项里登记，
//     由系统负责拉起，比自建快捷方式可靠；
//   * Linux：没有 setLoginItemSettings（那是 macOS/Windows 的接口），
//     按 XDG 约定写 ~/.config/autostart 下的 .desktop 文件。
//
// platform 可显式传入，便于在一种系统上验证另一种系统的分支。

const fs = require('node:fs/promises');
const path = require('node:path');

function autostartFile(home) {
    return path.join(home, '.config', 'autostart', 'wifimeter.desktop');
}

function createSystemIntegration({ app, Tray, Menu, Notification, nativeImage, getWindow, iconPath, logger = () => {}, platform = process.platform }) {
    let tray = null;
    let settings = { language: 'zh-CN', autoStart: false, minimizeToTray: false, notifications: true };
    let quitting = false;

    // Windows：登记或取消登录启动项。开发态（未打包）execPath 指向 electron 本体，
    // 因此把应用目录作为参数带上，登录后仍能加载正确的应用。
    function applyWindowsAutostart(enabled) {
        if (typeof app.setLoginItemSettings !== 'function') return false;
        const options = { openAtLogin: enabled, path: process.execPath };
        if (app.isPackaged === false) options.args = [path.resolve(__dirname, '..')];
        app.setLoginItemSettings(options);
        // 读回系统里的实际状态：组策略或安全软件可能拒绝写入。
        if (typeof app.getLoginItemSettings !== 'function') return enabled;
        return Boolean(app.getLoginItemSettings({ path: process.execPath }).openAtLogin);
    }

    // Linux：写 XDG 自启动文件。
    async function applyLinuxAutostart(enabled) {
        const file = autostartFile(app.getPath('home'));
        if (!enabled) {
            await fs.rm(file, { force: true });
            return false;
        }
        // 打包后 execPath 就是 /opt/WiFiMeter/wifimeter；开发态是 electron 本体。
        const command = process.env.APPIMAGE ?? process.execPath;
        const content = `[Desktop Entry]
Type=Application
Name=WiFiMeter
Comment=Wi-Fi 流量管理
Exec=${command}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
        // 每次读取实际文件，既避免重复写入，也能恢复被外部工具修改的启动项。
        try {
            if (await fs.readFile(file, 'utf8') === content) return true;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content);
        return true;
    }

    async function applyAutostart(enabled) {
        if (platform === 'win32') return applyWindowsAutostart(enabled);
        return applyLinuxAutostart(enabled);
    }

    function showWindow() {
        const window = getWindow();
        if (!window || window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
    }

    function updateTrayMenu() {
        tray.setContextMenu(Menu.buildFromTemplate([
            { label: settings.language === 'en' ? 'Open WiFiMeter' : '打开 WiFiMeter', click: showWindow },
            { type: 'separator' },
            {
                label: settings.language === 'en' ? 'Quit' : '退出',
                click: () => {
                    quitting = true;
                    app.quit();
                }
            }
        ]));
    }

    function ensureTray() {
        if (tray) { updateTrayMenu(); return; }
        if (!Tray) return;
        try {
            tray = new Tray(nativeImage.createFromPath(iconPath));
        } catch (error) {
            // 某些桌面环境没有状态栏（例如未装扩展的 GNOME），托盘不可用不应影响主功能。
            logger(`托盘不可用：${error.message}`);
            tray = null;
            return;
        }
        tray.setToolTip('WiFiMeter');
        updateTrayMenu();
        tray.on('click', showWindow);
    }

    function disposeTray() {
        if (!tray) return;
        tray.destroy();
        tray = null;
    }

    return {
        get quitting() {
            return quitting;
        },

        // 设置变更后同步到系统；返回实际生效的结果，供界面校对。
        async applySettings(next) {
            settings = { ...settings, ...next };
            let autoStartApplied = settings.autoStart;
            try {
                autoStartApplied = await applyAutostart(settings.autoStart);
            } catch (error) {
                logger(`设置开机启动失败：${error.message}`);
                autoStartApplied = false;
            }
            if (settings.minimizeToTray) ensureTray();
            else disposeTray();
            return { autoStart: autoStartApplied, minimizeToTray: Boolean(tray), notifications: settings.notifications };
        },

        // 窗口关闭时按设置决定隐藏还是退出。
        handleWindowClose(event) {
            if (quitting || !settings.minimizeToTray) return false;
            ensureTray();
            if (!tray) return false;
            event.preventDefault();
            const window = getWindow();
            if (window && !window.isDestroyed()) window.hide();
            return true;
        },

        // 后端的额度提醒转成系统通知；设置里关掉提醒就不打扰用户。
        notify(alert) {
            if (!settings.notifications || !Notification) return false;
            if (!Notification.isSupported()) return false;
            const name = alert.scope === 'total' ? (settings.language === 'en' ? 'Total Wi-Fi' : 'Wi-Fi 总额度') : alert.alias || alert.ssid || (settings.language === 'en' ? 'Current network' : '当前网络');
            const percent = Number(alert.percent ?? 0).toFixed(0);
            const body = alert.kind === 'quotaWarn'
                ? `${name} 已使用额度的 ${percent}%。`
                : alert.kind === 'quotaLimit' ? `${name} 已达到额度上限。`
                : alert.outcome === 0
                    ? `${name} 已达到额度上限，连接已断开。`
                    : `${name} 已达到额度上限，但未能断开：${alert.detail || '请检查系统状态'}`;
            const localizedBody = settings.language !== 'en' ? body : alert.kind === 'quotaWarn'
                ? `${name} has used ${percent}% of its quota.`
                : alert.kind === 'quotaLimit' ? `${name} has reached its quota.`
                : alert.outcome === 0 ? `${name} reached its quota and was disconnected.`
                : `${name} reached its quota but could not be disconnected: ${alert.detail || 'Check the system status.'}`;
            try {
                new Notification({ title: 'WiFiMeter', body: localizedBody, icon: iconPath }).show();
                return true;
            } catch (error) {
                logger(`发送通知失败：${error.message}`);
                return false;
            }
        },

        beginQuit() {
            quitting = true;
        },

        dispose() {
            disposeTray();
        }
    };
}

module.exports = { createSystemIntegration, autostartFile };
