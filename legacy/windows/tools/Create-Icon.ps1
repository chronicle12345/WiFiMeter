#requires -Version 5.1
param([Parameter(Mandatory)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$frames = @()
foreach ($size in @(16, 32, 48, 256)) {
    $bitmap = New-Object Drawing.Bitmap($size, $size)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([Drawing.Color]::Transparent)
    $scale = $size / 256.0
    $graphics.ScaleTransform($scale, $scale)
    $background = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#5A63E8'))
    $pathShape = New-Object Drawing.Drawing2D.GraphicsPath
    $pathShape.AddArc(4, 4, 80, 80, 180, 90)
    $pathShape.AddArc(172, 4, 80, 80, 270, 90)
    $pathShape.AddArc(172, 172, 80, 80, 0, 90)
    $pathShape.AddArc(4, 172, 80, 80, 90, 90)
    $pathShape.CloseFigure()
    $graphics.FillPath($background, $pathShape)
    $pen = New-Object Drawing.Pen([Drawing.Color]::White, 17)
    $pen.StartCap = [Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
    $graphics.DrawArc($pen, 39, 56, 178, 178, 220, 100)
    $graphics.DrawArc($pen, 73, 96, 110, 110, 220, 100)
    $white = New-Object Drawing.SolidBrush([Drawing.Color]::White)
    $graphics.FillEllipse($white, 114, 163, 28, 28)
    $memory = New-Object IO.MemoryStream
    $bitmap.Save($memory, [Drawing.Imaging.ImageFormat]::Png)
    $frames += ,@($size, $memory.ToArray())
    $memory.Dispose(); $white.Dispose(); $pen.Dispose(); $pathShape.Dispose(); $background.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path)))
$stream = [IO.File]::Create($Path)
$writer = New-Object IO.BinaryWriter($stream)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
    $offset = 6 + $frames.Count * 16
    foreach ($frame in $frames) {
        $dimension = if ($frame[0] -eq 256) { 0 } else { $frame[0] }
        $writer.Write([byte]$dimension); $writer.Write([byte]$dimension); $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$frame[1].Length); $writer.Write([uint32]$offset)
        $offset += $frame[1].Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame[1]) }
} finally { $writer.Dispose(); $stream.Dispose() }
