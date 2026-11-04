import { invoke, isTauri } from "@tauri-apps/api/core";

export function installMobileCallControls(host: HTMLElement) {
  let timer = 0;
  let speaker = true;
  const ios = isTauri() && (/iPhone|iPad/.test(navigator.userAgent) || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const audio = async (active: boolean, override?: boolean) => invoke<{route: string}>("mobile_audio_route", {active, speaker: override ?? null});
  if (ios) void audio(true, true).catch(error => console.warn("Audio session", error));
  const show = () => {
    host.classList.remove("phone-controls-hidden");
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (host.isConnected && !host.hidden && !document.querySelector(".modal-layer")) host.classList.add("phone-controls-hidden");
    }, 5000);
  };
  host.addEventListener("pointerdown", show);
  const attach = () => {
    const header = host.querySelector(".embedded-call-header");
    if (!header || header.querySelector(".phone-pip")) return;
    const pip = document.createElement("button");
    pip.className = "phone-pip"; pip.type = "button";
    pip.textContent = "▣"; pip.setAttribute("aria-label", "Видео поверх приложений");
    const video = () => host.querySelector<HTMLVideoElement>(".video-tile.has-video video, .p2p-screen-tile:not(.stream-available) video");
    pip.onclick = async () => {
      const player = video() as HTMLVideoElement & {webkitSetPresentationMode?: (mode: string) => void};
      if (!player) return;
      try {
        if (player.requestPictureInPicture) await player.requestPictureInPicture();
        else player.webkitSetPresentationMode?.("picture-in-picture");
      } catch (error) { console.warn("Picture in picture", error); }
    };
    const probe = document.createElement("video") as HTMLVideoElement & {webkitSetPresentationMode?: unknown};
    pip.hidden = !document.pictureInPictureEnabled && !probe.webkitSetPresentationMode;
    header.append(pip);
    if (ios) {
      const route = document.createElement("button"); route.type = "button";
      route.className = "phone-audio-route"; route.textContent = "Динамик";
      route.setAttribute("aria-label", "Переключить динамик и телефон");
      route.onclick = async () => {
        route.disabled = true;
        try {
          const next = !speaker;
          const result = await audio(true, next);
          speaker = next; route.textContent = speaker ? "Динамик" : "Телефон";
          route.title = result.route;
        } catch (error) { route.title = String(error); }
        finally { route.disabled = false; }
      };
      header.append(route);
    }
    show();
  };
  const contents = new MutationObserver(attach);
  contents.observe(host, {childList: true, subtree: true});
  const lifecycle = new MutationObserver(() => {
    if (host.isConnected) return;
    clearTimeout(timer); contents.disconnect(); lifecycle.disconnect();
    if (ios) void audio(false).catch(() => {});
  });
  lifecycle.observe(document.body, {childList: true});
}
