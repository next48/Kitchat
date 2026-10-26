$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $root 'public\kitchat-icon.png'
$outputDir = Join-Path $root 'src-tauri\installer'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$logo = [System.Drawing.Image]::FromFile($sourcePath)

function New-Canvas([int]$width, [int]$height) {
    return [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
}

function Add-Gradient($graphics, $width, $height, $top, $bottom) {
    $rect = [System.Drawing.Rectangle]::new(0, 0, $width, $height)
    $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($rect, $top, $bottom, 90)
    $graphics.FillRectangle($brush, $rect)
    $brush.Dispose()
}

function Save-Bitmap($bitmap, $path) {
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bitmap.Dispose()
}

try {
    $sidebar = New-Canvas 164 314
    $g = [System.Drawing.Graphics]::FromImage($sidebar)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    Add-Gradient $g 164 314 ([System.Drawing.Color]::FromArgb(38,20,38)) ([System.Drawing.Color]::FromArgb(12,16,32))
    $glow = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(55,255,92,164))
    $g.FillEllipse($glow, -58, -52, 210, 180)
    $glow.Color = [System.Drawing.Color]::FromArgb(45,96,87,255)
    $g.FillEllipse($glow, 64, 190, 170, 170)
    $g.DrawImage($logo, [System.Drawing.Rectangle]::new(42, 42, 80, 80))
    $titleFont = [System.Drawing.Font]::new('Segoe UI', 19, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $captionFont = [System.Drawing.Font]::new('Segoe UI', 10, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $center = [System.Drawing.StringFormat]::new(); $center.Alignment = 'Center'
    $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $muted = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(190,207,203,216))
    $g.DrawString('Kitchat', $titleFont, $white, [System.Drawing.RectangleF]::new(8, 139, 148, 28), $center)
    $g.DrawString("Stay close.`nTalk freely.", $captionFont, $muted, [System.Drawing.RectangleF]::new(14, 171, 136, 42), $center)
    $accent = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255,235,92,151))
    $g.FillRectangle($accent, 54, 235, 56, 3)
    $g.DrawString('FAST  /  SIMPLE  /  P2P', $captionFont, $muted, [System.Drawing.RectangleF]::new(8, 254, 148, 18), $center)
    $g.Dispose(); $glow.Dispose(); $titleFont.Dispose(); $captionFont.Dispose(); $center.Dispose(); $white.Dispose(); $muted.Dispose(); $accent.Dispose()
    Save-Bitmap $sidebar (Join-Path $outputDir 'installer-sidebar.bmp')

    foreach ($name in @('installer-header.bmp', 'uninstaller-header.bmp')) {
        $header = New-Canvas 150 57
        $g = [System.Drawing.Graphics]::FromImage($header)
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        Add-Gradient $g 150 57 ([System.Drawing.Color]::FromArgb(45,21,43)) ([System.Drawing.Color]::FromArgb(18,19,31))
        $g.DrawImage($logo, [System.Drawing.Rectangle]::new(105, 9, 38, 38))
        $font = [System.Drawing.Font]::new('Segoe UI', 15, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $small = [System.Drawing.Font]::new('Segoe UI', 8, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
        $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
        $muted = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(200,208,199,214))
        $g.DrawString('Kitchat', $font, $white, 10, 11)
        $g.DrawString($(if ($name -like 'uninstaller*') { 'Safe removal' } else { 'App installation' }), $small, $muted, 11, 32)
        $g.Dispose(); $font.Dispose(); $small.Dispose(); $white.Dispose(); $muted.Dispose()
        Save-Bitmap $header (Join-Path $outputDir $name)
    }
} finally {
    $logo.Dispose()
}
