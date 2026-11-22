# Domain and connection monitoring

English | [简体中文](CONNECTION_MONITORING.zh-CN.md)

WiFiMeter can read the connections handled by a local Clash / Mihomo controller. The connection page shows domains, destination addresses, applications, matched routing rules, outbound chains, connection bytes and observed transfer rates.

## Set up the controller

Enable the external controller in your proxy application and note its local address and secret. A Mihomo configuration can use:

```yaml
external-controller: 127.0.0.1:9090
secret: replace-with-your-local-secret
```

In WiFiMeter, open Settings → Proxy and find Domain and connection monitoring. Enter the controller address and matching secret, enable monitoring, choose a refresh interval, and save. The address belongs to the external controller; use the controller port rather than an HTTP or SOCKS proxy port.

Monitoring starts disabled on first use. Saved settings restore on subsequent starts. The interval accepts whole milliseconds from 250 to 60000; its default is 1000 milliseconds. Requests do not overlap, and the next interval starts after the previous poll completes.

HTTP and HTTPS are supported on literal loopback addresses, including `127.0.0.1` and `::1`. `localhost` is normalized to `127.0.0.1`. Controller URLs contain no credentials, extra path, query or fragment, and responses cannot redirect requests elsewhere. HTTPS uses normal certificate verification.

Leaving the secret field empty keeps an already saved secret. Use the separate clear-secret option to remove it. The host stores configuration in the local profile's `connection-monitor.json`; saved secrets are never returned to the page, logged, exported with connection records, or included in cloud backups.

## Read and search connections

Open the connection page and search for a domain, IP address, application, executable path, rule or node name. Combine the search with application, route and activity filters. Applications with the same filename but different executable paths remain separate filter choices, with paths shown for matching names. Select a destination to inspect its addresses, process path, rule, chain and observation times. Open details continue updating even when the connection leaves the filtered list.

Route classification follows the final outbound, which is the first element of Mihomo's chain. `DIRECT` and a controller-confirmed Direct outbound mean direct routing. `REJECT`, `REJECT-DROP` and a confirmed Reject outbound mean blocked routing. Other confirmed outbound types indicate proxy routing. Missing evidence stays unknown; a group name alone does not establish an outbound type. Each poll rereads outbound definitions so a configuration reload cannot reuse an old type.

Connection bytes are cumulative values reported by the controller. Rates use the counter change and actual elapsed observation time. The first observation, a counter reset, an interrupted observation or a missing counter has no measured rate and displays a dash. These connection observations remain separate from interface history, application accounting and quota ledgers; see the [data contracts](../contracts/README.md).

## Session records and export

The current application session retains at most 5000 observed connections in memory. When full, older inactive records are removed first. The table shows up to 500 matching records and reports additional matches. Export saves retained matching records as CSV with exact decimal byte counts. Clearing the list resets observations; still-active connections appear again on a later poll. Restarting WiFiMeter begins a new observation history.

A successful complete snapshot can establish that a previously active connection disappeared. Controller errors, disabling monitoring or changing its configuration instead stop observation. Those events do not establish that the remote connection closed. A connection observed again after an interruption establishes a fresh rate baseline.

## Observation limits

Only connections visible to the configured controller appear. Applications that bypass it remain outside this view. Domain and process fields depend on what the proxy software can identify; an IP-only connection does not prove a domain or application identity. Connection lists are polled snapshots, so a connection that starts and ends between polls can be missed. Rule and outbound information comes from the controller; WiFiMeter does not reconstruct its unobserved routing decisions.

If local process information is missing, Mihomo's supported configuration interface can set `find-process-mode: always` to request process lookup for each connection. Lookup still depends on platform support and permissions; a remote client's application cannot be identified as a local process.

Each read has a five-second absolute timeout and a four-MiB response limit. Authentication failures, invalid data and unavailable controllers produce an explicit error and make previous live rates unavailable. Proxy-definition lookup failure leaves the connection feed usable, with unknown classification where the available chain cannot establish the route.

For module responsibilities and the verification workflow, see [Architecture](ARCHITECTURE.md) and [Testing](TESTING.md).
