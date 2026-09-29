using System;
using System.Globalization;
using System.IO;
using System.Management.Automation;
using System.Management.Automation.Host;
using System.Management.Automation.Runspaces;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("WiFiMeter")]
[assembly: AssemblyDescription("WiFiMeter - Wi-Fi usage monitor")]
[assembly: AssemblyProduct("WiFiMeter")]
[assembly: AssemblyCompany("WiFiMeter")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace WiFiMeter.Native
{
    internal sealed class MeterHost : PSHost
    {
        private readonly Guid id = Guid.NewGuid();
        internal int ExitCode;
        internal bool ExitRequested;
        public override Guid InstanceId { get { return id; } }
        public override string Name { get { return "WiFiMeter"; } }
        public override Version Version { get { return new Version(1, 0); } }
        public override PSHostUserInterface UI { get { return null; } }
        public override CultureInfo CurrentCulture { get { return CultureInfo.CurrentCulture; } }
        public override CultureInfo CurrentUICulture { get { return CultureInfo.CurrentUICulture; } }
        public override void SetShouldExit(int exitCode) { ExitCode = exitCode; ExitRequested = true; }
        public override void EnterNestedPrompt() { throw new NotSupportedException("WiFiMeter does not provide an interactive console."); }
        public override void ExitNestedPrompt() { }
        public override void NotifyBeginApplication() { }
        public override void NotifyEndApplication() { }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            bool background = false, stop = false, preview = false, noStart = false, tray = false;
            string dataDirectory = null, snapshot = null, language = null;
            int? networkCount = null;
            Mutex windowMutex = null;
            EventWaitHandle activation = null, exit = null;
            bool ownsWindow = false;
            try
            {
                for (int i = 0; i < args.Length; i++)
                {
                    switch (args[i].ToLowerInvariant())
                    {
                        case "--background": background = true; break;
                        case "--stop": stop = true; break;
                        case "--preview": preview = true; break;
                        case "--no-start": noStart = true; break;
                        case "--tray": tray = true; break;
                        case "--data-directory": dataDirectory = Path.GetFullPath(Value(args, ref i)); break;
                        case "--snapshot": snapshot = Path.GetFullPath(Value(args, ref i)); break;
                        case "--language":
                            language = Value(args, ref i);
                            if (language != "en" && language != "zh-CN") throw new ArgumentException("Language must be en or zh-CN.");
                            break;
                        case "--preview-network-count":
                            int count;
                            if (!Int32.TryParse(Value(args, ref i), out count) || count < 0 || count > 1000) throw new ArgumentException("Preview network count must be between 0 and 1000.");
                            networkCount = count;
                            break;
                        default: throw new ArgumentException("Unknown startup argument: " + args[i]);
                    }
                }
                if (background && stop) throw new ArgumentException("Background and stop arguments cannot be used together.");
                if (tray && (background || stop || preview || snapshot != null)) throw new ArgumentException("Tray startup cannot be combined with background, stop or preview arguments.");
                dataDirectory = Path.GetFullPath(dataDirectory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WiFiMeter", "data"));
                string windowName = WindowName(dataDirectory);
                if (stop) SignalEvent(windowName + "_Exit");
                else if (!background && !preview && snapshot == null)
                {
                    windowMutex = new Mutex(false, windowName);
                    try { ownsWindow = windowMutex.WaitOne(0); }
                    catch (AbandonedMutexException) { ownsWindow = true; }
                    if (!ownsWindow)
                    {
                        if (!tray)
                        {
                            // The first process may still be creating its activation event.
                            for (int attempt = 0; attempt < 20 && !SignalEvent(windowName + "_Activate"); attempt++) Thread.Sleep(50);
                        }
                        return 0;
                    }
                    activation = new EventWaitHandle(false, EventResetMode.AutoReset, windowName + "_Activate");
                    exit = new EventWaitHandle(false, EventResetMode.AutoReset, windowName + "_Exit");
                }
                string executable = Assembly.GetExecutingAssembly().Location;
                string source = Path.Combine(Path.GetDirectoryName(executable), "src");
                Environment.SetEnvironmentVariable("WIFIMETER_EXE", executable, EnvironmentVariableTarget.Process);
                // Equivalent to PowerShell's process-only ExecutionPolicy switch. Group Policy still takes precedence.
                Environment.SetEnvironmentVariable("PSExecutionPolicyPreference", "Bypass", EnvironmentVariableTarget.Process);
                MeterHost host = new MeterHost();
                using (Runspace runspace = RunspaceFactory.CreateRunspace(host, InitialSessionState.CreateDefault()))
                {
                    runspace.ApartmentState = ApartmentState.STA;
                    runspace.ThreadOptions = PSThreadOptions.UseCurrentThread;
                    runspace.Open();
                    runspace.SessionStateProxy.SetVariable("WiFiMeterExecutablePath", executable);
                    runspace.SessionStateProxy.SetVariable("WiFiMeterActivationEvent", activation);
                    runspace.SessionStateProxy.SetVariable("WiFiMeterExitEvent", exit);
                    using (PowerShell shell = PowerShell.Create())
                    {
                        shell.Runspace = runspace;
                        if (stop)
                        {
                            shell.AddCommand("Import-Module").AddParameter("Name", Path.Combine(source, "Control.psm1")).AddParameter("Force").AddParameter("ErrorAction", ActionPreference.Stop);
                            shell.Invoke();
                            ThrowErrors(shell);
                            shell.Commands.Clear();
                            shell.AddCommand("Stop-MeterCollector").AddParameter("ErrorAction", ActionPreference.Stop);
                            if (dataDirectory != null) shell.AddParameter("DataDirectory", dataDirectory);
                        }
                        else
                        {
                            string script = Path.Combine(source, background ? "Collector.ps1" : "App.ps1");
                            if (!File.Exists(script)) throw new FileNotFoundException(language == "zh-CN" ? "缺少程序文件，请重新安装 WiFiMeter。" : "An application file is missing. Please reinstall WiFiMeter.", script);
                            shell.AddCommand(script);
                            if (dataDirectory != null) shell.AddParameter("DataDirectory", dataDirectory);
                            if (!background)
                            {
                                if (preview) shell.AddParameter("Preview");
                                if (noStart) shell.AddParameter("NoStart");
                                if (tray) shell.AddParameter("StartMinimized");
                                if (snapshot != null) shell.AddParameter("SnapshotPath", snapshot);
                                if (language != null) shell.AddParameter("Language", language);
                                if (networkCount.HasValue) shell.AddParameter("PreviewNetworkCount", networkCount.Value);
                            }
                        }
                        shell.Invoke();
                        ThrowErrors(shell);
                        if (stop) WaitForWindowExit(windowName);
                        return host.ExitRequested ? host.ExitCode : 0;
                    }
                }
            }
            catch (Exception error)
            {
                string logDirectory = dataDirectory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WiFiMeter", "data");
                string logPath = Path.Combine(logDirectory, "host.log");
                try
                {
                    Directory.CreateDirectory(logDirectory);
                    if (File.Exists(logPath) && new FileInfo(logPath).Length > 1048576) File.WriteAllText(logPath, "", Encoding.UTF8);
                    File.AppendAllText(logPath, DateTimeOffset.Now.ToString("o") + " " + error + Environment.NewLine, Encoding.UTF8);
                }
                catch { }
                if (!background && !stop && !preview && snapshot == null)
                    MessageBox.Show((language == "zh-CN" ? "WiFiMeter 无法启动。\r\n\r\n" : "WiFiMeter could not start.\r\n\r\n") + error.Message + "\r\n\r\n" + (language == "zh-CN" ? "日志：" : "Log: ") + logPath, "WiFiMeter", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            finally
            {
                if (activation != null) activation.Dispose();
                if (exit != null) exit.Dispose();
                if (windowMutex != null)
                {
                    if (ownsWindow) windowMutex.ReleaseMutex();
                    windowMutex.Dispose();
                }
            }
        }

        private static string WindowName(string directory)
        {
            using (SHA256 hash = SHA256.Create())
                return "Local\\WiFiMeterWindow_" + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(directory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).ToUpperInvariant()))).Replace("-", "");
        }

        private static bool SignalEvent(string name)
        {
            EventWaitHandle handle;
            if (!EventWaitHandle.TryOpenExisting(name, out handle)) return false;
            using (handle) { return handle.Set(); }
        }

        private static void WaitForWindowExit(string name)
        {
            Mutex existing;
            if (!Mutex.TryOpenExisting(name, out existing)) return;
            using (existing)
            {
                bool acquired;
                try { acquired = existing.WaitOne(15000); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) throw new TimeoutException("The WiFiMeter window did not finish closing.");
                existing.ReleaseMutex();
            }
        }

        private static string Value(string[] args, ref int index)
        {
            if (++index >= args.Length || String.IsNullOrWhiteSpace(args[index])) throw new ArgumentException("A startup argument is missing its value.");
            return args[index];
        }

        private static void ThrowErrors(PowerShell shell)
        {
            // Handled PowerShell errors may remain in Streams.Error after the script succeeds.
            if (shell.InvocationStateInfo.State != PSInvocationState.Failed) return;
            StringBuilder text = new StringBuilder();
            foreach (ErrorRecord record in shell.Streams.Error)
            {
                text.AppendLine(record.ToString());
                if (record.InvocationInfo != null) text.AppendLine(record.InvocationInfo.PositionMessage);
                text.AppendLine(record.ScriptStackTrace);
            }
            throw new InvalidOperationException(text.ToString());
        }
    }
}
