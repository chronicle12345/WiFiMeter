# User guide

English | [简体中文](USAGE.zh-CN.md)

## Install and open

Download `WiFiMeter-Setup.exe` from the repository's Releases page and follow the installer. It installs into the current user's program directory without administrator rights. Open WiFiMeter from the desktop or Start menu. For a portable copy, extract `WiFiMeter-Portable.zip` and open `WiFiMeter.exe`, keeping the extracted files together. Neither version needs a terminal.

Windows 10 or 11, Windows PowerShell 5.1 and .NET Framework 4.7.2 or later are required. The installer is unsigned; Windows may show an unknown-publisher prompt. The app and installer default to English and include Simplified Chinese.

## Dates and networks

Choose All time, Today or This month. Custom dates opens a calendar dialog: select both dates and apply them. Both endpoints are included. Cancel keeps the previous range. The chart, table and CSV export use the selected range, with no top-network limit.

Click a network row to open its settings and usage details. A display name changes its label without changing the original SSID or merging its records. Original SSIDs remain visible in the details and CSV. Identical SSIDs share totals; names with different letter case remain separate.

## Traffic limits

In a network's settings, enter a limit in GB, choose Daily, Monthly or All time, and set the warning percentage. A limit of 0 disables the rule. Both download and upload count toward the limit. Daily limits reset at local midnight; monthly limits reset on the first day of the month.

A new rule starts from that period's retained records. Its active counter then survives restarts and history cleanup. Changing the amount preserves the counter. Changing the period starts the selected period from available records. Removing old records cannot recover earlier traffic when creating a new rule.

Warnings appear through the tray icon at the chosen percentage and at the limit. Windows notification settings can hide these messages. Disconnect at limit is off by default. When enabled, the collector checks that the adapter is still on the configured SSID before disconnecting it. Sampling runs every five seconds, so a download can exceed the limit between samples. Reconnecting while still over the limit can trigger another disconnection. Raise or disable that rule before reconnecting if you want to continue using the network.

## Application usage

The Applications and By day tabs show records from Windows for the selected network and dates. Queries run in the background; closing the details window cancels pending work. WiFiMeter uses observed adapter/profile-to-SSID mappings, so an older disconnected profile may need to be connected once while the collector is running.

Windows may report application activity later than the adapter counters, and the two totals can differ. The query covers at most the most recent 60 days, beginning no earlier than WiFiMeter's first tracking date or the configured retention cutoff. Missing Windows records stay unavailable. Application history is queried on demand; it is not a permanent archive. Up to four recent queries are cached for five minutes.

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
| `settings.json` | Language, retention, network names and limit rules |
| `usage.csv`, `daily.csv` | Generated exports of retained totals and daily records |
| `app-usage-profiles.json` | Observed Windows profile-to-SSID mappings |
| `app-usage.json` | Disposable application-query cache |
| Status files and logs | Process control and error information |

Stop collection before backing up or restoring this folder. If the primary record is damaged, the app tries its backup. If both copies are unreadable, it reports the error and preserves them. When Excel holds a CSV open, JSON saving continues; close Excel to allow the export to refresh.

Updates and uninstall preserve the data folder. Uninstall through Windows Installed apps or the installed `Uninstall.exe`. The uninstaller closes that installation's app, removes its managed files, shortcuts and startup entry, and preserves unrelated files.

## Accounting and troubleshooting

WiFiMeter measures this PC's wireless adapter, including local transfers and VPN traffic carried over Wi-Fi. Ethernet and other devices on the router are excluded. Figures are not an ISP bill. Collection begins when the program runs and saves changed totals about every ten seconds.

A first sample, a network change, a counter reset or a long sampling gap establishes a new baseline. Ambiguous increments are discarded; brief traffic near a transition can be missed. A fast switch away and back between samples can go undetected. Power loss can discard the latest unsaved records.

If no network appears, check the Wi-Fi connection. For read or save errors, inspect the in-app message and `collector.log`, `ui.log` or `host.log` in the data folder. If application details remain empty, try an earlier date range after Windows has updated its records.
