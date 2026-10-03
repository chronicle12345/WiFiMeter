$ErrorActionPreference='Stop'
$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PATH__'))
$message=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__MESSAGE__'))
$title=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__TITLE__'))
$file=$null
$authorized=$false
try {
    $p=Get-Process -Id __PARENT__ -ErrorAction Stop
    $null=$p.Handle
    $file=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $sha=[Security.Cryptography.SHA256]::Create()
    try {$hash=([BitConverter]::ToString($sha.ComputeHash($file))).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose()}
    if($hash -ne '__DIGEST__'){throw 'Installer changed before handoff'}
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
    if([Console]::In.ReadLine() -ne 'GO'){exit 1}
    $authorized=$true
    if(-not $p.WaitForExit(60000)){throw 'WiFiMeter did not exit within 60 seconds'}
    Start-Process -FilePath $target -WindowStyle Hidden
} catch {
    if($authorized){
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($message, $title) | Out-Null
    }
    exit 1
} finally {if($file){$file.Dispose()}}
