# WiFiMeter

English | [简体中文](README.zh-CN.md)

<p align="center">
  <img src="docs/assets/screenshot.png" alt="WiFiMeter overview: current network, usage and trend" width="100%" />
</p>

A desktop meter that tracks traffic per Wi-Fi network, with one shared interface and backend
for Linux and Windows. Everything stays on the machine: the backend reads interface counters,
attributes them to networks, and stores history, quotas and preferences in a local SQLite
database. No network access, no account.

## The problem it solves

A router only sees the total for the whole connection, and an ISP bill is a single number.
Finding out *which network used the data* is usually guesswork. WiFiMeter keeps a separate
ledger per Wi-Fi network instead:

- traffic while connected to network A is booked to A only; switching to B starts from a new baseline;
- intervals with unknown attribution (just disconnected, network not yet identified) are recorded
  as gaps and are **never charged to the previous network**;
- every network gets its own quota and warning threshold, and an over-quota network can be
  disconnected automatically (off by default — a notification is the default).

## Features

**Collection**

- Reads interface counters every 2 / 5 / 10 seconds and shows live download and upload rates
  for the current network.
- Linux reads `/proc/net/dev` and gets network identity from `nmcli`; Windows uses the WLAN API
  for identity and the IP Helper API for counters, matching the same adapter on both sides by
  its interface alias.
- Samples that arrive much later than expected (for example after system sleep) are recorded as
  a gap and shown as such, never as zero traffic.
- Collection can be paused at any time; history stays readable while paused.

**Overview**

- Current connection: network name (notes take precedence), SSID, band, signal strength, live rates.
- Total, download and upload for the selected range, with their shares.
- Traffic trend chart (hourly for today, daily for other ranges).
- Quota progress and remaining allowance for the current network.
- Network usage table, sortable by usage, name or connected-first.

**Networks**

- One row per network: download, upload, total, quota progress, connected state.
- Add a note to any network — the original SSID is never modified, you just get a readable name.
- A detail view with that network's trend, recent records and its own quota settings.

**History**

- Daily totals with paging (10 days per page), range totals and daily average.
- Search, filter, and export exactly the range you are looking at.

**Quotas and alerts**

- Per-network cap, warning threshold (80% by default) and period (calendar month or day).
- A system notification when the threshold is reached; one master switch turns all notifications off.
- "Disconnect when over quota" is off by default and must be enabled per network. When enabled,
  the backend verifies that the adapter is actually associated with that network before
  disconnecting, then re-checks the result — a failed disconnect is reported honestly.

**Data**

- CSV / JSON export. The CSV carries a UTF-8 BOM (opens correctly in Excel) and escapes cells
  that would be interpreted as formulas; both export raw byte counts for the selected range.
- Full backup and restore covering records, notes, quotas and preferences. The file is tagged, so
  a traffic export cannot be restored as a backup by mistake. Collection pauses after a restore so
  the current counter delta cannot immediately overwrite what was just restored.
- Configurable retention (30 / 90 / 365 days or keep forever); shortening it asks for confirmation
  and suggests backing up first.
- Clearing records removes usage only and keeps notes and preferences.

**System integration**

- Start at login, minimise to tray on close, and quota alerts as system notifications.
- The interface is Chinese; adapter names, SSIDs and notes are handled as UTF-8, so Chinese text
  and emoji are never mangled.

## Installing

### Windows

