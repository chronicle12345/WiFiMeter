#requires -Version 5.1
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,100}$')][string]$ProductName,
    [Parameter(Mandatory)][string]$Publisher,
    [Parameter(Mandatory)][ValidateSet('32', '64')][string]$RegistryView
)
$ErrorActionPreference = 'Stop'

# This probe never changes registry entries or files. Only exit 0 permits repair.
function Test-MissingProductUninstaller {
    $view = if ($RegistryView -eq '64') { [Microsoft.Win32.RegistryView]::Registry64 } else { [Microsoft.Win32.RegistryView]::Registry32 }
    $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
    try {
        $entry = $registry.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $ProductName)
        if ($null -eq $entry) { return $false }
        try {
            if ($entry.GetValue('DisplayName') -ine $ProductName -or $entry.GetValue('Publisher') -ine $Publisher) { return $false }
            $directory = [string]$entry.GetValue('InstallLocation', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            if ($directory.StartsWith('"') -and $directory.EndsWith('"')) { $directory = $directory.Substring(1, $directory.Length - 2) }
            if ($directory -notmatch '^(?:[a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+\\)' -or $directory.IndexOf('"') -ge 0) { return $false }
            $normalized = [IO.Path]::GetFullPath($directory).TrimEnd('\')
            if ($directory.TrimEnd('\') -ine $normalized -or -not [IO.Directory]::Exists($normalized)) { return $false }
            $command = [string]$entry.GetValue('UninstallString', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            if ($command -notmatch '^"([^"\r\n]+)"(?:\s+(?:--uninstall|/currentuser|/S))*\s*$') { return $false }
            $uninstaller = [IO.Path]::GetFullPath($Matches[1])
            if ([IO.Path]::GetDirectoryName($uninstaller) -ine $normalized -or
                [IO.Path]::GetFileName($uninstaller) -inotmatch '^(?:uninstall\.exe|Uninstall WiFiMeter\.exe)$') { return $false }
            # File.Exists also returns false for access errors. Only missing paths permit repair.
            try { [IO.File]::GetAttributes($uninstaller) | Out-Null; return $false }
            catch [IO.FileNotFoundException] { }
            catch [IO.DirectoryNotFoundException] { }
            $main = Join-Path $normalized 'WiFiMeter.exe'
            if (-not [IO.File]::Exists($main)) { return $false }
            return [Diagnostics.FileVersionInfo]::GetVersionInfo($main).ProductName -ieq $ProductName
        } finally { $entry.Dispose() }
    } finally { $registry.Dispose() }
}

try { if (Test-MissingProductUninstaller) { exit 0 }; exit 2 }
catch { exit 2 }
