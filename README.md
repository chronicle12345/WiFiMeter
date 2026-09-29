# WiFiMeter

English | [简体中文](README.zh-CN.md)

WiFiMeter is a Wi-Fi traffic meter for Linux and Windows. A shared Electron desktop application talks to a local C++ backend that reads interface counters, attributes them to networks, and stores history, quotas and preferences in a local SQLite database. Nothing leaves the machine. Both platform layers, the JSON protocol and the desktop integration are implemented: Linux reads `/proc/net/dev` and drives NetworkManager over `nmcli`, Windows uses the WLAN API for identity and the IP Helper API for counters.

## Getting started

Use Node.js 22.12 or newer, npm, a graphical desktop, and — to build the backend — CMake, a C++20 compiler and the SQLite development headers. Dependency installation and the first Electron download require an internet connection; the application itself runs offline.

From the repository root:

```bash
npm ci --prefix apps/desktop
npm start
```

The application includes overview, networks, history, settings, live updates, quota editing, exports, and backup/restore, all backed by real collection. Autostart and tray settings are stored and applied to the system.

## Tests and packaging

```bash
npm test
npm run test:unit
npm run test:ui
npm run test:backend
npm run test:windows
npm run dist:linux
npm run dist:windows
```

UI tests require a graphical session, use temporary user profiles, and drive the real backend with a fake adapter, so they never change the machine's network state. `npm run dist:linux` builds the backend and then packages both the application and the `wifimeter-backend` executable into the deb; the package depends on `libsqlite3-0`. Set `WIFIMETER_EXECUTABLE=dist/linux/linux-unpacked/wifimeter` to run the UI tests against the packaged build.

```bash
sudo apt install ./dist/linux/WiFiMeter-0.1.0-linux-amd64.deb
```

Launch WiFiMeter from the application menu or run `wifimeter`. Uninstall with `sudo apt remove wifimeter-linux`.

## Windows build

`npm run dist:windows` works on Windows 10/11 x64 and on Linux. On Windows it builds the backend with the local CMake and packages it with NSIS; on Linux it cross-compiles the backend and the installer with Zig and a portable Wine, downloading both on first use. Output: `dist/windows/WiFiMeter-Demo-0.1.0-x64-Setup.exe`, containing the unsigned **WiFiMeter Demo** application together with `wifimeter-backend.exe`. The demo uses a separate name, installation directory, and data directory so it can coexist with the legacy application. Docker is not used. See the [Windows build and acceptance instructions](packaging/windows/README.md).

`npm run test:windows` cross-compiles every test target and runs it under Wine, covering encoding, time zone, 64-bit counters, SQLite and the protocol. Behaviour that depends on real system calls (WLAN API, IP Helper) is covered by the acceptance checklist in the packaging documentation.

## Layout

- `apps/desktop/`: shared Electron application, desktop integration, and tests.
- `backend/`: C++ backend: platform layer (Linux and Windows), business rules, SQLite storage, IPC and the `wifimeter-backend` executable.
- `backend/third_party/sqlite/`: vendored SQLite amalgamation used by the Windows build.
- `contracts/`: current data format and future protocol boundaries.
- `packaging/linux/`: deb packaging; `packaging/windows/`: native and cross Windows NSIS packaging.
- `legacy/windows/`: original WPF/PowerShell application, documentation, and tests.
- `docs/`: architecture documentation.
- `build/`, `dist/` and `.cross-build/`: ignored build, distribution, and toolchain outputs.

See the [architecture](docs/ARCHITECTURE.md) and [desktop documentation](apps/desktop/README.md). Dependencies and the lockfile belong to `apps/desktop/`; the root package only forwards commands and is not an npm workspace.

## Legacy Windows application

The original application is preserved under [legacy/windows](legacy/windows/README.md). Run its original build and test commands from that directory. Existing GitHub Actions still build and release this legacy application; `v*.*.*` tags continue to trigger legacy releases.

## License

[MIT](LICENSE)