Download `WiFiMeter-Demo-1.0.0-x64-Setup.exe` from [Releases](https://github.com/shw940/WiFiMeter/releases) and run the wizard.
The installer is unsigned, so SmartScreen may report an unknown publisher — choose
"More info" → "Run anyway".

- Install directory: `%LOCALAPPDATA%\Programs\WiFiMeter Demo`
- Data directory: `%APPDATA%\WiFiMeter Demo` (database `wifimeter.db`), kept on uninstall
- Uses a different name, install directory and data directory from the original WPF application,
  so both can coexist

### Linux

```bash
sudo apt install ./dist/linux/WiFiMeter-1.0.0-linux-amd64.deb
```

Launch it from the application menu or run `wifimeter`. The package depends on `libsqlite3-0`.
Uninstall with `sudo apt remove wifimeter-linux`.

### First run

1. Connect to a Wi-Fi network and wait for one sampling interval (5 seconds by default).
2. The overview shows the current network and live rates — collection is working.
3. Open **Networks** and give that Wi-Fi a note so it is easy to recognise later.
4. Set a cap and warning threshold in the network's detail view if you want one.
5. After some use, check **History** for the trend or press **Export** to save the records.

If nothing appears, press **Collection status** in the header: it reports the collector, the
adapters and any recorded gaps.

## Running from source

You need Node.js 22.12 or newer, npm and a graphical desktop. Building the backend additionally
needs CMake, a C++20 compiler and the SQLite development headers. Installing dependencies and the
first Electron download require an internet connection; **the application itself runs offline**.

```bash
npm ci --prefix apps/desktop
npm start
```

## Tests and packaging

```bash
npm test             # desktop unit tests + interface tests
npm run test:unit    # data, file actions and product identity
npm run test:ui      # Playwright drives the real Electron app and the real backend
npm run test:backend # C++ backend: build and run every ctest target
npm run test:windows # cross-compile the Windows test targets and run them under Wine
npm run dist:linux   # build the deb
npm run dist:windows # build the NSIS installer (natively on Windows, or cross-compiled on Linux)
```

Interface tests need a graphical session, use a temporary user profile and drive the real backend
with fake adapter data, so they **never change the machine's network state**. `npm run dist:linux`
builds the backend and packages it together with the application into the deb.

**Cross-platform tests**: `backend/tests/backend_process_support.h` is a single end-to-end suite
shared by both platforms — it starts a real backend process, speaks the protocol, and writes to
SQLite, with adapter and counter data injected through `--fake-adapter` / `--fake-counters`.
The same assertions produce the same result on Linux, under Wine and on a real Windows machine.

Two additional checks run on a real Windows machine:

```powershell
node packaging\windows\acceptance.mjs   # artifacts + read-only self-check + end-to-end + launching the packaged app
node packaging\windows\system-check.mjs # tray, export, backup
```

For build details, acceptance steps and troubleshooting see
[Windows build and acceptance](packaging/windows/README.md) and the
[acceptance checklist](packaging/windows/ACCEPTANCE.md).

## Layout

```text
apps/desktop/               shared Electron application, desktop integration and tests
backend/                    C++ backend: platform layer, business rules, SQLite storage, protocol, wifimeter-backend
backend/platform/linux/     Linux platform layer (/proc/net/dev + nmcli)
backend/platform/win32/     Windows system calls (WLAN API + IP Helper)
backend/platform/windows/   Windows platform layer and conversion logic testable anywhere
backend/third_party/sqlite/ SQLite amalgamation used by the Windows build
contracts/                  data formats and protocol boundaries
packaging/linux/            Linux deb packaging
packaging/windows/          native and cross Windows packaging, acceptance scripts and checklist
docs/                       architecture documentation and screenshots
```

Dependencies and the lockfile belong to `apps/desktop/`; the root `package.json` only forwards
commands and is not an npm workspace.

## Design decisions

- **Don't guess what you cannot see.** When network identity is unavailable, that traffic is
  recorded as a gap rather than charged to the previous network. Showing "an interval was not
  sampled" beats a continuous-looking but wrong history.
- **Never fail silently.** An unreadable adapter, an alias that does not match, or a kernel link
  contradicting the connection manager all report a concrete reason, so the interface shows what
  is actually wrong instead of "not connected".
- **Over-quota notification by default.** Automatic disconnection must be enabled explicitly, and
  the identity is verified before disconnecting and the result re-checked afterwards.
- **Data never leaves the machine.** No account, no cloud sync; the database is one local file and
  is kept on uninstall.

## Architecture

The Electron main process starts a `wifimeter-backend` child process and they exchange
line-delimited JSON; the page only reaches desktop capabilities and the backend through a
restricted preload bridge. Business rules, storage and the protocol live in the backend; each
platform only provides "read the counters" and "perform a disconnect", with the sampling sequence
written once in a shared implementation.

See the [architecture notes](docs/ARCHITECTURE.md) and the
[desktop documentation](apps/desktop/README.md).

## License

[MIT](LICENSE)
