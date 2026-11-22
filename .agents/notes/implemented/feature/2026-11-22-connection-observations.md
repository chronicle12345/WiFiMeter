# Agent Note: Controller observations and live traffic charts

Status: implemented

English | [简体中文](2026-11-22-connection-observations.zh-CN.md)

## Problem

Application byte counters cannot explain the domains, routing rules or outbound nodes behind a proxy connection. Day and month aggregates also conceal brief changes in transfer rates.

## Decision

Connection observations use the local controller's read-only connection and outbound definitions. This preserves the source's domain, process and route evidence without changing native collection or attribution. Missing evidence remains unknown. Credentials stay in the Node host, with bounded session history separate from backups and accounting. Protocol fields belong to [Contracts](../../../../contracts/README.md); setup and coverage belong to [Connection monitoring](../../../../docs/CONNECTION_MONITORING.md).

The renderer shares an SVG component for line and bar charts. A bounded rolling buffer keeps native rates and their timestamps; its integral is explicitly estimated. Gaps and interface changes break continuity. Native sampling supports millisecond intervals so a faster display corresponds to actual counter reads. Existing storage and byte precision remain compatible.

## Alternatives considered

**Inferring domains from IP addresses or executable names.** Shared hosting, cached DNS and encrypted DNS cannot establish which application requested a hostname. Controller metadata provides explicit evidence within its observed scope.

**Adding a proxy core or packet interception driver.** This would change the application's responsibilities and authorization requirements. Reading the user's configured local controller meets the requested connection inspection without operating a second proxy.

**Reusing upstream UI source.** The examined Mihomo and Clash Verge Rev repositories use GPL version 3. This implementation follows their observable interaction patterns with original modules and the project's existing controls, without importing their code or a new UI framework. Research covered Mihomo's `hub/route/connections.go`, `constant/metadata.go` and `tunnel/statistic/tracker.go`, and Clash Verge Rev's `src/components/layout/traffic-graph.tsx` and `layout-traffic.tsx`.

## Consequences

Users can inspect controller-observed application destinations and choose live or historical chart styles. Connections outside the controller and short connections between polls remain unobserved. Session records do not reconstruct earlier domain history. Rate integration remains an estimate, while persisted native byte totals retain their existing authority.
