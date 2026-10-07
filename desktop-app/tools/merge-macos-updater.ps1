param(
    [Parameter(Mandatory = $true)]
    [string]$MacManifest,
    [string]$LatestJson = (Join-Path $PSScriptRoot '..\..\downloads\kitchat\latest.json')
)

$ErrorActionPreference = 'Stop'
$macPath = (Resolve-Path -LiteralPath $MacManifest).Path
$latestPath = (Resolve-Path -LiteralPath $LatestJson).Path
$mac = Get-Content -LiteralPath $macPath -Raw | ConvertFrom-Json
$latest = Get-Content -LiteralPath $latestPath -Raw | ConvertFrom-Json

foreach ($target in @('darwin-aarch64', 'darwin-x86_64')) {
    $property = $mac.PSObject.Properties[$target]
    $entry = if ($property) { $property.Value } else { $null }
    if (-not $entry -or -not $entry.signature -or -not $entry.url) {
        throw "macOS manifest does not contain a complete $target entry"
    }
    $latest.platforms | Add-Member -NotePropertyName $target -NotePropertyValue $entry -Force
}

[IO.File]::WriteAllText(
    $latestPath,
    ($latest | ConvertTo-Json -Depth 12),
    [Text.UTF8Encoding]::new($false)
)

[pscustomobject]@{
    Manifest = $latestPath
    Version = $latest.version
    MacTargets = 'darwin-aarch64, darwin-x86_64'
} | Format-List
