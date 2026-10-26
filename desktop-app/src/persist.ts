import { invoke } from "@tauri-apps/api/core";

// localStorage stays the fast synchronous store; every kitchat_* key is also
// mirrored to a file by the native side. WebView2 can drop the last writes of
// its LevelDB log when the app exits, so the file is restored first on start.
const PREFIX = "kitchat_";
const snapshot = () => {
  const data: Record<string, string> = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(PREFIX)) data[key] = localStorage.getItem(key) || "";
  }
  return data;
};

let restored = false;
try {
  const saved = await invoke<string | null>("settings_backup_load");
  if (saved) {
    const data = JSON.parse(saved) as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith(PREFIX) && typeof value === "string" && localStorage.getItem(key) !== value) {
        localStorage.setItem(key, value);
        restored = true;
      }
    }
  }
} catch (error) {
  console.warn("Settings backup unavailable", error);
}
if (restored) console.info("[Kitchat] settings restored from the native backup");

let flushTimer = 0;
export function flushSettingsBackup() {
  window.clearTimeout(flushTimer);
  flushTimer = 0;
  return invoke("settings_backup_save", { data: JSON.stringify(snapshot()) }).catch((error) => console.warn("Settings backup failed", error));
}
const scheduleFlush = (key: string) => {
  if (!key.startsWith(PREFIX)) return;
  // The session token must survive an immediate exit; the rest is batched.
  if (key === "kitchat_token") { void flushSettingsBackup(); return; }
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => void flushSettingsBackup(), 400);
};
const originalSetItem = Storage.prototype.setItem;
const originalRemoveItem = Storage.prototype.removeItem;
Storage.prototype.setItem = function (key: string, value: string) {
  originalSetItem.call(this, key, value);
  if (this === localStorage) scheduleFlush(key);
};
Storage.prototype.removeItem = function (key: string) {
  originalRemoveItem.call(this, key);
  if (this === localStorage) scheduleFlush(key);
};
window.addEventListener("pagehide", () => void flushSettingsBackup());
void flushSettingsBackup();
