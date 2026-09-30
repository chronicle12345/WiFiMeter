# User guide

English | [简体中文](USAGE.zh-CN.md)

## Install and open

Download `WiFiMeter-Setup.exe` from the repository's Releases page and follow the installer. It installs into the current user's program directory without administrator rights. Open WiFiMeter from the desktop or Start menu. For a portable copy, extract `WiFiMeter-Portable.zip` and open `WiFiMeter.exe`, keeping the extracted files together. Neither version needs a terminal.

Windows 10 or 11, Windows PowerShell 5.1 and .NET Framework 4.7.2 or later are required. The installer is unsigned; Windows may show an unknown-publisher prompt. The app and installer default to English and include Simplified Chinese.

## Dates and networks

Choose All time, Today or This month. Custom dates opens a calendar dialog: select both dates and apply them. Both endpoints are included. Cancel keeps the previous range. The chart, table and CSV export use the selected range, with no top-network limit.

The card can also draw a trend: a per-day download and upload line chart for the selected range across the listed networks. Ranges with fewer than two days of data show a placeholder instead of a line. The search field filters the network list as you type, matching display names and SSIDs without case sensitivity; the summary cards, the network count and the chart or table then reflect the filtered networks, while CSV export always covers the whole selected range.

Click a network row to open its settings and usage details. A display name changes its label without changing the original SSID or merging its records. The details dialog shows the original identity: Wi-Fi SSIDs unchanged and wired adapters under their reserved `Ethernet:` identity. The network list and CSV exports show wired adapters under their Windows connection name, or the alias you set for that identity, whenever this machine can identify the adapter; otherwise the raw `Ethernet:` identity is used. Wi-Fi SSIDs are always exported unchanged. Identical SSIDs share totals; names with different letter case remain separate.

## Traffic limits

In a network's settings, enter a limit in GB, choose Daily, Monthly or All time, and set the warning percentage. A limit of 0 disables the rule. Both download and upload count toward the limit. Daily limits reset at local midnight; monthly limits reset on the first day of the month.

A new rule starts from that period's retained records. Its active counter then survives restarts and history cleanup. Changing the amount preserves the counter. Changing the period starts the selected period from available records. Removing old records cannot recover earlier traffic when creating a new rule.

Settings also offer a total Wi-Fi limit that counts every metered Wi-Fi network together for a daily, monthly or all-time period. Wired Ethernet traffic is excluded from the total, and the total is independent of each network's own limit, so both kinds of rule can trigger in the same sample. The total counter is seeded from retained Wi-Fi records and then accumulates sampling deltas like a network counter. Disconnect at limit for the total disconnects every currently connected Wi-Fi adapter; wired connections stay connected. A total limit of 0 disables the rule.

Warnings appear through the tray icon at the chosen percentage and at the limit. Windows notification settings can hide these messages. Disconnect at limit is off by default. When enabled, the collector checks that the adapter is still on the configured SSID before disconnecting it. Sampling runs every five seconds, so a download can exceed the limit between samples. Reconnecting while still over the limit can trigger another disconnection. Raise or disable that rule before reconnecting if you want to continue using the network.

## Application usage

The Applications and By day tabs show records from Windows for the selected network and dates. Queries run in the background; closing the details window cancels pending work. Each program's icon appears next to its name whenever its executable can be identified, and a placeholder glyph appears otherwise. WiFiMeter uses observed adapter/profile-to-SSID mappings, so an older disconnected profile may need to be connected once while the collector is running.

Windows may report application activity later than the adapter counters, and the two totals can differ. The query covers at most the most recent 60 days, beginning no earlier than WiFiMeter's first tracking date or the configured retention cutoff. Missing Windows records stay unavailable. Application history is queried on demand; it is not a permanent archive. Up to four recent queries are cached for five minutes.

Traffic through a local proxy is attributed by Windows to the proxy process. In Settings you can enter the proxy's TCP ports and process names. The collector then records which programs open connections through the proxy each day, and application queries split those proxy bytes across the client programs by their share of observed connections. Bytes without such observations stay as a "Via proxy · unattributed" estimate. The split is an estimate: connections are sampled every five seconds so short connections can be missed, UDP and QUIC traffic is not visible to this method, and Windows reports bytes with a delay. Connection counts describe activity, not traffic volume.

