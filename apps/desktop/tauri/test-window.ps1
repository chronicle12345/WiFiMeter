param(
    [Parameter(Mandatory=$true)][int]$ProcessId,
    [ValidateSet('close','dialog','click','visible')][string]$Action,
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
$script:dialog = [IntPtr]::Zero
$script:main = [IntPtr]::Zero
[TestWindow]::EnumWindows({
    param($window, $parameter)
    [uint32]$owner = 0
    [void][TestWindow]::GetWindowThreadProcessId($window, [ref]$owner)
    if ($owner -eq $ProcessId) {
        $class = New-Object System.Text.StringBuilder 256
        [void][TestWindow]::GetClassName($window, $class, 256)
        if ($class.ToString() -eq '#32770' -and [TestWindow]::IsWindowVisible($window)) { $script:dialog = $window }
        elseif ($class.ToString() -eq 'Tao Window') { $script:main = $window }
    }
    return $true
}, [IntPtr]::Zero) | Out-Null
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
    if ($script:dialog -ne [IntPtr]::Zero) {
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $focused = [System.Windows.Automation.AutomationElement]::FocusedElement.Current.Name
    }
    @{ found = $script:dialog -ne [IntPtr]::Zero; focused = $focused } | ConvertTo-Json -Compress
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
