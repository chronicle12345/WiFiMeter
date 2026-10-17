# Multi-architecture packaging

English | [简体中文](README.zh-CN.md)

## Tauri installers

Run commands from the repository root; the version is read from package metadata. Version 1.3.6 CI builds and publishes only Windows x64; Windows x86/ARM64 and Linux x64/ARM64 configurations are temporarily commented out. Their native source build helpers remain available. Windows builds use target-architecture Node.js, a Rust MSVC toolchain, CMake and a C++20 compiler; Linux source builds use native toolchains and WebKitGTK 4.1. See the [platform documentation](../docs/PACKAGING-MATRIX.md) for active checks and paused targets.

```powershell
npm ci --prefix apps/desktop --ignore-scripts
npm run dist:windows
```

Windows generates only an NSIS installer by default; Linux generates deb, rpm, and AppImage packages. Portable ZIP files have been discontinued. Internal SHA-256 manifests remain part of build and CI validation, but are not Release attachments.

```text
dist/windows/WiFiMeter-1.3.6-windows-x64-Tauri-Setup.exe
```

Tauri uses the system WebView and bundles the Node business process and C++ collector. The Windows installer downloads WebView2 when it is missing; Linux uses system WebKitGTK 4.1. User data retains its original directory.

Packaging uses the current Node.js executable unless `WIFIMETER_NODE_EXECUTABLE` is set. Release CI uses the official Node.js 22.23.3 binaries supplied by `actions/setup-node`. The target architecture must match Node.js, Rust, and the C++ collector. [runtime-check.cjs](tauri/runtime-check.cjs) validates actual capabilities including TLS, Chinese collation, atomic file saves, subprocesses, and download streams. Release packages also retain the corresponding Node.js license.

Legacy runtime trimming and cross-compilation tools have been archived. Current sources retain native Tauri builds, validation, and installation helpers used by the current application. NSIS uses a 64 MiB LZMA dictionary. Linux RPM uses XZ compression, AppImage uses ZSTD supported by the official plugin, and deb retains Tauri's compression configuration.

To reproduce the CI release configuration locally, run these commands from the repository root. The current Node.js architecture must match the target. Windows also requires Python 3, a complete 7-Zip installation, and the Visual Studio C++ toolchain; native validation requires WebView2 Runtime.

```powershell
$nodeArch = node -p 'process.arch'
$rustTarget = @{ x64 = 'x86_64-pc-windows-msvc'; ia32 = 'i686-pc-windows-msvc'; arm64 = 'aarch64-pc-windows-msvc' }[$nodeArch]
rustup target add $rustTarget
if ($LASTEXITCODE) { throw 'Rust target installation failed' }
node packaging/tauri/runtime-check.cjs
if ($LASTEXITCODE) { throw 'Official Node runtime validation failed' }
node -e "require('./packaging/tauri/prepare.cjs').nodeLicense(); require('./packaging/tauri/verify-windows.cjs').sevenZipExecutable()"
if ($LASTEXITCODE) { throw 'Node license or 7-Zip lookup failed' }
node packaging/tauri/build.cjs --platform win32 --arch $nodeArch --target $rustTarget --formats nsis
if ($LASTEXITCODE) { throw 'Tauri build failed' }
node packaging/tauri/verify-windows.cjs --arch $nodeArch --target $rustTarget
```

The following source-build commands for other architectures remain available while their CI jobs are paused. When specifying a target architecture explicitly, Node.js must use that architecture and the Rust target must match:

```powershell
node packaging/tauri/build.cjs --platform win32 --arch ia32 --target i686-pc-windows-msvc --formats nsis
```

On Linux, run on a host with the target architecture and first install the system dependencies listed in [tauri-linux-deps.sh](../.github/workflows/scripts/tauri-linux-deps.sh):

```bash
set -euo pipefail
node_arch=$(node -p 'process.arch')
node packaging/tauri/runtime-check.cjs
export WIFIMETER_NODE_LICENSE=$(node -p "require('./packaging/tauri/prepare.cjs').nodeLicense({ license: require('node:path').resolve(require('node:path').dirname(process.execPath), '..', 'LICENSE') })")
npm run dist:linux
cargo install tauri-driver --version 2.0.5 --locked
node packaging/tauri/verify-linux.cjs --arch "$node_arch"
```

CI cache configuration and active/paused targets are maintained in the [CI matrix](../docs/PACKAGING-MATRIX.md). Local builds do not require those CI caches. Package verification entry points and their native prerequisites are maintained in [Testing](../docs/TESTING.md#native-host-and-installers). Installation instructions and version limits are in the [release notes](../docs/releases/v1.3.6.md).

RPM validation first checks package digests, then performs strict extraction using `bsdtar` from `libarchive-tools`, accommodating packages whose archive length fields are omitted by Tauri's packaging library. Any failed digest, extraction, resource, or native UI check prevents release.

Installation and system interaction validation uses separate test installations and data directories. Check installation, upgrades, shortcuts, the tray, a single startup registration, settings and backup restoration, and data integrity after exiting and reopening. Quota notifications, actual network disconnection, and download limiting require target-machine validation under actual permissions and network conditions. Uninstallation preserves user data. Record packaged WebView automation and complete installation/uninstallation validation separately; the former does not establish the latter's results.

## Verification and release

Follow [Testing](../docs/TESTING.md) for checks, isolated profiles, diagnostics, and evidence limits. The [CI and release matrix](../docs/PACKAGING-MATRIX.md) owns publication gates and artifact counts. Development, review, and decision records follow [Development](../docs/DEVELOPMENT.md).

## Icon sources and validation

The canonical logo is `docs/assets/logo.svg`. `node packaging/generate-icons.cjs` generates the desktop SVG, PNG, and Windows ICO. Windows, tray icons, and installers use the same resources. The Windows ICO contains seven sizes: 16, 24, 32, 48, 64, 128, and 256 px, retaining transparent rounded corners.

Icon checks validate actual ICO images, their correspondence with the SVG, and Tauri's installer icon configuration. On Windows with Microsoft Edge installed, run:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'msedge'
node --test packaging/icons.test.cjs
```

The environment variable can be omitted when Playwright Chromium is installed. Release validation must still check the final PE icons and corresponding installer resources. Historical Electron build entry points have been archived; published version notes retain the facts of those releases.
