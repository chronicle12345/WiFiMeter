# Build installers

English | [简体中文](README.zh-CN.md)

## Tauri installers

Run all commands from the repository root. The version comes from package metadata. Version 1.3.8 CI builds and publishes Windows x64 only. Windows x86/ARM64 and Linux x64/ARM64 jobs are temporarily commented out, but their native build helpers remain available. See the [platform documentation](../docs/PACKAGING-MATRIX.md) for active checks and paused targets.

Windows requires Node.js for the target architecture, a Rust MSVC toolchain, CMake and a C++20 compiler. Linux requires native toolchains and WebKitGTK 4.1. To build a Windows installer:

```powershell
npm ci --prefix apps/desktop --ignore-scripts
npm run dist:windows
```

Windows produces an NSIS installer by default; Linux produces deb, rpm and AppImage packages. Portable ZIPs have been discontinued. Builds and CI still validate internal SHA-256 manifests, which are excluded from Release attachments.

```text
dist/windows/WiFiMeter-1.3.8-windows-x64-Tauri-Setup.exe
```

The package contains the Node business process and C++ collector; Tauri uses the system WebView. The Windows installer downloads WebView2 if needed. Linux uses system WebKitGTK 4.1. User data stays in its original directory.

Packaging uses the current Node.js executable. Set `WIFIMETER_NODE_EXECUTABLE` to use another one. Release CI uses official Node.js 22.23.3 binaries from `actions/setup-node`. Node.js, Rust and the C++ collector must all match the target architecture. [runtime-check.cjs](tauri/runtime-check.cjs) checks TLS, Chinese collation, atomic file saves, subprocesses and download streams. Packages also include the matching Node.js license.

Legacy runtime trimming and cross-compilation tools are archived. The current helpers build and verify native Tauri packages and support installation. NSIS uses a 64 MiB LZMA dictionary. Linux RPM uses XZ, AppImage uses the official plugin's ZSTD support, and deb uses Tauri's compression configuration.

To reproduce the CI release configuration locally, use Node.js matching the target architecture. On Windows, install Python 3, the full 7-Zip distribution and the Visual Studio C++ toolchain. Native validation also needs WebView2 Runtime. Then run:

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

You can still build other architectures while their CI jobs are paused. Use matching Node.js and Rust targets when selecting an architecture explicitly:

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

The [CI matrix](../docs/PACKAGING-MATRIX.md) lists cache configuration and active or paused targets. Local builds do not need CI caches. See [Testing](../docs/TESTING.md#native-host-and-installers) for package verification commands and native prerequisites, and the [release notes](../docs/releases/v1.3.8.md) for installation instructions and version limits.

RPM validation checks package digests, then extracts with `bsdtar` from `libarchive-tools`. This supports packages for which Tauri's packaging library omits archive length fields while keeping extraction checks strict. A failed digest, extraction, resource or native UI check blocks release.

Use separate test installations and data directories to verify installation and system interaction. Check upgrades, shortcuts, the tray, a single startup registration, settings and backup restoration, and data integrity after exiting and reopening. Test quota notifications, actual network disconnection and download limits on the target machine with the required permissions and network conditions. Uninstallation preserves user data. Record packaged WebView automation separately from complete installation and uninstallation tests; each needs its own evidence.

## Verification and release

Use [Testing](../docs/TESTING.md) for checks, isolated profiles, diagnostics and the limits of each check. Release requirements and artifact counts are in the [CI and release matrix](../docs/PACKAGING-MATRIX.md). See [Development](../docs/DEVELOPMENT.md) for the development, review and decision-record process.

## Icon sources and validation

Edit `docs/assets/logo.svg`, then run `node packaging/generate-icons.cjs` to generate the desktop SVG, PNG and Windows ICO. Application windows, tray icons and installers share these resources. The Windows ICO contains 16, 24, 32, 48, 64, 128 and 256 px images with transparent rounded corners.

Icon checks compare the ICO images with the SVG and verify Tauri's installer icon configuration. On Windows with Microsoft Edge installed, run:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'msedge'
node --test packaging/icons.test.cjs
```

Omit the environment variable if Playwright Chromium is installed. Before release, also check the final PE icons and installer resources. Electron build entry points are archived; their release notes retain the details of those versions.
