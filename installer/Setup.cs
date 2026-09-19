using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("WiFiMeter Setup")]
[assembly: AssemblyDescription("WiFiMeter - Per-user setup and uninstall")]
[assembly: AssemblyProduct("WiFiMeter")]
[assembly: AssemblyCompany("WiFiMeter")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace WiFiMeter.Setup
{
    internal sealed class Settings
    {
        internal string TestRoot;
        internal bool Uninstall, Silent;
        internal bool Desktop = true, StartMenu = true;
        internal bool Chinese;
        internal string InstallRoot, DataRoot, RegistryPath, DesktopLink, StartMenuLink, LogPath;

        internal void Resolve()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (TestRoot != null)
            {
                TestRoot = Path.GetFullPath(TestRoot).TrimEnd(Path.DirectorySeparatorChar);
                if (TestRoot.Length <= Path.GetPathRoot(TestRoot).Length) throw new ArgumentException(Text("The test directory cannot be a drive root.", "测试目录不能是磁盘根目录。"));
                InstallRoot = Path.Combine(TestRoot, "Programs", "WiFiMeter");
                DataRoot = Path.Combine(TestRoot, "Data");
                RegistryPath = @"Software\WiFiMeter\InstallerTests\" + Identity(TestRoot);
                DesktopLink = Path.Combine(TestRoot, "Shortcuts", "Desktop", "WiFiMeter.lnk");
                StartMenuLink = Path.Combine(TestRoot, "Shortcuts", "StartMenu", "WiFiMeter.lnk");
                LogPath = Path.Combine(TestRoot, "setup.log");
            }
            else
            {
                InstallRoot = Path.Combine(local, "Programs", "WiFiMeter");
                DataRoot = Path.Combine(local, "WiFiMeter", "data");
                RegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\WiFiMeter";
                DesktopLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "WiFiMeter.lnk");
                StartMenuLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "WiFiMeter.lnk");
                LogPath = Path.Combine(local, "WiFiMeter", "setup.log");
            }
        }

        internal static string Identity(string path)
        {
            using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(path).ToUpperInvariant()))).Replace("-", "").Substring(0, 20);
        }

        internal string Text(string english, string chinese) { return Chinese ? chinese : english; }
    }

    internal static class Program
    {
        internal static bool Chinese;
        internal static string Text(string english, string chinese) { return Chinese ? chinese : english; }

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "--cleanup") return Cleanup(args);
            Settings settings = new Settings();
            try
            {
                settings.Uninstall = String.Equals(Path.GetFileName(Assembly.GetExecutingAssembly().Location), "Uninstall.exe", StringComparison.OrdinalIgnoreCase);
                for (int i = 0; i < args.Length; i++)
                {
                    switch (args[i].ToLowerInvariant())
                    {
                        case "--uninstall": settings.Uninstall = true; break;
                        case "--silent": settings.Silent = true; break;
                        case "--language":
                            if (++i >= args.Length || (args[i] != "en" && args[i] != "zh-CN")) throw new ArgumentException("Language must be en or zh-CN.");
                            settings.Chinese = args[i] == "zh-CN";
                            Chinese = settings.Chinese;
                            break;
                        case "--test-root":
                            if (++i >= args.Length) throw new ArgumentException(Text("The test directory argument is missing.", "缺少测试目录。"));
                            settings.TestRoot = args[i];
                            break;
                        default: throw new ArgumentException(Text("Unknown setup argument: ", "无法识别安装参数：") + args[i]);
                    }
                }
                // The installed uninstaller remembers its isolated test location.
                if (settings.Uninstall && settings.TestRoot == null)
                {
                    string context = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), ".install-context");
                    if (File.Exists(context))
                    {
                        string saved = File.ReadAllText(context, Encoding.UTF8).Trim();
                        if (saved.Length > 0) settings.TestRoot = saved;
                    }
                }
                settings.Resolve();
                if (settings.Silent)
                {
                    Installer.Run(settings, delegate { });
                    return 0;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (SetupWindow window = new SetupWindow(settings)) { Application.Run(window); return window.Result; }
            }
            catch (Exception error)
            {
                Log(settings, error.ToString());
                if (!settings.Silent) MessageBox.Show(settings.Text("Setup could not complete.\r\n\r\n", "安装操作未完成。\r\n\r\n") + error.Message, "WiFiMeter", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        internal static void Log(Settings settings, string message)
        {
            try
            {
                if (String.IsNullOrEmpty(settings.LogPath)) return;
                Directory.CreateDirectory(Path.GetDirectoryName(settings.LogPath));
                File.AppendAllText(settings.LogPath, DateTimeOffset.Now.ToString("o") + " " + message + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }

        internal static string Quote(string value)
        {
            // Windows CommandLineToArgvW quoting, including paths ending in a backslash.
            StringBuilder result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
                result.Append('\\', slashes); slashes = 0; result.Append(c);
            }
            result.Append('\\', slashes * 2); result.Append('"');
            return result.ToString();
        }

        internal static Process StartHidden(string executable, string arguments)
        {
            return Process.Start(new ProcessStartInfo(executable, arguments) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden });
        }

        private static int Cleanup(string[] args)
        {
            // Only a verified uninstaller with a one-time adjacent marker may be removed.
            try
            {
                if (args.Length != 6) return 2;
                int parentId = Int32.Parse(args[1]);
                long ticks = Int64.Parse(args[2]);
                string root = Path.GetFullPath(args[3]);
                string target = Installer.SafeChild(root, "Uninstall.exe");
                string marker = Installer.SafeChild(root, ".uninstall-pending");
                if (!File.Exists(marker) || File.ReadAllText(marker, Encoding.UTF8) != args[4]) return 2;
                if (!String.Equals(Settings.Identity(root), args[5], StringComparison.Ordinal)) return 2;
                try
                {
                    using (Process parent = Process.GetProcessById(parentId))
                    {
                        if (parent.StartTime.ToUniversalTime().Ticks != ticks || !parent.WaitForExit(30000)) return 2;
                    }
                }
                catch (ArgumentException) { }
                for (int attempt = 0; attempt < 40; attempt++)
                {
                    try { if (File.Exists(target)) File.Delete(target); break; }
                    catch (IOException) { Thread.Sleep(150); }
                    catch (UnauthorizedAccessException) { Thread.Sleep(150); }
                }
                if (File.Exists(target)) return 1;
                File.Delete(marker);
                Installer.RemoveEmptyDirectories(root);
                // The running helper is retained in the OS temporary directory; the next installer run removes it.
                return 0;
            }
            catch { return 1; }
        }
    }

    internal static class Installer
    {
        private const string Manifest = ".install-manifest";
        internal static void Run(Settings settings, Action<string> progress)
        {
            using (Mutex mutex = new Mutex(false, @"Local\WiFiMeterSetup_" + Settings.Identity(settings.InstallRoot)))
            {
                bool held = false;
                try
                {
                    try { held = mutex.WaitOne(0); } catch (AbandonedMutexException) { held = true; }
                    if (!held) throw new IOException(settings.Text("Another WiFiMeter setup is running. Please wait for it to finish.", "另一个 WiFiMeter 安装操作正在进行，请等待它完成。"));
                    if (settings.Uninstall) Uninstall(settings, progress); else Install(settings, progress);
                }
                finally { if (held) mutex.ReleaseMutex(); }
            }
        }
        internal static string SafeChild(string root, string relative)
        {
            string fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
            if (Path.IsPathRooted(relative)) throw new InvalidDataException(Program.Text("The package contains an invalid path.", "安装包路径无效。"));
            string child = Path.GetFullPath(Path.Combine(fullRoot, relative));
            if (!child.StartsWith(fullRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException(Program.Text("A package path is outside the installation directory.", "安装包路径超出安装目录。"));
            AssertNoLinks(fullRoot);
            string parent = Path.GetDirectoryName(child);
            AssertNoLinks(parent);
            if (File.Exists(child) && (File.GetAttributes(child) & FileAttributes.ReparsePoint) != 0) throw new IOException(Program.Text("The installation path contains a redirected file. Use a regular folder.", "安装位置含有重定向文件，请选择普通文件夹。"));
            return child;
        }

        private static void AssertNoLinks(string path)
        {
            DirectoryInfo directory = new DirectoryInfo(path);
            while (directory != null)
            {
                if (directory.Exists && (directory.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException(Program.Text("The installation path contains a redirected folder. Use a regular folder.", "安装位置含有重定向文件夹，请使用普通文件夹。"));
                directory = directory.Parent;
            }
        }

        private static List<string> PayloadFiles()
        {
            List<string> files = new List<string>();
            using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream("WiFiMeter.Runtime.zip"))
            using (ZipArchive archive = new ZipArchive(input, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in archive.Entries) if (!String.IsNullOrEmpty(entry.Name)) files.Add(entry.FullName.Replace('/', Path.DirectorySeparatorChar));
            }
            return files;
        }

        private static void StopCollector(Settings settings)
        {
            string executable = SafeChild(settings.InstallRoot, "WiFiMeter.exe");
            if (!File.Exists(executable)) return;
            using (Process stop = Program.StartHidden(executable, "--stop --data-directory " + Program.Quote(settings.DataRoot)))
            {
                if (!stop.WaitForExit(25000)) throw new IOException(settings.Text("The collector is still saving data. Please try again shortly.", "后台统计仍在保存数据，请稍后重试。"));
                if (stop.ExitCode != 0) throw new IOException(settings.Text("The collector could not stop. Stop collection in WiFiMeter before trying again.", "后台统计未能正常停止。请先在 WiFiMeter 中停止统计，再重新操作。"));
            }
            foreach (Process process in Process.GetProcessesByName("WiFiMeter"))
            {
                using (process)
                {
                    try
                    {
                        if (!process.HasExited && String.Equals(process.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase) && !process.WaitForExit(5000))
                            throw new IOException(settings.Text("Close the WiFiMeter window before continuing.", "请先关闭 WiFiMeter 窗口，再继续操作。"));
                    }
                    catch (System.ComponentModel.Win32Exception) { }
                    catch (InvalidOperationException) { }
                }
            }
        }

        internal static void Install(Settings settings, Action<string> progress)
        {
            CleanupOldHelpers();
            progress(settings.Text("Preparing installation files…", "正在准备安装文件…"));
            AssertNoLinks(settings.InstallRoot);
            List<string> files = PayloadFiles();
            bool previous = File.Exists(SafeChild(settings.InstallRoot, Manifest));
            if (!previous)
            {
                foreach (string relative in files)
                    if (File.Exists(SafeChild(settings.InstallRoot, relative))) throw new IOException(settings.Text("The installation folder already contains files with the same names. Move them before continuing: ", "安装目录已有同名文件，请先移动这些文件：") + settings.InstallRoot);
            }
            string executable = SafeChild(settings.InstallRoot, "WiFiMeter.exe");
            if (settings.Desktop) AssertShortcutAvailable(settings, settings.DesktopLink, executable);
            if (settings.StartMenu) AssertShortcutAvailable(settings, settings.StartMenuLink, executable);
            progress(settings.Text("Saving usage and stopping the collector…", "正在保存并停止后台统计…"));
            StopCollector(settings);
            Directory.CreateDirectory(settings.InstallRoot);
            using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream("WiFiMeter.Runtime.zip"))
            using (ZipArchive archive = new ZipArchive(input, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    if (String.IsNullOrEmpty(entry.Name)) continue;
                    string target = SafeChild(settings.InstallRoot, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream source = entry.Open())
                    using (FileStream output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None)) source.CopyTo(output);
                }
            }
            string uninstall = SafeChild(settings.InstallRoot, "Uninstall.exe");
            string self = Assembly.GetExecutingAssembly().Location;
            if (!String.Equals(self, uninstall, StringComparison.OrdinalIgnoreCase)) File.Copy(self, uninstall, true);
            File.Copy(SafeChild(settings.InstallRoot, "WiFiMeter.exe.config"), SafeChild(settings.InstallRoot, "Uninstall.exe.config"), true);
            File.WriteAllText(SafeChild(settings.InstallRoot, ".install-context"), settings.TestRoot ?? "", Encoding.UTF8);
            files.Add("Uninstall.exe"); files.Add("Uninstall.exe.config"); files.Add(".install-context"); files.Add(Manifest);
            File.WriteAllLines(SafeChild(settings.InstallRoot, Manifest), files.ToArray(), Encoding.UTF8);
            progress(settings.Text("Creating shortcuts…", "正在创建快捷方式…"));
            if (settings.Desktop) CreateShortcut(settings.DesktopLink, executable);
            if (settings.StartMenu) CreateShortcut(settings.StartMenuLink, executable);
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(settings.RegistryPath))
            {
                key.SetValue("DisplayName", "WiFiMeter");
                key.SetValue("DisplayVersion", "1.0.0");
                key.SetValue("Publisher", "WiFiMeter");
                key.SetValue("InstallLocation", settings.InstallRoot);
                key.SetValue("DisplayIcon", executable);
                string arguments = " --uninstall" + (settings.TestRoot == null ? "" : " --test-root " + Program.Quote(settings.TestRoot));
                key.SetValue("UninstallString", Program.Quote(uninstall) + arguments);
                key.SetValue("QuietUninstallString", Program.Quote(uninstall) + arguments + " --silent");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            }
            string runPath = settings.TestRoot == null ? @"Software\Microsoft\Windows\CurrentVersion\Run" : settings.RegistryPath + @"\Run";
            using (RegistryKey run = Registry.CurrentUser.OpenSubKey(runPath, true))
            {
                // Preserve existing opt-in and Windows disable state while upgrading older startup commands.
                if (run != null && String.Equals(run.GetValue("WiFiMeter") as string, Program.Quote(executable) + " --background", StringComparison.OrdinalIgnoreCase))
                    run.SetValue("WiFiMeter", Program.Quote(executable) + " --tray", RegistryValueKind.String);
            }
            Program.Log(settings, "Installed " + settings.InstallRoot);
            progress(settings.Text("Installation complete", "安装完成"));
        }

        internal static void Uninstall(Settings settings, Action<string> progress)
        {
            AssertNoLinks(settings.InstallRoot);
            string manifest = SafeChild(settings.InstallRoot, Manifest);
            if (!File.Exists(manifest)) throw new IOException(settings.Text("No WiFiMeter installation record was found. Uninstall has been cancelled.", "未找到 WiFiMeter 安装记录，已取消卸载。"));
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(settings.RegistryPath))
            {
                if (key != null && !String.Equals(key.GetValue("InstallLocation") as string, settings.InstallRoot, StringComparison.OrdinalIgnoreCase))
                    throw new IOException(settings.Text("The uninstall registration points to a different installation directory.", "卸载注册信息与当前目录不一致。"));
            }
            progress(settings.Text("Saving usage data…", "正在保存统计数据…"));
            StopCollector(settings);
            string executable = SafeChild(settings.InstallRoot, "WiFiMeter.exe");
            RemoveShortcut(settings.DesktopLink, executable);
            RemoveShortcut(settings.StartMenuLink, executable);
            if (settings.TestRoot == null)
            {
                using (RegistryKey run = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                {
                    if (run != null)
                    {
                        string value = run.GetValue("WiFiMeter") as string;
                        if (IsTargetCommand(value, executable)) run.DeleteValue("WiFiMeter", false);
                    }
                }
            }
            List<string> known = PayloadFiles();
            known.Add("Uninstall.exe"); known.Add("Uninstall.exe.config"); known.Add(".install-context"); known.Add(Manifest);
            HashSet<string> allowed = new HashSet<string>(known, StringComparer.OrdinalIgnoreCase);
            List<string> owned = new List<string>(File.ReadAllLines(manifest, Encoding.UTF8));
            string self = Assembly.GetExecutingAssembly().Location;
            bool cleanupSelf = false;
            progress(settings.Text("Removing application files…", "正在移除程序文件…"));
            foreach (string relative in owned)
            {
                if (!allowed.Contains(relative)) continue;
                string target = SafeChild(settings.InstallRoot, relative);
                if (String.Equals(target, self, StringComparison.OrdinalIgnoreCase)) { cleanupSelf = true; continue; }
                if (File.Exists(target)) File.Delete(target);
            }
            Registry.CurrentUser.DeleteSubKey(settings.RegistryPath, false);
            if (cleanupSelf)
            {
                string token = Guid.NewGuid().ToString("N");
                File.WriteAllText(SafeChild(settings.InstallRoot, ".uninstall-pending"), token, Encoding.UTF8);
                string helper = Path.Combine(Path.GetTempPath(), "WiFiMeter-uninstall-" + token + ".exe");
                File.Copy(self, helper, false);
                using (Process process = Process.GetCurrentProcess())
                    Program.StartHidden(helper, "--cleanup " + process.Id + " " + process.StartTime.ToUniversalTime().Ticks + " " + Program.Quote(settings.InstallRoot) + " " + token + " " + Settings.Identity(settings.InstallRoot)).Dispose();
            }
            else RemoveEmptyDirectories(settings.InstallRoot);
            Program.Log(settings, "Uninstalled program; retained data at " + settings.DataRoot);
            progress(settings.Text("Uninstall complete. Usage data has been kept.", "卸载完成，统计数据已保留"));
        }

        private static bool IsTargetCommand(string command, string executable)
        {
            if (String.IsNullOrWhiteSpace(command)) return false;
            return command.Equals(Program.Quote(executable), StringComparison.OrdinalIgnoreCase)
                || command.StartsWith(Program.Quote(executable) + " ", StringComparison.OrdinalIgnoreCase)
                || command.Equals(executable, StringComparison.OrdinalIgnoreCase);
        }

        private static object Property(object target, string name, object value, bool set)
        {
            return target.GetType().InvokeMember(name, set ? BindingFlags.SetProperty : BindingFlags.GetProperty, null, target, set ? new object[] { value } : null);
        }

        private static void AssertShortcutAvailable(Settings settings, string path, string executable)
        {
            if (!File.Exists(path)) return;
            object shell = null, link = null;
            try
            {
                shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
                link = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
                if (!String.Equals(Property(link, "TargetPath", null, false) as string, executable, StringComparison.OrdinalIgnoreCase))
                    throw new IOException(settings.Text("A different shortcut already uses this name. Move it or turn off this shortcut option: ", "已有其他快捷方式使用此名称，请先移动它，或关闭对应的快捷方式选项：") + path);
            }
            finally
            {
                if (link != null) Marshal.FinalReleaseComObject(link);
                if (shell != null) Marshal.FinalReleaseComObject(shell);
            }
        }

        private static void CreateShortcut(string path, string executable)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            object shell = null, link = null;
            try
            {
                shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
                link = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
                Property(link, "TargetPath", executable, true);
                Property(link, "WorkingDirectory", Path.GetDirectoryName(executable), true);
                Property(link, "Description", "WiFiMeter - Wi-Fi usage monitor", true);
                Property(link, "IconLocation", executable + ",0", true);
                link.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
            }
            finally
            {
                if (link != null) Marshal.FinalReleaseComObject(link);
                if (shell != null) Marshal.FinalReleaseComObject(shell);
            }
        }

        private static void RemoveShortcut(string path, string executable)
        {
            if (!File.Exists(path)) return;
            object shell = null, link = null;
            try
            {
                shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
                link = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
                if (String.Equals(Property(link, "TargetPath", null, false) as string, executable, StringComparison.OrdinalIgnoreCase)) File.Delete(path);
            }
            finally
            {
                if (link != null) Marshal.FinalReleaseComObject(link);
                if (shell != null) Marshal.FinalReleaseComObject(shell);
            }
        }

        internal static void RemoveEmptyDirectories(string root)
        {
            if (!Directory.Exists(root)) return;
            // Only owned runtime folders are eligible; never recurse into user-created folders.
            foreach (string relative in new string[] { "src", "assets", "docs" })
            {
                string folder = SafeChild(root, relative);
                if (Directory.Exists(folder) && Directory.GetFileSystemEntries(folder).Length == 0) Directory.Delete(folder, false);
            }
            if (Directory.GetFileSystemEntries(root).Length == 0) Directory.Delete(root, false);
        }

        private static void CleanupOldHelpers()
        {
            foreach (string file in Directory.GetFiles(Path.GetTempPath(), "WiFiMeter-uninstall-*.exe"))
            {
                try
                {
                    string token = Path.GetFileNameWithoutExtension(file).Substring("WiFiMeter-uninstall-".Length);
                    Guid parsed;
                    if (Guid.TryParseExact(token, "N", out parsed) && File.GetLastWriteTimeUtc(file) < DateTime.UtcNow.AddMinutes(-5)) File.Delete(file);
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
    }

    internal sealed class SetupWindow : Form
    {
        private readonly Settings settings;
        private readonly Button action, close;
        private readonly CheckBox desktop, startMenu, launch;
        private readonly Label status, subtitle, heading, description;
        private readonly ComboBox language;
        private readonly ProgressBar progress;
        private bool busy, finished;
        internal int Result = 0;

        internal SetupWindow(Settings options)
        {
            settings = options;
            Font = new Font("Segoe UI", 9F);
            BackColor = Color.FromArgb(247, 248, 252);
            ClientSize = new Size(620, 460);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            AutoScaleMode = AutoScaleMode.Dpi;
            Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
            Panel banner = new Panel { BackColor = Color.White, Location = new Point(0, 0), Size = new Size(620, 124) };
            PictureBox logo = new PictureBox { Image = Icon.ToBitmap(), SizeMode = PictureBoxSizeMode.Zoom, Location = new Point(30, 29), Size = new Size(62, 62) };
            banner.Controls.Add(logo);
            banner.Controls.Add(new Label { Text = "WiFiMeter", Font = new Font(Font.FontFamily, 22F, FontStyle.Bold), ForeColor = Color.FromArgb(35, 42, 66), Location = new Point(108, 24), AutoSize = true });
            subtitle = new Label { ForeColor = Color.FromArgb(98, 106, 125), Location = new Point(110, 75), AutoSize = true };
            banner.Controls.Add(subtitle);
            language = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Location = new Point(454, 35), Size = new Size(135, 26) };
            language.Items.AddRange(new object[] { "English", "简体中文" });
            language.SelectedIndex = settings.Chinese ? 1 : 0;
            banner.Controls.Add(language);
            Controls.Add(banner);
            heading = new Label { Font = new Font(Font.FontFamily, 13F, FontStyle.Bold), Location = new Point(30, 148), AutoSize = true };
            description = new Label { ForeColor = Color.FromArgb(88, 103, 98), Location = new Point(31, 186), Size = new Size(558, 26) };
            Controls.Add(heading); Controls.Add(description);
            Controls.Add(new Label { Text = settings.InstallRoot, ForeColor = Color.FromArgb(65, 84, 78), Location = new Point(31, 220), Size = new Size(558, 38), AutoEllipsis = true });
            desktop = new CheckBox { Checked = true, Location = new Point(31, 274), AutoSize = true, Visible = !settings.Uninstall };
            startMenu = new CheckBox { Checked = true, Location = new Point(280, 274), AutoSize = true, Visible = !settings.Uninstall };
            launch = new CheckBox { Checked = true, Location = new Point(31, 307), AutoSize = true, Visible = !settings.Uninstall };
            Controls.Add(desktop); Controls.Add(startMenu); Controls.Add(launch);
            status = new Label { ForeColor = Color.FromArgb(94, 111, 106), Location = new Point(31, 349), Size = new Size(558, 24) };
            Controls.Add(status);
            progress = new ProgressBar { Location = new Point(31, 377), Size = new Size(558, 4), Style = ProgressBarStyle.Marquee, Visible = false };
            Controls.Add(progress);
            close = new Button { Location = new Point(377, 402), Size = new Size(90, 34), FlatStyle = FlatStyle.Flat };
            close.FlatAppearance.BorderColor = Color.FromArgb(203, 213, 208);
            action = new Button { Location = new Point(481, 402), Size = new Size(108, 34), FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(90, 99, 232), ForeColor = Color.White };
            action.FlatAppearance.BorderSize = 0;
            close.Click += delegate { Close(); };
            action.Click += Begin;
            Controls.Add(close); Controls.Add(action);
            AcceptButton = action;
            CancelButton = close;
            language.SelectedIndexChanged += delegate { settings.Chinese = language.SelectedIndex == 1; Program.Chinese = settings.Chinese; ApplyLanguage(); };
            ApplyLanguage();
            FormClosing += delegate(object sender, FormClosingEventArgs e) { if (busy) e.Cancel = true; };
        }

        private void ApplyLanguage()
        {
            Text = settings.Uninstall ? settings.Text("Uninstall WiFiMeter", "卸载 WiFiMeter") : settings.Text("Install WiFiMeter", "安装 WiFiMeter");
            subtitle.Text = settings.Text("Usage by Wi-Fi network", "Wi-Fi 用量统计");
            heading.Text = settings.Uninstall ? settings.Text("Remove the app. Keep your history.", "移除程序，保留统计记录") : settings.Text("Install for your Windows account", "为当前 Windows 用户安装");
            description.Text = settings.Uninstall ? settings.Text("Your usage history will be available if you reinstall later.", "卸载后，重新安装即可继续查看已有数据。") : settings.Text("No administrator access needed. Usage history is stored separately.", "无需管理员权限。统计记录单独保存在用户数据目录。");
            desktop.Text = settings.Text("Create a desktop shortcut", "创建桌面快捷方式");
            startMenu.Text = settings.Text("Add to the Start menu", "添加到开始菜单");
            launch.Text = settings.Text("Open WiFiMeter when installation finishes", "安装完成后打开 WiFiMeter");
            close.Text = settings.Text("Cancel", "取消");
            action.Text = finished ? settings.Text("Finish", "完成") : (settings.Uninstall ? settings.Text("Uninstall", "卸载") : settings.Text("Install", "安装"));
            if (finished) status.Text = settings.Uninstall ? settings.Text("Uninstall complete. Usage data has been kept.", "卸载完成，统计数据已保留") : settings.Text("Installation complete", "安装完成");
            else status.Text = settings.Uninstall ? settings.Text("The collector will save your data before it exits.", "后台统计会先保存数据并退出。") : settings.Text("Version 1.0.0 · Windows 10 / 11", "版本 1.0.0 · Windows 10 / 11");
        }

        private void Begin(object sender, EventArgs e)
        {
            if (finished) { Close(); return; }
            settings.Desktop = desktop.Checked; settings.StartMenu = startMenu.Checked;
            busy = true; action.Enabled = false; close.Enabled = false; language.Enabled = false;
            desktop.Enabled = false; startMenu.Enabled = false; launch.Enabled = false; progress.Visible = true;
            Task.Factory.StartNew(delegate
            {
                Exception failure = null;
                try
                {
                    Action<string> update = delegate(string text) { BeginInvoke((Action)delegate { status.Text = text; }); };
                    Installer.Run(settings, update);
                }
                catch (Exception error) { failure = error; Program.Log(settings, error.ToString()); }
                BeginInvoke((Action)delegate
                {
                    busy = false; progress.Visible = false; close.Enabled = true; action.Enabled = true; language.Enabled = true;
                    if (failure != null)
                    {
                        desktop.Enabled = true; startMenu.Enabled = true; launch.Enabled = true;
                        Result = 1; status.Text = settings.Text("Setup could not complete. Review the message and try again.", "操作未完成，请查看提示后重试。");
                        MessageBox.Show(this, settings.Text("Setup could not complete.\r\n\r\n", "安装操作未完成。\r\n\r\n") + failure.Message, "WiFiMeter", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return;
                    }
                    Result = 0; finished = true; close.Visible = false; ApplyLanguage();
                    if (!settings.Uninstall && launch.Checked)
                    {
                        string args = "--language " + (settings.Chinese ? "zh-CN" : "en") + (settings.TestRoot == null ? "" : " --data-directory " + Program.Quote(settings.DataRoot));
                        Process.Start(new ProcessStartInfo(Path.Combine(settings.InstallRoot, "WiFiMeter.exe"), args) { UseShellExecute = true });
                    }
                });
            });
        }
    }
}
