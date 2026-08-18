Add-Type -AssemblyName System.Drawing

$text = [string][char]0x00A3  # £ (POUND SIGN) — written as a code point, not a literal
                               # byte, since PowerShell 5.1 can misread a UTF-8-encoded
                               # non-ASCII source file as Windows-1252 and mangle it
$fontFamily = "Arial"

# Measure the true ink bounding box of the text (not the font's nominal
# line box, which reserves asymmetric ascent/descent space and makes
# vertical centering via StringFormat look visually off-center). Render at
# a reference size once, scan for non-background pixels, then scale the
# resulting bearings for each final icon size.
$refSize = 80
$canvasW = 600
$canvasH = 220
$originX = 20
$originY = 20

$refFont = New-Object System.Drawing.Font($fontFamily, $refSize, [System.Drawing.FontStyle]::Bold)
$measureBmp = New-Object System.Drawing.Bitmap($canvasW, $canvasH)
$mg = [System.Drawing.Graphics]::FromImage($measureBmp)
$mg.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$mg.Clear([System.Drawing.Color]::White)
$mg.DrawString($text, $refFont, [System.Drawing.Brushes]::Black, $originX, $originY)
$mg.Dispose()

$minX = $canvasW; $maxX = 0; $minY = $canvasH; $maxY = 0
for ($y = 0; $y -lt $canvasH; $y++) {
  for ($x = 0; $x -lt $canvasW; $x++) {
    $p = $measureBmp.GetPixel($x, $y)
    if ($p.R -lt 250) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
$measureBmp.Dispose()

$inkW = $maxX - $minX
$inkH = $maxY - $minY
$leftBearing = $minX - $originX
$topBearing = $minY - $originY

Write-Host "Ink box at ref size $refSize : W=$inkW H=$inkH leftBearing=$leftBearing topBearing=$topBearing"

function New-Icon($size, $path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  $bg = [System.Drawing.ColorTranslator]::FromHtml("#1C3A2B")
  $fg = [System.Drawing.ColorTranslator]::FromHtml("#CDDC5C")

  $radius = [int]($size * 0.22)
  $path2 = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path2.AddArc(0, 0, $d, $d, 180, 90)
  $path2.AddArc($size - $d, 0, $d, $d, 270, 90)
  $path2.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $path2.AddArc(0, $size - $d, $d, $d, 90, 90)
  $path2.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush($bg)
  $g.FillPath($brush, $path2)

  # target ink width = 62% of icon width (a single glyph reads better
  # smaller than a full word would at the same fill ratio)
  $targetInkW = $size * 0.62
  $finalFontSize = $refSize * ($targetInkW / $inkW)
  $scale = $finalFontSize / $refSize

  $font = New-Object System.Drawing.Font($fontFamily, $finalFontSize, [System.Drawing.FontStyle]::Bold)
  $fgBrush = New-Object System.Drawing.SolidBrush($fg)

  $scaledInkW = $inkW * $scale
  $scaledInkH = $inkH * $scale
  $drawX = (($size - $scaledInkW) / 2) - ($leftBearing * $scale)
  $drawY = (($size - $scaledInkH) / 2) - ($topBearing * $scale)

  $g.DrawString($text, $font, $fgBrush, $drawX, $drawY)

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

New-Icon 192 "C:\Users\jakem\projects\price-watch\icon-192.png"
New-Icon 512 "C:\Users\jakem\projects\price-watch\icon-512.png"
New-Icon 180 "C:\Users\jakem\projects\price-watch\apple-touch-icon.png"

Write-Host "Icons generated."
