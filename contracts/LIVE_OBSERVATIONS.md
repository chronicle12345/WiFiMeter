# Live rates and controller observations

English | [简体中文](LIVE_OBSERVATIONS.zh-CN.md)

This reference expands the live observation fields in [Data contracts](README.md).

## Sampling and charts

`settings.interval` accepts 0.25..3600 seconds with at most three decimal places. Old integer settings and backups remain valid. Native sampling, rates and minute allocation use elapsed milliseconds. `live.updatedAt` includes milliseconds. A connection's `measurementAvailable` is false and its rates are null when no valid interval exists; an observed zero rate remains a decimal zero.

The renderer's rolling five-minute buffer contains this session's samples only. Its rate-integrated usage is labeled estimated and never persisted as native usage. Missing samples and interface-set changes break continuity. While visible, the rolling window expires old samples at least once per second even with longer native sampling intervals. The `chartStyle` window preference selects `line` or `bar`.

Finite coverage gaps retain millisecond boundaries internally and round their start down and end up to whole seconds in storage. A completed subsecond gap therefore has a finite end and at least one second of coverage. Overlapping or adjacent closed gaps with the same network, reason, detail and scope merge into their interval union, so rounded boundaries do not count the same seconds repeatedly. Open gaps remain explicitly unfinished until closed. Byte allocation retains millisecond precision independently of coverage display.

## Controller channels and records

The main-window desktop channels `connections:status`, `connections:read`, `connections:configure`, `connections:refresh` and `connections:clear` expose independent session observations from a local Clash / Mihomo controller. The host reads `/connections` and `/proxies`; no mutating controller methods are exposed. Status includes `hasSecret`, never the secret.

Reads add `records`, `total`, `active`, `matched` and `applications`. Filters accept `id`, `search`, `application`, `route`, `state` and a limit of 1..5000. An optional `id` selects one retained connection independently of page filters when those filters are omitted. Application keys preserve executable-path identity, normalizing Windows paths case-insensitively.

Each record includes `id`, target domain/IP/port, source IP/port, `network`, `type`, `process`, `processPath`, `chains`, `rule` and `rulePayload`. `uploadBytes` and `downloadBytes` are exact nonnegative decimal strings or null. Rates are nonnegative numbers or null, with `measurementAvailable` identifying continuous valid counter evidence. Observation times include `start`, `firstSeen`, `lastSeen` and `end`.

`route` is `direct`, `proxy`, `blocked` or `unknown`. Classification follows the terminal outbound and current type evidence. `active` describes current observation. `endReason: closed` means a complete snapshot no longer contained the connection; `disconnected`, `configured`, `disabled` and `unobserved` instead describe interrupted observation.

These values never update native snapshots, accounting, quotas or backups. [Connection monitoring](../docs/CONNECTION_MONITORING.md) owns setup, credentials and observation limits.
