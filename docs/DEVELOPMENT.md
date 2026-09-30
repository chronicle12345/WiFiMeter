# Development

English | [简体中文](DEVELOPMENT.zh-CN.md)

## Build and test

Use Windows 10/11, Windows PowerShell 5.1 and .NET Framework 4.7.2 or later. The build uses the framework C# compiler and downloads no dependencies. PowerShell 7 is not the runtime target.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\Build.ps1
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\tests\Run-All.ps1
```

Build outputs are `dist/WiFiMeter-Setup.exe`, `dist/WiFiMeter-Portable.zip` and the unpacked `dist/WiFiMeter/` runtime. `-HostOnly` skips installer and ZIP generation during development.

The test runner checks PowerShell syntax and encoding, then runs accounting, preferences, quota, application usage, process, WPF, native host and installer tests. Registry tests use isolated keys and require current-user registry write access. Installation tests use a temporary directory, start their own background collector, and leave existing data and startup entries alone. Quota tests do not disconnect a real network.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\AppUsage.Tests.ps1 -Live
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\Measure-Performance.ps1
```

The optional live query reads Windows usage records. The performance script samples collector CPU, memory and adapter-read time without creating downloads. Results depend on the machine and stored history.

## Modules

| Component | Responsibility |
| --- | --- |
| `Host.cs` | GUI executable, STA PowerShell runspace, single-window activation and exit signals |
| `App.ps1`, `MainWindow.xaml`, `Dialogs.ps1` | Dashboard, modal forms, tray lifecycle and background application queries |
| `Strings.psm1` | English and Simplified Chinese interface text |
| `Sampler.psm1` | WinRT SSID discovery and .NET Wi-Fi and wired adapter byte counters |
| `Core.psm1` | Deltas, daily records, range queries, JSON recovery and CSV export |
| `Storage.psm1` | Atomic file replacement with bounded retries for short file locks |
| `Preferences.psm1` | Validated settings, atomic merge operations and retention rules |
| `QuotaRuntime.psm1`, `NetworkControl.cs` | Active quota counters, notification acknowledgements and guarded WLAN disconnection |
| `AppUsage.psm1` | Windows application attribution, profile mappings and bounded query cache |
| `AppMonitor.psm1`, `TcpTable.cs` | Proxy process attribution, per-application connection snapshots and bounded observation storage |
| `Control.psm1`, `Collector.ps1` | Collector lifecycle, sampling loop and login startup |
| `installer/Setup.cs` | Per-user installation, upgrade and uninstall |

## Accounting and storage

Samples arrive every five seconds. Changed records save about every ten seconds and on normal stop. Each interval belongs to the local date of its ending sample. Range endpoints are inclusive. SSID identity uses ordinal, case-sensitive comparison; aliases never change it.

