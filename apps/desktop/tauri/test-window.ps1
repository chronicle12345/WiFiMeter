param(
    [Parameter(Mandatory=$true)][int]$ProcessId,
    [ValidateSet('close','dialog','cancel-dialog','click','visible','bounds','move','cursor','drag')][string]$Action,
    [ValidateSet('main','mini')][string]$Target = 'main',
    [int]$X, [int]$Y,
    [string]$ButtonName,
    [switch]$Remember
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TestWindow {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    public delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder text, int capacity);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@
[void][TestWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
$script:windows = @()
$script:dialog = [IntPtr]::Zero
$script:main = [IntPtr]::Zero
[TestWindow]::EnumWindows({
    param($window, $parameter)
    [uint32]$owner = 0
    [void][TestWindow]::GetWindowThreadProcessId($window, [ref]$owner)
    if ($owner -eq $ProcessId) {
        $class = New-Object System.Text.StringBuilder 256
        [void][TestWindow]::GetClassName($window, $class, 256)
        $script:windows += @{class=$class.ToString();style=[TestWindow]::GetWindowLongPtr($window,-16).ToInt64();exstyle=[TestWindow]::GetWindowLongPtr($window,-20).ToInt64()}
        if ($class.ToString() -eq '#32770' -and [TestWindow]::IsWindowVisible($window)) { $script:dialog = $window }
        elseif ($class.ToString() -eq 'Tauri Window') {
            $mini = ([TestWindow]::GetWindowLongPtr($window, -20).ToInt64() -band 0x8000000) -ne 0
            if (($Target -eq 'mini') -eq $mini) { $script:main = $window }
        }
    }
    return $true
}, [IntPtr]::Zero) | Out-Null
if ($Action -in @('bounds','move','cursor','drag')) {
    if ($script:main -eq [IntPtr]::Zero) { throw ('Test window not found: ' + ($script:windows | ConvertTo-Json -Compress)) }
    $rect = New-Object TestWindow+Rect
    [void][TestWindow]::GetWindowRect($script:main, [ref]$rect)
    $cursor = New-Object TestWindow+Point
    [void][TestWindow]::GetCursorPos([ref]$cursor)
    if ($Action -eq 'cursor') {
        [void][TestWindow]::SetCursorPos($X,$Y)
        @{ x=$cursor.X; y=$cursor.Y } | ConvertTo-Json -Compress
    } elseif ($Action -eq 'move') {
        [void][TestWindow]::SetWindowPos($script:main,[IntPtr]::Zero,$X,$Y,0,0,21)
    } elseif ($Action -eq 'drag') {
        try {
            [void][TestWindow]::SetCursorPos($rect.Left+35,$rect.Top+22)
            [TestWindow]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
            Start-Sleep -Milliseconds 150
            [void][TestWindow]::SetCursorPos($X+35,$Y+22)
            Start-Sleep -Milliseconds 150
            [TestWindow]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
        } finally { [void][TestWindow]::SetCursorPos($cursor.X,$cursor.Y) }
    } else {
        $monitor = New-Object TestWindow+MonitorInfo
        $monitor.Size = [System.Runtime.InteropServices.Marshal]::SizeOf($monitor)
        [void][TestWindow]::GetMonitorInfo([TestWindow]::MonitorFromWindow($script:main,2),[ref]$monitor)
        $extended = [TestWindow]::GetWindowLongPtr($script:main,-20).ToInt64()
        @{ x=$rect.Left; y=$rect.Top; width=$rect.Right-$rect.Left; height=$rect.Bottom-$rect.Top;
           scale=[TestWindow]::GetDpiForWindow($script:main)/96; visible=[TestWindow]::IsWindowVisible($script:main);
           topmost=($extended -band 8) -ne 0; noActivate=($extended -band 0x8000000) -ne 0;
           cursor=@{x=$cursor.X;y=$cursor.Y}; leftButtonDown=[TestWindow]::GetAsyncKeyState(1) -lt 0;
           area=@{x=$monitor.Work.Left;y=$monitor.Work.Top;width=$monitor.Work.Right-$monitor.Work.Left;height=$monitor.Work.Bottom-$monitor.Work.Top} } | ConvertTo-Json -Compress
    }
    exit
}
$script:controls = @()
if ($script:dialog -ne [IntPtr]::Zero) {
    [TestWindow]::EnumChildWindows($script:dialog, {
        param($window, $parameter)
        $text = New-Object System.Text.StringBuilder 1024
        $class = New-Object System.Text.StringBuilder 256
        [void][TestWindow]::GetWindowText($window, $text, 1024)
        [void][TestWindow]::GetClassName($window, $class, 256)
        $script:controls += @{ handle=$window.ToInt64(); name=$text.ToString(); class=$class.ToString() }
        return $true
    }, [IntPtr]::Zero) | Out-Null
}
if ($Action -eq 'dialog') {
    $focused = ''
    $title = New-Object System.Text.StringBuilder 1024
    if ($script:dialog -ne [IntPtr]::Zero) {
        [void][TestWindow]::GetWindowText($script:dialog, $title, 1024)
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $focused = [System.Windows.Automation.AutomationElement]::FocusedElement.Current.Name
    }
    @{ found = $script:dialog -ne [IntPtr]::Zero; focused = $focused; title = $title.ToString() } | ConvertTo-Json -Compress
} elseif ($Action -eq 'cancel-dialog') {
    if ($script:dialog -eq [IntPtr]::Zero) { throw 'Test dialog not found' }
    [TestWindow]::PostMessage($script:dialog, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
} elseif ($Action -eq 'click') {
    if ($script:dialog -eq [IntPtr]::Zero) { throw 'Test dialog not found' }
    $nativeButton = $script:controls | Where-Object { $_.class -eq 'Button' -and $_.name -eq $ButtonName } | Select-Object -First 1
    if (-not $nativeButton) { throw "Test button not found: $ButtonName" }
    [TestWindow]::SetForegroundWindow($script:dialog) | Out-Null
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $element = [System.Windows.Automation.AutomationElement]::FromHandle($script:dialog)
    $nameCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $ButtonName)
    $button = $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
    if ($button.Current.AutomationId -notmatch '^CommandButton_(\d+)$') { throw 'Unexpected TaskDialog button identity' }
    $buttonId = [int]$Matches[1]
    if ($Remember) {
        $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::CheckBox)
        $checkbox = $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
        $checkbox.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
    }
    [TestWindow]::SendMessage($script:dialog, 1126, [IntPtr]$buttonId, [IntPtr]::Zero) | Out-Null
} elseif ($Action -eq 'close') {
    if ($script:main -eq [IntPtr]::Zero) { $script:main = (Get-Process -Id $ProcessId).MainWindowHandle }
    if ($script:main -eq [IntPtr]::Zero) { throw 'Test main window not found' }
    [TestWindow]::PostMessage($script:main, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
} else {
    @{ visible = $script:main -ne [IntPtr]::Zero -and [TestWindow]::IsWindowVisible($script:main) } | ConvertTo-Json -Compress
}
