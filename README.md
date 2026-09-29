# WiFiMeter

English | [简体中文](README.zh-CN.md)

WiFiMeter is a Wi-Fi traffic meter for Linux and Windows. A shared Electron desktop application talks to a local C++ backend that reads interface counters, attributes them to networks, and stores history, quotas and preferences in a local SQLite database. Nothing leaves the machine. The Linux backend, its JSON protocol and the desktop integration are implemented; the Windows platform layer, system-level features (autostart, tray, notifications) and per-application accounting are not.

## Getting started

Use Node.js 22.12 or newer, npm, a graphical desktop, and — to build the backend — CMake, a C++20 compiler and the SQLite development headers. Dependency installation and the first Electron download require an internet connection; the application itself runs offline.

From the repository root:

```bash
npm ci --prefix apps/desktop
npm start
```

The application includes overview, networks, history, settings, live updates, quota editing, exports, and backup/restore, all backed by real collection. Autostart and tray settings are stored but not yet applied to the system.

## Tests and Linux packaging

```bash
npm test
npm run test:unit
npm run test:ui
npm run test:backend
npm run dist:linux
```

UI tests require a graphical session, use temporary user profiles, and drive the real backend with a fake adapter, so they never change the machine's network state. `npm run dist:linux` builds the backend and then packages both the application and the `wifimeter-backend` executable into the deb; the package depends on `libsqlite3-0`. Set `WIFIMETER_EXECUTABLE=dist/linux/linux-unpacked/wifimeter` to run the UI tests against the packaged build.

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

- `apps/desktop/`: shared Electron application, desktop integration, and tests.
- `backend/`: C++ backend: platform layer, business rules, SQLite storage, IPC and the `wifimeter-backend` executable.
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
