# WiFiMeter

English | [简体中文](README.zh-CN.md)

WiFiMeter uses a shared Electron desktop application for Windows and Linux, with a planned local C++ backend for network collection and business data. The current application uses sample data. Linux deb packaging and native Windows NSIS packaging are configured. The Linux platform layer of the C++ backend is implemented and tested; its business logic, storage, IPC, and the Electron integration are not.

## Getting started

Use Node.js 22.12 or newer, npm, and a graphical desktop. Dependency installation and the first Electron download require an internet connection. The demo runs offline.

From the repository root:

```bash
npm ci --prefix apps/desktop
npm start
```

The application includes overview, networks, history, settings, simulated updates, quota editing, exports, and backup/restore. Startup, tray, and disconnect settings are previews; closing the window exits the application.

## Tests and Linux packaging

```bash
npm test
npm run test:unit
npm run test:ui
npm run test:backend
npm run dist:linux
```

UI tests require a graphical session and use temporary user profiles. Linux packaging targets Ubuntu x64 and uses electron-builder plus the system's `dpkg-deb`. Backend tests need CMake, a C++20 compiler, and the SQLite development headers (`libsqlite3-dev`); they read `/proc/net/dev` and `nmcli` but never change the machine's network state.

```bash
sudo apt install ./dist/linux/WiFiMeter-0.1.0-linux-amd64.deb
```

Launch WiFiMeter from the application menu or run `wifimeter`. Uninstall with `sudo apt remove wifimeter-linux`.

## Windows demo installer

On Windows 10/11 x64 with Node.js 22.12 or newer, run from the repository root:

```powershell
npm ci --prefix apps/desktop
npm run dist:windows
```

Output: `dist/windows/WiFiMeter-Demo-0.1.0-x64-Setup.exe`. The unsigned **WiFiMeter Demo** installer uses a separate name, installation directory, and data directory so it can coexist with the legacy application. Docker is not used. See the [Windows build and acceptance instructions](packaging/windows/README.md).

## Layout

- `apps/desktop/`: shared Electron application, sample data, and tests.
- `backend/`: C++ backend; the Linux platform layer and its tests are implemented.
- `contracts/`: current data format and future protocol boundaries.
- `packaging/linux/`: deb packaging; `packaging/windows/`: native Windows NSIS packaging.
- `legacy/windows/`: original WPF/PowerShell application, documentation, and tests.
- `docs/`: architecture documentation.
- `build/` and `dist/`: ignored build and distribution outputs.

See the [architecture](docs/ARCHITECTURE.md) and [desktop documentation](apps/desktop/README.md). Dependencies and the lockfile belong to `apps/desktop/`; the root package only forwards commands and is not an npm workspace.

## Legacy Windows application

The original application is preserved under [legacy/windows](legacy/windows/README.md). Run its original build and test commands from that directory. Existing GitHub Actions still build and release this legacy application; `v*.*.*` tags continue to trigger legacy releases.

## License

[MIT](LICENSE)
