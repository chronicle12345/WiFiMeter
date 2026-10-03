# Windows and Linux Tauri migration

This directory adapts the existing renderer to Tauri. `build-frontend.mjs` copies the
renderer, styles, floating-window assets and the two browser dependencies without
bundling Electron or changing the page layout. The HTML entry script, CSP and host-dialog stylesheet are adapted. `src-tauri` contains the Rust host and the existing C++ collector's
JSON-lines client. No Node.js runtime is required by that host.

The migration is in progress. The default Electron launch and packaging commands
remain until the Windows and Linux feature and package acceptance tests pass.
Do not publish the intermediate Tauri host: full Linux platform and release package
acceptance are still pending. All final packaging entry points will run on Linux.
Automatic and manual legacy imports are connected: collection starts
after migration, failed imports keep it paused, and overlapping dates require an
explicit decision. Recovery backups preserve the original JSON text and counters.
Windows autostart uses the existing `io.wifimeter.demo` login item and reads back
the applied state. Legacy imports inherit only the enabled current executable;
unmatched portable paths and failed migrations preserve existing entries until
an explicit preference change. Isolated profiles do not modify real login items.
Linux keeps Electron's `$XDG_CONFIG_HOME/WiFiMeter` profile (`~/.config/WiFiMeter`
by default). Autostart uses `autostart/wifimeter.desktop` under that config root,
quotes executable paths and uses the persistent AppImage launcher when available.
Quota alerts use the official Tauri notification plugin, with the existing language,
notification preference and application icon. Isolated profiles record dispatches
to stderr instead of posting real notifications. Windows notification identity must
still be verified with an installed release package, as required by the plugin.
Tray activation, close preferences, remembered choices and the renderer's existing
unsaved-change checks are connected to the native window lifecycle. Close, exit,
resume and import confirmations use the existing UI tokens and follow its theme
and language. Native dialogs remain available before the page is ready.
The floating window reuses the original renderer and supports all shapes/palettes,
physical-pixel placement with monitor DPI, edge snapping, idle collapse/hover
expansion, live speed units, reopening the main window and independent close.
Application icons are extracted with Windows Shell on background IPC workers and
returned as transparent PNG data URLs to the unchanged renderer. Only executable
paths present in backend application records are used; historical lookups,
bounded caches, concurrent request sharing and missing-icon fallbacks are preserved.
Application network control reuses the existing Windows policy module, embedded
in the host and extracted under the profile's `native/windows` directory. The
hidden runner validates local executable headers, preserves cancellation and
partial policy states, and retains the existing decimal upload-rate conversion.
Only the helper's PowerShell sessions set their execution policy; no registry
execution policy is changed. Drawer messages and picker titles follow the app
language; original provider diagnostics remain in detail fields.
Linux uses GIO/GTK file icons, GTK fallback confirmations and `xdg-open` for
validated update links. Per-application network controls remain unsupported on
Linux, as in the existing host, with localized feedback. Linux updates open the
release download page for manual installation.
The existing update page now uses the Rust update service, with persisted preferences,
automatic-check rate limits, release asset selection, streamed SHA-256 verification
and phase progress. Confirmation dialogs follow the UI theme and language. The
Windows helper locks and rechecks the installer, accepts a READY/GO handshake and
waits for the host to exit. Preparation checks unsaved changes and gracefully stops
collection; failures restore the original pause and application-collection states.
Pending shutdown or failed recovery keeps data operations blocked until recovery
succeeds. Automatic checks run only in non-debug, non-isolated builds. Actual release
installer upgrades still require package acceptance testing.

## Development on Linux

Install the [Linux Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#linux)
and `webkit2gtk-driver` for the real WebKitGTK test. Use a graphical session (or
`xvfb-run` in CI), a session D-Bus, and fonts for the UI language.

```sh
node apps/desktop/tauri/build-frontend.mjs
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --features custom-protocol,test-fixture --bin WiFiMeter
WIFIMETER_EXECUTABLE="$PWD/apps/desktop/src-tauri/target/debug/WiFiMeter" \
WIFIMETER_BACKEND="$PWD/build/app/wifimeter-backend" \
dbus-run-session -- node apps/desktop/tauri/smoke-linux.mjs
```

The test starts WebKitWebDriver directly using the same native capabilities as
tauri-driver, a temporary profile and the existing real-backend fixtures. It checks
pages, SQLite data, pause/resume, native file icons, language changes through the
settings UI, manual-update confirmations, and floating-window creation/IPC/close.
`WEBKIT_WEBDRIVER` can override the driver path; `WIFIMETER_SCREENSHOT` optionally
saves a screenshot. It never changes real login items or launches an installer.

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
preference events, isolated autostart changes, bilingual quota notification
dispatch and its off switch, floating-window shapes/palettes, real native dragging,
native application icons displayed by the existing application list,
read-only application policy queries and bilingual picker cancellation,
edge snapping, idle collapse/hover expansion, close/reopen and live speed units,
themed close choices in light/dark mode, keyboard focus,
import/resume localization, tray hiding, single-instance activation and canceling
an exit with unsaved changes. Update checks use local release/download fixtures;
the tests cover preference persistence, bilingual confirmation, verified download,
handoff failure and real collector recovery, unsaved-change cancellation, stale
error clearing and the manual release-page fallback. It then closes the native window and
waits for a clean exit:

Build the smoke-test host on Linux with the Windows cross compiler configured:

```sh
node apps/desktop/tauri/build-frontend.mjs
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --target x86_64-pc-windows-gnu --features custom-protocol,test-fixture --bin WiFiMeter
```

The update fixture is enabled only when `test-fixture`, debug assertions, test
isolation, and the profile's `update-fixture` directory are all present. That path
rejects installer handoff and records external-link requests instead of executing
them. Release builds do not contain the fixture transport. Point the Windows test
runner at that cross-built executable:

```powershell
$env:WIFIMETER_EXECUTABLE = (Resolve-Path 'apps/desktop/src-tauri/target/x86_64-pc-windows-gnu/debug/WiFiMeter.exe').Path
$env:WIFIMETER_BACKEND = (Resolve-Path 'build/windows/app/wifimeter-backend.exe').Path
npm --prefix apps/desktop run test:tauri:windows
```

Run this test with Windows Node.js. CDP is enabled only in that test process;
the normal application does not open a debugging port. Native drag/hover checks
require a Windows input desktop that accepts cursor positioning.

API references: [Tauri commands](https://v2.tauri.app/develop/calling-rust/),
[events](https://v2.tauri.app/develop/calling-frontend/),
[Windows prerequisites](https://v2.tauri.app/start/prerequisites/).
