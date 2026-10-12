# Floating Window

English | [简体中文](FLOATING_WINDOW.zh-CN.md)

Enable the desktop floating window on the General page of WiFiMeter settings on Windows. By default it shows combined download and upload rates across all current connections. It supports bar, square, and circular shapes, colors, edge snapping, and automatic hiding.

Click the floating window's application-list button to expand each application's live upload/download rates and usage for a recent time range. The list scrolls while the combined network rates remain at the top. Click the button again to collapse the list. Keyboard input is enabled while the list is expanded; collapsing it restores the original shape.

Choose 1 minute, 5 minutes, 1 hour, or a custom range of 1–10080 minutes. The selected range and custom value are saved automatically and reused after restarting the application. The list displays the actual start and end dates and times, to the minute.

Accumulated usage is summed from local calendar-minute records, including the current minute; historical usage is not extrapolated from live rates. The 1-minute range shows the current minute, the 5-minute range includes the current minute and the previous 4 minutes, and the 1-hour range includes the current minute and the previous 59 minutes. Results follow the database's minute precision, and the current minute is still in progress. Minute details are not fabricated for older records.

Live rates use units ending in `/s`; range usage uses byte units. When a rate cannot be obtained, application capture is disabled, permissions are insufficient, or records are missing, the UI shows the corresponding status or `—`. Missing records are not treated as zero traffic. The application list and main window share native capture data; loopback observations are not counted again in network-interface traffic.

Application capture requires the corresponding system permissions. If the list reports that capture is disabled, open the main window and enable capture on the Applications page. The background process reads minute details for the selected range only while the application list is expanded. Collapsing the list or closing the floating window stops further history queries. A snapshot for the same range is refreshed at most once every 5 seconds; rates refresh with live sampling.
