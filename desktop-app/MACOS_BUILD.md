# Сборка Kitchat для macOS через GitHub Actions

Файл `.github/workflows/build-macos.yml` собирает Kitchat сразу для Apple Silicon (`arm64`) и Intel (`x64`). Локальный Mac для сборки не нужен.

## Один раз настроить Secrets

В репозитории GitHub откройте **Settings → Secrets and variables → Actions** и добавьте:

- `TAURI_SIGNING_PRIVATE_KEY` — полное содержимое `C:\Users\Oliver\.tauri\kitchat-updater-2026.key`;
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — пароль ключа обновлений.

Для обычной проверочной сборки этого достаточно. Она будет подписана updater-ключом и ad-hoc подписью macOS.

Для публичной установки без предупреждений Gatekeeper нужны Apple Developer Program и следующие Secrets:

- `APPLE_CERTIFICATE` — экспортированный сертификат Developer ID Application (`.p12`) в Base64;
- `APPLE_CERTIFICATE_PASSWORD`;
- `APPLE_SIGNING_IDENTITY`;
- `APPLE_ID`;
- `APPLE_PASSWORD` — app-specific password;
- `APPLE_TEAM_ID`.

`APPLE_SIGNING_IDENTITY` указывается полностью, например `Developer ID Application: Имя (TEAMID)`. `APPLE_PASSWORD` — отдельный пароль приложения Apple ID. Workflow сам создаёт временный Keychain, импортирует сертификат, подписывает и при наличии Apple-реквизитов отправляет сборку на нотариальное заверение.

Updater-ключ и Apple-сертификат нельзя коммитить в репозиторий. Они хранятся только в GitHub Secrets.

## Проверочная сборка

Откройте **Actions → Build Kitchat for macOS → Run workflow**. После завершения появятся два артефакта: `kitchat-macos-arm64` и `kitchat-macos-x64`.

## Релиз 1.4.92

Создайте и отправьте тег:

```bash
git tag kitchat-v1.4.92
git push origin kitchat-v1.4.92
```

Workflow выполнит тесты на обеих архитектурах, соберёт `.dmg` и подписанные updater-архивы `.app.tar.gz`, создаст контрольные суммы и прикрепит файлы к GitHub Release. Итоговый `macos-updater-platform.json` содержит оба блока — `darwin-aarch64` и `darwin-x86_64`; их нужно добавить в `platforms` основного `downloads/kitchat/latest.json`.

Скачайте `macos-updater-platform.json` из GitHub Release и выполните из `desktop-app`:

```powershell
.\tools\merge-macos-updater.ps1 -MacManifest C:\путь\macos-updater-platform.json
```

Скрипт проверит обе архитектуры и безопасно добавит их в текущий `latest.json`. После этого загрузите обновлённый `latest.json` на сайт.

## Проверка на Mac

После установки проверьте системные разрешения **System Settings → Privacy & Security** для Camera, Microphone, Screen & System Audio Recording и Notifications. Kitchat запрашивает разрешения при первом использовании соответствующей функции.
