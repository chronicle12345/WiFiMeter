# Floating Window

English | [简体中文](FLOATING_WINDOW.zh-CN.md)

Enable the desktop floating window on the General page of WiFiMeter settings on Windows. By default it shows combined download and upload rates across all current connections. It supports bar, square, and circular shapes, colors, edge snapping, and automatic hiding.

The current source adds themed help for the six toolbar buttons: pin, keep visible, proxy filter, application list, open the main window and close the floating window. Hover over a button or focus it with the keyboard to see its action and current state. The explanation disappears when the pointer leaves, focus moves away, the button is clicked or Escape is pressed. These explanations use the application's theme without native tooltip popups; they are not yet included in the published 1.3.4 installer.

Drag an empty area of the floating window to move it. Click the pin button to lock its current position. While pinned, dragging, edge snapping, and automatic hiding are disabled. Unpinning restores the configured snapping and hiding behavior. You can also change pinning in General settings; the choice is saved and reused after restarting the application.

The keep-visible button toggles automatic hiding, which can also be changed in General settings. With edge snapping and automatic hiding enabled, an unpinned window hides partly beyond the left or right screen edge after the pointer leaves and reappears when the pointer returns. At the top or bottom edge it remains fully visible. Keeping it visible does not lock its position; the setting is saved across restarts.

Use the proxy-filter button or General settings to choose whether to exclude proxy application traffic. This option is off by default and is saved across restarts. When enabled, the displayed combined live rates subtract measured network rates of identified proxy applications, and the live and usage lists hide matching proxy application rows. Proxy applications are identified from configured process names and known live or historical application identifiers. The option applies only to identified proxy applications; if needed, set the proxy process names on the existing Proxy settings page.

Proxy exclusion requires working application capture and matching measurements. If capture is unavailable, a detected proxy cannot be identified, or a required download/upload measurement is missing or exceeds the corresponding network total, the affected filtered rate shows `—`. This display option does not change collected network totals, quotas, or stored history. Accumulated usage continues to use native minute records with proxy rows excluded; proxy attribution estimates do not replace those records.

Click the floating window's application-list button to expand each application's live upload/download rates and usage for a recent time range. The list scrolls while the selected combined rates remain at the top. Click the button again to collapse the list. Keyboard input is enabled while the list is expanded; collapsing it restores the original shape.

Choose 1 minute, 5 minutes, 1 hour, or a custom range of 1–10080 minutes. The selected range and custom value are saved automatically and reused after restarting the application. The list displays the actual start and end dates and times, to the minute.

Accumulated usage is summed from local calendar-minute records, including the current minute; historical usage is not extrapolated from live rates. The 1-minute range shows the current minute, the 5-minute range includes the current minute and the previous 4 minutes, and the 1-hour range includes the current minute and the previous 59 minutes. Results follow the database's minute precision, and the current minute is still in progress. Minute details are not fabricated for older records.

Live rates use units ending in `/s`; range usage uses byte units. When a rate cannot be obtained, application capture is disabled, permissions are insufficient, or records are missing, the UI shows the corresponding status or `—`. Missing records are not treated as zero traffic. The application list and main window share native capture data; loopback observations are not counted again in network-interface traffic.

Application capture requires the corresponding system permissions. If the list reports that capture is disabled, open the main window and enable capture on the Applications page. The background process reads minute details for the selected range only while the application list is expanded. Collapsing the list or closing the floating window stops further history queries. A snapshot for the same range is refreshed at most once every 5 seconds; rates refresh with live sampling.
