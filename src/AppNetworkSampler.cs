using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;

namespace WiFiMeter.Networking
{
    public sealed class AppNetworkRate
    {
        public int ProcessId { get; internal set; }
        public int[] ProcessIds { get; internal set; }
        public string Name { get; internal set; }
        public string AppId { get; internal set; }
        public ulong RxBytes { get; internal set; }
        public ulong TxBytes { get; internal set; }
        public double? RxBytesPerSecond { get; internal set; }
        public double? TxBytesPerSecond { get; internal set; }
        public double? DownloadPerSecond { get { return RxBytesPerSecond; } }
        public double? UploadPerSecond { get { return TxBytesPerSecond; } }
        public int Connections { get; internal set; }
        public int SampledConnections { get; internal set; }
        internal AppNetworkRate Copy()
        {
            AppNetworkRate copy = (AppNetworkRate)MemberwiseClone();
            copy.ProcessIds = (int[])ProcessIds.Clone();
            return copy;
        }
    }

    public sealed class AppNetworkSample
    {
        public bool Available { get; internal set; }
        public string Status { get; internal set; }
        public string Source { get { return "WindowsTcpEStats"; } }
        public DateTime TimestampUtc { get; internal set; }
        public double IntervalSeconds { get; internal set; }
        public AppNetworkRate[] Rows { get; internal set; }
        public int FailedConnections { get; internal set; }
        public int ObservedConnections { get; internal set; }
        public int WarmingConnections { get; internal set; }
        public int NativeErrorCode { get; internal set; }
        internal static AppNetworkSample Empty(string status, int error)
        {
            return new AppNetworkSample { Status = status, NativeErrorCode = error,
                TimestampUtc = DateTime.UtcNow, Rows = new AppNetworkRate[0] };
        }
        internal AppNetworkSample Copy()
        {
            AppNetworkSample copy = (AppNetworkSample)MemberwiseClone();
            copy.Rows = new AppNetworkRate[Rows.Length];
            for (int i = 0; i < Rows.Length; i++) copy.Rows[i] = Rows[i].Copy();
            return copy;
        }
    }

    internal sealed class TcpByteCounter
    {
        public string Key;
        public int ProcessId;
        public string Name;
        public string AppId;
        public ulong Rx;
        public ulong Tx;
    }

