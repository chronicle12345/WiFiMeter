// WinDivert 2.2 ABI: https://github.com/basil00/WinDivert/blob/v2.2.2/include/windivert.h
// Endpoint ownership: Windows IP Helper OWNER_PID tables, IPv4 and IPv6.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace WiFiMeter.DownloadControl
{
    // A single packet burst is necessary because a packet cannot be split by the scheduler.
    public sealed class TokenBucket
    {
        private double tokens;
        private double last;
        public readonly double BytesPerSecond;
        public TokenBucket(long kbps, double now) { BytesPerSecond = kbps * 125.0; last = now; }
        public bool Take(int bytes, double now)
        {
            double capacity = Math.Max(bytes, Math.Max(1500, BytesPerSecond * 0.05));
            tokens = Math.Min(capacity, tokens + Math.Max(0, now - last) * BytesPerSecond);
            last = now;
            if (tokens + 0.000001 < bytes) return false;
            tokens -= bytes;
            return true;
        }
    }

    public sealed class PacketKey
    {
        public string Local, Remote;
        public int LocalPort, RemotePort, Protocol, PayloadBytes;
        public string Exact { get { return Protocol + "|" + Local + "|" + LocalPort + "|" + Remote + "|" + RemotePort; } }
        public string Bound { get { return Protocol + "|" + Local + "|" + LocalPort; } }
        public string Wildcard { get { return Protocol + "|" + (Local.IndexOf(':') >= 0 ? "::" : "0.0.0.0") + "|" + LocalPort; } }
        // Parses extension headers without changing packets; malformed/fragments fail open.
        public static PacketKey Parse(byte[] packet, int count)
        {
            if (count < 20) return null;
            int offset, protocol; string local, remote;
            if ((packet[0] >> 4) == 4)
            {
                offset = (packet[0] & 15) * 4;
                if (offset < 20 || count < offset || (ReadPort(packet, 6) & 0x1fff) != 0) return null;
                protocol = packet[9]; remote = Address(packet, 12, 4); local = Address(packet, 16, 4);
            }
            else if ((packet[0] >> 4) == 6 && count >= 40)
            {
                offset = 40; protocol = packet[6]; remote = Address(packet, 8, 16); local = Address(packet, 24, 16);
                for (int depth = 0; protocol != 6 && protocol != 17 && depth < 8; depth++)
                {
                    if (count < offset + 2) return null;
                    int next = packet[offset], length;
                    if (protocol == 0 || protocol == 43 || protocol == 60) length = (packet[offset + 1] + 1) * 8;
                    else if (protocol == 51) length = (packet[offset + 1] + 2) * 4;
                    else if (protocol == 44) { if (count < offset + 8 || (ReadPort(packet, offset + 2) & 0xfff8) != 0) return null; length = 8; }
                    else return null;
                    offset += length; protocol = next;
                }
            }
            else return null;
            if ((protocol != 6 && protocol != 17) || count < offset + (protocol == 6 ? 20 : 8)) return null;
            int header = protocol == 6 ? (packet[offset + 12] >> 4) * 4 : 8;
            if (header < (protocol == 6 ? 20 : 8) || count < offset + header) return null;
            return new PacketKey { Local = local, Remote = remote, LocalPort = ReadPort(packet, offset + 2), RemotePort = ReadPort(packet, offset), Protocol = protocol, PayloadBytes = count - offset - header };
        }
        public static int ReadPort(byte[] bytes, int offset) { return (bytes[offset] << 8) | bytes[offset + 1]; }
        public static string Address(byte[] bytes, int offset, int length)
        {
            byte[] address = new byte[length]; Buffer.BlockCopy(bytes, offset, address, 0, length);
            return new IPAddress(address).ToString();
        }
    }

    public sealed class EndpointIndex
    {
        private readonly Dictionary<string, string> entries = new Dictionary<string, string>(StringComparer.Ordinal);
        public void Add(string key, string path)
        {
            string previous;
            if (!entries.TryGetValue(key, out previous)) entries[key] = path;
            else if (!String.Equals(previous, path, StringComparison.OrdinalIgnoreCase)) entries[key] = null;
        }
        public string Find(PacketKey packet)
        {
            string result;
            if (entries.TryGetValue(packet.Exact, out result)) return result;
            if (packet.Protocol != 17) return null;
            if (entries.TryGetValue(packet.Bound, out result)) return result;
            return entries.TryGetValue(packet.Wildcard, out result) ? result : null;
        }
    }

    // UDP sockets may share a tuple. Track each endpoint instead of overwriting its owner.
    public sealed class FlowIndex
    {
        private readonly Dictionary<string, Dictionary<ulong, string>> entries = new Dictionary<string, Dictionary<ulong, string>>();
        private int count;
        public void Add(string tuple, ulong endpoint, string path)
        {
            if (count >= 65536) Clear();
            Dictionary<ulong, string> owners;
            if (!entries.TryGetValue(tuple, out owners)) { owners = new Dictionary<ulong, string>(); entries.Add(tuple, owners); }
            if (!owners.ContainsKey(endpoint)) count++;
            owners[endpoint] = path;
        }
        public void Remove(string tuple, ulong endpoint)
        {
            Dictionary<ulong, string> owners;
            if (entries.TryGetValue(tuple, out owners) && owners.Remove(endpoint)) { count--; if (owners.Count == 0) entries.Remove(tuple); }
        }
        public bool TryFind(string tuple, out string path)
        {
            path = null; Dictionary<ulong, string> owners;
            if (!entries.TryGetValue(tuple, out owners)) return false;
            foreach (string owner in owners.Values)
            {
                if (owner == null || (path != null && !String.Equals(path, owner, StringComparison.OrdinalIgnoreCase))) { path = null; return true; }
                path = owner;
            }
            return true;
        }
        public void Clear() { entries.Clear(); count = 0; }
    }

    internal sealed class Packet
    {
        internal byte[] Bytes, Address;
        internal int Payload;
    }
    internal sealed class Limit
    {
        internal long Kbps;
        internal TokenBucket Bucket;
        internal readonly Queue<Packet> Queue = new Queue<Packet>();
        internal int QueuedBytes;
    }

    public sealed class Server
    {
        private readonly object gate = new object();
        private readonly object endpointGate = new object();
        private readonly Dictionary<string, Limit> limits = new Dictionary<string, Limit>(StringComparer.OrdinalIgnoreCase);
        private readonly FlowIndex flows = new FlowIndex();
        private EndpointIndex endpoints = new EndpointIndex();
        private IntPtr network = new IntPtr(-1), flow = new IntPtr(-1);
        private volatile bool running;
        private int queuedBytes;
        private string failure;
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private Thread receiver, sender, flowReceiver;
        private Timer refresh;
        private Process owner;
        private string dllPath;
        private bool libraryLoaded;
        private const int PerApplicationQueue = 4 * 1024 * 1024, TotalQueue = 16 * 1024 * 1024;
        private static double Seconds(Stopwatch clock) { return clock.Elapsed.TotalSeconds; }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("WinDivert.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi, SetLastError = true)] private static extern IntPtr WinDivertOpen(string filter, int layer, short priority, ulong flags);
        [DllImport("WinDivert.dll", CallingConvention = CallingConvention.Cdecl, SetLastError = true)] private static extern bool WinDivertRecv(IntPtr handle, [Out] byte[] packet, uint capacity, out uint length, [Out] byte[] address);
        [DllImport("WinDivert.dll", CallingConvention = CallingConvention.Cdecl, SetLastError = true)] private static extern bool WinDivertSend(IntPtr handle, byte[] packet, uint length, out uint sent, byte[] address);
        [DllImport("WinDivert.dll", CallingConvention = CallingConvention.Cdecl)] private static extern bool WinDivertClose(IntPtr handle);
        [DllImport("WinDivert.dll", CallingConvention = CallingConvention.Cdecl)] private static extern bool WinDivertShutdown(IntPtr handle, uint how);
        [DllImport("WinDivert.dll", CallingConvention = CallingConvention.Cdecl)] private static extern bool WinDivertSetParam(IntPtr handle, int parameter, ulong value);
        [DllImport("WinDivert.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)] private static extern bool WinDivertHelperFormatIPv6Address(uint[] address, StringBuilder text, uint length);
        [DllImport("iphlpapi.dll")] private static extern uint GetExtendedTcpTable(IntPtr table, ref uint size, bool order, uint family, int tableClass, uint reserved);
        [DllImport("iphlpapi.dll")] private static extern uint GetExtendedUdpTable(IntPtr table, ref uint size, bool order, uint family, int tableClass, uint reserved);

        private static string ProcessPath(uint pid)
        {
            IntPtr process = OpenProcess(0x1000, false, pid);
            if (process == IntPtr.Zero) return null;
            try { uint size = 32768; StringBuilder text = new StringBuilder((int)size); return QueryFullProcessImageName(process, 0, text, ref size) ? text.ToString() : null; }
            finally { CloseHandle(process); }
        }
        private static string FlowAddress(byte[] address, int offset)
        {
            uint[] words = new uint[4]; for (int i = 0; i < 4; i++) words[i] = BitConverter.ToUInt32(address, offset + 4 * i);
            StringBuilder text = new StringBuilder(80);
            if (!WinDivertHelperFormatIPv6Address(words, text, 80)) return null;
            IPAddress ip = IPAddress.Parse(text.ToString()); return ip.IsIPv4MappedToIPv6 ? ip.MapToIPv4().ToString() : ip.ToString();
        }

        private void ReadTable(EndpointIndex index, bool tcp, bool ipv6, Dictionary<uint, string> processes)
        {
            uint size = 0, family = ipv6 ? 23u : 2u;
            uint result = tcp ? GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, 5, 0) : GetExtendedUdpTable(IntPtr.Zero, ref size, false, family, 1, 0);
            if (result != 122 || size < 4 || size > 64 * 1024 * 1024) return;
            for (int attempt = 0; attempt < 3; attempt++)
            {
                IntPtr memory = Marshal.AllocHGlobal((int)size);
                try
                {
                    uint capacity = size;
                    result = tcp ? GetExtendedTcpTable(memory, ref size, false, family, 5, 0) : GetExtendedUdpTable(memory, ref size, false, family, 1, 0);
                    if (result == 122) continue;
                    if (result != 0) return;
                    byte[] bytes = new byte[capacity]; Marshal.Copy(memory, bytes, 0, bytes.Length);
                    int rows = BitConverter.ToInt32(bytes, 0), stride = tcp ? (ipv6 ? 56 : 24) : (ipv6 ? 28 : 12);
                    for (int row = 0, offset = 4; row < rows && offset + stride <= bytes.Length; row++, offset += stride)
                    {
                        uint pid = BitConverter.ToUInt32(bytes, offset + stride - 4); string path;
                        if (!processes.TryGetValue(pid, out path)) { path = ProcessPath(pid); processes[pid] = path; }
                        // Index all owners, including unrestricted owners, to reject ambiguous UDP binds.
                        if (path == null) path = "?";
                        string local = PacketKey.Address(bytes, offset + (tcp && !ipv6 ? 4 : 0), ipv6 ? 16 : 4);
                        int localPort = PacketKey.ReadPort(bytes, offset + (ipv6 ? 20 : (tcp ? 8 : 4)));
                        string key = (tcp ? 6 : 17) + "|" + local + "|" + localPort;
                        if (tcp) key += "|" + PacketKey.Address(bytes, offset + (ipv6 ? 24 : 12), ipv6 ? 16 : 4) + "|" + PacketKey.ReadPort(bytes, offset + (ipv6 ? 44 : 16));
                        index.Add(key, path);
                    }
                    return;
                }
                finally { Marshal.FreeHGlobal(memory); }
            }
        }

        private void Refresh(object ignored)
        {
            if (!running || !Monitor.TryEnter(endpointGate)) return;
            try
            {
                if (owner != null && owner.HasExited) { StopReceiving(); return; }
                EndpointIndex next = new EndpointIndex(); Dictionary<uint, string> processes = new Dictionary<uint, string>();
                ReadTable(next, true, false, processes); ReadTable(next, true, true, processes);
                ReadTable(next, false, false, processes); ReadTable(next, false, true, processes);
                HashSet<string> active = new HashSet<string>(processes.Values, StringComparer.OrdinalIgnoreCase);
                lock (gate)
                {
                    endpoints = next;
                    foreach (KeyValuePair<string, Limit> item in limits) if (!active.Contains(item.Key)) Flush(item.Value);
                }
            }
            catch { lock (gate) endpoints = new EndpointIndex(); }
            finally { Monitor.Exit(endpointGate); }
        }

        private void TrackFlows()
        {
            byte[] address = new byte[80]; uint ignored;
            try
            {
                while (running && WinDivertRecv(flow, null, 0, out ignored, address))
                {
                    PacketKey tuple = new PacketKey { Local = FlowAddress(address, 36), Remote = FlowAddress(address, 52), LocalPort = BitConverter.ToUInt16(address, 68), RemotePort = BitConverter.ToUInt16(address, 70), Protocol = address[72] };
                    string path = ProcessPath(BitConverter.ToUInt32(address, 32));
                    lock (gate)
                    {
                        ulong endpoint = BitConverter.ToUInt64(address, 16);
                        if (address[9] == 2) flows.Remove(tuple.Exact, endpoint);
                        else flows.Add(tuple.Exact, endpoint, path);
                        // The IP Helper snapshot remains available for flows opened before this daemon.
                    }
                }
            }
            catch { }
            // A native false return also ends tracking. Discard owners and use IP Helper snapshots.
            finally { lock (gate) flows.Clear(); }
        }

        private void Inject(Packet packet)
        {
            uint sent;
            // Unchanged packet/address retain WinDivert's checksum offload flags.
            if (!WinDivertSend(network, packet.Bytes, (uint)packet.Bytes.Length, out sent, packet.Address)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Packet reinjection failed");
        }
        private void ReceivePackets()
        {
            byte[] buffer = new byte[65575], address = new byte[80]; uint count;
            try
            {
                // After shutdown(RECV), WinDivertRecv drains the driver queue before ERROR_NO_DATA.
                while (WinDivertRecv(network, buffer, (uint)buffer.Length, out count, address))
                {
                    Packet packet = new Packet { Bytes = new byte[count], Address = (byte[])address.Clone() };
                    Buffer.BlockCopy(buffer, 0, packet.Bytes, 0, (int)count);
                    PacketKey key = PacketKey.Parse(packet.Bytes, packet.Bytes.Length); bool queued = false, overflow = false;
                    if (key != null && key.PayloadBytes > 0 && running)
                    {
                        lock (gate)
                        {
                            string path; Limit limit;
                            if (!flows.TryFind(key.Exact, out path)) path = endpoints.Find(key);
                            if (path != null && limits.TryGetValue(path, out limit))
                            {
                                packet.Payload = key.PayloadBytes;
                                overflow = limit.QueuedBytes + count > PerApplicationQueue || queuedBytes + count > TotalQueue || limit.Queue.Count >= 4096;
                                if (!overflow) { limit.Queue.Enqueue(packet); limit.QueuedBytes += (int)count; queuedBytes += (int)count; queued = true; }
                            }
                        }
                    }
                    if (!queued && !overflow) Inject(packet);
                    // At capacity only the selected application's data is dropped; TCP retransmits.
                }
                // Only shutdown may finish normally; a native failure must release the capture handle.
                if (running) throw new Win32Exception(Marshal.GetLastWin32Error(), "Packet receive failed");
            }
            catch (Exception error) { RecordFailure(error); }
        }
        private void SendPackets()
        {
            try
            {
                while (running)
                {
                    List<Packet> ready = new List<Packet>();
                    lock (gate)
                    {
                        double now = Seconds(clock);
                        foreach (Limit limit in limits.Values)
                        {
                            int sent = 0; Stopwatch batch = Stopwatch.StartNew();
                            while (limit.Queue.Count > 0 && limit.Bucket.Take(limit.Queue.Peek().Payload, now))
                            {
                                Packet packet = limit.Queue.Dequeue(); limit.QueuedBytes -= packet.Bytes.Length; queuedBytes -= packet.Bytes.Length; ready.Add(packet);
                                // Bound CPU time per app without adding a fixed packets/s speed limit.
                                if ((++sent & 63) == 0 && batch.ElapsedMilliseconds >= 2) break;
                            }
                        }
                    }
                    foreach (Packet packet in ready) Inject(packet);
                    Thread.Sleep(5);
                }
            }
            catch (Exception error) { RecordFailure(error); }
        }
        private void Flush(Limit limit)
        {
            while (limit.Queue.Count != 0) { Packet packet = limit.Queue.Dequeue(); queuedBytes -= packet.Bytes.Length; try { Inject(packet); } catch { } }
            limit.QueuedBytes = 0;
        }
        private void Set(string path, long kbps)
        {
            lock (gate)
            {
                Limit previous;
                if (limits.TryGetValue(path, out previous))
                {
                    if (kbps == 0) { Flush(previous); limits.Remove(path); }
                    else { previous.Kbps = kbps; previous.Bucket = new TokenBucket(kbps, Seconds(clock)); }
                }
                else if (kbps > 0) limits.Add(path, new Limit { Kbps = kbps, Bucket = new TokenBucket(kbps, Seconds(clock)) });
            }
        }
        private void StopReceiving()
        {
            if (!running) return;
            running = false;
            if (network != new IntPtr(-1)) WinDivertShutdown(network, 1);
            if (flow != new IntPtr(-1)) WinDivertShutdown(flow, 1);
        }
        private void RecordFailure(Exception error)
        {
            string message = error.Message;
            Win32Exception native = error as Win32Exception;
            if (native != null) message += " (Win32 " + native.NativeErrorCode + ": " + new Win32Exception(native.NativeErrorCode).Message + ")";
            lock (gate) { if (failure == null) failure = message; }
            StopReceiving();
        }
        private void CloseCapture()
        {
            StopReceiving();
            if (refresh != null) { refresh.Dispose(); refresh = null; }
            // A callback already in progress must finish before its capture handles are closed.
            lock (endpointGate) { }
            if (receiver != null) receiver.Join(5000);
            if (sender != null) sender.Join(5000);
            if (flowReceiver != null) flowReceiver.Join(5000);
            lock (gate) { foreach (Limit limit in limits.Values) Flush(limit); endpoints = new EndpointIndex(); flows.Clear(); }
            if (network != new IntPtr(-1)) { WinDivertClose(network); network = new IntPtr(-1); }
            if (flow != new IntPtr(-1)) { WinDivertClose(flow); flow = new IntPtr(-1); }
        }
        private void StartCapture()
        {
            try
            {
                CloseCapture();
                if ((receiver != null && receiver.IsAlive) || (sender != null && sender.IsAlive) || (flowReceiver != null && flowReceiver.IsAlive))
                    throw new IOException("Previous download workers have not stopped; try again shortly");
                lock (gate)
                {
                    failure = null;
                    foreach (Limit limit in limits.Values) limit.Bucket = new TokenBucket(limit.Kbps, Seconds(clock));
                }
                if (!libraryLoaded)
                {
                    if (LoadLibraryEx(dllPath, IntPtr.Zero, 0x100 | 0x800) == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                    libraryLoaded = true;
                }
                network = WinDivertOpen("inbound and !loopback and !impostor and (tcp.PayloadLength > 0 or udp.PayloadLength > 0)", 0, 0, 0);
                if (network == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "WinDivert download driver could not start");
                WinDivertSetParam(network, 0, 4096); WinDivertSetParam(network, 1, 2000); WinDivertSetParam(network, 2, 8 * 1024 * 1024);
                flow = WinDivertOpen("tcp or udp", 2, 0, 5);
                // IP Helper supports existing flows even when flow capture is unavailable.
                running = true; Refresh(null);
                receiver = new Thread(ReceivePackets); receiver.IsBackground = true; receiver.Start();
                sender = new Thread(SendPackets); sender.IsBackground = true; sender.Start();
                if (flow != new IntPtr(-1)) { flowReceiver = new Thread(TrackFlows); flowReceiver.IsBackground = true; flowReceiver.Start(); }
                refresh = new Timer(Refresh, null, 100, 100);
            }
            catch (Exception error) { RecordFailure(error); CloseCapture(); }
        }
        private bool KeepServing()
        {
            if (owner.HasExited) return false;
            if (!running) CloseCapture();
            lock (gate) { return limits.Count != 0; }
        }
        private void Cleanup()
        {
            CloseCapture();
            lock (gate) limits.Clear();
            if (owner != null) owner.Dispose();
        }

        private static string ReadLine(Stream stream, int timeout)
        {
            // Async byte reads give both sides a timeout and cap client controlled input.
            StringBuilder line = new StringBuilder(); byte[] buffer = new byte[1]; Stopwatch elapsed = Stopwatch.StartNew();
            while (line.Length <= 32768)
            {
                int remaining = timeout - (int)elapsed.ElapsedMilliseconds;
                if (remaining <= 0) throw new TimeoutException("Download control response timed out");
                var read = stream.ReadAsync(buffer, 0, 1);
                if (!read.Wait(remaining)) throw new TimeoutException("Download control response timed out");
                if (read.Result == 0) throw new IOException("Download control pipe disconnected");
                if (buffer[0] == 10) return line.ToString();
                line.Append((char)buffer[0]);
            }
            throw new IOException("Download control request is too long");
        }
        private static void WriteLine(Stream stream, string line)
        {
            byte[] bytes = Encoding.ASCII.GetBytes(line + "\n"); var write = stream.WriteAsync(bytes, 0, bytes.Length);
            if (!write.Wait(3000)) throw new TimeoutException("Download control pipe write timed out");
            stream.Flush();
        }
        public static string Request(string pipeName, string action, string path, long rate, int timeout)
        {
            using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Impersonation))
            {
                try { pipe.Connect(timeout); } catch (TimeoutException) { return null; }
                WriteLine(pipe, action + "|" + Convert.ToBase64String(Encoding.UTF8.GetBytes(path)) + "|" + rate.ToString(CultureInfo.InvariantCulture));
                string response = ReadLine(pipe, 5000);
                if (response.StartsWith("ERROR|", StringComparison.Ordinal)) throw new IOException(Encoding.UTF8.GetString(Convert.FromBase64String(response.Substring(6))));
                return response;
            }
        }
        private string Handle(NamedPipeServerStream pipe, string request)
        {
            string[] fields = request.Split('|'); long kbps;
            if (fields.Length != 3 || !Int64.TryParse(fields[2], NumberStyles.None, CultureInfo.InvariantCulture, out kbps)) throw new ArgumentException("Invalid download control request");
            string path = Encoding.UTF8.GetString(Convert.FromBase64String(fields[1]));
            if (!Path.IsPathRooted(path) || Path.GetExtension(path).ToLowerInvariant() != ".exe") throw new ArgumentException("Invalid executable path");
            path = Path.GetFullPath(path);
            if (fields[0] == "SET")
            {
                bool administrator = false;
                pipe.RunAsClient(delegate { administrator = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator); });
                if (!administrator) throw new UnauthorizedAccessException("Administrator permission is required to change download limits");
                if (kbps < 0 || kbps > 1000000000) throw new ArgumentOutOfRangeException("rate");
                Set(path, kbps);
                if (kbps > 0 && !running) StartCapture();
            }
            else if (fields[0] != "READ") throw new ArgumentException("Unknown download control action");
            lock (gate)
            {
                Limit limit;
                if (!limits.TryGetValue(path, out limit)) return "OK|0";
                if (failure != null) throw new IOException(failure);
                if (!running) throw new IOException("Download capture is not running");
                return "OK|" + limit.Kbps.ToString(CultureInfo.InvariantCulture);
            }
        }

        public static void Run(string pipeName, string dllPath, string initialPath, long initialKbps, int ownerPid, string ownerSid)
        {
            new Server().Serve(pipeName, dllPath, initialPath, initialKbps, ownerPid, ownerSid);
        }
        private void Serve(string pipeName, string dllPath, string path, long rate, int ownerPid, string ownerSid)
        {
            SecurityIdentifier sid = new SecurityIdentifier(ownerSid);
            PipeSecurity security = new PipeSecurity(); security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.ReadWrite, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
            using (Mutex singleton = new Mutex(false, "Local\\" + pipeName))
            {
                bool acquired = false;
                try
                {
                    try { acquired = singleton.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
                    if (!acquired) return;
                    owner = Process.GetProcessById(ownerPid);
                    IntPtr ownerHandle = owner.Handle; // Open now so PID reuse cannot extend daemon lifetime.
                    this.dllPath = Path.GetFullPath(dllPath);
                    Set(path, rate); StartCapture();
                    // Failed capture is closed, but READ retains the cause and an elevated SET can retry.
                    while (KeepServing())
                    {
                        using (NamedPipeServerStream pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, security))
                        {
                            var wait = pipe.BeginWaitForConnection(null, null);
                            bool keepServing = true;
                            while (!wait.AsyncWaitHandle.WaitOne(100)) { if (!KeepServing()) { keepServing = false; break; } }
                            if (!keepServing) break;
                            pipe.EndWaitForConnection(wait);
                            try { WriteLine(pipe, Handle(pipe, ReadLine(pipe, 3000))); }
                            catch (Exception error) { try { WriteLine(pipe, "ERROR|" + Convert.ToBase64String(Encoding.UTF8.GetBytes(error.Message))); } catch { } }
                        }
                    }
                }
                finally { Cleanup(); if (acquired) singleton.ReleaseMutex(); }
            }
        }
    }
}
