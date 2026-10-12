$ErrorActionPreference = 'Stop'
$profilePath = $args[0]
$controlPath = $args[1]
if (![IO.Path]::IsPathRooted($profilePath) -or ![IO.Path]::IsPathRooted($controlPath)) {
    throw 'Instance test requires isolated absolute paths.'
}

function Publish-State([string] $name, [string] $state) {
    $temporary = [IO.Path]::Combine($controlPath, "$name.tmp")
    [IO.File]::WriteAllText($temporary, "$state $PID`n")
    [IO.File]::Move($temporary, [IO.Path]::Combine($controlPath, $name))
}

$lock = $null
try {
    try {
        # 保留旧用户配置目录的 Windows lockfile 共享与关闭协议。
        $lock = [IO.FileStream]::new([IO.Path]::Combine($profilePath, 'lockfile'),
            [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read,
            4096, [IO.FileOptions]::DeleteOnClose)
    } catch [IO.IOException] {
        if (($_.Exception.HResult -band 0xffff) -notin @(32, 33)) { throw }
        Publish-State 'state' 'DENIED'
        exit 0
    }
    Publish-State 'state' 'READY'
    $nextPing = 1
    while (![IO.File]::Exists([IO.Path]::Combine($controlPath, 'exit'))) {
        if ([IO.File]::Exists([IO.Path]::Combine($controlPath, "ping-$nextPing"))) {
            Publish-State "pong-$nextPing" 'ALIVE'
            $nextPing++
        }
        [Threading.Thread]::Sleep(25)
    }
} finally {
    if ($lock) { $lock.Dispose() }
}
