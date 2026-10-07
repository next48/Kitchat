import "./tray.css";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Window, getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";

const trayWindow = getCurrentWindow();
let actionRunning = false;
async function fallbackAction(action: string) {
  if (action === "quit") return exit(0);
  const main = await Window.getByLabel("main");
  if (!main) return;
  await main.show();
  await main.unminimize();
  await main.setFocus();
  if (action === "updates") await emit("kitchat://check-update");
  await trayWindow.hide();
}
async function runAction(action: string) {
  if (actionRunning) return;
  actionRunning = true;
  try {
    await invoke("tray_action", { action });
  } catch (error) {
    console.warn("Native tray action failed, using webview fallback", error);
    await fallbackAction(action);
  } finally {
    actionRunning = false;
  }
}
document.addEventListener("pointerdown", (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-action]");
  if (!button?.dataset.action) return;
  event.preventDefault();
  event.stopPropagation();
  void runAction(button.dataset.action);
});
void trayWindow.onFocusChanged(({ payload }) => {
  if (!payload) void trayWindow.hide();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void trayWindow.hide();
});
