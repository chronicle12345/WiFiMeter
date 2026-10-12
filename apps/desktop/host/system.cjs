'use strict';

// 系统级功能：开机启动、托盘、系统通知。
//
// 这些能力与窗口生命周期耦合，因此集中在一个模块里，主进程只负责在启动、
// 设置变更与退出时调用 applySettings / dispose。
//
// 开机启动按平台分两条路：
//
//   * Windows：宿主使用 windows-autostart.cjs，在登录启动项里登记，
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

function createSystemIntegration({ app, Tray, Menu, Notification, nativeImage, getWindow, iconPath, logger = () => {}, platform = process.platform, backgroundTest = false }) {
    let tray = null;
    let settings = { language: 'zh-CN', autoStart: false, minimizeToTray: false, notifications: true };
    let quitting = false;

    // 原生宿主负责使用实际的桌面可执行文件登记登录启动项。
    function applyWindowsAutostart(enabled, enableAutostart) {
        if (typeof app.setLoginItemSettings !== 'function') return false;
        const executable = process.env.WIFIMETER_APP_EXE || process.execPath;
        const options = { openAtLogin: enabled, path: executable };
        if (enableAutostart) options.enabled = true;
        const applied = app.setLoginItemSettings(options);
        if (typeof applied?.openAtLogin === 'boolean') return applied.openAtLogin;
        // 读回系统里的实际状态：组策略或安全软件可能拒绝写入。
        if (typeof app.getLoginItemSettings !== 'function') return enabled;
        return Boolean(app.getLoginItemSettings({ path: executable }).openAtLogin);
    }

    // Linux：写 XDG 自启动文件。
    async function applyLinuxAutostart(enabled) {
        const file = autostartFile(app.getPath('home'));
        if (!enabled) {
            await fs.rm(file, { force: true });
            return false;
        }
        // 使用原生桌面入口；APPIMAGE 保留 AppImage 的原有启动路径。
        const command = process.env.APPIMAGE ?? process.env.WIFIMETER_APP_EXE ?? process.execPath;
        // Desktop Entry 先处理字符串转义，再解析 Exec 引号及字面百分号。
        const quoted = '"' + command.replace(/%/g, '%%').replace(/["`$\\]/g, '\\$&')
            .replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
        const content = `[Desktop Entry]
Type=Application
Name=WiFiMeter
Comment=Wi-Fi 流量管理
Exec=${quoted}
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

    async function applyAutostart(enabled, enableAutostart) {
        if (platform === 'win32') return applyWindowsAutostart(enabled, enableAutostart);
        return applyLinuxAutostart(enabled);
    }

    function showWindow() {
        if (backgroundTest) return;
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
                    app.quit();
                }
            }
        ]));
    }

    function ensureTray() {
        try {
            if (tray) { updateTrayMenu(); return; }
            if (!Tray) return;
            tray = new Tray(nativeImage.createFromPath(iconPath));
            tray.setToolTip('WiFiMeter');
            updateTrayMenu();
            tray.on('click', showWindow);
        } catch (error) {
            // 无状态栏或初始化失败时保留主窗口，允许后续重试。
            const failedTray = tray;
            tray = null;
            try { failedTray?.destroy(); } catch (_) { /* 尽力释放未完成初始化的托盘。 */ }
            logger(`托盘不可用：${error.message}`);
        }
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

        initializeTray: ensureTray,

        // 设置变更后同步到系统；返回实际生效的结果，供界面校对。
        async applySettings(next, { enableAutostart = false } = {}) {
            settings = { ...settings, ...next };
            let autoStartApplied = settings.autoStart;
            let autoStartError;
            try {
                autoStartApplied = await applyAutostart(settings.autoStart, enableAutostart);
            } catch (error) {
                logger(`设置开机启动失败：${error.message}`);
                autoStartError = String(error?.message || '无法同步开机启动状态。');
                autoStartApplied = false;
                if (platform === 'win32' && typeof app.getLoginItemSettings === 'function') {
                    try { autoStartApplied = Boolean(app.getLoginItemSettings({ path: process.env.WIFIMETER_APP_EXE || process.execPath }).openAtLogin); }
                    catch { /* 保留原同步错误，不能把读取失败当成成功。 */ }
                }
            }
            // 默认常驻图标，旧 minimizeToTray 字段不再决定图标是否存在。
            ensureTray();
            return { autoStart: autoStartApplied, minimizeToTray: Boolean(tray), notifications: settings.notifications,
                ...(autoStartError ? { autoStartError } : {}) };
        },

        // 显式关闭到托盘不依赖旧的 minimizeToTray 设置，也不修改自启动项。
        hideToTray() {
            const window = getWindow();
            if (quitting || !window || window.isDestroyed()) return false;
            try {
                ensureTray();
            } catch (error) {
                const failedTray = tray;
                tray = null;
                try { failedTray?.destroy(); } catch (_) { /* 初始化失败后尽力释放托盘。 */ }
                logger(`托盘不可用：${error.message}`);
                return false;
            }
            if (!tray) return false;
            window.hide();
            return true;
        },
        // 后端的额度提醒转成系统通知；后台测试不向用户显示真实通知。
        notify(alert) {
            if (backgroundTest || !settings.notifications || !Notification) return false;
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
