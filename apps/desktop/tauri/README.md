# Windows Tauri migration

This directory adapts the existing renderer to Tauri. `build-frontend.mjs` copies the
renderer, styles, floating-window assets and the two browser dependencies without
bundling Electron or changing the page layout. The HTML entry script, CSP and host-dialog stylesheet are adapted. `src-tauri` contains the Rust host and the existing C++ collector's
JSON-lines client. No Node.js runtime is required by that host.

The migration is in progress. The default Electron launch and packaging commands
remain until the Windows feature and package acceptance tests pass. Do not publish
the intermediate Tauri host: autostart/notifications, application icons/control
and updates still need
integration. Automatic and manual legacy imports are connected: collection starts
after migration, failed imports keep it paused, and overlapping dates require an
explicit decision. Recovery backups preserve the original JSON text and counters.
System login-item inheritance will be connected with autostart integration.
Tray activation, close preferences, remembered choices and the renderer's existing
unsaved-change checks are connected to the native window lifecycle. Close, exit,
resume and import confirmations use the existing UI tokens and follow its theme
and language. Native dialogs remain available before the page is ready.
The floating window reuses the original renderer and supports all shapes/palettes,
physical-pixel placement with monitor DPI, edge snapping, idle collapse/hover
expansion, live speed units, reopening the main window and independent close.

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

The Windows WebView2 smoke test uses the existing C++ network fixtures and a
temporary profile. It checks navigation, collection controls, exact counters and
preference events, floating-window shapes/palettes, real native dragging,
edge snapping, idle collapse/hover expansion, close/reopen and live speed units,
themed close choices in light/dark mode, keyboard focus,
import/resume localization, tray hiding, single-instance activation and canceling
an exit with unsaved changes. It then closes the native window and
waits for a clean exit:

```powershell
$env:WIFIMETER_EXECUTABLE = (Resolve-Path 'apps/desktop/src-tauri/target/debug/WiFiMeter.exe').Path
$env:WIFIMETER_BACKEND = (Resolve-Path 'build/windows/app/wifimeter-backend.exe').Path
npm --prefix apps/desktop run test:tauri:windows
```

Run this test with Windows Node.js. CDP is enabled only in that test process; the
normal application does not open a debugging port.

API references: [Tauri commands](https://v2.tauri.app/develop/calling-rust/),
[events](https://v2.tauri.app/develop/calling-frontend/),
[Windows prerequisites](https://v2.tauri.app/start/prerequisites/).
