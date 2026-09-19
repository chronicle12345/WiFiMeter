using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace WiFiMeter.Networking
{
    public static class WirelessControl
    {
        // Fixed prefix of WLAN_CONNECTION_ATTRIBUTES through DOT11_SSID.
        private const int SsidLengthOffset = 520;
        private const int SsidBytesOffset = 524;
        private const int ConnectionPrefixSize = 556;
        [DllImport("wlanapi.dll")]
        private static extern uint WlanOpenHandle(uint version, IntPtr reserved, out uint negotiated, out IntPtr client);
        [DllImport("wlanapi.dll")]
        private static extern uint WlanCloseHandle(IntPtr client, IntPtr reserved);
        [DllImport("wlanapi.dll")]
        private static extern uint WlanQueryInterface(IntPtr client, ref Guid adapter, int opcode,
            IntPtr reserved, out uint size, out IntPtr data, out int opcodeType);
        [DllImport("wlanapi.dll")]
        private static extern void WlanFreeMemory(IntPtr memory);
        [DllImport("wlanapi.dll")]
        private static extern uint WlanDisconnect(IntPtr client, ref Guid adapter, IntPtr reserved);

        public static bool DisconnectIfConnected(Guid adapter, string expectedSsid)
        {
            if (String.IsNullOrEmpty(expectedSsid)) throw new ArgumentException("An SSID is required.");
            if (adapter == Guid.Empty) throw new ArgumentException("An adapter identifier is required.");
            IntPtr client;
            uint version;
            uint error = WlanOpenHandle(2, IntPtr.Zero, out version, out client);
            if (error != 0) throw new Win32Exception((int)error);
            try
            {
                IntPtr data;
                uint size;
                int opcodeType;
                error = WlanQueryInterface(client, ref adapter, 7, IntPtr.Zero, out size, out data, out opcodeType);
                // ERROR_INVALID_STATE means the adapter is already disconnected.
                if (error == 5023) return false;
                if (error != 0) throw new Win32Exception((int)error);
                try
                {
                    // WLAN_CONNECTION_ATTRIBUTES: state, mode, WCHAR profile[256], DOT11_SSID.
                    if (size < ConnectionPrefixSize || data == IntPtr.Zero) return false;
                    byte[] prefix = new byte[ConnectionPrefixSize];
                    Marshal.Copy(data, prefix, 0, prefix.Length);
                    if (!MatchesConnection(prefix, expectedSsid)) return false;
                    error = WlanDisconnect(client, ref adapter, IntPtr.Zero);
                    if (error != 0) throw new Win32Exception((int)error);
                    return true;
                }
                finally { WlanFreeMemory(data); }
            }
            finally { WlanCloseHandle(client, IntPtr.Zero); }
        }

        public static bool MatchesConnection(byte[] attributes, string expectedSsid)
        {
            if (attributes == null || attributes.Length < ConnectionPrefixSize || String.IsNullOrEmpty(expectedSsid)) return false;
            if (BitConverter.ToInt32(attributes, 0) != 1) return false;
            int length = BitConverter.ToInt32(attributes, SsidLengthOffset);
            if (length < 1 || length > 32) return false;
            try
            {
                string actual = new UTF8Encoding(false, true).GetString(attributes, SsidBytesOffset, length);
                return String.Equals(actual, expectedSsid, StringComparison.Ordinal);
            }
            catch (DecoderFallbackException) { return false; }
        }
    }
}
