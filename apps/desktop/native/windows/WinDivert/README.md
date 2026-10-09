WinDivert 2.2.2-A is bundled without modification under LGPL v3.

Official release: https://github.com/basil00/WinDivert/releases/tag/v2.2.2
Source: https://github.com/basil00/WinDivert/tree/v2.2.2
Archive: https://github.com/basil00/WinDivert/releases/download/v2.2.2/WinDivert-2.2.2-A.zip
Archive SHA256: 63CB41763BB4B20F600B6DE04E991A9C2BE73279E317D4D82F237B150C5F3F15

The complete upstream license is in LICENSE. DLLs remain outside app.asar and
can be replaced with compatible user-built WinDivert 2.2 libraries.
The x64 and x86 directories contain upstream DLLs and signed drivers.
ARM64 is unsupported by this upstream release.

DownloadLimiter.cs uses WinDivert NETWORK interception and FLOW process IDs,
with Windows IP Helper OWNER_PID tables for connections opened before startup.
Only matching applications' inbound TCP/UDP payload is queued. Unmatched,
ambiguous and malformed packets are reinjected immediately. Loopback traffic
and traffic received by a separate proxy executable cannot be controlled by
limiting the original application. Download limits run while WiFiMeter is open.

Queues have a 4 MiB and 4096 packet per-application limit and a 16 MiB total limit.
Only excess target packets are discarded at capacity; TCP can retransmit them,
whereas UDP can lose packets. The scheduler charges payload bytes and permits
bounded packet-sized bursts. Stopping drains pending packets and closes the
capture handles. Driver or worker failures close the handles and restore normal
forwarding. An abrupt process termination can lose already queued packets.
