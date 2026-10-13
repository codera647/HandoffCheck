# Rasterize the existing public/favicon.svg mark for the Windows installer.
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$shape = New-Object System.Drawing.Drawing2D.GraphicsPath
$shape.AddArc(0, 0, 102.4, 102.4, 180, 90)
$shape.AddArc(153.6, 0, 102.4, 102.4, 270, 90)
$shape.AddArc(153.6, 153.6, 102.4, 102.4, 0, 90)
$shape.AddArc(0, 153.6, 102.4, 102.4, 90, 90)
$shape.CloseFigure()
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#252522'))
$graphics.FillPath($brush, $shape)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 19.2
$graphics.DrawLine($pen, 76.8, 76.8, 76.8, 179.2)
$graphics.DrawLine($pen, 179.2, 76.8, 179.2, 179.2)
$graphics.DrawLine($pen, 76.8, 128, 179.2, 128)
$pen.Width = 12.8
$graphics.DrawLine($pen, 147.2, 76.8, 166.4, 96)
$graphics.DrawLine($pen, 166.4, 96, 198.4, 57.6)
$png = New-Object System.IO.MemoryStream
$bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$bytes = $png.ToArray()
$target = Join-Path $PSScriptRoot 'icon.ico'
$writer = New-Object System.IO.BinaryWriter ([System.IO.File]::Create($target))
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([uint16]1); $writer.Write([uint16]32)
$writer.Write([uint32]$bytes.Length); $writer.Write([uint32]22); $writer.Write($bytes)
$writer.Dispose(); $png.Dispose(); $pen.Dispose(); $brush.Dispose()
$shape.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
Write-Output "Created $target"
