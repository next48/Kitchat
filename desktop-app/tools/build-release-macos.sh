#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/kitchat-updater-2026.key}"
if [[ ! -f "$KEY_PATH" ]]; then
  echo "Updater key not found: $KEY_PATH" >&2
  echo "Set TAURI_SIGNING_PRIVATE_KEY_PATH to the copied private key." >&2
  exit 1
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
  echo "Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD before building." >&2
  exit 1
fi

export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
npm ci
npm test
npm run tauri -- build --bundles app,dmg

echo "macOS bundles and updater artifacts are in src-tauri/target/release/bundle/"