The sampler matches WinRT profiles to adapter GUIDs and checks the connection before and after reading counters. A first sample, changed SSID, missing interface, reduced counter, backward clock adjustment or gap over 15 seconds resets the baseline. Ambiguous increments are discarded. [User guide](USAGE.md#accounting-and-troubleshooting) describes the resulting limits.

Wired Ethernet adapters are sampled by interface type without a Wi-Fi profile. They are tracked under reserved `Ethernet:<adapter GUID>` identities that also keep the adapter's connection name for display; plugging or unplugging reuses the same baseline and disconnected-cleanup rules. `Core.psm1` exposes `Test-MeterWiredIdentity` so quota totals and other consumers can exclude reserved identities. The range CSV export accepts optional connection names that replace reserved wired identities only; Wi-Fi SSIDs and unmapped identities are exported unchanged.

Data defaults to `%LOCALAPPDATA%\WiFiMeter\data`. Schema 1 in `state.json` stores daily records plus an optional `QuotaLedger`. Old records without that field remain readable. Active quota counters are saved with the daily state, independently of retention pruning. A new policy is seeded from retained history; later samples update its counter. Each active policy keeps warning and limit acknowledgements. Period or policy changes discard obsolete acknowledgements.

An optional top-level `TotalLimit` setting enables a quota across all Wi-Fi networks. Its counter is the separate `QuotaLedger.Total` member, never a pseudo-SSID inside `Networks`, and it validates with the same period-key and byte rules. Seeding and delta accumulation both exclude reserved wired identities through `Test-MeterWiredIdentity`, so wired traffic never enters the total; bytes mixed in could only be fixed by reseeding. When the total reaches its limit with disconnect enabled, the collector disconnects every WLAN adapter it currently samples, reusing the ten-second throttle and the native per-adapter SSID recheck. Total notices carry `Scope: Total` so the interface can word them separately.

JSON saves use temporary files and atomic replacement. The previous valid state becomes `state.json.bak`. Retention recalculates retained totals and rotates both state copies so recovery cannot restore deleted days. CSV files are derived exports; a locked export does not block JSON saving. Settings updates use a per-directory mutex and atomic replacement, so changing language cannot erase a concurrently saved network rule.

Application attribution uses `ConnectionProfile.GetAttributedNetworkUsageAsync`. Queries run in a UI worker with up to four native requests at once and a 15-second budget. Pending operations are cancelled and closed. Windows queries are limited to 60 days and clipped to tracking start and retention. The module returns explicit empty, partial, unavailable and timeout states; it never divides adapter totals among applications.

Proxy attribution is optional. When proxy TCP ports and process names are configured, the collector reads the owner-PID TCP tables every five seconds, classifies loopback connections to those ports as clients (a proxy row is one whose local port is configured or whose owner name is listed), and stores the day's deduplicated connections in `proxy-clients.json`. A connection counts once per local day by its local and remote address/port tuple; the file keeps at most 60 days, 1024 tuples and 48 clients per day, and obeys the retention setting. Application queries pass through `Repair-MeterProxyAttribution`, which redistributes the bytes Windows attributed to the proxy process across client applications by each day's share of deduplicated connections; days without observations keep a "via proxy · unattributed" estimate row. The split is an estimate: five-second sampling misses short connections, UDP and QUIC are outside the TCP tables, and Windows attributes bytes with a delay relative to the observed connections.

Independently of the proxy settings, the collector publishes a live per-application connection snapshot in `status.json` as `Apps`: established TCP rows are aggregated by owner process, analyzing at most 512 rows and publishing the twelve busiest programs. Connections measure activity, not volume. Real-time per-application byte rates would need administrator-enabled TCP eStats or ETW/WFP providers, which this unelevated app does not use, so it offers no live rates and no throttling. Daily per-application usage stays on the delayed Windows attribution.

The application cache stores at most four recent ranges, expires after five minutes, and is capped at 8 MiB. A query stops at 12,000 daily rows and asks for a shorter interval. Collector maintenance clears expired cached data. This cache is not an archive. Profile mappings use adapter GUID plus profile name observed with a connected SSID; a profile name alone is not treated as an SSID.

## Processes and startup

The executable opens the dashboard by default. `--tray` starts it hidden with a notification icon, `--background` runs the collector, and `--stop` requests both the window and collector to exit. `--data-directory` selects isolated data for tests. `--preview` uses demo data; `--snapshot` renders without starting collection or writing settings.

A named mutex keyed by the full data directory permits one normal window. A second launch signals its activation event. A separate event lets the stop command close the tray process after saving. An exclusive file lock prevents duplicate collectors. Process identity checks use PID and start time. Stop waits for the final save and process exit.

Closing the dashboard asks whether to minimize, exit or cancel. Minimize keeps the tray and collector alive. Exit stops collection before closing. Notification icons and query workers are disposed when their owners close.

Login startup registers `WiFiMeter.exe --tray` under the current user's `Software\Microsoft\Windows\CurrentVersion\Run`, value `WiFiMeter`. Task Manager can manage this entry. The app respects Windows disable states and does not modify `StartupApproved`.

The installer runs without elevation. It tracks owned files and shortcuts, stops its running tray instance before upgrade or removal, and preserves the data directory and unrelated files.

## Security and performance

Arguments reach PowerShell as parameters rather than interpolated script text. The app does not read Wi-Fi passwords, send telemetry or listen on a port. SSIDs remain data. CSV fields are quoted and spreadsheet formula prefixes are escaped. Settings and cached records are validated; logs and query caches have size bounds. Files inherit folder permissions and are not encrypted.

Disconnect rules are disabled by default. The native WLAN helper re-reads the current SSID and checks an exact match before calling `WlanDisconnect` for the configured adapter. Repeated attempts are throttled. This is a sampled limit, not an exact byte-level firewall.

The collector stays in one process and avoids rewriting unchanged history. Settings reload only after their file changes; profile discovery runs once a minute. The dashboard caches saved state, skips chart redraws when its input is unchanged, and refreshes less work while hidden. Application grids virtualize rows.

## Editing conventions

Follow `.editorconfig` and `.gitattributes`. PowerShell files use UTF-8 BOM and CRLF for Windows PowerShell 5.1; Markdown and SVG use UTF-8 and LF. Keep interface strings and both documentation languages in sync. Screenshots use demo records. Build files, logs, test artifacts and runtime data remain ignored by Git.

References: [Windows startup apps](https://learn.microsoft.com/en-us/windows/win32/w8cookbook/startup-apps), [Run registry keys](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys), [desktop application usage queries](https://devblogs.microsoft.com/oldnewthing/20210521-00/?p=105234), [WlanDisconnect](https://learn.microsoft.com/en-us/windows/win32/api/wlanapi/nf-wlanapi-wlandisconnect).
