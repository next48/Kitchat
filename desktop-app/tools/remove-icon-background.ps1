param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

Add-Type -AssemblyName System.Drawing
$original = [System.Drawing.Bitmap]::new($InputPath)
$source = [System.Drawing.Bitmap]::new($original.Width, $original.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($source)
$graphics.DrawImage($original, 0, 0, $original.Width, $original.Height)
$graphics.Dispose()
$original.Dispose()
$width = $source.Width
$height = $source.Height
$seen = [bool[,]]::new($width, $height)
$queue = [System.Collections.Generic.Queue[System.Drawing.Point]]::new()

function Add-BackgroundPixel([int]$x, [int]$y) {
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $width -or $y -ge $height -or $seen[$x, $y]) { return }
  $pixel = $source.GetPixel($x, $y)
  # Only near-white pixels connected to an outer edge are background.
  if ($pixel.R -lt 242 -or $pixel.G -lt 242 -or $pixel.B -lt 242) { return }
  $seen[$x, $y] = $true
  $queue.Enqueue([System.Drawing.Point]::new($x, $y))
}

for ($x = 0; $x -lt $width; $x++) { Add-BackgroundPixel $x 0; Add-BackgroundPixel $x ($height - 1) }
for ($y = 0; $y -lt $height; $y++) { Add-BackgroundPixel 0 $y; Add-BackgroundPixel ($width - 1) $y }

while ($queue.Count -gt 0) {
  $point = $queue.Dequeue()
  $source.SetPixel($point.X, $point.Y, [System.Drawing.Color]::FromArgb(0, 255, 255, 255))
  Add-BackgroundPixel ($point.X + 1) $point.Y
  Add-BackgroundPixel ($point.X - 1) $point.Y
  Add-BackgroundPixel $point.X ($point.Y + 1)
  Add-BackgroundPixel $point.X ($point.Y - 1)
}

$source.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$source.Dispose()