    // Separate interval accounting from native reads. New/reused sockets and reset
    // counters establish a baseline; lifetime totals are never reported as speed.
    internal sealed class TcpRateWindow
    {
        private Dictionary<string, TcpByteCounter> previous = new Dictionary<string, TcpByteCounter>();
        private double previousTime;
        private bool initialized;
        internal AppNetworkSample Update(List<TcpByteCounter> counters, double seconds, int failed, int error)
        {
            double elapsed = initialized ? seconds - previousTime : 0;
            Dictionary<string, TcpByteCounter> next = new Dictionary<string, TcpByteCounter>();
            Dictionary<string, AppNetworkRate> apps = new Dictionary<string, AppNetworkRate>(StringComparer.OrdinalIgnoreCase);
            Dictionary<string, HashSet<int>> processIds = new Dictionary<string, HashSet<int>>(StringComparer.OrdinalIgnoreCase);
            int warming = 0;
            foreach (TcpByteCounter current in counters)
            {
                next[current.Key] = current;
                string appKey = String.IsNullOrEmpty(current.AppId) ? "pid:" + current.ProcessId : "path:" + current.AppId;
                AppNetworkRate app;
                if (!apps.TryGetValue(appKey, out app))
                {
                    app = new AppNetworkRate { ProcessId = current.ProcessId, Name = current.Name, AppId = current.AppId };
                    apps.Add(appKey, app);
                    processIds.Add(appKey, new HashSet<int>());
                }
                processIds[appKey].Add(current.ProcessId);
                app.Connections++;
                TcpByteCounter old;
                if (elapsed <= 0 || !previous.TryGetValue(current.Key, out old) || current.Rx < old.Rx || current.Tx < old.Tx)
                {
                    warming++;
                    continue;
                }
                app.SampledConnections++;
                app.RxBytes += current.Rx - old.Rx;
                app.TxBytes += current.Tx - old.Tx;
            }
            bool ready = initialized && elapsed > 0;
            previous = next;
            previousTime = seconds;
            initialized = true;
            foreach (KeyValuePair<string, AppNetworkRate> entry in apps)
            {
                int[] ids = new int[processIds[entry.Key].Count];
                processIds[entry.Key].CopyTo(ids);
                Array.Sort(ids);
                entry.Value.ProcessIds = ids;
                // Multi-process applications have no single owner PID.
                entry.Value.ProcessId = ids.Length == 1 ? ids[0] : 0;
            }
            List<AppNetworkRate> rows = new List<AppNetworkRate>(apps.Values);
            foreach (AppNetworkRate row in rows)
            {
                if (row.SampledConnections == 0) continue;
                row.RxBytesPerSecond = row.RxBytes / elapsed;
                row.TxBytesPerSecond = row.TxBytes / elapsed;
            }
            rows.Sort(delegate(AppNetworkRate a, AppNetworkRate b) {
                int result = ((b.RxBytesPerSecond + b.TxBytesPerSecond) ?? -1).CompareTo((a.RxBytesPerSecond + a.TxBytesPerSecond) ?? -1);
                if (result != 0) return result;
                result = StringComparer.OrdinalIgnoreCase.Compare(a.AppId, b.AppId);
                return result != 0 ? result : a.ProcessId.CompareTo(b.ProcessId);
            });
            bool measured = counters.Count > warming;
            string status = !ready || (warming > 0 && !measured) ? "WarmingUp" : "Available";
            if (failed > 0) status = counters.Count == 0 ? (error == 5 ? "AccessDenied" : "Unavailable") : "Partial";
            else if (warming > 0 && measured) status = "Partial";
            bool available = ready && (measured || (counters.Count == 0 && failed == 0));
            return new AppNetworkSample { Available = available, Status = status,
                TimestampUtc = DateTime.UtcNow, IntervalSeconds = Math.Max(0, elapsed), Rows = rows.ToArray(),
                FailedConnections = failed, ObservedConnections = counters.Count + failed,
                WarmingConnections = warming, NativeErrorCode = error };
        }
    }

    // Windows Vista+ TCP extended statistics, IPv4 and IPv6. No ETW session,
    // service, driver or external assembly is installed. C# 5 / PowerShell 5.1.
    // References: Get/SetPerTcp[6]ConnectionEStats, TCP_ESTATS_DATA_ROD_v0.
    // TCP only; sockets that close between polls and their final bytes can be missed.
    // Includes loopback/proxy legs independently, so totals are not NIC totals.
    public sealed class AppNetworkMonitor : IDisposable
    {
        private sealed class SocketRow
        {
            internal byte[] Native;
            internal bool V6;
            internal int Pid;
            internal string Key;
        }
        private readonly object gate = new object();
        private readonly ManualResetEvent stop = new ManualResetEvent(false);
        private readonly Thread worker;
        private AppNetworkSample latest = AppNetworkSample.Empty("Starting", 0);
        private bool disposed;
        private readonly Dictionary<string, SocketRow> enabled = new Dictionary<string, SocketRow>();

