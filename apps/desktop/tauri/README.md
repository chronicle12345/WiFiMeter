# Windows Tauri migration

This directory adapts the existing renderer to Tauri. `build-frontend.mjs` copies the
renderer, styles, floating-window assets and the two browser dependencies without
bundling Electron or changing the page layout. Only the HTML entry script and CSP
source change. `src-tauri` contains the Rust host and the existing C++ collector's
JSON-lines client. No Node.js runtime is required by that host.

The migration is in progress. The default Electron launch and packaging commands
remain until the Windows feature and package acceptance tests pass. Do not publish
the intermediate Tauri host: tray/close preferences, floating-window placement,
autostart/notifications, legacy import, application icons/control and updates still
need integration. The collector currently starts paused; automatic migration and
startup collection will be connected in the next lifecycle step.

## Development on Windows

Install Rust, the Visual Studio C++ build tools and WebView2, then run:

```powershell
npm ci --prefix apps/desktop
npm run build:backend
$env:WIFIMETER_BACKEND = (Resolve-Path 'build/windows/app/wifimeter-backend.exe').Path
# Use an isolated profile while the migration is incomplete.
$env:WIFIMETER_USER_DATA = Join-Path $env:TEMP 'wifimeter-tauri-development'
npm --prefix apps/desktop run dev:windows
```

The production profile remains `%APPDATA%\WiFiMeter Demo`, including `wifimeter.db`
and `window-preferences.json`. The test override also isolates WebView2 storage.

## Tests

```sh
npm --prefix apps/desktop run test:unit
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --features test-fixture
```

The protocol fixture is a separate Rust executable enabled only for tests. Run
the real collector test after building C++, with `WIFIMETER_BACKEND` set to the
absolute executable path:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test real_backend -- --ignored
```

Core tests can run on Linux without a Linux Tauri shell. Windows-only behavior,
WebView2 rendering, installation and memory/size measurements must be verified on
Windows before switching the release entry point.

API references: [Tauri commands](https://v2.tauri.app/develop/calling-rust/),
[events](https://v2.tauri.app/develop/calling-frontend/),
[Windows prerequisites](https://v2.tauri.app/start/prerequisites/).
