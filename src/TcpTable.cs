using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Net;
using System.Runtime.InteropServices;

namespace WiFiMeter.Networking
{
    public sealed class TcpConnectionRow
    {
        public int State { get; set; }
        public string LocalAddress { get; set; }
        public int LocalPort { get; set; }
        public string RemoteAddress { get; set; }
        public int RemotePort { get; set; }
        public int OwningPid { get; set; }
        public bool RemoteIsLoopback { get; set; }
    }

    // Read-only snapshot of the owner-PID TCP tables. Windows PowerShell 5.1 compiles
    // this file at runtime with the framework C# 5 compiler, so newer syntax stays out.
    public static class TcpTable
    {
        private const int AfInet = 2;
        private const int AfInet6 = 23;
        private const int TcpTableOwnerPidAll = 5;
        private const int MibTcpStateEstablished = 5;
        private const int ErrorInsufficientBuffer = 122;
        private const int ErrorNoData = 232;
        private const int RowSizeV4 = 24;
        private const int RowSizeV6 = 44;

        [DllImport("iphlpapi.dll", SetLastError = true)]
        private static extern uint GetExtendedTcpTable(IntPtr tcpTable, ref int tcpTableLength, bool order, int ipVersion, int tableClass, int reserved);

        public static TcpConnectionRow[] GetEstablishedConnections()
        {
            List<TcpConnectionRow> rows = new List<TcpConnectionRow>();
            AppendFamily(rows, AfInet, RowSizeV4);
            AppendFamily(rows, AfInet6, RowSizeV6);
            return rows.ToArray();
        }

        private static void AppendFamily(List<TcpConnectionRow> rows, int family, int rowSize)
        {
            int size = 0;
            uint error = GetExtendedTcpTable(IntPtr.Zero, ref size, true, family, TcpTableOwnerPidAll, 0);
            if (error == ErrorNoData || (error == 0 && size <= 0)) return;
            if (error != ErrorInsufficientBuffer || size <= 0) throw new Win32Exception((int)error);
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                int length = size;
                error = GetExtendedTcpTable(buffer, ref length, true, family, TcpTableOwnerPidAll, 0);
                if (error != 0) throw new Win32Exception((int)error);
                byte[] data = new byte[length];
                Marshal.Copy(buffer, data, 0, length);
                if (data.Length < 4) return;
                int count = BitConverter.ToInt32(data, 0);
                for (int index = 0; index < count; index++)
                {
                    int offset = 4 + index * rowSize;
                    if (offset + rowSize > data.Length) break;
                    int state = BitConverter.ToInt32(data, offset);
                    if (state != MibTcpStateEstablished) continue;
                    TcpConnectionRow row = new TcpConnectionRow();
                    row.State = state;
                    if (family == AfInet)
                    {
                        row.LocalAddress = FormatAddress(CopyBytes(data, offset + 4, 4));
                        row.LocalPort = ReadNetworkPort(data, offset + 8);
                        row.RemoteAddress = FormatAddress(CopyBytes(data, offset + 12, 4));
                        row.RemotePort = ReadNetworkPort(data, offset + 16);
                    }
                    else
                    {
                        row.LocalAddress = FormatAddress(CopyBytes(data, offset, 16));
                        row.LocalPort = ReadNetworkPort(data, offset + 16);
                        row.RemoteAddress = FormatAddress(CopyBytes(data, offset + 20, 16));
                        row.RemotePort = ReadNetworkPort(data, offset + 36);
                    }
                    row.OwningPid = BitConverter.ToInt32(data, offset + rowSize - 4);
                    row.RemoteIsLoopback = IsLoopback(row.RemoteAddress);
                    rows.Add(row);
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        private static byte[] CopyBytes(byte[] data, int offset, int length)
        {
            byte[] bytes = new byte[length];
            Array.Copy(data, offset, bytes, 0, length);
            return bytes;
        }

        // TCP table ports travel in network byte order inside the low two bytes.
        private static int ReadNetworkPort(byte[] data, int offset)
        {
            return (data[offset] << 8) | data[offset + 1];
        }

        private static string FormatAddress(byte[] bytes)
        {
            return new IPAddress(bytes).ToString();
        }

        private static bool IsLoopback(string address)
        {
            try { return IPAddress.IsLoopback(IPAddress.Parse(address)); }
            catch (FormatException) { return false; }
        }
    }
}
