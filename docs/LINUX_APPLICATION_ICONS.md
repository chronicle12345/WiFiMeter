# Linux Application Icons

English | [简体中文](LINUX_APPLICATION_ICONS.zh-CN.md)

The Tauri desktop shell associates application icons using `Exec` and `Icon` from Freedesktop desktop files. It reads the user's `XDG_DATA_HOME/applications` first, then `XDG_DATA_DIRS/applications`. A user entry overrides a system entry with the same name. Desktop files are read only as metadata; their commands are never executed.

PNG icons can be read directly. Theme lookup follows inheritance in `index.theme`, with `hicolor` and `pixmaps` as the final fallbacks. The current theme is first read from `GTK_ICON_THEME` or GTK's `settings.ini`. When `gsettings` is available, it can also read the current GNOME theme. These system tools must be available in `PATH`.

Converting SVG and XPM icons requires an existing system installation of `gdk-pixbuf-thumbnailer`, a GdkPixbuf tool. WiFiMeter does not install it automatically, and icon lookup does not require administrator permissions. If the converter is missing, the icon cannot be found, or its format is invalid, the application list continues to show the default icon. PNG icons do not depend on this converter.

Limits apply to scan counts, input file sizes, theme candidates, and cache entries. Only conversion creates a PNG in the system temporary directory; the temporary directory is removed immediately after the PNG is read and validated. Icon lookup does not modify applications, desktop files, or system themes.
