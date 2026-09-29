'use strict';

// 系统级功能：开机启动、托盘、系统通知。
//
// 这些能力与窗口生命周期耦合，因此集中在一个模块里，主进程只负责在启动、
// 设置变更与退出时调用 applySettings / dispose。
//
// Linux 上没有 Electron 的 setLoginItemSettings（那是 macOS/Windows 的接口），
// 开机启动按 XDG 约定写 ~/.config/autostart 下的 .desktop 文件。

const fs = require('node:fs/promises');
const path = require('node:path');

function autostartFile(home) {
    return path.join(home, '.config', 'autostart', 'wifimeter.desktop');
}

function createSystemIntegration({ app, Tray, Menu, Notification, nativeImage, getWindow, iconPath, logger = () => {} }) {
    let tray = null;
    let settings = { autoStart: false, minimizeToTray: false, notifications: true };
    let quitting = false;

    async function applyAutostart(enabled) {
        const file = autostartFile(app.getPath('home'));
        if (!enabled) {
            await fs.rm(file, { force: true });
            return false;
        }
        // 打包后 execPath 就是 /opt/WiFiMeter/wifimeter；开发态是 electron 本体。
        const command = process.env.APPIMAGE ?? process.execPath;
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, `[Desktop Entry]
Type=Application
Name=WiFiMeter
Comment=Wi-Fi 流量管理
Exec=${command}
Terminal=false
X-GNOME-Autostart-enabled=true
`);
        return true;
    }

    function showWindow() {
        const window = getWindow();
        if (!window || window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
    }

    function ensureTray() {
        if (tray || !Tray) return;
        try {
            tray = new Tray(nativeImage.createFromPath(iconPath));
        } catch (error) {
            // 某些桌面环境没有状态栏（例如未装扩展的 GNOME），托盘不可用不应影响主功能。
            logger(`托盘不可用：${error.message}`);
            tray = null;
            return;
        }
        tray.setToolTip('WiFiMeter');
        tray.setContextMenu(Menu.buildFromTemplate([
            { label: '打开 WiFiMeter', click: showWindow },
            { type: 'separator' },
            {
                label: '退出',
                click: () => {
                    quitting = true;
                    app.quit();
                }
            }
        ]));
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
            event.preventDefault();
            const window = getWindow();
            if (window && !window.isDestroyed()) window.hide();
            ensureTray();
            return true;
        },

        // 后端的额度提醒转成系统通知；设置里关掉提醒就不打扰用户。
        notify(alert) {
            if (!settings.notifications || !Notification) return false;
            if (!Notification.isSupported()) return false;
            const name = alert.alias || alert.ssid || '当前网络';
            const percent = Number(alert.percent ?? 0).toFixed(0);
            const body = alert.kind === 'quotaWarn'
                ? `${name} 已使用额度的 ${percent}%。`
                : alert.outcome === 0
                    ? `${name} 已达到额度上限，连接已断开。`
                    : `${name} 已达到额度上限，但未能断开：${alert.detail || '请检查系统状态'}`;
            try {
                new Notification({ title: 'WiFiMeter', body, icon: iconPath }).show();
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
