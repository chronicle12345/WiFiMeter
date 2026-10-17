# Testing and verification

English | [简体中文](TESTING.zh-CN.md)

This guide owns verification entry points and their limits. Run npm commands from the repository root; their definitions are in [package.json](../package.json). The [development workflow](DEVELOPMENT.md) explains when to update rules, guides, and Notes. The [CI and release matrix](PACKAGING-MATRIX.md) defines the active release requirements.

## Setup and entry points

Install Node.js and the locked desktop dependencies with `npm ci --prefix apps/desktop`. Backend fixtures require a matching native C++ toolchain and CMake. Rust and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) are required for the native host and installers. Use the [packaging guide](../packaging/README.md) for target-specific dependencies. Build the backend before desktop tests that exercise a real backend process.

| Command | Coverage and prerequisites |
| --- | --- |
| `npm test` | Desktop JavaScript unit/integration tests followed by Playwright; excludes CTest, Rust, packaging, CI helper, and documentation checks |
| `npm run test:unit` | Desktop host, bridge, storage, and fixture-based integration tests |
| `npm run test:ui -- <Playwright options>` | Browser UI regression through the actual page bridge and an isolated Node host |
| `npm run build:backend` | Builds the backend program for the current native target; does not run its tests |
| `npm run test:backend` | Configures and builds backend tests, then runs CTest in the platform build directory; handles Release configuration on Windows |
| `npm run test:packaging:tauri` | Tauri build, resource, installer-helper, and release-helper regression tests; some cases need their native platform |
| `npm run test:ci` | Existing CI report, validated-artifact reuse, and Linux cache helper regression tests |
| `npm run check:docs` | Pair records, Markdown structure and relative links, active Notes, instruction mirrors, and repository file policy |
| `npm run docs:budget` | Reports visible-prose usage and limits; `check:docs` enforces the limits |
| `npm run test:docs` | Regression tests for the repository documentation and policy tools |
| `npm run check:notes` | Active Notes metadata, required content, and lifecycle conventions |

`npm run check:docs` checks the repository as it stands; it does not update pair records. `npm run docs:pair -- <path> --reviewed` records an explicitly reviewed bilingual pair. `npm run docs:instructions` synchronizes instruction mirrors. Their workflow and exceptions are described in [bilingual documentation](i18n/README.md).

On Windows, browser tests use installed Microsoft Edge by default. Otherwise install the locked Playwright Chromium with `npm --prefix apps/desktop exec -- playwright install chromium`. CI uses the locked Chromium runtime and runs every `*.spec.js` in two Windows shards. [.github/workflows/scripts/ci.cjs](../.github/workflows/scripts/ci.cjs) rejects an empty run, unexpected skips, failures, global errors, and flaky retries. A successful retry is not sufficient for release.

## Verification by scope

| Changed scope | Relevant checks |
| --- | --- |
| Maintained documentation, Notes, or instructions | Review both languages, synchronize instruction mirrors or pair records as needed, then `check:docs`; use `check:notes` while editing Notes |
| Documentation or policy checking tools | `test:docs` and `check:docs` against the real repository |
| Desktop business logic or bridge | Relevant `test:unit` cases; add `test:ui` when visible behavior or interaction changes |
| Renderer and floating window | Relevant Playwright cases plus the native host checks when system WebView, windows, tray, or IPC behavior changes |
| C++ accounting, storage, or protocol | `test:backend`, affected desktop integration cases, and contracts/compatibility checks |
| Native collection or traffic control | Backend and platform tests plus actual target-machine checks for the changed system behavior |
| Rust host, resources, or packaging | Rust tests, `test:packaging:tauri`, target installer build, and packaged native WebView verification |
| CI helper or workflow | `test:ci`, relevant helper tests, pinned actionlint, and the affected platform checks |
| Product icons | `node --test packaging/icons.test.cjs` with the configured browser, plus the affected package/resource checks |

Choose tests for observable behavior and failure cases. For a reversible, low-impact edit, avoid adding a test that merely repeats the implementation. After relevant checks pass, repeat or broaden them only for a new change, a failure, or an unresolved concern. Record platform-dependent skips and missing prerequisites rather than treating them as evidence of success.

## Native host and installers

Rust host tests are separate from npm tests:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --features custom-protocol --locked
```

For an explicit target, use its matching Rust toolchain and `--target`. Build the installer with the [packaging commands](../packaging/README.md#tauri-installers), then use `node packaging/tauri/verify-windows.cjs` or, on Linux, `node packaging/tauri/verify-linux.cjs`. These helpers extract the actual packages, validate resources and executable architectures, and run the real host and backend in the system WebView. Linux validation requires its native driver, display/session environment, and platform dependencies.

Browser fixtures substitute operating-system windows, dialogs, and settings. Packaged WebView checks exercise the actual host, database, resources, and native WebView with isolated profiles and synthetic capture fixtures. Neither establishes complete installation/uninstallation, actual driver loading, quota disconnection, or download-limit throughput; validate those separately on the target machine. Preserve user data and record which kind of evidence was obtained.

Actual Windows ETW/EStats and Linux eBPF checks are documented in [Windows capture](WINDOWS_APP_CAPTURE.md#building-and-validation) and [Linux capture](LINUX_APP_CAPTURE.md#real-kernel-validation). Ordinary CTest may mark privileged checks skipped. CI explicitly requires the active Windows native checks; the Linux product and browser jobs are currently paused. A fixture, skip, or historical result cannot establish current native capture success.

## Isolation, diagnostics, and evidence

Use synthetic fixtures and isolated installations and data directories. Background checks disable visible windows, native dialogs, and notifications. Elevated capture helpers remain separate from the ordinary application and backend. Do not run tests against a personal database or alter personal firewall, quota, startup, or network settings without the appropriate isolated setup.

Reuse existing browsers, dependencies, and valid build caches. Keep local screenshots, logs, and temporary data in ignored `del/` or an explicitly isolated tool directory; CI uses `RUNNER_TEMP`. Move files when archiving local diagnostics. Keep credentials and private network details out of fixtures and published evidence.

Report commands, commit, platform, executed coverage, failures, skips, and remaining limits. Compare performance with the same workload and environment using [tools/performance](../tools/performance/). Installer sizes and timings must come from the current artifact and CI run; browser or microbenchmark results do not establish total application memory or startup performance.
