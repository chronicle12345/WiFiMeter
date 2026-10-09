# Linux 应用图标

Tauri 桌面壳通过 Freedesktop desktop 文件的 `Exec` 和 `Icon` 关联应用图标。
优先读取用户的 `XDG_DATA_HOME/applications`，再读取 `XDG_DATA_DIRS/applications`；
同名用户条目会覆盖系统条目。desktop 文件只用于读取元数据，其中的命令不会执行。

PNG 图标可直接读取。主题查找遵循 `index.theme` 的继承关系，最后查找 `hicolor` 和
`pixmaps`。当前主题优先从 `GTK_ICON_THEME` 或 GTK 的 `settings.ini` 读取；
系统存在 `gsettings` 时，也可以读取 GNOME 当前主题。这些系统工具都需要位于 `PATH`。

SVG 和 XPM 图标转换需要系统已有的 `gdk-pixbuf-thumbnailer`，属于 GdkPixbuf 工具。
WiFiMeter 不会自动安装它，也不会要求 Electron 或管理员权限。缺少转换工具、找不到图标
或图标格式无效时，应用列表继续显示默认图标。PNG 图标不依赖这个转换工具。

扫描数量、输入文件大小、主题候选数量和缓存数量均设有上限。只有转换时会在系统临时目录
创建 PNG，读取并验证后立即删除临时目录。图标查询不修改应用程序、desktop 文件或系统主题。
