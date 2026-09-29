#requires -Version 5.1
Set-StrictMode -Version Latest

function Invoke-MeterFileReplace {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [AllowNull()][string]$BackupPath
    )
    for ($attempt = 0; ; $attempt++) {
        try {
            if ([string]::IsNullOrEmpty($BackupPath)) {
                [IO.File]::Replace($Source, $Destination, [Management.Automation.Language.NullString]::Value)
            } else { [IO.File]::Replace($Source, $Destination, $BackupPath) }
            return
        } catch [IO.IOException] {
            # Retry only transient replacement errors, retaining atomic replacement and the old file.
            $nativeError = $_.Exception.HResult -band 0xffff
            if ($attempt -ge 3 -or $nativeError -notin @(32, 33, 1175) -or -not [IO.File]::Exists($Source)) { throw }
            Start-Sleep -Milliseconds (40 * ($attempt + 1))
        }
    }
}

Export-ModuleMember -Function Invoke-MeterFileReplace
