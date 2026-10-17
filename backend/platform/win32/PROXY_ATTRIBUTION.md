# Proxy identity and historical attribution

English | [简体中文](PROXY_ATTRIBUTION.zh-CN.md)

This contract separates proxy identity evidence and connection-weight history estimates from [measured live loopback traffic](APP_TRAFFIC.md). It does not turn client connection counts into measured historical bytes or add estimates to adapter totals.

## Proxy identity evidence

An ordinary backend can obtain a listener PID through `GetExtendedTcpTable` while `QueryFullProcessImageName` cannot read its path. `detectedClients` retains `proxyProcessId` internally. Identity completion uses only a newly arrived helper EStats snapshot in the current sample, requiring all of:

- A nonempty `generation` and increasing `loopbackSampledAtMs`.
- The complete client four-tuple and proxy reverse four-tuple in that same snapshot.
- A proxy PID matching the TCP query result and process instances containing creation times.
- Consistent, known executable paths and identities with `source=WindowsTcpEStats`.

Do not complete identity when the same PID has different creation times or paths, a client endpoint is missing, its path is unknown, the source is wrong, or the snapshot repeats or arrives out of order. There is no cross-sample PID-to-path cache. A new generation validates current evidence again and never reuses an old connection identity.

## Historical observations

After identity validation, persist the real proxy path and deduplicated connection keys for the observation date in the existing tables. Do not backfill earlier dates with current client weights or modify `app_usage`. An old record without observations on its own date can yield only `proxy/unattributed`; today's connections cannot attribute yesterday's traffic.

Historical `proxyEstimatedRecords` uses connection-count weights and `estimated=true`, separately from live measured values. Full paths are case-insensitive identifiers; filenames cannot substitute for them. The native proxy amount remains the authoritative amount being attributed, with any unmatched share explicitly unattributed. [Application contracts](../../../contracts/APPLICATION_TRAFFIC.md) define the shared data fields.

## Estimate update events

`live` may include `proxyEstimatedUpdates`:

```json
{"proxyEstimatedUpdates":[{"networkId":"network-key","date":"2026-10-18","proxyAppId":"C:\\proxy.exe","records":[]}]}
```

Each `records` group contains cumulative rows for one network, date, and full proxy path, using the same fields as `snapshot.proxyEstimatedRecords`. Replace the entire matching group; never add it as an increment. An empty array clears that group.

The backend recalculates only application records for the sampling date and compares them with the last groups sent. Changes in native cumulative values or observation weights send changed groups. The first sample may send every group for the current date; complete history still comes from `snapshot`. Crossing midnight does not clear the previous day.

Before replacing native proxy rows, consumers verify RX and TX conservation independently for the same network/date/proxy group. Keep direct client native rows. Never accumulate estimates and the original native rows for the same proxy together. Partial-day and minute/hour queries omit daily estimates because they cannot establish the shorter interval's attribution.

## Existing boundaries and verification

Loopback remains live-only and is not mapped to Wi-Fi history. No independent historical loopback ledger is introduced by this contract. Measured local client bytes, native proxy traffic, and estimated shares are separate quantities and must not be directly added.

Use `proxy_service_test` and the affected desktop application/proxy tests to check current evidence, repeated/out-of-order snapshots, generation changes, missing paths, same-PID identity conflicts, date boundaries, empty replacement groups, and RX/TX conservation. [Testing](../../../docs/TESTING.md) owns invocation and evidence limits. Native source permission, polling, and event-loss limits remain in the [live contract](APP_TRAFFIC.md#permissions-limits-and-validation).
