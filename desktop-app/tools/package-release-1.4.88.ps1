$ErrorActionPreference = 'Stop'
$version = '1.4.88'
Push-Location (Join-Path $PSScriptRoot '..')
try {
    $releaseRoot = Join-Path (Get-Location) "release-$version"
    if (Test-Path -LiteralPath $releaseRoot) {
        $resolvedRelease = [IO.Path]::GetFullPath($releaseRoot)
        $workspaceRoot = [IO.Path]::GetFullPath((Get-Location).Path)
        if (-not $resolvedRelease.StartsWith($workspaceRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolvedRelease) -ne "release-$version") { throw 'Unsafe release path' }
        Remove-Item -LiteralPath $resolvedRelease -Recurse -Force
    }
    $downloadRoot = Resolve-Path '..\downloads\kitchat'
    $bundleRoot = Resolve-Path 'src-tauri\target\release\bundle\nsis'
    New-Item -ItemType Directory -Path `
        (Join-Path $releaseRoot 'api'), `
        (Join-Path $releaseRoot 'bd'), `
        (Join-Path $releaseRoot 'downloads\kitchat'), `
        (Join-Path $releaseRoot 'macos') | Out-Null

    $exe = "Kitchat_${version}_x64-setup.exe"
    Copy-Item -LiteralPath (Join-Path $bundleRoot $exe) -Destination (Join-Path $downloadRoot $exe)
    Copy-Item -LiteralPath (Join-Path $bundleRoot "$exe.sig") -Destination (Join-Path $downloadRoot "$exe.sig")
    $hero = "kitchat-update-$version.svg"
    Copy-Item -LiteralPath 'public\kitchat-update-hero.svg' -Destination (Join-Path $downloadRoot $hero)

    $signature = (Get-Content -LiteralPath (Join-Path $downloadRoot "$exe.sig") -Raw).Trim()
    $notes = @"
- Нативные уведомления включаются при первом входе и работают, пока Kitchat скрыт в трее.
- В настройках появилась кнопка тестового уведомления.
- Раздел «О себе» синхронизируется между пользователями; старые локальные описания переносятся автоматически.
- Окно обновления стало нагляднее: обложка, список изменений, галерея изображений и прогресс установки.
- Добавлена подготовка macOS: камера, микрофон, фоновые обновления и сценарий сборки DMG.
"@.Trim()
    $manifest = [ordered]@{
        version = $version
        title = 'Общение без пропущенных сообщений'
        notes = $notes
        images = @([ordered]@{
            url = "https://oliverkitchen.ru/downloads/kitchat/$hero"
            alt = 'Обновление Kitchat 1.4.88'
        })
        pub_date = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
        platforms = [ordered]@{
            'windows-x86_64' = [ordered]@{
                signature = $signature
                url = "https://oliverkitchen.ru/downloads/kitchat/$exe"
            }
        }
    }
    [IO.File]::WriteAllText((Join-Path $downloadRoot 'latest.json'), ($manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))

    foreach ($name in @('community.php', 'community_social.php', 'desktop_auth.php', 'profile_about.php')) {
        Copy-Item -LiteralPath (Join-Path '..\api' $name) -Destination (Join-Path (Join-Path $releaseRoot 'api') $name)
    }
    Copy-Item -LiteralPath '..\bd\desktop_session.php' -Destination (Join-Path $releaseRoot 'bd\desktop_session.php')
    foreach ($name in @($exe, "$exe.sig", 'latest.json', $hero)) {
        Copy-Item -LiteralPath (Join-Path $downloadRoot $name) -Destination (Join-Path (Join-Path $releaseRoot 'downloads\kitchat') $name)
    }

    $macStage = Join-Path $env:TEMP "kitchat-macos-source-$version"
    if (Test-Path -LiteralPath $macStage) {
        $resolved = [IO.Path]::GetFullPath($macStage)
        $tempResolved = [IO.Path]::GetFullPath($env:TEMP)
        if (-not $resolved.StartsWith($tempResolved, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe mac staging path' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    New-Item -ItemType Directory -Path $macStage, (Join-Path $macStage 'src-tauri'), (Join-Path $macStage 'tools') | Out-Null
    foreach ($name in @('src', 'public')) { Copy-Item -LiteralPath $name -Destination $macStage -Recurse }
    foreach ($name in @('Cargo.toml', 'Cargo.lock', 'build.rs', 'tauri.conf.json', 'Info.plist', 'Entitlements.plist')) {
        Copy-Item -LiteralPath (Join-Path 'src-tauri' $name) -Destination (Join-Path (Join-Path $macStage 'src-tauri') $name)
    }
    foreach ($name in @('src', 'icons', 'installer', 'capabilities')) {
        Copy-Item -LiteralPath (Join-Path 'src-tauri' $name) -Destination (Join-Path (Join-Path $macStage 'src-tauri') $name) -Recurse
    }
    foreach ($name in @('package.json', 'package-lock.json', 'index.html', 'tray.html', 'tsconfig.json', 'vite.config.ts', 'MACOS_BUILD.md')) {
        Copy-Item -LiteralPath $name -Destination (Join-Path $macStage $name)
    }
    Copy-Item -LiteralPath 'tools\build-release-macos.sh' -Destination (Join-Path (Join-Path $macStage 'tools') 'build-release-macos.sh')
    $macZip = Join-Path $releaseRoot "macos\Kitchat-$version-macos-source.zip"
    Compress-Archive -Path (Join-Path $macStage '*') -DestinationPath $macZip -CompressionLevel Optimal

    $readme = @"
# Kitchat $version

## Загрузить на сервер

Содержимое папок api, bd и downloads копируется в одноимённые папки сайта с заменой файлов. Новый api/profile_about.php обязателен. Таблица описаний профиля создастся автоматически.

Сначала загрузите PHP-файлы, затем обложку и установщик с подписью, а latest.json — последним.

## macOS

Архив macos/Kitchat-$version-macos-source.zip собирается на Mac по инструкции MACOS_BUILD.md. Готовый .dmg и updater-архив требуют подписи Apple Developer ID и нотариального заверения для обычной установки другими пользователями.
"@
    [IO.File]::WriteAllText((Join-Path $releaseRoot 'README.md'), $readme, [Text.UTF8Encoding]::new($false))
    Copy-Item -LiteralPath 'MACOS_BUILD.md' -Destination (Join-Path $releaseRoot 'MACOS_BUILD.md')
    @"
# Kitchat $version

$notes

Проверено: 32 автоматических теста, TypeScript/Vite production build, Tauri release build и подпись updater-артефакта.
"@ | ForEach-Object { [IO.File]::WriteAllText((Join-Path (Get-Location) "RELEASE_$version.md"), $_, [Text.UTF8Encoding]::new($false)) }

    $releaseZip = "release-$version.zip"
    if (Test-Path -LiteralPath $releaseZip) { Remove-Item -LiteralPath $releaseZip -Force }
    Compress-Archive -Path (Join-Path $releaseRoot '*') -DestinationPath $releaseZip -CompressionLevel Optimal
    [pscustomobject]@{
        Installer = Join-Path $downloadRoot $exe
        InstallerSHA256 = (Get-FileHash (Join-Path $downloadRoot $exe) -Algorithm SHA256).Hash
        Signature = Join-Path $downloadRoot "$exe.sig"
        Manifest = Join-Path $downloadRoot 'latest.json'
        ReleaseZip = Join-Path (Get-Location) $releaseZip
        MacSource = $macZip
    } | Format-List
} finally {
    Pop-Location
}