The collector also counts the connections each program currently holds and keeps the busiest programs in its status data. The dashboard's Live apps card shows these counts for up to twelve programs and refreshes every few seconds; its Today usage view queries Windows on demand for the current network's application usage for today and states that the record may be delayed. These counts are activity hints only: real-time per-application byte rates would need administrator-level Windows counters that this app does not use, so no live rates are shown, a program's connection count can diverge from its actual traffic, and the today view follows the same limitations as the application queries above. When the only connection is wired, the card explains that Windows keeps no application usage for wired networks.

## Retention

Open Settings and enter how many local calendar days to keep. Today counts as one day; 0 keeps all metered daily records. Cleanup runs when collection starts, when the setting changes, and after the date changes. The recovery copy and generated CSV files are refreshed as well. A locked CSV refreshes after the other program releases it.

After cleanup, All time means all remaining daily records. Active quota counters and network settings remain so that deleting history does not silently reset a limit. Expired application query caches are removed during background maintenance. Deletion is permanent; back up the data folder before shortening retention if you may need those records later.

## Tray, closing and startup

The WiFiMeter icon appears in the Windows notification area while the app runs. Click it to reopen the window; Windows may place it under the hidden-icons arrow. Opening the app again activates the existing window.

Closing the window offers Minimize to tray, Exit and Cancel. Minimizing keeps collection running. Exit saves pending records, stops collection and removes the icon. The window's minimize button also sends it to the tray. Stop tracking pauses collection while leaving the interface available.

Start with Windows is off by default. Enable it to start in the tray after Windows sign-in. The WiFiMeter entry appears in Task Manager's Startup apps list. If disabled there, re-enable it through Windows startup settings. Turning off startup does not stop an already-running collector. After moving a portable copy, set up startup again from its new location.

The interface and collector use separate `WiFiMeter.exe` processes. Seeing two while the app is running is expected.

## Data and recovery

The data-folder button opens `%LOCALAPPDATA%\WiFiMeter\data`.

| File | Contents |
| --- | --- |
| `state.json`, `state.json.bak` | Metered daily records, active quota counters and recovery copy |
| `settings.json` | Language, retention, network names, limit rules and the total Wi-Fi limit |
| `usage.csv`, `daily.csv` | Generated exports of retained totals and daily records |
| `app-usage-profiles.json` | Observed Windows profile-to-SSID mappings |
| `app-usage.json` | Disposable application-query cache |
| `proxy-clients.json` | Daily deduplicated connections observed through the configured proxy |
| Status files and logs | Process control and error information |

Stop collection before backing up or restoring this folder. If the primary record is damaged, the app tries its backup. If both copies are unreadable, it reports the error and preserves them. When Excel holds a CSV open, JSON saving continues; close Excel to allow the export to refresh.

Updates and uninstall preserve the data folder. Uninstall through Windows Installed apps or the installed `Uninstall.exe`. The uninstaller closes that installation's app, removes its managed files, shortcuts and startup entry, and preserves unrelated files.

## Accounting and troubleshooting

WiFiMeter measures this PC's Wi-Fi and wired Ethernet adapters, including local transfers and VPN traffic they carry. Other devices on the router are excluded. Figures are not an ISP bill. Collection begins when the program runs and saves changed totals about every ten seconds.

A first sample, a network change, a counter reset or a long sampling gap establishes a new baseline; for wired adapters this includes plugging the cable in or out. Ambiguous increments are discarded; brief traffic near a transition can be missed. A fast switch away and back between samples can go undetected. Power loss can discard the latest unsaved records.

If no network appears, check the Wi-Fi connection or the wired network cable. For read or save errors, inspect the in-app message and `collector.log`, `ui.log` or `host.log` in the data folder. If application details remain empty, try an earlier date range after Windows has updated its records. Application usage records are not available for wired connections.
