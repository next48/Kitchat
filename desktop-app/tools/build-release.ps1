$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
try {
    $config = Get-Content 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json
    $publicKey = (Get-Content -LiteralPath 'C:\Users\Oliver\.tauri\kitchat-updater-2026.key.pub' -Raw).Trim()
    if ($config.plugins.updater.pubkey -ne $publicKey) { throw 'Updater public key mismatch' }
    $passwordLines = @(Get-Content -LiteralPath 'C:\Users\Oliver\Desktop\site\UPDATER_KEY_PASSWORD.txt')
    # This file contains a heading, then the password, then informational paths.
    # The old release script incorrectly used the last informational line.
    $password = $passwordLines | Select-Object -Skip 1 | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1
    if (-not $password) { throw 'Updater password not found' }
    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -LiteralPath 'C:\Users\Oliver\.tauri\kitchat-updater-2026.key' -Raw
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $password.Trim()
    npm run tauri -- build --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw 'Release build or updater signing failed' }
} finally {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY,Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    $password = $null
    $passwordLines = $null
    Pop-Location
}
