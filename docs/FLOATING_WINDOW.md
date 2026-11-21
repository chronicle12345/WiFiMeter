# Floating window

English | [简体中文](FLOATING_WINDOW.zh-CN.md)

On Windows, open Settings > General to enable the floating window. By default, it shows the combined download and upload speeds of all current connections. Choose a bar, square or circle, then adjust its colors, edge snapping and automatic hiding.

## Moving and hiding the window

Drag an empty area to move the window. Pin it to lock its position and disable dragging, edge snapping and automatic hiding. Unpinning restores your snapping and hiding settings. You can also change pinning in General settings; the choice is saved across restarts.

The keep-visible button toggles automatic hiding, also available in General settings. When snapping and automatic hiding are enabled, an unpinned window partly hides beyond the left or right screen edge after the pointer leaves. Move the pointer back to reveal it. At the top or bottom edge, the window stays fully visible. Keeping it visible still allows dragging, and the setting is saved across restarts.

When the application list is collapsed, hover over a square or circular window, or focus it with the keyboard, to reveal its title-area toolbar. Its six buttons pin the window, keep it visible, filter proxies, expand the application list, open the main window and close the floating window. Hover over or focus a button for its action and current state. Help uses the application theme, without native tooltips, and disappears when the pointer or focus leaves, the button is clicked or Escape is pressed.

## Application speeds and recent usage

Click the application-list button to see each application's live upload/download speeds and recent usage. The list scrolls beneath the combined rates. Click again to collapse it and restore the original shape. Keyboard input is available while the list is expanded.

Application capture needs system permissions. If the list says capture is disabled, open the main window and enable it on the Applications page. The list and main window share native capture data; loopback observations are not counted again as network-interface traffic.

Choose a range of 1 minute, 5 minutes, 1 hour or a custom 1–10080 minutes. The range and custom value are saved across restarts. The list shows the actual start and end dates and times, to the minute.

Usage comes from local calendar-minute records, including the current minute. The 1-minute range shows the current minute; 5 minutes includes it and the previous 4; 1 hour includes it and the previous 59. The current minute is still in progress. Older records retain their original precision, without fabricated minute details.

Speeds use units ending in `/s`; usage uses byte units. Unavailable speeds, disabled capture, insufficient permissions and missing records show the relevant status or `—`. A missing record does not mean zero traffic.

History queries run only while the list is expanded. Collapsing it or closing the window stops further queries. The same range refreshes at most once every 5 seconds; speeds update with live sampling.

## Excluding proxy traffic

Use the proxy-filter button or General settings to exclude proxy applications. This is off by default and saved across restarts. When enabled, the combined live speeds subtract the measured network speeds of identified proxies, and both lists hide their rows. Identification uses configured process names and known application identifiers from live or historical data. Add missing process names in Proxy settings if needed; the filter applies only to identified proxies.

Filtering requires working application capture and matching measurements. If capture is unavailable, a detected proxy cannot be identified, or a download/upload measurement is missing or exceeds the corresponding network total, that filtered direction shows `—`.

The filter leaves collected network totals, quotas and stored history unchanged. Recent usage still sums native minute records with proxy rows excluded; attribution estimates do not replace those records.

## Estimating traffic through a proxy

The expanded list's Live source selector offers Native capture and Include port estimates. Configure proxy ports in Proxy settings and enable application capture first. Observed connections identify the proxy; optional process names can help confirm it. The main window offers the same sources. Its choice lasts for the session, while the floating window saves its choice across restarts.

Port estimates allocate an identified proxy's current physical-network download and upload speeds in proportion to its clients' observed local TCP connection counts. Direct client traffic remains listed, and attributed shares carry an estimate marker. Successfully attributed proxy rows are replaced to avoid counting the same speeds twice. Unknown clients and undistributed shares remain estimated unattributed traffic. These values estimate attribution; they do not measure each client's actual transfer. Missing connection weights or proxy measurements leave native or unavailable values in place.

The selector changes application live rates only. Combined adapter rates, Wi-Fi totals, quotas and stored history stay unchanged. Recent usage continues to use native minute records, even with Include port estimates selected. It is never extrapolated from live speeds, and daily proxy connection weights do not establish minute-level attribution.