        [DllImport("iphlpapi.dll")]
        private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);
        [DllImport("iphlpapi.dll")]
        private static extern uint GetPerTcpConnectionEStats(byte[] row, int type, [Out] byte[] rw, uint rwVersion, uint rwSize,
            IntPtr ros, uint rosVersion, uint rosSize, [Out] byte[] rod, uint rodVersion, uint rodSize);
        [DllImport("iphlpapi.dll")]
        private static extern uint GetPerTcp6ConnectionEStats(byte[] row, int type, [Out] byte[] rw, uint rwVersion, uint rwSize,
            IntPtr ros, uint rosVersion, uint rosSize, [Out] byte[] rod, uint rodVersion, uint rodSize);
        [DllImport("iphlpapi.dll")]
        private static extern uint SetPerTcpConnectionEStats(byte[] row, int type, byte[] rw, uint version, uint size, uint offset);
        [DllImport("iphlpapi.dll")]
        private static extern uint SetPerTcp6ConnectionEStats(byte[] row, int type, byte[] rw, uint version, uint size, uint offset);

        public AppNetworkMonitor()
        {
            worker = new Thread(Run);
            worker.IsBackground = true;
            worker.Name = "WiFiMeter TCP byte sampler";
            worker.Start();
        }
        public AppNetworkSample GetSnapshot()
        {
            lock (gate) { return latest.Copy(); }
        }
        private void Publish(AppNetworkSample sample) { lock (gate) { latest = sample; } }
        private static uint ReadStats(SocketRow row, byte[] rw, byte[] data)
        {
            return row.V6
                ? GetPerTcp6ConnectionEStats(row.Native, 1, rw, 0, 1, IntPtr.Zero, 0, 0, data, 0, (uint)data.Length)
                : GetPerTcpConnectionEStats(row.Native, 1, rw, 0, 1, IntPtr.Zero, 0, 0, data, 0, (uint)data.Length);
        }
        private static uint SetStats(SocketRow row, bool value)
        {
            byte[] rw = new byte[] { value ? (byte)1 : (byte)0 };
            return row.V6 ? SetPerTcp6ConnectionEStats(row.Native, 1, rw, 0, 1, 0)
                : SetPerTcpConnectionEStats(row.Native, 1, rw, 0, 1, 0);
        }
        private static void ReadTable(List<SocketRow> rows, bool v6)
        {
            int size = 0;
            uint result = GetExtendedTcpTable(IntPtr.Zero, ref size, false, v6 ? 23 : 2, 5, 0);
            if (result == 232 || (result == 0 && size == 0)) return;
            if (result != 122 && result != 0) throw new Win32Exception((int)result);
            // Socket churn can grow the table between the size and data calls.
            for (int attempt = 0; attempt < 3; attempt++)
            {
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    int capacity = size;
                    result = GetExtendedTcpTable(buffer, ref size, false, v6 ? 23 : 2, 5, 0);
                    if (result == 122) continue;
                    if (result != 0) throw new Win32Exception((int)result);
                    if (size < 4 || size > capacity) throw new InvalidOperationException("Invalid TCP table size.");
                    byte[] data = new byte[size];
                    Marshal.Copy(buffer, data, 0, size);
                    int count = BitConverter.ToInt32(data, 0);
                    int stride = v6 ? 56 : 24;
                    if (count < 0 || count > (size - 4) / stride) throw new InvalidOperationException("Invalid TCP table rows.");
                    for (int i = 0; i < count; i++)
                    {
                        int offset = 4 + i * stride;
                        if (BitConverter.ToInt32(data, offset + (v6 ? 48 : 0)) != 5) continue;
                        byte[] native = new byte[stride - 4];
                        if (v6)
                        {
                            // OWNER_PID has state at +48; MIB_TCP6ROW puts it first.
                            Array.Copy(data, offset + 48, native, 0, 4);
                            Array.Copy(data, offset, native, 4, 48);
                        }
                        else Array.Copy(data, offset, native, 0, native.Length);
                        int pid = BitConverter.ToInt32(data, offset + stride - 4);
                        rows.Add(new SocketRow { Native = native, V6 = v6, Pid = pid,
                            Key = (v6 ? "6:" : "4:") + pid + ":" + Convert.ToBase64String(native) });
                    }
                    return;
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            throw new Win32Exception(122);
        }
        private List<TcpByteCounter> Capture(out int failed, out int error)
        {
            List<SocketRow> sockets = new List<SocketRow>();
            ReadTable(sockets, false);
            ReadTable(sockets, true);
            List<TcpByteCounter> counters = new List<TcpByteCounter>();
            Dictionary<int, string[]> identities = new Dictionary<int, string[]>();
            HashSet<string> present = new HashSet<string>();
            failed = 0;
            error = 0;
            foreach (SocketRow socket in sockets)
            {
                if (stop.WaitOne(0)) break;
                present.Add(socket.Key);
                // 96 bytes including native alignment, RcvNxt and trailing padding.
                byte[] data = new byte[96];
                byte[] rw = new byte[1];
                uint result = ReadStats(socket, rw, data);
                if (result == 0 && rw[0] == 0)
                {
                    result = SetStats(socket, true);
                    if (result == 0)
                    {
                        enabled[socket.Key] = socket;
                        result = ReadStats(socket, rw, data);
                    }
                }
                if (result != 0 || rw[0] == 0)
                {
                    failed++;
                    error = result == 0 ? 50 : (int)result;
                    continue;
                }
                string[] identity;
                if (!identities.TryGetValue(socket.Pid, out identity))
                {
                    identity = new string[] { "", "", "" };
                    try
                    {
                        using (Process process = Process.GetProcessById(socket.Pid))
                        {
                            identity[0] = process.ProcessName;
                            identity[2] = process.StartTime.ToUniversalTime().Ticks.ToString();
                            try { identity[1] = process.MainModule.FileName; } catch (Win32Exception) { }
                        }
                    }
                    catch (ArgumentException) { }
                    catch (InvalidOperationException) { }
                    catch (Win32Exception) { }
                    identities.Add(socket.Pid, identity);
                }
                // Without a process generation, PID reuse cannot be distinguished.
                if (identity[2].Length == 0) { failed++; continue; }
                counters.Add(new TcpByteCounter { Key = socket.Key + ":" + identity[2], ProcessId = socket.Pid,
                    Name = identity[0], AppId = identity[1], Rx = BitConverter.ToUInt64(data, 16), Tx = BitConverter.ToUInt64(data, 0) });
            }
            List<string> expired = new List<string>();
            foreach (string key in enabled.Keys) if (!present.Contains(key)) expired.Add(key);
            foreach (string key in expired) enabled.Remove(key); // Closed sockets release their own EStats storage.
            return counters;
        }
        private void Run()
        {
            try
            {
                using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
                {
                    if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                    {
                        Publish(AppNetworkSample.Empty("AccessDenied", 5));
                        return;
                    }
                }
                Stopwatch clock = Stopwatch.StartNew();
                TcpRateWindow window = new TcpRateWindow();
                do
                {
                    try
                    {
                        int failed, error;
                        List<TcpByteCounter> counters = Capture(out failed, out error);
                        Publish(window.Update(counters, clock.Elapsed.TotalSeconds, failed, error));
                    }
                    catch (Win32Exception ex)
                    {
                        window = new TcpRateWindow();
                        Publish(AppNetworkSample.Empty(ex.NativeErrorCode == 5 ? "AccessDenied" : "Unavailable", ex.NativeErrorCode));
                    }
                } while (!stop.WaitOne(1000));
            }
            catch (Exception)
            {
                Publish(AppNetworkSample.Empty("Unavailable", 0));
            }
            finally
            {
                // Do not disable statistics already enabled by another consumer.
                foreach (SocketRow row in enabled.Values) { try { SetStats(row, false); } catch (Exception) { } }
                enabled.Clear();
            }
        }
        public void Dispose()
        {
            // Lifecycle operations are serialized by the owning PowerShell module.
            if (disposed) return;
            disposed = true;
            stop.Set();
            worker.Join();
            stop.Dispose();
            Publish(AppNetworkSample.Empty("Stopped", 0));
        }
    }
}
