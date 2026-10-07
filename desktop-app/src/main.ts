import "./styles.css";
import "./social.css";
import { friendsView, friendRows, selectFriends, socialSignature, type FriendFilter } from "./social-ui";
import { streamProfile } from "./stream-preferences";
import { SocialSnapshotClient } from "./social-sync";
import { formatVoiceDuration, resolveCallFocus, voiceStartedAtFromElapsed } from "./voice-session";
import { startSystemAudioTrack } from "./system-audio";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { enable as enableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import type {
  LocalVideoTrack,
  Participant,
  RemoteParticipant,
  RemoteTrack,
} from "livekit-client";

const lowResourceMode = () => localStorage.getItem("kitchat_low_performance") === "1";
const cameraPreviewMirrored = () => localStorage.getItem("kitchat_camera_mirror") !== "0";
const LIVEKIT_ENABLED = false; // Retained for a future coordinated server/client rollback.
const API = "https://oliverkitchen.ru/api";
let appVersion = "1.4.87";
const app = document.querySelector<HTMLDivElement>("#app")!;
const loadingView = () => `<main class="loading-screen" aria-label="Kitchat загружается"><div class="loading-logo"><img src="/kitchat-loader.png" alt=""></div><p>Запускаем Kitchat<span class="loading-dots" aria-hidden="true"><i></i><i></i><i></i></span></p></main>`;
type AppTheme = "standard" | "pink" | "hotpink" | "light" | "aurora";
function applyTheme(value = localStorage.getItem("kitchat_theme") || "standard") {
  const theme: AppTheme = ["pink", "hotpink", "light", "aurora"].includes(value) ? value as AppTheme : "standard";
  document.body.dataset.theme = theme;
}
applyTheme();

const VOICE_MUTED_KEY = "kitchat_self_muted";
const VOICE_DEAFENED_KEY = "kitchat_self_deafened";
const VOICE_PRE_DEAFEN_MUTE_KEY = "kitchat_pre_deafen_muted";
function getVoicePreferences() {
  const deafened = localStorage.getItem(VOICE_DEAFENED_KEY) === "1";
  const muted = deafened || localStorage.getItem(VOICE_MUTED_KEY) === "1";
  return { muted, deafened };
}
function saveVoicePreferences(muted: boolean, deafened: boolean) {
  localStorage.setItem(VOICE_MUTED_KEY, muted ? "1" : "0");
  localStorage.setItem(VOICE_DEAFENED_KEY, deafened ? "1" : "0");
}
function paintVoicePreferenceButtons() {
  const { muted, deafened } = getVoicePreferences();
  document.querySelectorAll<HTMLElement>("#selfMute,#callMic").forEach((node) => {
    node.classList.toggle("off", muted);
    node.setAttribute("aria-pressed", String(muted));
  });
  document.querySelectorAll<HTMLElement>("#selfDeafen,#callDeafen").forEach((node) => {
    node.classList.toggle("off", deafened);
    node.setAttribute("aria-pressed", String(deafened));
  });
}
function toggleVoicePreferenceBeforeJoin(kind: "mute" | "deafen") {
  let { muted, deafened } = getVoicePreferences();
  if (kind === "mute") {
    // При включённых наушниках микрофон по правилам Discord остаётся выключенным.
    if (!deafened) muted = !muted;
  } else if (!deafened) {
    localStorage.setItem(VOICE_PRE_DEAFEN_MUTE_KEY, muted ? "1" : "0");
    deafened = true;
    muted = true;
  } else {
    deafened = false;
    muted = localStorage.getItem(VOICE_PRE_DEAFEN_MUTE_KEY) === "1";
  }
  saveVoicePreferences(muted, deafened);
  paintVoicePreferenceButtons();
}
// В десктопном клиенте не показываем системное меню WebView: для рабочих областей
// ниже открывается контекстное меню Kitchat.
document.addEventListener("contextmenu", (event) => event.preventDefault());
document.addEventListener("pointerdown", (event) => {
  const popover = document.querySelector<HTMLElement>("#stickerPopover");
  const target = event.target as HTMLElement;
  if (popover && !popover.hidden && !target.closest("#stickerPopover,#stickerButton")) popover.hidden = true;
});
const dropOverlay = document.createElement("div");
dropOverlay.className = "drop-zone-overlay";
dropOverlay.innerHTML = `<div class="drop-zone-card"><div class="drop-zone-art"><span>▧</span><span>▨</span><span>▤</span></div><b>Добавить файлы к сообщению</b><small>Отпустите их здесь — можно выбрать до 10 файлов</small></div>`;
document.body.append(dropOverlay);
let dragDepth = 0;
let activeFileDropHandler: ((files: FileList) => void) | null = null;
window.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types.includes("Files") || !activeFileDropHandler) return;
  dragDepth += 1; dropOverlay.classList.add("show");
});
window.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files") || !activeFileDropHandler) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", (event) => {
  if (!event.dataTransfer?.types.includes("Files") || !activeFileDropHandler) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropOverlay.classList.remove("show");
});
window.addEventListener("drop", (event) => {
  const files = event.dataTransfer?.files;
  if (files?.length && activeFileDropHandler) {
    event.preventDefault();
    activeFileDropHandler(files);
  }
  dragDepth = 0;
  dropOverlay.classList.remove("show");
});

const imageViewer = document.createElement("div");
imageViewer.className = "image-viewer";
imageViewer.hidden = true;
imageViewer.innerHTML = `<header><span class="image-viewer-name"></span><nav><button data-image-zoom-out title="Уменьшить">−</button><button data-image-zoom-reset title="Исходный размер">100%</button><button data-image-zoom-in title="Увеличить">＋</button><button data-image-download title="Скачать">↓</button><button data-image-close title="Закрыть">×</button></nav></header><div class="image-viewer-stage"><img alt=""></div><div class="image-viewer-notice" hidden><span></span><button type="button">Открыть папку</button></div>`;
document.body.append(imageViewer);
let imageViewerScale = 1;
let imageViewerSource = "";
let imageViewerFilename = "image";
const paintImageViewerScale = () => {
  const image = imageViewer.querySelector<HTMLImageElement>("img")!;
  image.style.transform = `scale(${imageViewerScale})`;
  imageViewer.querySelector<HTMLButtonElement>("[data-image-zoom-reset]")!.textContent = `${Math.round(imageViewerScale * 100)}%`;
};
const closeImageViewer = () => { imageViewer.hidden = true; document.body.classList.remove("image-viewer-open"); };
const openImageViewer = (source: string, name: string) => {
  imageViewerScale = 1;
  imageViewerSource = source;
  imageViewerFilename = name || "image";
  imageViewer.querySelector<HTMLImageElement>("img")!.src = source;
  imageViewer.querySelector<HTMLElement>(".image-viewer-name")!.textContent = name || "Изображение";
  imageViewer.querySelector<HTMLElement>(".image-viewer-notice")!.hidden = true;
  imageViewer.hidden = false;
  document.body.classList.add("image-viewer-open");
  paintImageViewerScale();
};
document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const media = target.closest<HTMLAnchorElement>("a.chat-media.image");
  if (media) {
    event.preventDefault();
    const image = media.querySelector<HTMLImageElement>("img");
    if (image) openImageViewer(media.href || image.src, image.alt);
    return;
  }
  if (target.closest("[data-image-close]") || (target.classList.contains("image-viewer-stage"))) closeImageViewer();
  if (target.closest("[data-image-zoom-in]")) { imageViewerScale = Math.min(4, imageViewerScale + .25); paintImageViewerScale(); }
  if (target.closest("[data-image-zoom-out]")) { imageViewerScale = Math.max(.25, imageViewerScale - .25); paintImageViewerScale(); }
  if (target.closest("[data-image-zoom-reset]")) { imageViewerScale = 1; paintImageViewerScale(); }
  if (target.closest("[data-image-download]")) {
    const button = imageViewer.querySelector<HTMLButtonElement>("[data-image-download]")!;
    if (button.disabled || !imageViewerSource) return;
    button.disabled = true;
    button.textContent = "…";
    void invoke<string>("download_attachment", { url: imageViewerSource, filename: imageViewerFilename })
      .then((savedPath) => {
        const notice = imageViewer.querySelector<HTMLElement>(".image-viewer-notice")!;
        const savedName = savedPath.split(/[\\/]/).pop() || imageViewerFilename;
        notice.querySelector("span")!.textContent = `Файл «${savedName}» сохранён в «download kitchat»`;
        notice.hidden = false;
        notice.querySelector<HTMLButtonElement>("button")!.onclick = () => void revealItemInDir(savedPath).catch((error) => appAlert(String(error)));
        window.setTimeout(() => { if (!notice.matches(":hover")) notice.hidden = true; }, 7000);
      })
      .catch((error) => appAlert(String(error || "Не удалось скачать файл")))
      .finally(() => { button.disabled = false; button.textContent = "↓"; });
  }
});
imageViewer.querySelector(".image-viewer-stage")?.addEventListener("wheel", (event) => {
  event.preventDefault();
  imageViewerScale = Math.max(.25, Math.min(4, imageViewerScale + ((event as WheelEvent).deltaY < 0 ? .15 : -.15)));
  paintImageViewerScale();
}, { passive: false });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !imageViewer.hidden) closeImageViewer(); });
type User = {
  id: number;
  name: string;
  login: string;
  avatar?: string;
  about?: string;
  online?: boolean;
  role?: "owner" | "admin" | "moderator" | "member";
  global_role?: "user" | "superadmin";
};
const profileAboutCache = new Map<number, string>();
const PROFILE_ABOUT_LOCAL_KEY = "kitchat_profile_about";
function localProfileAbout(userId: number) {
  if (!currentUser || currentUser.id !== userId) return "";
  return localStorage.getItem(PROFILE_ABOUT_LOCAL_KEY) || "";
}

async function profileAboutRequest(action: "get" | "set", userId = 0, about = "") {
  const params = new URLSearchParams({ action });
  if (userId) params.set("user_id", String(userId));
  const response = await fetch(`${API}/profile_about.php?${params}`, {
    method: action === "set" ? "POST" : "GET",
    headers: {
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
      ...(action === "set" ? { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" } : {}),
    },
    body: action === "set" ? new URLSearchParams({ about }) : undefined,
  });
  const result = await response.json().catch(() => ({ ok: false, error: "Сервер профиля не ответил" }));
  if (!response.ok || !result.ok) throw new Error(result.error || "Не удалось загрузить описание профиля");
  return result;
}

async function loadProfileAbout(userId: number, force = false) {
  if (!force && profileAboutCache.has(userId)) return profileAboutCache.get(userId) || "";
  const localFallback = localProfileAbout(userId);
  if (!force && localFallback) profileAboutCache.set(userId, localFallback);
  try {
    const result = await profileAboutRequest("get", userId);
    const about = String(result.about || "");
    profileAboutCache.set(userId, about);
    return about;
  } catch (error) {
    console.warn("Profile about load failed", error);
    return profileAboutCache.get(userId) || localFallback || "";
  }
}

async function saveOwnProfileAbout(about: string) {
  if (!currentUser) return false;
  const clean = about.trim().slice(0, 190);
  // Сохраняем локально сразу: описание не пропадёт даже при временной ошибке API.
  localStorage.setItem(PROFILE_ABOUT_LOCAL_KEY, clean);
  profileAboutCache.set(currentUser.id, clean);
  try {
    await profileAboutRequest("set", currentUser.id, clean);
    return true;
  } catch (error) {
    // Описание профиля — дополнительная функция. Ошибка API не должна
    // блокировать сохранение темы, голоса и остальных локальных настроек.
    console.warn("Profile about save failed", error);
    return false;
  }
}

async function syncOwnProfileAbout() {
  if (!currentUser) return;
  const serverAbout = String(currentUser.about || "").trim().slice(0, 190);
  if (serverAbout) {
    localStorage.setItem(PROFILE_ABOUT_LOCAL_KEY, serverAbout);
    profileAboutCache.set(currentUser.id, serverAbout);
    return;
  }
  const savedLocally = (localStorage.getItem(PROFILE_ABOUT_LOCAL_KEY) || "").trim().slice(0, 190);
  if (savedLocally) await saveOwnProfileAbout(savedLocally);
}
type GameActivity = { game: string; executable: string; started_at: number; checked_at?: number };
type GamePresenceReport = { user_id: number; game: string; executable: string; started_at: number; checked_at: number; detector?: string; client_version?: string };
const gameActivities = new Map<number, GameActivity>();
const gamePresenceReports = new Map<number, GamePresenceReport>();
let localGameActivity: GameActivity | null = null;
let gameActivityPollTimer = 0;
let remoteGameActivityPollTimer = 0;
let gameActivityRefreshInFlight = false;
let lastGamePresenceHeartbeat = 0;
let lastReportedGameActivity = "";

async function gamePresence(action: "report" | "list", data: Record<string, string | number> = {}) {
  const response = await fetch(`${API}/game_presence.php?action=${encodeURIComponent(action)}`, {
    method: action === "report" ? "POST" : "GET",
    headers: {
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
      ...(action === "report" ? { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" } : {}),
    },
    body: action === "report"
      ? new URLSearchParams(Object.entries(data).map(([key, value]) => [key, String(value)]))
      : undefined,
  });
  const result = await response.json().catch(() => ({ ok: false, error: "Сервер статуса игр не ответил" }));
  if (!response.ok || !result.ok) throw new Error(result.error || "Не удалось обновить игровую активность");
  return result;
}

function gameElapsed(startedAt: number) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - startedAt));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours} ч ${minutes} мин`;
  if (minutes) return `${minutes} мин`;
  return "только что";
}

async function refreshOwnGameActivity() {
  if (!currentUser || gameActivityRefreshInFlight) return;
  gameActivityRefreshInFlight = true;
  try {
    const next = await invoke<GameActivity | null>("detect_game_activity");
    if (next) next.checked_at = Date.now();
    localGameActivity = next;
    // Keep the local result independently from server permissions: the owner of
    // a profile must always see their own activity immediately.
    if (next) gameActivities.set(currentUser.id, next);
    else gameActivities.delete(currentUser.id);
    refreshOpenProfileActivity(currentUser.id);
    const activityKey = `${next?.game || ""}\u0000${next?.executable || ""}\u0000${next?.started_at || 0}`;
    const now = Date.now();
    // Send immediately on entering/leaving a game, plus a light heartbeat so
    // another client never keeps an old game after this app closes.
    if (activityKey !== lastReportedGameActivity || now - lastGamePresenceHeartbeat >= 15_000) {
      await gamePresence("report", {
        game: next?.game || "",
        executable: next?.executable || "",
        started_at: next?.started_at || 0,
        detector: next ? "matched" : "no_match",
        client_version: "1.4.80",
      });
      lastReportedGameActivity = activityKey;
      lastGamePresenceHeartbeat = now;
    }
  } catch (error) {
    console.warn("Game activity detection/report failed", error);
  } finally {
    gameActivityRefreshInFlight = false;
  }
}

async function refreshRemoteGameActivities() {
  if (!currentUser) return;
  try {
    const result = await gamePresence("list");
    const nextIds = new Set<number>();
    gamePresenceReports.clear();
    for (const item of (result.activities || []) as GamePresenceReport[]) {
      const userId = Number(item.user_id);
      if (!userId) continue;
      nextIds.add(userId);
      gamePresenceReports.set(userId, {
        user_id: userId,
        game: String(item.game || ""),
        executable: String(item.executable || ""),
        started_at: Number(item.started_at || 0),
        checked_at: Number(item.checked_at || 0),
        detector: String(item.detector || ""),
        client_version: String(item.client_version || ""),
      });
      if (item.game) {
        gameActivities.set(userId, {
          game: String(item.game),
          executable: String(item.executable || ""),
          started_at: Number(item.started_at || 0),
          checked_at: Date.now(),
        });
      } else if (userId !== currentUser.id) {
        gameActivities.delete(userId);
      }
      refreshOpenProfileActivity(userId);
    }
    for (const userId of [...gameActivities.keys()]) {
      if (userId === currentUser.id && localGameActivity?.game) continue;
      if (!nextIds.has(userId)) gameActivities.delete(userId);
    }
  } catch (error) {
    console.warn("Global game activity polling failed", error);
  }
}

function ensureGameActivityPolling() {
  if (!gameActivityPollTimer) {
    void refreshOwnGameActivity();
    gameActivityPollTimer = window.setInterval(() => void refreshOwnGameActivity(), 5_000);
  }
  if (!remoteGameActivityPollTimer) {
    void refreshRemoteGameActivities();
    remoteGameActivityPollTimer = window.setInterval(() => void refreshRemoteGameActivities(), 8_000);
  }
}
type Server = {
  id: number;
  name: string;
  icon?: string;
  description?: string;
  owner_id?: number;
  banner?: string;
  role?: "owner" | "admin" | "moderator" | "member";
};
type Channel = {
  id: number;
  slug: string;
  name: string;
  topic: string;
  type: "text" | "voice";
  voice_mode: "p2p" | "livekit";
  can_edit?: boolean;
};
type VoiceUser = {
  channel_id: number;
  id: number;
  name: string;
  avatar?: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  sharing: boolean;
  camera: boolean;
};
type Person = {
  id: number;
  name: string;
  avatar?: string;
  online?: boolean;
  friend_status: number;
  sent_by_me?: boolean;
};
type Sticker = { id: number; name: string; path: string; user_id?: number };
type Attachment = { name: string; path: string; mime: string; size?: number };
type CommunityState = {
  me: { id: number; admin: boolean; global_role: "user" | "superadmin"; title?: string | null };
  servers: Server[];
  server: Server | null;
  channels: Channel[];
  messages: Array<{
    id: number;
    user_id?: number;
    name: string;
    avatar?: string;
    message: string;
    created_at: string;
    edited_at?: string | null;
    read_by?: number;
    sticker?: Sticker;
    attachment?: Attachment;
  }>;
  server_members: User[];
  voice: VoiceUser[];
  people: Person[];
  search: Person[];
  stickers: Sticker[];
  message_sync?: { count: number; max_id: number; changed: string; read_changed?: string };
};
type DirectMessage = { id: number; sender_id: number; receiver_id: number; message: string; created_at: string; read_at?: string | null; edited_at?: string | null };
type DirectThread = { peer_id: number; last_message: string; updated_at: string; unread?: number };
type DirectState = { threads: DirectThread[]; messages?: DirectMessage[] };
let friendsFilter: FriendFilter = "all";
let friendsQuery = "";
let socialCleanup = () => {};
const socialSnapshotClient = new SocialSnapshotClient();
let homePane: { kind: "friends" | "requests" | "dm"; userId?: number } = { kind: "friends" };
const directMessageDrafts = new Map<number, string>();
const channelMessageDrafts = new Map<string, string>();
let currentUser: User | null = null;
let activeVoiceChannel = 0;
let activeVoiceLeave: (() => Promise<void>) | null = null;
let activeVoiceMute: (() => Promise<void>) | null = null;
let activeVoiceSetMuted: ((muted: boolean) => Promise<void>) | null = null;
let activeVoiceDeafen: (() => Promise<void>) | null = null;
let activeVoiceCamera: (() => Promise<void>) | null = null;
let activeVoiceShare: (() => Promise<void>) | null = null;
let activeVoiceSetUserVolume: ((userId: number, volume: number) => void) | null = null;
let activeVoiceMeta: { name: string; serverName: string } | null = null;
let activeVoiceMode: "p2p" | "livekit" | null = null;
let activeVoiceRoom: HTMLElement | null = null;
let activeVoiceConnectedAt = 0;
let activeVoiceDurationTimer = 0;
const voiceDurationSeconds = () => activeVoiceConnectedAt ? Math.max(0, Math.floor((Date.now() - activeVoiceConnectedAt) / 1000)) : 0;
const voiceDurationText = () => formatVoiceDuration(voiceDurationSeconds());
function paintVoiceDuration() {
  const value = voiceDurationText();
  document.querySelectorAll<HTMLElement>("[data-voice-duration]").forEach((node) => { node.textContent = value; });
}
function paintActiveVoiceChannel() {
  document.querySelectorAll<HTMLButtonElement>(".channel[data-voice]").forEach((button) => {
    const connected = Number(button.dataset.voice) === activeVoiceChannel;
    button.classList.toggle("voice-connected", connected);
    const icon = button.querySelector<HTMLElement>(":scope > b");
    if (icon) icon.innerHTML = ico(connected ? "signal" : "mic");
    button.querySelector(".voice-channel-duration")?.remove();
    if (connected) {
      const time = document.createElement("time");
      time.className = "voice-channel-duration";
      time.dataset.voiceDuration = "";
      time.textContent = voiceDurationText();
      const manage = button.querySelector(".channel-manage");
      if (manage) manage.before(time); else button.append(time);
    }
  });
}
function syncVoiceDuration(elapsedSeconds: unknown) {
  const sharedStart = voiceStartedAtFromElapsed(Date.now(), elapsedSeconds);
  if (sharedStart && (!activeVoiceConnectedAt || Math.abs(activeVoiceConnectedAt - sharedStart) > 2500)) {
    activeVoiceConnectedAt = sharedStart;
    paintVoiceDuration();
  }
}
function startVoiceDuration(elapsedSeconds?: unknown) {
  syncVoiceDuration(elapsedSeconds);
  if (!activeVoiceConnectedAt) activeVoiceConnectedAt = Date.now();
  if (activeVoiceDurationTimer) window.clearInterval(activeVoiceDurationTimer);
  paintActiveVoiceChannel();
  paintVoiceDuration();
  activeVoiceDurationTimer = window.setInterval(paintVoiceDuration, 1000);
}
function stopVoiceDuration() {
  if (activeVoiceDurationTimer) window.clearInterval(activeVoiceDurationTimer);
  activeVoiceDurationTimer = 0;
  activeVoiceConnectedAt = 0;
}
let voiceSwitchPromise: Promise<void> = Promise.resolve();
let knownVoiceChannelIds: number[] = [];
let remoteAudioContext: AudioContext | null = null;
type RemoteAudioGain = { element: HTMLMediaElement; gain: GainNode; volume: number; muted: boolean; direct: boolean };
const remoteAudioGains = new WeakMap<HTMLMediaElement, RemoteAudioGain>();
function remoteAudioGain(element: HTMLMediaElement): RemoteAudioGain {
  let state = remoteAudioGains.get(element);
  if (!state) {
    remoteAudioContext ||= new AudioContext();
    const stream = element.srcObject;
    const direct = stream instanceof MediaStream;
    const source = direct
      ? remoteAudioContext.createMediaStreamSource(stream)
      : remoteAudioContext.createMediaElementSource(element);
    const gain = remoteAudioContext.createGain();
    const limiter = remoteAudioContext.createDynamicsCompressor();
    limiter.threshold.value = -5;
    limiter.knee.value = 10;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    source.connect(gain).connect(limiter).connect(remoteAudioContext.destination);
    state = { element, gain, volume: 1, muted: false, direct };
    remoteAudioGains.set(element, state);
    gain.gain.value = 0;
    const speaker = localStorage.getItem("kitchat_speaker") || "";
    const contextWithSink = remoteAudioContext as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (speaker && contextWithSink.setSinkId) void contextWithSink.setSinkId(speaker).catch(() => {});
  }
  return state;
}
function applyRemoteAudioGain(state: RemoteAudioGain) {
  const amplified = state.volume > 1 && !state.muted;
  // Обычная громкость идёт напрямую и остаётся полностью исходного качества.
  // Web Audio включается только для усиления выше 100%.
  state.element.muted = state.muted || amplified || !state.direct;
  state.element.volume = state.muted ? 0 : Math.min(1, state.volume);
  state.gain.gain.cancelScheduledValues(remoteAudioContext!.currentTime);
  state.gain.gain.setTargetAtTime(amplified || (!state.direct && !state.muted) ? state.volume : 0, remoteAudioContext!.currentTime, 0.01);
  if ((amplified || !state.direct) && remoteAudioContext!.state === "suspended") void remoteAudioContext!.resume();
}
function setRemoteAudioVolume(element: HTMLMediaElement, volume: number) {
  const value = Math.max(0, Math.min(2, volume));
  const existing = remoteAudioGains.get(element);
  // При обычной громкости вообще не создаём Web Audio-граф: это сохраняет
  // нативный путь MediaStream в WebView2 без лишнего ресэмплинга.
  if (!existing && value <= 1) {
    element.volume = value;
    return;
  }
  const state = existing || remoteAudioGain(element);
  state.volume = value;
  applyRemoteAudioGain(state);
}
function setRemoteAudioMuted(element: HTMLMediaElement, muted: boolean) {
  const existing = remoteAudioGains.get(element);
  if (!existing) {
    element.muted = muted;
    return;
  }
  const state = existing;
  state.muted = muted;
  applyRemoteAudioGain(state);
}
let changingVoiceChannel = false;
let hideLocalScreenPreview = false;
let pushToTalkPressed = false;
let pttCueContext: AudioContext | null = null;
let pttMuteChain = Promise.resolve();
let pttCaptureActive = false;
let registeredPttShortcut: string | null = null;
const voiceDirectory = new Map<number, VoiceUser>();
let viewRevision = 0;
async function syncGlobalPttShortcut() {
  const code = localStorage.getItem("kitchat_input_mode") === "ptt"
    ? localStorage.getItem("kitchat_ptt_key") || "Space"
    : null;
  registeredPttShortcut = code;
  try {
    await invoke("set_ptt_binding", { code });
  } catch (error) {
    registeredPttShortcut = null;
    console.warn("Не удалось настроить нативную клавишу PTT", error);
  }
}
function playPttCue(open: boolean) {
  if (!activeVoiceChannel || localStorage.getItem("kitchat_sounds") === "0") return;
  try {
    pttCueContext ||= new AudioContext();
    const context = pttCueContext;
    void context.resume();
    const start = context.currentTime + 0.005;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.032, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.115);
    gain.connect(context.destination);
    [open ? 520 : 430, open ? 690 : 320].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, start + index * 0.035);
      oscillator.connect(gain);
      oscillator.start(start + index * 0.035);
      oscillator.stop(start + 0.12);
    });
  } catch (error) {
    console.warn("Не удалось воспроизвести сигнал PTT", error);
  }
}
function setPttPressed(pressed: boolean) {
  if (pushToTalkPressed === pressed) return;
  pushToTalkPressed = pressed;
  playPttCue(pressed);
  pttMuteChain = pttMuteChain
    .catch(() => {})
    .then(() => activeVoiceSetMuted?.(!pressed));
}
void listen<{ code: string; state: "Pressed" | "Released" }>("kitchat://global-ptt", ({ payload }) => {
  if (localStorage.getItem("kitchat_input_mode") !== "ptt") return;
  if (payload.state === "Pressed" && !pushToTalkPressed) {
    setPttPressed(true);
  } else if (payload.state === "Released" && pushToTalkPressed) {
    setPttPressed(false);
  }
});
window.addEventListener("keydown", (event) => {
  if (pttCaptureActive) return;
  if (registeredPttShortcut) return;
  if (localStorage.getItem("kitchat_input_mode") !== "ptt" || event.repeat)
    return;
  if ((event.target as HTMLElement)?.matches("input,textarea,[contenteditable]"))
    return;
  if (event.code !== (localStorage.getItem("kitchat_ptt_key") || "Space"))
    return;
  event.preventDefault();
  setPttPressed(true);
});
window.addEventListener("keyup", (event) => {
  if (pttCaptureActive) return;
  if (registeredPttShortcut) return;
  if (!pushToTalkPressed) return;
  if (event.code !== (localStorage.getItem("kitchat_ptt_key") || "Space"))
    return;
  event.preventDefault();
  setPttPressed(false);
});
window.addEventListener("mousedown", (event) => {
  if (pttCaptureActive) return;
  if (localStorage.getItem("kitchat_input_mode") !== "ptt") return;
  if (`Mouse${event.button}` !== localStorage.getItem("kitchat_ptt_key")) return;
  if ((event.target as HTMLElement)?.closest("button,input,textarea,select")) return;
  event.preventDefault();
  setPttPressed(true);
});
window.addEventListener("mouseup", (event) => {
  if (pttCaptureActive) return;
  if (!pushToTalkPressed || `Mouse${event.button}` !== localStorage.getItem("kitchat_ptt_key")) return;
  event.preventDefault();
  setPttPressed(false);
});
window.addEventListener("blur", () => {
  if (!registeredPttShortcut && pushToTalkPressed) {
    setPttPressed(false);
  }
});
void syncGlobalPttShortcut();
const token = () => localStorage.getItem("kitchat_token") || "";
function activateTooltips(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[title]").forEach((node) => {
    node.dataset.tooltip = node.getAttribute("title") || "";
    node.removeAttribute("title");
  });
}
new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => {
  if (node instanceof HTMLElement) activateTooltips(node);
}))).observe(document.documentElement, { childList: true, subtree: true });
const floatingTooltip = document.createElement("div");
floatingTooltip.className = "floating-tooltip";
floatingTooltip.hidden = true;
document.body.append(floatingTooltip);
document.addEventListener("pointerover", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-tooltip]");
  if (!target?.dataset.tooltip) return;
  const bounds = target.getBoundingClientRect();
  floatingTooltip.textContent = target.dataset.tooltip;
  floatingTooltip.hidden = false;
  requestAnimationFrame(() => {
    const tip = floatingTooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - tip.width - 8, bounds.left + bounds.width / 2 - tip.width / 2));
    const above = bounds.top - tip.height - 9;
    floatingTooltip.style.left = `${left}px`;
    floatingTooltip.style.top = `${above > 8 ? above : bounds.bottom + 9}px`;
  });
});
document.addEventListener("pointerout", (event) => {
  if ((event.target as HTMLElement).closest("[data-tooltip]")) floatingTooltip.hidden = true;
});
document.addEventListener("pointerdown", (event) => {
  if ((event.target as HTMLElement).closest("button,[data-tooltip]")) floatingTooltip.hidden = true;
});
document.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (button) { floatingTooltip.hidden = true; button.blur(); }
});
async function request(path: string, data?: Record<string, string>) {
  const response = await fetch(`${API}/${path}`, {
    method: data ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response
    .json()
    .catch(() => ({ ok: false, error: "Сервер вернул некорректный ответ" }));
  if (!response.ok || !result.ok)
    throw new Error(result.error || "Не удалось выполнить запрос");
  return result;
}
async function community(
  query: Record<string, string | number> = {},
  data?: Record<string, string | number>,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams(
    Object.entries(query).map(([k, v]) => [k, String(v)]),
  );
  const response = await fetch(`${API}/community.php?${params}`, {
    signal,
    method: data ? "POST" : "GET",
    headers: { ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
    body: data
      ? new URLSearchParams(
          Object.entries(data).map(([k, v]) => [k, String(v)]),
        )
      : undefined,
  });
  const result = await response
    .json()
    .catch(() => ({ ok: false, error: "Сервер сообщества не ответил" }));
  if (!response.ok || !result.ok)
    throw new Error(result.error || "Не удалось загрузить серверы");
  return result;
}
async function communityUpload(data: FormData) {
  const response = await fetch(`${API}/community.php`, {
    method: "POST",
    headers: token() ? { Authorization: `Bearer ${token()}` } : {},
    body: data,
  });
  const result = await response
    .json()
    .catch(() => ({ ok: false, error: "Сервер сообщества не ответил" }));
  if (!response.ok || !result.ok)
    throw new Error(result.error || "Не удалось загрузить файл");
  return result;
}
async function markDesktopOffline() {
  if (!token()) return;
  const abort = new AbortController();
  const timeout = window.setTimeout(() => abort.abort(), 900);
  try { await community({}, { action: "presence_leave" }, abort.signal); }
  catch { /* Closing must never be blocked by a missing network. */ }
  finally { window.clearTimeout(timeout); }
}
async function directMessages(query: Record<string, string | number> = {}, data?: Record<string, string | number>) {
  const stringQuery = Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)]));
  const stringData = data ? Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)])) : undefined;
  let result: { ok: boolean; error?: string; threads?: DirectThread[]; messages?: DirectMessage[]; message?: DirectMessage };
  try {
    result = await invoke("direct_messages_request", { token: token(), query: stringQuery, data: stringData });
  } catch (error) {
    throw new Error(typeof error === "string" ? error : "Сервер личных сообщений недоступен");
  }
  if (!result.ok) throw new Error(result.error || "Не удалось загрузить личные сообщения");
  return result as { ok: true; threads?: DirectThread[]; messages?: DirectMessage[]; message?: DirectMessage };
}

async function authUpload(data: FormData) {
  const response = await fetch(`${API}/desktop_auth.php`, {
    method: "POST",
    headers: token() ? { Authorization: `Bearer ${token()}` } : {},
    body: data,
  });
  const result = await response
    .json()
    .catch(() => ({ ok: false, error: "Сервер не ответил" }));
  if (!response.ok || !result.ok)
    throw new Error(result.error || "Не удалось загрузить файл");
  return result;
}
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
function playSound(kind: "join" | "leave" | "send" | "receive" | "share") {
  if (localStorage.getItem("kitchat_sounds") === "0") return;
  const notes = {
    join: [440, 660],
    leave: [520, 300],
    send: [660],
    receive: [520, 720],
    share: [380, 520, 760],
  }[kind];
  try {
    const ctx = new AudioContext();
    notes.forEach((frequency, index) => {
      const oscillator = ctx.createOscillator(),
        gain = ctx.createGain(),
        start = ctx.currentTime + index * 0.075;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.045, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.12);
    });
    window.setTimeout(() => void ctx.close(), 600);
  } catch {}
}
const notifiedMessageIds = new Set<number>();
const notifiedDirectMessageIds = new Set<number>();
const notifiedDirectThreadUpdates = new Set<string>();
let notificationPermissionRequest: Promise<boolean> | null = null;
let lastForegroundAt = Date.now();
const noteForeground = () => { if (!document.hidden && document.hasFocus()) lastForegroundAt = Date.now(); };
window.addEventListener("focus", noteForeground);
document.addEventListener("visibilitychange", noteForeground);
function showAppNotice(title: string, body: string, tone: "message" | "success" | "warning" = "message") {
  let stack = document.querySelector<HTMLElement>("#appNoticeStack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "appNoticeStack";
    stack.className = "app-notice-stack";
    stack.setAttribute("aria-live", "polite");
    document.body.append(stack);
  }
  const notice = document.createElement("button");
  notice.type = "button";
  notice.className = `app-notice ${tone}`;
  notice.innerHTML = `<span class="app-notice-mark">${tone === "success" ? "✓" : tone === "warning" ? "!" : "●"}</span><span><b>${esc(title)}</b><small>${esc(body)}</small></span><i>×</i>`;
  const remove = () => { notice.classList.add("leaving"); window.setTimeout(() => notice.remove(), 170); };
  notice.onclick = remove;
  stack.append(notice);
  window.setTimeout(remove, 5200);
}
async function ensureNotificationPermission() {
  // Previously permission was requested only after manually toggling the bell.
  // Initialise it at app launch while preserving an explicit user choice to
  // keep notifications disabled.
  if (localStorage.getItem("kitchat_notifications") === "0") return false;
  if (!localStorage.getItem("kitchat_notifications")) {
    localStorage.setItem("kitchat_notifications", "1");
  }
  if (notificationPermissionRequest) return notificationPermissionRequest;
  notificationPermissionRequest = (async () => {
    const alreadyGranted = await isPermissionGranted().catch(() => false);
    const granted = alreadyGranted || (await requestPermission().catch(() => "denied")) === "granted";
    if (granted) {
      localStorage.setItem("kitchat_notifications", "1");
      if (!alreadyGranted && localStorage.getItem("kitchat_notification_ready_shown") !== "1") {
        localStorage.setItem("kitchat_notification_ready_shown", "1");
        try { sendNotification({ title: "Kitchat готов к общению", body: "Уведомления включены — новые сообщения не потеряются." }); } catch {}
      }
    }
    return granted;
  })();
  return notificationPermissionRequest;
}
async function sendSystemNotice(title: string, body: string) {
  if (document.hasFocus() && !document.hidden) return;
  if (Date.now() - lastForegroundAt < 1200) return;
  if (!(await ensureNotificationPermission())) return;
  try { await sendNotification({ title, body }); } catch {}
}
async function notifyAboutMessage(message: CommunityState["messages"][number]) {
  if (localStorage.getItem("kitchat_notifications") === "0") return;
  if (notifiedMessageIds.has(message.id)) return;
  notifiedMessageIds.add(message.id);
  const body = message.sticker ? "Отправил(а) стикер" : message.message.slice(0, 140);
  if (document.hasFocus() && !document.hidden) showAppNotice(message.name, body);
  await sendSystemNotice(message.name, body);
}
async function notifyAboutFriendRequest(person: Person) {
  if (localStorage.getItem("kitchat_notifications") === "0") return;
  const key = `kitchat_friend_request_notified_${person.id}`;
  if (localStorage.getItem(key) === "1") return;
  localStorage.setItem(key, "1");
  const body = `${person.name} хочет добавить вас в друзья`;
  if (document.hasFocus() && !document.hidden) showAppNotice("Новая заявка в друзья", body, "success");
  await sendSystemNotice("Новая заявка в друзья", body);
}
async function notifyAboutDirectMessage(person: Person | undefined, message: DirectMessage) {
  if (localStorage.getItem("kitchat_notifications") === "0" || notifiedDirectMessageIds.has(message.id)) return;
  notifiedDirectMessageIds.add(message.id);
  const title = person?.name || "Личное сообщение";
  const body = message.message.slice(0, 140);
  if (document.hasFocus() && !document.hidden) showAppNotice(title, body);
  await sendSystemNotice(title, body);
}
async function notifyAboutDirectThread(person: Person | undefined, thread: DirectThread) {
  if (localStorage.getItem("kitchat_notifications") === "0") return;
  const key = `${thread.peer_id}:${thread.updated_at}`;
  if (notifiedDirectThreadUpdates.has(key)) return;
  notifiedDirectThreadUpdates.add(key);
  const title = person?.name || "Новое личное сообщение";
  const body = thread.last_message.slice(0, 140) || "Новое сообщение";
  if (document.hasFocus() && !document.hidden) showAppNotice(title, body);
  await sendSystemNotice(title, body);
}
let autostartConfigured = false;
async function ensureAutostart() {
  if (autostartConfigured) return;
  autostartConfigured = true;
  try {
    if (!(await isAutostartEnabled())) await enableAutostart();
  } catch {
    // Автозапуск недоступен только вне установленного приложения.
  }
}
const materialIcons: Record<string, string> = {
  attach: "attach_file", bell: "notifications", "bell-off": "notifications_off", camera: "videocam",
  "chevron-down": "expand_more", edit: "edit", focus: "fullscreen",
  gear: "settings", gift: "redeem", headphones: "headphones", "headphones-off": "volume_off", mic: "mic", "mic-off": "mic_off",
  "phone-down": "call_end", "fullscreen-exit": "fullscreen_exit", search: "search", send: "send", signal: "network_cell", game: "sports_esports",
  smile: "sentiment_satisfied", users: "group", chat: "chat_bubble", link: "link", delete: "delete", "video-message": "screen_share",
};
const materialOffIcons: Record<string, string> = {
  camera: "videocam_off", headphones: "volume_off", mic: "mic_off",
  "video-message": "stop_screen_share",
};
const ico = (name: string) =>
  `<span class="app-icon material-symbols-rounded" data-material-icon="${name}" aria-hidden="true"><span class="icon-normal">${materialIcons[name] || name}</span>${materialOffIcons[name] ? `<span class="icon-off">${materialOffIcons[name]}</span>` : ""}</span>`;
const fullscreenCallControls = () =>
  `<div class="fullscreen-call-chrome is-visible" id="fullscreenCallChrome"><header class="fullscreen-call-heading"><span>${ico("signal")}</span><div><b>${esc(activeVoiceMeta?.name || "Голосовой канал")}</b><small>${esc(activeVoiceMeta?.serverName || "Kitchat")} · <time data-voice-duration>${voiceDurationText()}</time></small></div></header><div class="fullscreen-call-toolbar" role="toolbar" aria-label="Управление голосовым каналом"><button type="button" data-fullscreen-call-action="mic" title="Микрофон">${ico("mic")}</button><button type="button" data-fullscreen-call-action="camera" title="Камера">${ico("camera")}</button><button type="button" data-fullscreen-call-action="share" title="Демонстрация экрана">${ico("video-message")}</button><button type="button" data-fullscreen-call-action="roulette" title="Рулетка ников"><span aria-hidden="true">🎡</span></button><button type="button" data-fullscreen-call-action="deafen" title="Не слышать других">${ico("headphones")}</button><button type="button" data-fullscreen-call-action="exit" title="Выйти из полноэкранного режима">${ico("fullscreen-exit")}</button><button type="button" class="danger" data-fullscreen-call-action="leave" title="Отключиться">${ico("phone-down")}</button></div></div>`;
const fullscreenActionTargets: Record<string, string> = {
  mic: "#callMic",
  camera: "#callCamera",
  share: "#callShare",
  roulette: "#callRoulette",
  deafen: "#callDeafen",
};
let fullscreenChromeTimer = 0;
function syncFullscreenCallControls() {
  const chrome = document.querySelector<HTMLElement>("#fullscreenCallChrome");
  if (!chrome) return;
  for (const [action, selector] of Object.entries(fullscreenActionTargets)) {
    const mirror = chrome.querySelector<HTMLButtonElement>(`[data-fullscreen-call-action="${action}"]`);
    const source = document.querySelector<HTMLButtonElement>(selector);
    if (!mirror) continue;
    mirror.hidden = !source;
    mirror.classList.toggle("on", !!source?.classList.contains("on"));
    mirror.classList.toggle("off", !!source?.classList.contains("off"));
    mirror.disabled = !!source?.disabled;
  }
}
function revealFullscreenCallControls() {
  const stage = document.fullscreenElement?.closest<HTMLElement>(".call-stage");
  const chrome = stage?.querySelector<HTMLElement>("#fullscreenCallChrome");
  if (!stage || !chrome) return;
  syncFullscreenCallControls();
  chrome.classList.add("is-visible");
  stage.classList.remove("controls-hidden");
  window.clearTimeout(fullscreenChromeTimer);
  fullscreenChromeTimer = window.setTimeout(() => {
    if (chrome.querySelector(".fullscreen-call-toolbar")?.matches(":hover")) return revealFullscreenCallControls();
    chrome.classList.remove("is-visible");
    stage.classList.add("controls-hidden");
  }, 2600);
}
const voicePerson = (person: VoiceUser) =>
  `<div class="voice-person ${person.speaking && !person.muted ? "speaking" : ""}" data-voice-person="${person.id}"><div class="avatar">${avatar(person)}</div><span>${esc(person.name)}</span><i>${person.sharing ? ico("video-message") : person.deafened ? ico("headphones-off") : person.muted ? ico("mic-off") : ""}</i></div>`;
function visibleVoicePresence(users: VoiceUser[]) {
  const byUser = new Map<number, VoiceUser>();
  for (const person of users) {
    if (person.id === currentUser?.id) {
      if (person.channel_id === activeVoiceChannel) byUser.set(person.id, person);
      continue;
    }
    // Старые версии API могли вернуть одного пользователя в нескольких каналах.
    // Никогда не рисуем дубликаты, даже пока сервер очищает устаревшую запись.
    if (!byUser.has(person.id)) byUser.set(person.id, person);
  }
  return [...byUser.values()];
}
function modal(
  title: string,
  body: string,
  submitLabel: string,
  onSubmit: (form: HTMLFormElement) => Promise<void>,
) {
  const layer = document.createElement("div");
  layer.className = "modal-layer";
  layer.dataset.modalKind = title.includes("сервер") || title.includes("Сервер") ? "server" : title.includes("канал") || title.includes("Канал") ? "channel" : title.includes("Настройки") || title.includes("Управление") ? "settings" : "dialog";
  layer.innerHTML = `<form class="modal-card"><button class="modal-close" type="button" aria-label="Закрыть">×</button><div class="modal-titlebar"><div class="modal-title-icon">${title.includes("голос") ? "◖" : title.includes("канал") ? "#" : title.includes("сервер") || title.includes("Сервер") ? "✦" : ""}</div><div><h2>${esc(title)}</h2></div></div>${body}<p class="modal-error"></p><div class="modal-actions"><button type="button" class="cancel">Отмена</button><button type="submit" class="primary">${esc(submitLabel)}</button></div></form>`;
  document.body.append(layer);
  const form = layer.querySelector<HTMLFormElement>("form")!;
  const close = () => {
    if (layer.dataset.closing) return;
    layer.dataset.closing = "true";
    layer.classList.add("is-closing");
    window.setTimeout(() => layer.remove(), 180);
  };
  layer.addEventListener("mousedown", (e) => {
    if (e.target === layer) close();
  });
  layer
    .querySelectorAll<HTMLButtonElement>(".cancel,.modal-close")
    .forEach((b) => (b.onclick = close));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const submit = form.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!;
    const error = form.querySelector<HTMLElement>(".modal-error")!;
    submit.disabled = true;
    error.textContent = "";
    try {
      await onSubmit(form);
      close();
    } catch (reason) {
      error.textContent =
        reason instanceof Error
          ? reason.message
          : "Не удалось выполнить действие";
      submit.disabled = false;
    }
  };
  setTimeout(() => form.querySelector<HTMLInputElement>("input")?.focus(), 0);
  return layer;
}
function appDialog(
  title: string,
  message: string,
  options: { confirm?: string; cancel?: string; danger?: boolean } = {},
) {
  return new Promise<boolean>((resolve) => {
    const layer = document.createElement("div");
    layer.className = "modal-layer app-dialog-layer";
    const confirmLabel = options.confirm || "Понятно";
    layer.innerHTML = `<section class="modal-card app-dialog"><button class="modal-close" type="button" aria-label="Закрыть">×</button><h2>${esc(title)}</h2><p>${esc(message)}</p><div class="modal-actions">${options.cancel ? `<button class="cancel" type="button">${esc(options.cancel)}</button>` : ""}<button class="primary ${options.danger ? "danger" : ""}" type="button">${esc(confirmLabel)}</button></div></section>`;
    document.body.append(layer);
    const close = (value: boolean) => {
      if (layer.dataset.closing) return;
      layer.dataset.closing = "true";
      layer.classList.add("is-closing");
      window.setTimeout(() => { layer.remove(); resolve(value); }, 180);
    };
    layer.addEventListener("mousedown", (event) => { if (event.target === layer) close(false); });
    layer.querySelector<HTMLButtonElement>(".modal-close")!.onclick = () => close(false);
    layer.querySelector<HTMLButtonElement>(".primary")!.onclick = () => close(true);
    layer.querySelector<HTMLButtonElement>(".cancel")?.addEventListener("click", () => close(false));
  });
}
const appAlert = (message: string) => void appDialog("Kitchat", message);
const appConfirm = (title: string, message: string, danger = false) =>
  appDialog(title, message, { confirm: danger ? "Удалить" : "Продолжить", cancel: "Отмена", danger });
async function requestMediaAccess(kind: "microphone" | "camera") {
  if (localStorage.getItem(`kitchat_${kind}_granted`) === "1") return true;
  const isMicrophone = kind === "microphone";
  return appDialog(
    isMicrophone ? "Разрешить микрофон?" : "Разрешить камеру?",
    isMicrophone
      ? "Kitchat использует микрофон только для проверки уровня и голосовой связи. Звук не записывается и не отправляется без подключения к звонку."
      : "Kitchat использует камеру только для предпросмотра и звонков. Изображение не записывается.",
    { confirm: "Продолжить", cancel: "Не сейчас" },
  );
}
function bindSettings(layer: HTMLElement) {
  layer.classList.add("settings-layer");
  const buttons = [
      ...layer.querySelectorAll<HTMLButtonElement>("[data-settings-tab]"),
    ],
    panels = [...layer.querySelectorAll<HTMLElement>("[data-settings-panel]")];
  const select = (name: string) => {
    buttons.forEach((button) =>
      button.classList.toggle("active", button.dataset.settingsTab === name),
    );
    panels.forEach(
      (panel) => (panel.hidden = panel.dataset.settingsPanel !== name),
    );
  };
  buttons.forEach(
    (button) =>
      (button.onclick = () => select(button.dataset.settingsTab || "profile")),
  );
  select(buttons[0]?.dataset.settingsTab || "profile");
  layer
    .querySelectorAll<HTMLInputElement>('input[type="file"][data-preview]')
    .forEach(
      (input) =>
        (input.onchange = () => {
          const file = input.files?.[0],
            target = layer.querySelector<HTMLImageElement>(
              input.dataset.preview || "",
            );
          if (file && target) {
            target.src = URL.createObjectURL(file);
            target
              .closest(".avatar,.server-icon-preview")
              ?.classList.add("has-preview");
          }
        }),
    );
}
type CaptureChoice = {
  id: number;
  kind: "window" | "monitor";
  title: string;
  thumbnail: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  jpegQuality: number;
};
async function capturePicker(): Promise<CaptureChoice | null> {
  const sources =
    await invoke<Array<Omit<CaptureChoice, "width" | "height" | "fps" | "bitrate" | "jpegQuality">>>(
      "capture_sources",
    );
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.className = "modal-layer capture-layer";
    const savedResolution = localStorage.getItem("kitchat_stream_resolution") || "1280x720";
    const savedFps = localStorage.getItem("kitchat_stream_fps") || "30";
    layer.innerHTML = `<section class="capture-picker"><header><div><h2>Поделиться экраном</h2><p>Что вы хотите транслировать?</p></div><button class="capture-close">×</button></header><nav><button class="active" data-capture-tab="window">Приложения</button><button data-capture-tab="monitor">Экраны</button></nav><div class="capture-sources"></div><footer><div><b>Качество трансляции</b><div class="capture-options"><select id="captureResolution"><option value="1280x720">720p</option><option value="1920x1080">1080p</option><option value="2560x1440">1440p</option><option value="3840x2160">4K (максимум)</option></select><select id="captureFps"><option>15</option><option>30</option><option>60</option></select></div><small>Частота, разрешение и битрейт действительно применяются к исходящему WebRTC-потоку. Системный звук включён.</small></div><button class="cancel">Отмена</button><button class="primary" disabled>Начать трансляцию</button></footer></section>`;
    layer.querySelector<HTMLSelectElement>("#captureResolution")!.value = savedResolution;
    layer.querySelector<HTMLSelectElement>("#captureFps")!.value = savedFps;
    document.body.append(layer);
    let tab: "window" | "monitor" = "window",
      selected: number | null = null;
    const grid = layer.querySelector<HTMLElement>(".capture-sources")!,
      start = layer.querySelector<HTMLButtonElement>("footer .primary")!;
    const close = (value: CaptureChoice | null) => {
      layer.remove();
      resolve(value);
    };
    const render = () => {
      const filtered = sources.filter((source) => source.kind === tab);
      grid.innerHTML = filtered.length
        ? filtered
            .map(
              (source) =>
                `<button class="capture-source ${selected === source.id ? "selected" : ""}" data-source="${source.id}"><img src="${source.thumbnail}" alt=""><span>${esc(source.title)}</span><i>✓</i></button>`,
            )
            .join("")
        : `<p>Доступных источников нет</p>`;
    };
    layer.querySelectorAll<HTMLButtonElement>("[data-capture-tab]").forEach(
      (button) =>
        (button.onclick = () => {
          tab = button.dataset.captureTab as "window" | "monitor";
          selected = null;
          start.disabled = true;
          layer
            .querySelectorAll("[data-capture-tab]")
            .forEach((item) =>
              item.classList.toggle("active", item === button),
            );
          render();
        }),
    );
    grid.onclick = (event) => {
      const card = (event.target as HTMLElement).closest<HTMLButtonElement>(
        ".capture-source",
      );
      if (!card) return;
      selected = Number(card.dataset.source);
      start.disabled = false;
      render();
    };
    grid.ondblclick = () => start.click();
    layer
      .querySelectorAll<HTMLButtonElement>(".cancel,.capture-close")
      .forEach((button) => (button.onclick = () => close(null)));
    start.onclick = () => {
      const source = sources.find(
        (item) => item.kind === tab && item.id === selected,
      );
      if (!source) return;
      const [width, height] = layer
        .querySelector<HTMLSelectElement>("#captureResolution")!
        .value.split("x")
        .map(Number);
      const fps = Number(layer.querySelector<HTMLSelectElement>("#captureFps")!.value);
      localStorage.setItem("kitchat_stream_resolution", `${width}x${height}`);
      localStorage.setItem("kitchat_stream_fps", String(fps));
      const pixels = width * height;
      // Start conservatively: the advertised tariff is not the same thing as
      // stable upload. RTCP adaptation can then react without initial queueing.
      const bitrate = pixels >= 8_000_000 ? (fps >= 60 ? 18_000_000 : 12_000_000)
        : pixels >= 3_500_000 ? (fps >= 60 ? 10_000_000 : 7_000_000)
          : pixels >= 2_000_000 ? (fps >= 60 ? 6_000_000 : 4_500_000)
            : fps >= 60 ? 4_500_000 : 3_000_000;
      close({
        ...source,
        width,
        height,
        fps,
        bitrate,
        jpegQuality: pixels >= 3_500_000 ? 94 : 90,
      });
    };
    render();
  });
}
async function nativeCapture(choice: CaptureChoice) {
  const canvas = document.createElement("canvas");
  canvas.width = choice.width;
  canvas.height = choice.height;
  const context = canvas.getContext("2d", { alpha: false })!,
    stream = canvas.captureStream(choice.fps);
  let stopped = false,
    busy = false;
  let resizeBusyUntil = 0;
  const onResize = () => (resizeBusyUntil = performance.now() + 260);
  window.addEventListener("resize", onResize, { passive: true });
  const draw = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const data = await invoke<string>("capture_frame", {
          kind: choice.kind,
          id: choice.id,
          width: choice.width,
          height: choice.height,
          quality: choice.jpegQuality,
        }),
        image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => {
          context.fillStyle = "#080b12";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve();
        };
        image.onerror = () => reject(new Error("Не удалось получить кадр"));
        image.src = data;
      });
    } finally {
      busy = false;
      if (!stopped) {
        const resizing = performance.now() < resizeBusyUntil;
        window.setTimeout(
          () => void draw(),
          resizing ? 100 : Math.max(16, 1000 / Math.min(choice.fps, 60)),
        );
      }
    }
  };
  await draw();
  return {
    track: stream.getVideoTracks()[0],
    stop: () => {
      stopped = true;
      window.removeEventListener("resize", onResize);
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
async function p2pStreamPicker(): Promise<CaptureChoice | null> {
  return capturePicker();
}
function friendsModal(serverId: number, onChanged: () => void, initialPeople: Person[] = [], canInvite = false) {
  const layer = document.createElement("div");
  layer.className = "modal-layer";
  layer.innerHTML = `<section class="modal-card friends-card"><button class="modal-close" type="button">×</button><small>ДРУЗЬЯ</small><h2>Найти человека</h2><div class="friend-search">${ico("search")}<input placeholder="Имя или ID" autocomplete="off"></div><div class="friend-results"><p>Начните вводить имя пользователя</p></div></section>`;
  document.body.append(layer);
  let searchRevision = 0;
  let timer = 0;
  const previousFocus = document.activeElement as HTMLElement | null;
  const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
  const close = () => { ++searchRevision; clearTimeout(timer); document.removeEventListener("keydown", onEscape); layer.remove(); previousFocus?.focus(); };
  document.addEventListener("keydown", onEscape);
  layer.querySelector("section")?.setAttribute("role", "dialog");
  layer.querySelector("section")?.setAttribute("aria-modal", "true");
  layer.querySelector("section")?.setAttribute("aria-label", "Добавить друга");
  layer.querySelector("h2")!.textContent = "Хорошей компании всегда рады";
  layer.querySelector("h2")!.insertAdjacentHTML("afterend", '<p class="friend-search-help">Найдите друга по имени или ID. После принятия заявки вы сможете общаться лично.</p>');
  layer.querySelector<HTMLButtonElement>(".modal-close")!.onclick = close;
  layer.addEventListener("mousedown", (e) => {
    if (e.target === layer) close();
  });
  const input = layer.querySelector<HTMLInputElement>("input")!,
    results = layer.querySelector<HTMLElement>(".friend-results")!;
  input.setAttribute("aria-label", "Имя или ID друга");
  results.setAttribute("aria-live", "polite");
  const render = (people: Person[]) => {
    results.innerHTML = people.length
      ? people
          .map((p) => {
            const mode =
              p.friend_status === 1
                ? serverId && canInvite
                  ? "member"
                  : "none"
                : p.friend_status === 0
                  ? p.sent_by_me
                    ? "none"
                    : "accept"
                  : "add";
            const label =
              mode === "member"
                ? "Пригласить"
                : mode === "accept"
                  ? "Принять"
                  : mode === "none"
                    ? p.friend_status === 1
                      ? serverId && !canInvite
                        ? "Только владелец"
                        : "Уже в друзьях"
                      : "Заявка отправлена"
                    : "Добавить";
            return `<div class="friend-row" data-person="${p.id}" data-person-name="${esc(p.name)}"><div class="avatar">${avatar(p)}${p.online ? "<i></i>" : ""}</div><div><b>${esc(p.name)}</b><small>ID ${p.id}</small></div><button data-friend="${mode}" data-id="${p.id}" ${mode === "none" ? "disabled" : ""}>${label}</button></div>`;
          })
          .join("")
      : "<p>Никого не нашли</p>";
  };
  input.oninput = () => {
    clearTimeout(timer);
    const requestRevision = ++searchRevision;
    const query = input.value.trim();
    if (!query) { results.innerHTML = "<p>Введите имя или числовой ID друга</p>"; return; }
    results.innerHTML = '<p class="friend-search-pending">Ищем…</p>';
    timer = window.setTimeout(async () => {
      try {
        const found = await community({ server_id: serverId, q: query });
        if (requestRevision === searchRevision && layer.isConnected) render(found.search);
      } catch {
        if (requestRevision === searchRevision && layer.isConnected) results.innerHTML = "<p>Не удалось выполнить поиск. Попробуйте ещё раз.</p>";
      }
    }, 260);
  };
  results.onclick = async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-friend]",
    );
    if (!button || button.dataset.friend === "none") return;
    button.disabled = true;
    try {
      if (button.dataset.friend === "member")
        await community(
          {},
          {
            action: "add_member",
            server_id: serverId,
            user_id: Number(button.dataset.id),
          },
        );
      else
        await community(
          {},
          {
            action: "friend",
            mode: button.dataset.friend || "add",
            user_id: Number(button.dataset.id),
          },
        );
      onChanged();
      showAppNotice("Друзья", button.dataset.friend === "add" ? "Заявка отправлена" : button.dataset.friend === "accept" ? "Друг добавлен" : "Приглашение отправлено", "success");
      if (input.value.trim()) input.dispatchEvent(new Event("input"));
      else { button.textContent = button.dataset.friend === "add" ? "Заявка отправлена" : "Готово"; button.dataset.friend = "none"; }
    } catch (error) {
      button.disabled = false;
      appAlert(
        error instanceof Error
          ? error.message
          : "Не удалось выполнить действие",
      );
    }
  };
  if (initialPeople.length) render(initialPeople);
  setTimeout(() => input.focus(), 0);
}
function logo(cls: string) {
  return `<div class="${cls}"><img src="/kitchat-icon.png" alt="Kitchat"></div>`;
}
function setError(message: string, busy = false) {
  const el = document.querySelector<HTMLElement>("#authError");
  if (el) el.textContent = message;
  document
    .querySelectorAll<HTMLButtonElement>(".auth-card button")
    .forEach((b) => (b.disabled = busy));
}
function authView(mode: "login" | "register" = "login") {
  socialCleanup();
  ++viewRevision;
  const register = mode === "register";
  app.innerHTML = `<main class="auth-screen"><section class="auth-brand">${logo("brand-mark")}<div><b>Kitchat</b><span>Свои люди. Свои разговоры.</span></div></section><section class="auth-card"><header>${logo("mini-logo")}<h1>${register ? "Создайте аккаунт" : "С возвращением"}</h1><p>${register ? "Присоединяйтесь к своим людям" : "Войдите, чтобы продолжить общение"}</p></header><form id="authForm">${register ? '<label>Как вас зовут<input id="name" autocomplete="name" maxlength="40" placeholder="Ваше имя" required></label>' : ""}<label>Электронная почта<input id="login" type="email" autocomplete="username" placeholder="name@example.com" required></label><label>Пароль<input id="password" type="password" autocomplete="${register ? "new-password" : "current-password"}" minlength="8" placeholder="Минимум 8 символов" required></label><button class="primary" type="submit">${register ? "Создать аккаунт" : "Войти"}</button>${register ? "" : '<button class="link" type="button">Забыли пароль?</button>'}</form><div class="divider"><span>или продолжить через</span></div><div class="oauth"><button data-provider="google"><b class="google">G</b>Google</button><button data-provider="yandex"><b class="yandex">Я</b>Яндекс</button><button data-provider="vk"><b class="vk">VK</b>ВКонтакте</button></div><footer>${register ? "Уже есть аккаунт?" : "Впервые здесь?"} <button id="switchMode">${register ? "Войти" : "Создать аккаунт"}</button></footer><p class="auth-error" id="authError"></p></section><div class="auth-glow one"></div><div class="auth-glow two"></div></main>`;
  document.querySelector<HTMLButtonElement>("#switchMode")!.onclick = () =>
    authView(register ? "login" : "register");
  document.querySelector<HTMLFormElement>("#authForm")!.onsubmit = async (
    e,
  ) => {
    e.preventDefault();
    setError(register ? "Создаём аккаунт…" : "Входим…", true);
    try {
      const data = await request("desktop_auth.php", {
        action: register ? "register" : "login",
        login: document.querySelector<HTMLInputElement>("#login")!.value.trim(),
        password: document.querySelector<HTMLInputElement>("#password")!.value,
        ...(register
          ? {
              name: document
                .querySelector<HTMLInputElement>("#name")!
                .value.trim(),
            }
          : {}),
      });
      localStorage.setItem("kitchat_token", data.token);
      currentUser = data.user;
      void syncOwnProfileAbout();
      void ensureNotificationPermission();
      const inviteCode = localStorage.getItem("kitchat_pending_invite");
      if (inviteCode) {
        localStorage.removeItem("kitchat_pending_invite");
        const joined = await community({}, { action: "join_invite", code: inviteCode });
        shellView(joined.server_id, "");
      } else shellView();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Ошибка авторизации",
        false,
      );
    }
  };
  document.querySelectorAll<HTMLButtonElement>("[data-provider]").forEach(
    (button) =>
      (button.onclick = async () => {
        setError("Открываем безопасный вход в браузере…");
        await openUrl(
          `https://oliverkitchen.ru/auth/oauth.php?action=start&provider=${button.dataset.provider}&desktop=1`,
        );
      }),
  );
}
const assetUrl = (path?: string) => {
  const value = path?.trim() || "";
  return value
    ? value.startsWith("http://") || value.startsWith("https://")
      ? value
      : `https://oliverkitchen.ru${value.startsWith("/") ? "" : "/"}${value}`
    : "";
};
function avatar(user: { name: string; avatar?: string | null }) {
  const src = assetUrl(user.avatar || undefined);
  return src
    ? `<img src="${esc(src)}" alt="">`
    : (user.name[0] || "?").toUpperCase();
}
function friendlyTime(value: string) {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return { short: value, full: value };
  const now = new Date();
  const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString() === date.toDateString();
  return {
    short: sameDay ? time : yesterday ? `Вчера, в ${time}` : date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) + `, в ${time}`,
    full: date.toLocaleString("ru-RU"),
  };
}
type ChatMessage = CommunityState["messages"][number];
function messagesCanGroup(previous: ChatMessage | undefined, current: ChatMessage) {
  if (!previous || previous.user_id !== current.user_id) return false;
  const before = new Date(previous.created_at.replace(" ", "T")).getTime();
  const now = new Date(current.created_at.replace(" ", "T")).getTime();
  return Number.isFinite(before) && Number.isFinite(now) && now >= before && now - before <= 7 * 60_000;
}
const messageMarkup = (m: ChatMessage, groupedOrIndex: boolean | number = false, batch?: ChatMessage[]) => {
  const grouped = typeof groupedOrIndex === "number"
    ? messagesCanGroup(batch?.[groupedOrIndex - 1], m)
    : groupedOrIndex;
  const date = friendlyTime(m.created_at);
  const file = m.attachment;
  const source = file ? esc(assetUrl(file.path)) : "";
  const attachment = !file ? "" : file.mime.startsWith("image/")
    ? `<a class="chat-media image" href="${source}" target="_blank"><img src="${source}" alt="${esc(file.name)}"></a>`
    : file.mime.startsWith("video/")
      ? `<video class="chat-media video" controls preload="metadata" src="${source}"></video>`
      : file.mime.startsWith("audio/")
        ? `<audio class="chat-audio" controls src="${source}"></audio>`
        : `<a class="chat-file" href="${source}" target="_blank" download>${ico("attach")}<span><b>${esc(file.name)}</b><small>${esc(file.mime || "Файл")}</small></span></a>`;
  const body = esc(m.message).replace(/(https?:\/\/[^\s<]+)/gi, '<a class="message-link" href="$1" target="_blank" rel="noopener noreferrer">$1</a>').replace(/\n/g, "<br>");
  const delivery = m.user_id === currentUser?.id ? `<span class="message-delivery" title="${m.read_by ? "Прочитано" : "Отправлено"}">${m.read_by ? "✓✓" : "✓"}</span>` : "";
  const content = m.sticker ? `<img class="chat-sticker" data-sticker-id="${m.sticker.id}" src="${esc(assetUrl(m.sticker.path))}" alt="${esc(m.sticker.name)}">` : attachment || `<p>${body}</p>`;
  return `<article class="${grouped ? "message-continuation" : "message-start"}" data-message-id="${m.id}" data-message-user="${m.user_id || 0}" data-message-author="${esc(m.name)}" data-message-text="${esc(m.message)}">${grouped ? `<time class="continuation-time" data-tooltip="${esc(date.full)}">${esc(date.short.replace(/^.*в /, ""))}</time>` : `<div class="avatar">${avatar(m)}</div>`}<div>${grouped ? "" : `<header><b>${esc(m.name)}</b><time data-tooltip="${esc(date.full)}">${esc(date.short)}</time>${m.edited_at ? '<small class="message-edited">изменено</small>' : ""}</header>`}<div class="message-body">${content}${delivery}</div></div></article>`;
};
function messageBatchMarkup(messages: ChatMessage[], previous?: ChatMessage) {
  return messages.map((message) => {
    const markup = messageMarkup(message, messagesCanGroup(previous, message));
    previous = message;
    return markup;
  }).join("");
}
type ContextItem = { label: string; danger?: boolean; action: () => void | Promise<void> };
let appContextMenu: HTMLElement | null = null;
function closeAppContextMenu() {
  appContextMenu?.remove();
  appContextMenu = null;
}
function openAppContextMenu(x: number, y: number, items: ContextItem[]) {
  closeAppContextMenu();
  const menu = document.createElement("div");
  menu.className = "app-context-menu";
  menu.innerHTML = items.map((item, index) => `<button type="button" data-context-item="${index}" class="${item.danger ? "danger" : ""}">${esc(item.label)}</button>`).join("");
  menu.addEventListener("pointerdown", (event) => event.stopPropagation());
  document.body.append(menu);
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - bounds.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - bounds.height - 8)}px`;
  menu.querySelectorAll<HTMLButtonElement>("[data-context-item]").forEach((button) => {
    button.onclick = () => { const item = items[Number(button.dataset.contextItem)]; closeAppContextMenu(); void item?.action(); };
  });
  appContextMenu = menu;
  window.setTimeout(() => document.addEventListener("pointerdown", closeAppContextMenu, { once: true }), 0);
}
function openVoiceUserMenu(
  x: number,
  y: number,
  person: User,
  voiceChannelId: number,
  canModerate: boolean,
  serverId: number,
  refresh: () => Promise<void>,
) {
  closeAppContextMenu();
  const menu = document.createElement("div");
  menu.className = "app-context-menu user-context-menu";
  const savedVolume = Math.max(0, Math.min(200, Number(localStorage.getItem(`kitchat_user_volume_${person.id}`) || "100")));
  menu.innerHTML = `<header><span class="avatar">${avatar(person)}</span><b>${esc(person.name)}</b></header><label><span>Громкость пользователя</span><output>${savedVolume}%</output><input type="range" min="0" max="200" step="5" value="${savedVolume}"></label>${voiceChannelId && canModerate ? `<button type="button" data-action="kick-voice">Отключить от голосового</button>` : ""}${canModerate ? `<button type="button" class="danger" data-action="kick-server">Выгнать с сервера</button>` : ""}`;
  menu.addEventListener("pointerdown", (event) => event.stopPropagation());
  document.body.append(menu);
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - bounds.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - bounds.height - 8)}px`;
  const range = menu.querySelector<HTMLInputElement>('input[type="range"]')!;
  const output = menu.querySelector<HTMLOutputElement>("output")!;
  range.oninput = () => {
    const volume = Number(range.value);
    output.value = `${volume}%`;
    localStorage.setItem(`kitchat_user_volume_${person.id}`, String(volume));
    activeVoiceSetUserVolume?.(person.id, volume / 100);
  };
  menu.querySelector<HTMLButtonElement>('[data-action="kick-voice"]')?.addEventListener("click", async () => {
    await community({}, { action: "kick_voice", channel_id: voiceChannelId, user_id: person.id });
    closeAppContextMenu(); await refresh();
  });
  menu.querySelector<HTMLButtonElement>('[data-action="kick-server"]')?.addEventListener("click", async () => {
    if (!(await appConfirm("Выгнать с сервера", `Выгнать пользователя «${person.name}» с сервера?`, true))) return;
    await community({}, { action: "kick_member", server_id: serverId, user_id: person.id });
    closeAppContextMenu(); await refresh();
  });
  appContextMenu = menu;
  window.setTimeout(() => document.addEventListener("pointerdown", closeAppContextMenu, { once: true }), 0);
}
function memberRoleLabel(person: User) {
  if (person.global_role === "superadmin") return "Самый главный";
  if (person.role === "owner") return "Владелец сервера";
  if (person.role === "admin") return "Администратор";
  if (person.role === "moderator") return "Модератор";
  return "Участник";
}
function profileActivityMarkup(person: User) {
  // Game activity is ordinary presence information: any signed-in participant
  // may see it, just like the online indicator.
  const activity = person.id === currentUser?.id ? localGameActivity : gameActivities.get(person.id);
  const fresh = activity && (!activity.checked_at || Date.now() - activity.checked_at < 45_000) ? activity : null;
  const report = person.id !== currentUser?.id ? gamePresenceReports.get(person.id) : null;
  const reportAge = report?.checked_at ? Math.max(0, Math.floor(Date.now() / 1000 - report.checked_at)) : null;
  if (fresh) {
    return `<section class="supreme-activity"><small>ИГРАЕТ СЕЙЧАС</small><div><span class="supreme-game-icon">${ico("game")}</span><span><b>${esc(fresh.game)}</b><em>В игре ${esc(gameElapsed(fresh.started_at))}</em></span></div>${report ? `<p class="presence-debug">Клиент ${esc(report.client_version || "?")} · отчёт ${reportAge ?? 0} сек назад · ${esc(report.executable || "процесс определён")}</p>` : ""}</section>`;
  }
  if (report) {
    return `<section class="supreme-activity idle"><small>АКТИВНОСТЬ</small><div><span class="supreme-game-icon">${ico("game")}</span><span><b>Игра не распознана</b><em>Клиент на связи, но детектор вернул «нет игры»</em></span></div><p class="presence-debug">Клиент ${esc(report.client_version || "?")} · отчёт ${reportAge ?? 0} сек назад · detector=${esc(report.detector || "?")}</p></section>`;
  }
  return `<section class="supreme-activity idle"><small>АКТИВНОСТЬ</small><div><span class="supreme-game-icon">${ico("game")}</span><span><b>Сейчас не играет</b><em>Игровая активность не обнаружена</em></span></div></section>`;
}
const profilePersonCache = new Map<number, User>();
function refreshOpenProfileActivity(userId: number) {
  document.querySelectorAll<HTMLElement>(`.supreme-profile-menu[data-profile-user="${userId}"] [data-profile-activity]`).forEach((target) => {
    const person = userId === currentUser?.id ? currentUser : profilePersonCache.get(userId);
    if (person) target.innerHTML = profileActivityMarkup(person);
  });
}
function openUserProfileMenu(x: number, y: number, person: User) {
  closeAppContextMenu();
  profilePersonCache.set(person.id, person);
  if (Object.prototype.hasOwnProperty.call(person, "about")) profileAboutCache.set(person.id, String(person.about || ""));
  const menu = document.createElement("div");
  menu.className = `supreme-profile-menu ${person.global_role === "superadmin" ? "is-supreme" : "is-member"}`;
  if (person.id === currentUser?.id) void refreshOwnGameActivity();
  else void refreshRemoteGameActivities();
  const statusText = person.online ? "В сети" : "Не в сети";
  const roleText = memberRoleLabel(person);
  const loginChip = person.login ? `<span>@${esc(person.login)}</span>` : "";
  const cachedAbout = profileAboutCache.get(person.id) || person.about || "";
  const activityMarkup = profileActivityMarkup(person);
  menu.dataset.profileUser = String(person.id);
  menu.innerHTML = `<div class="supreme-profile-banner"></div><div class="supreme-profile-avatar avatar">${avatar(person)}${person.online ? "<i></i>" : ""}</div><div class="supreme-profile-body"><div class="supreme-profile-name"><b>${esc(person.name)}</b><span>${person.global_role === "superadmin" ? "✦ Самый главный" : esc(roleText)}</span></div><div class="profile-quick-meta"><span><i class="profile-dot ${person.online ? "online" : ""}"></i>${esc(statusText)}</span>${loginChip}<span>ID ${person.id}</span></div><div class="supreme-profile-divider"></div><div data-profile-activity>${activityMarkup}</div><section class="profile-about"><small>О СЕБЕ</small><p data-profile-about>${cachedAbout ? esc(cachedAbout) : "Пока ничего не рассказал о себе."}</p></section></div>`;
  if (!profileAboutCache.has(person.id)) {
    void loadProfileAbout(person.id).then((about) => {
      const target = menu.querySelector<HTMLElement>("[data-profile-about]");
      if (target && menu.isConnected) target.textContent = about || "Пока ничего не рассказал о себе.";
    });
  }
  menu.addEventListener("pointerdown", (event) => event.stopPropagation());
  document.body.append(menu);
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
  appContextMenu = menu;
  window.setTimeout(() => document.addEventListener("pointerdown", closeAppContextMenu, { once: true }), 0);
}
const dockMarkup = () =>
  activeVoiceChannel && activeVoiceMeta
    ? `<section class="voice-dock-app" id="voiceDockApp" data-connection="connected"><div class="voice-status-app"><span>${ico("signal")}</span><div><b id="voiceConnectionLabel">Голосовая связь подключена</b><small><span>${esc(activeVoiceMeta.name)} / ${esc(activeVoiceMeta.serverName)}</span><time data-voice-duration>${voiceDurationText()}</time></small></div><button id="voiceQuality" data-tooltip="Качество связи">${ico("signal")}</button><button id="voiceDockLeave" data-tooltip="Отключиться">${ico("phone-down")}</button></div><div class="voice-quality-popover" id="voiceQualityPopover" hidden data-level="good"><header><span><b>Качество связи</b><small>Соединение стабильно</small></span><i></i></header><div class="quality-metrics"><div><small>Задержка</small><b id="qualityPing">—</b></div><div><small>Канал</small><b>${activeVoiceMode === "p2p" ? "P2P mesh" : "LiveKit"}</b></div><div><small>Статус</small><b id="qualityState">Хорошо</b></div></div></div></section>`
    : "";
const SERVER_ORDER_KEY = "kitchat_server_order";
function orderedServers<T extends { id: number }>(servers: T[]): T[] {
  let order: number[] = [];
  try { order = JSON.parse(localStorage.getItem(SERVER_ORDER_KEY) || "[]"); } catch { order = []; }
  const rank = new Map(order.map((id, index) => [Number(id), index]));
  return [...servers].sort((a, b) => {
    const ar = rank.has(a.id) ? rank.get(a.id)! : Number.MAX_SAFE_INTEGER;
    const br = rank.has(b.id) ? rank.get(b.id)! : Number.MAX_SAFE_INTEGER;
    return ar - br;
  });
}
function saveServerOrder(ids: number[]) {
  localStorage.setItem(SERVER_ORDER_KEY, JSON.stringify(ids));
}
function memberSidebarRoleLabel(member: User) {
  return member.global_role === "superadmin" ? "Самый главный"
    : member.role === "owner" ? "Владелец"
    : member.role === "admin" ? "Администратор"
    : member.role === "moderator" ? "Модератор"
    : member.online ? "В сети" : "Не в сети";
}
function memberRows(members: User[]) {
  const online = members.filter((m) => !!m.online);
  const offline = members.filter((m) => !m.online);
  const row = (m: User) => `<div class="member ${m.online ? "online" : "offline"} ${m.global_role === "superadmin" ? "supreme" : ""}" data-person="${m.id}" data-person-name="${esc(m.name)}"><div class="avatar">${avatar(m)}<i></i></div><div><b>${esc(m.name)}</b><small>${esc(memberSidebarRoleLabel(m))}</small></div></div>`;
  return `${online.length ? `<div class="member-group-title">В сети — ${online.length}</div>${online.map(row).join("")}` : ""}${offline.length ? `<div class="member-group-title offline-title">Не в сети — ${offline.length}</div>${offline.map(row).join("")}` : ""}`;
}

async function shellView(serverId = 0, channelSlug = "", forceHome = false) {
  socialCleanup();
  activeFileDropHandler = null;
  dragDepth = 0;
  dropOverlay.classList.remove("show");
  void ensureAutostart();
  const currentRoom = document.querySelector<HTMLElement>(".call-screen");
  if (currentRoom && activeVoiceChannel) {
    // Не уничтожаем медиа-элементы звонка при переходе в текстовый канал.
    // Иначе WebView удаляет remote audio и собеседников перестаёт быть слышно.
    const remoteAudio = currentRoom.querySelector<HTMLElement>("#remoteAudio");
    if (remoteAudio) document.body.append(remoteAudio);
    activeVoiceRoom = currentRoom;
    currentRoom.remove();
  }
  const revision = ++viewRevision;
  const user = currentUser!;
  if (!app.querySelector(".app-shell")) app.innerHTML = loadingView();
  let state: CommunityState;
  try {
    state = await community({ server_id: serverId, channel: channelSlug });
    // desktop_auth.php may return a reduced user object without global_role.
    // community.php is authoritative for global permissions, so keep currentUser
    // in sync before starting private game-presence polling or opening profiles.
    if (currentUser) currentUser.global_role = state.me.global_role;
    state.voice.forEach((user) => voiceDirectory.set(user.id, user));
  } catch (error) {
    if (revision !== viewRevision) return;
    app.innerHTML = `<main class="loading-screen error">${esc(error instanceof Error ? error.message : "Ошибка загрузки")}</main>`;
    return;
  }
  if (revision !== viewRevision) return;
  const serverSignature = JSON.stringify(
    state.servers.map((server) => [server.id, server.name, server.icon]),
  );
  const channelSignature = JSON.stringify(state.channels.map((channel) => [channel.id, channel.slug, channel.name, channel.topic, channel.type, channel.voice_mode]));
  const memberSignature = JSON.stringify([...state.server_members].sort((a,b) => a.id-b.id).map((member) => [member.id, member.role, member.global_role]));
  const stickerSignature = JSON.stringify(state.stickers.map((sticker) => [sticker.id, sticker.name, sticker.path]));
  let messageCount = state.message_sync?.count ?? state.messages.length;
  let messageChanged = state.message_sync?.changed || "";
  state.people.filter((person) => person.friend_status === 0 && !person.sent_by_me).forEach((person) => void notifyAboutFriendRequest(person));
  const active = forceHome ? null : state.server;
  let dmState: DirectState = { threads: [] };
  try {
      const listing = await directMessages({ action: "list" });
      dmState.threads = listing.threads || [];
    if (!active) {
      if (homePane.kind === "dm" && homePane.userId) {
        const thread = await directMessages({ action: "thread", user_id: homePane.userId });
        dmState.messages = thread.messages || [];
      }
    }
  } catch (error) {
    console.warn("Direct messages unavailable", error);
  }
  if (revision !== viewRevision) return;
  const textChannels = state.channels.filter((c) => c.type === "text");
  const voiceChannels = state.channels.filter((c) => c.type === "voice");
  knownVoiceChannelIds = voiceChannels.map((channel) => channel.id);
  const visibleVoice = visibleVoicePresence(state.voice);
  const selected =
    textChannels.find((c) => c.slug === channelSlug) || textChannels[0];
  if (active && selected && selected.slug !== channelSlug) {
    void shellView(active.id, selected.slug);
    return;
  }
  const sortedServers = orderedServers(state.servers);
  const serverButtons = sortedServers
    .map(
      (s) =>
        `<button class="server ${active?.id === s.id ? "active" : ""}" data-server="${s.id}" draggable="false" title="${esc(s.name)}">${s.icon ? `<img src="${esc(assetUrl(s.icon))}" alt="" draggable="false">` : esc(s.name.slice(0, 2).toUpperCase())}</button>`,
    )
    .join("");
  const channelList = (list: Channel[], type: string) =>
    list
      .map((c) => {
        const users = visibleVoice.filter((v) => v.channel_id === c.id);
        const edit = c.can_edit
          ? `<i class="channel-manage" data-edit-channel="${c.id}" title="Настроить канал">${ico("edit")}</i>`
          : "";
        const connected = type === "voice" && c.id === activeVoiceChannel;
        const button = `<button class="channel ${selected?.id === c.id ? "active" : ""} ${connected ? "voice-connected" : ""}" ${type === "voice" ? `data-voice="${c.id}" data-voice-name="${esc(c.name)}" data-voice-mode="${"p2p"}"` : `data-channel="${esc(c.slug)}"`}><b>${type === "text" ? "#" : ico(connected ? "signal" : "mic")}</b><span>${esc(c.name)}<small>${type === "voice" ? `${users.length} в голосовом · ${"P2P"}` : esc(c.topic || "Текстовый канал")}</small></span>${connected ? `<time class="voice-channel-duration" data-voice-duration>${voiceDurationText()}</time>` : ""}${edit}</button>`;
        return type === "voice"
          ? `<div class="voice-channel-wrap">${button}<div class="voice-presence" data-channel-id="${c.id}">${users.map(voicePerson).join("")}</div></div>`
          : button;
      })
      .join("");
  const stickerPicker = selected
    ? `<div class="sticker-popover" id="stickerPopover" hidden><header><div><b>Стикеры</b><small>Стикеры этого сервера</small></div><label>＋ Добавить<input id="stickerUpload" type="file" accept="image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg" hidden></label></header><div class="sticker-grid">${state.stickers.length ? state.stickers.map((s) => `<button data-sticker="${s.id}" title="${esc(s.name)}"><img src="https://oliverkitchen.ru${esc(s.path)}" alt="${esc(s.name)}"><span>${esc(s.name)}</span></button>`).join("") : "<p>Добавьте первый JPG, PNG, WEBP или GIF-стикер</p>"}</div></div>`
    : "";
  const friends = state.people.filter((person) => person.friend_status === 1);
  const incomingRequests = state.people.filter((person) => person.friend_status === 0 && !person.sent_by_me);
  const friendById = new Map(friends.map((person) => [person.id, person]));
  const dmPeer = homePane.kind === "dm" && homePane.userId ? friendById.get(homePane.userId) : undefined;
  const dmThreadRows = dmState.threads.map((thread) => {
    const person = friendById.get(thread.peer_id);
    if (!person) return "";
    return `<button class="dm-thread ${homePane.kind === "dm" && homePane.userId === person.id ? "active" : ""}" type="button" data-dm-user="${person.id}"><div class="avatar">${avatar(person)}${person.online ? "<i></i>" : ""}</div><span><b>${esc(person.name)}</b><small>${esc(thread.last_message || "Начните переписку")}</small></span>${thread.unread ? `<em>${thread.unread}</em>` : ""}</button>`;
  }).filter(Boolean).join("");
  const dmMessages = (dmState.messages || []).map((message, index, messages) => {
    const mine = message.sender_id === user.id;
    const author = mine ? user : dmPeer;
    const previous = messages[index - 1];
    const previousTime = previous ? new Date(previous.created_at.replace(" ", "T")).getTime() : 0;
    const currentTime = new Date(message.created_at.replace(" ", "T")).getTime();
    const grouped = !!previous && previous.sender_id === message.sender_id && Number.isFinite(previousTime) && Number.isFinite(currentTime) && currentTime - previousTime >= 0 && currentTime - previousTime <= 7 * 60_000;
    const date = friendlyTime(message.created_at);
    const body = esc(message.message).replace(/(https?:\/\/[^\s<]+)/gi, '<a class="message-link" href="$1" target="_blank" rel="noopener noreferrer">$1</a>').replace(/\n/g, "<br>");
    const edited = message.edited_at ? `<small class="message-edited">изменено</small>` : "";
    const actions = mine ? `<div class="dm-message-actions"><button type="button" data-dm-edit="${message.id}" title="Редактировать">${ico("edit")}</button><button type="button" class="danger" data-dm-delete="${message.id}" title="Удалить">${ico("delete")}</button></div>` : "";
    return `<article class="dm-message ${grouped ? "message-continuation" : "message-start"}" data-dm-message-id="${message.id}" data-dm-message-owner="${mine ? "1" : "0"}" data-dm-message-text="${esc(message.message)}">${grouped ? `<time class="continuation-time" data-tooltip="${esc(date.full)}">${esc(date.short.replace(/^.*в /, ""))}</time>` : `<div class="avatar">${avatar(author || { name: "?" })}</div>`}<div class="dm-message-body">${grouped ? "" : `<header><b>${esc(mine ? user.name : (dmPeer?.name || "Пользователь"))}</b><time data-tooltip="${esc(date.full)}">${esc(date.short)}</time>${edited}</header>`}<div class="message-body"><p>${body}</p></div></div>${actions}</article>`;
  }).join("");
  const middle = !active
    ? homePane.kind === "dm" && dmPeer
      ? `<div class="dm-view"><header class="dm-header"><div class="avatar">${avatar(dmPeer)}${dmPeer.online ? "<i></i>" : ""}</div><div><b>${esc(dmPeer.name)}</b><small>${dmPeer.online ? "В сети" : "Не в сети"}</small></div></header><div class="dm-messages">${dmMessages || `<div class="dm-welcome"><div class="avatar">${avatar(dmPeer)}</div><h2>${esc(dmPeer.name)}</h2><p>Это начало вашей личной переписки.</p></div>`}</div><form class="composer dm-composer" id="dmMessageForm"><div class="composer-row"><div class="composer-box dm-composer-box"><textarea id="dmMessageInput" rows="1" maxlength="2000" placeholder="Написать ${esc(dmPeer.name)}">${esc(directMessageDrafts.get(dmPeer.id) || "")}</textarea></div><button class="send" type="submit" aria-label="Отправить">${ico("send")}</button></div></form></div>`
      : friendsView(state.people, homePane.kind === "requests" ? "incoming" : friendsFilter, avatar)
    : `<header><div class="channel-icon">#</div><div class="channel-heading"><b>${esc(selected?.name || active.name)}</b><small>${esc(selected?.topic || active.description || "")}</small></div><nav><button class="header-action ${localStorage.getItem("kitchat_notifications") === "0" ? "off" : "on"}" id="toggleNotifications" title="Уведомления">${ico(localStorage.getItem("kitchat_notifications") === "0" ? "bell-off" : "bell")}</button><button class="header-action" id="openFriends" title="Друзья">${ico("users")}</button><button class="header-action" id="focusMode" title="Режим фокуса">${ico("focus")}</button><button class="header-search" id="openSearch" title="Поиск"><span>Поиск</span>${ico("search")}</button></nav></header><div class="messages">${state.messages.length ? "" : `<div class="welcome"><span>#</span><h1>Добро пожаловать в #${esc(selected?.name || "")}</h1><p>${esc(selected?.topic || "Начало нового разговора.")}</p></div>`}${state.messages.map(messageMarkup).join("")}</div>${stickerPicker}${selected ? `<form class="composer" id="messageForm"><input id="messageFiles" type="file" multiple accept="image/jpeg,.jpg,.jpeg,image/*,video/*,audio/*,.pdf,.zip" hidden><div class="composer-queue" id="composerQueue" hidden></div><div class="composer-row"><div class="composer-box"><button id="attachButton" type="button" title="Прикрепить файл">+</button><textarea id="messageInput" rows="1" maxlength="2000" placeholder="Написать в #${esc(selected.name)}">${esc(channelMessageDrafts.get(`${active.id}:${selected.slug}`) || "")}</textarea><button id="stickerButton" type="button" title="Стикеры">${ico("smile")}</button></div><button class="send" type="submit" aria-label="Отправить">${ico("send")}</button></div></form>` : ""}`;
  const isSupreme = state.me.global_role === "superadmin";
  ensureGameActivityPolling();
  const canManageChannels = !!active && (isSupreme || ["owner", "admin"].includes(active.role || "member"));
  const canModerate = !!active && (isSupreme || ["owner", "admin", "moderator"].includes(active.role || "member"));
  const canManageServer = !!active && (isSupreme || ["owner", "admin"].includes(active.role || "member"));
  const canManageRoles = !!active && (isSupreme || active.role === "owner");
  const canDeleteServer = !!active && (isSupreme || active.owner_id === user.id);
  app.innerHTML = `<main class="app-shell ${active ? "" : "no-server"}"><nav class="rail"><button class="home active-home ${incomingRequests.length ? "has-notice" : ""}" id="homeStart" title="Главная"><img src="/kitchat-icon.png" alt="Kitchat">${incomingRequests.length ? `<em>${incomingRequests.length}</em>` : ""}</button><i></i>${serverButtons}<button class="add" id="createServer" title="Создать сервер">+</button><div class="rail-spacer"></div></nav><aside class="channels"><header><div><small>${active ? "СЕРВЕР" : "KITCHAT"}</small><b>${esc(active?.name || "Главная")}</b></div>${active && canManageServer ? `<button id="serverSettings" title="Настройки сервера">${ico("gear")}</button>` : ""}</header><div class="channel-scroll">${active ? `<div class="section"><span>ТЕКСТОВЫЕ КАНАЛЫ</span>${canManageChannels ? '<button data-create-channel="text" title="Создать текстовый канал">+</button>' : ""}</div>${channelList(textChannels, "text")}<div class="section voice-title"><span>ГОЛОСОВЫЕ КАНАЛЫ</span>${canManageChannels ? '<button data-create-channel="voice" title="Создать голосовой канал">+</button>' : ""}</div>${channelList(voiceChannels, "voice")}` : `<button class="home-nav-friends ${homePane.kind === "friends" ? "active" : ""}" type="button" id="homeFriends">${ico("users")}<span><b>Друзья</b><small>${friends.filter((p) => p.online).length} сейчас в сети</small></span></button><button class="home-nav-friends requests ${homePane.kind === "requests" ? "active" : ""}" type="button" id="homeRequests">${ico("bell")}<span><b>Заявки в друзья</b><small>${incomingRequests.length ? `${incomingRequests.length} новых` : "Новых заявок нет"}</small></span>${incomingRequests.length ? `<em>${incomingRequests.length}</em>` : ""}</button><section class="dm-sidebar-card"><div class="section dm-title"><span>ЛИЧНЫЕ СООБЩЕНИЯ</span><button type="button" id="homeNewDm" title="Новое сообщение">+</button></div><div class="dm-thread-list">${dmThreadRows || `<div class="dm-empty-hint">${ico("chat")}<b>Диалогов пока нет</b><small>Начните личную переписку с другом</small></div>`}</div></section>`}</div>${dockMarkup()}<section class="profile"><div class="avatar">${avatar(user)}<i></i></div><div><b>${esc(user.name)}</b><small>${isSupreme ? "Самый главный" : "В сети"}</small></div><button id="selfMute" class="${getVoicePreferences().muted ? "off" : ""}" aria-pressed="${getVoicePreferences().muted}" title="Микрофон">${ico("mic")}</button><button id="selfDeafen" class="${getVoicePreferences().deafened ? "off" : ""}" aria-pressed="${getVoicePreferences().deafened}" title="Наушники">${ico("headphones")}</button><button id="userSettings" title="Настройки">${ico("gear")}</button><button id="logout" title="Выйти">${ico("phone-down")}</button></section></aside><section class="chat">${middle}</section><aside class="members"><header><div><b>${active ? `Участники — ${state.server_members.length}` : `В сети — ${friends.filter((p) => p.online).length}`}</b></div>${active ? `<button id="membersFriends" title="Добавить друга">${ico("users")}</button>` : ""}</header>${active ? memberRows(state.server_members) : friends.filter((p) => p.online).map((p) => `<div class="member online" data-person="${p.id}"><div class="avatar">${avatar(p)}<i></i></div><div><b>${esc(p.name)}</b><small>В сети</small></div></div>`).join("") || `<p class="dm-right-empty">Никого из друзей сейчас нет в сети</p>`}</aside><div class="titlebar"><span>Kitchat</span><div><button>—</button><button>□</button><button>×</button></div></div></main>`;
  paintVoiceDuration();
  if (homePane.kind === "requests") friendsFilter = "incoming";
  const membersPanel = document.querySelector<HTMLElement>(".members")!;
  const presenceHealth = document.createElement("small");
  presenceHealth.className = "presence-health";
  presenceHealth.textContent = "Обновляем статусы…";
  membersPanel.querySelector("header > div")?.append(presenceHealth);
  const membersBody = document.createElement("div");
  membersBody.className = "members-list";
  [...membersPanel.children].filter(node => node.tagName !== "HEADER").forEach(node => membersBody.append(node));
  membersPanel.append(membersBody);
  membersPanel.addEventListener("click", event => {
    const node = (event.target as HTMLElement).closest<HTMLElement>(".member[data-person]");
    if (!node) return;
    const id = Number(node.dataset.person);
    const person = state.server_members.find(member => member.id === id) || state.people.find(person => person.id === id);
    if (person) openUserProfileMenu(event.clientX, event.clientY, { ...person, login: "login" in person ? person.login : "" });
  });
  const paintFriends = () => {
    const list = document.querySelector<HTMLElement>(".social-hub .home-friends-list");
    if (list) {
      const markup = friendRows(state.people, friendsFilter, friendsQuery, avatar);
      if (list.innerHTML !== markup) list.innerHTML = markup;
    }
    document.querySelectorAll<HTMLButtonElement>("[data-friends-filter]").forEach(button => {
      const selected = button.dataset.friendsFilter === friendsFilter;
      button.classList.toggle("active", selected); button.setAttribute("aria-selected", String(selected));
      const count = button.querySelector("[data-friends-count]");
      if (count) count.textContent = String(selectFriends(state.people, button.dataset.friendsFilter as FriendFilter).length);
    });
    const count = document.querySelector("#friendsListCount");
    if (count) count.textContent = `${selectFriends(state.people, friendsFilter, friendsQuery).length} в списке`;
  };
  const friendInput = document.querySelector<HTMLInputElement>("#friendsFilter");
  if (friendInput) { friendInput.value = friendsQuery; friendInput.oninput = () => { friendsQuery = friendInput.value; paintFriends(); }; }
  const ownId = document.querySelector(".social-footer b"); if (ownId) ownId.textContent = String(user.id);
  paintFriends();
  let currentSocialSignature = "";
  let syncBusy = false, syncStopped = false, socialTimer = 0, socialRefreshRequested = false;
  let socialAbort: AbortController | null = null;
  const syncSocial = async () => {
    if (syncStopped || revision !== viewRevision || !currentUser) return;
    if (syncBusy) { socialRefreshRequested = true; return; }
    syncBusy = true;
    socialAbort = new AbortController();
    const timeout = window.setTimeout(() => socialAbort?.abort(), 10_000);
    try {
      const signal = socialAbort.signal;
      const fresh = await socialSnapshotClient.load<CommunityState>(async () => {
        const primaryAbort = new AbortController();
        const cancelPrimary = () => primaryAbort.abort();
        signal.addEventListener("abort", cancelPrimary, { once: true });
        const primaryTimeout = window.setTimeout(cancelPrimary, 3500);
        try {
          const response = await fetch(`${API}/community_social.php?server_id=${active?.id || 0}`, {
            headers: token() ? {Authorization: `Bearer ${token()}`} : {}, signal: primaryAbort.signal, cache: "no-store",
          });
          if (!response.ok) throw new Error(`Presence HTTP ${response.status}`);
          const snapshot = await response.json();
          if (!snapshot.ok) throw new Error("Presence unavailable");
          return snapshot;
        } finally { clearTimeout(primaryTimeout); signal.removeEventListener("abort", cancelPrimary); }
      }, () => community({ server_id: active?.id || 0 }, undefined, signal), signal);
      if (syncStopped || revision !== viewRevision) return;
      const signature = socialSignature(fresh.people) + JSON.stringify(fresh.server_members);
      const status = document.querySelector<HTMLElement>("#socialSync");
      if (status) { status.innerHTML = '<i></i>Синхронизировано'; status.classList.remove("stale"); }
      presenceHealth.textContent = "Статусы обновлены"; presenceHealth.classList.remove("stale");
      state.people = fresh.people; state.server_members = fresh.server_members;
      state.people.filter(person => person.friend_status === 0 && !person.sent_by_me).forEach(person => void notifyAboutFriendRequest(person));
      if (signature === currentSocialSignature) return;
      currentSocialSignature = signature;
      paintFriends();
      const online = state.people.filter(person => person.friend_status === 1 && person.online);
      const incoming = state.people.filter(person => person.friend_status === 0 && !person.sent_by_me);
      const header = membersPanel.querySelector("header b");
      if (header) header.textContent = active ? `Участники — ${state.server_members.length}` : `В сети — ${online.length}`;
      membersBody.innerHTML = active ? memberRows(state.server_members) : memberRows(online.map(person => ({ ...person, login: "" }))) || '<p class="dm-right-empty">Друзья появятся здесь, когда будут в сети.</p>';
      const homeCount = document.querySelector("#homeFriends small"); if (homeCount) homeCount.textContent = `${online.length} сейчас в сети`;
      const requestCount = document.querySelector("#homeRequests small"); if (requestCount) requestCount.textContent = incoming.length ? `${incoming.length} новых` : "Новых заявок нет";
      for (const selector of ["#homeStart", "#homeRequests"]) {
        const button = document.querySelector(selector); if (!button) continue;
        button.querySelector("em")?.remove(); button.classList.toggle("has-notice", incoming.length > 0);
        if (incoming.length) button.insertAdjacentHTML("beforeend", `<em>${incoming.length}</em>`);
      }
      // Update identities without touching message history, drafts, focus or call media.
      document.querySelectorAll<HTMLElement>(".dm-thread[data-dm-user]").forEach(row => {
        const person = state.people.find(person => person.id === Number(row.dataset.dmUser));
        row.hidden = !person || person.friend_status !== 1;
        if (!person) return;
        const name = row.querySelector("b"); if (name) name.textContent = person.name;
        const face = row.querySelector(".avatar"); if (face) face.innerHTML = avatar(person) + (person.online ? '<i></i>' : '');
      });
      if (homePane.kind === "dm") {
        const peer = state.people.find(person => person.id === homePane.userId);
        const header = document.querySelector(".dm-header");
        if (header) {
          const status = header.querySelector("small"); if (status) status.textContent = peer?.online ? "В сети" : "Не в сети";
          const name = header.querySelector("b"); if (name && peer) name.textContent = peer.name;
          const face = header.querySelector(".avatar"); if (face && peer) face.innerHTML = avatar(peer) + (peer.online ? '<i></i>' : '');
        }
      }
    } catch {
      if (syncStopped || revision !== viewRevision) return;
      const status = document.querySelector<HTMLElement>("#socialSync");
      if (status) { status.textContent = "Нет связи · повторяем…"; status.classList.add("stale"); }
      presenceHealth.textContent = "Нет связи · данные могут устареть"; presenceHealth.classList.add("stale");
    } finally {
      clearTimeout(timeout); socialAbort = null; syncBusy = false;
      if (socialRefreshRequested && !syncStopped && revision === viewRevision) { socialRefreshRequested = false; void syncSocial(); }
    }
  };
  const socialLoop = async () => { await syncSocial(); if (!syncStopped && revision === viewRevision) socialTimer = window.setTimeout(socialLoop, 3000); };
  const wakeSocial = () => { if (!document.hidden) void syncSocial(); };
  window.addEventListener("focus", wakeSocial); window.addEventListener("online", wakeSocial); document.addEventListener("visibilitychange", wakeSocial);
  socialTimer = window.setTimeout(socialLoop, 300);
  socialCleanup = () => { syncStopped = true; clearTimeout(socialTimer); socialAbort?.abort(); window.removeEventListener("focus",wakeSocial); window.removeEventListener("online",wakeSocial); document.removeEventListener("visibilitychange",wakeSocial); };
  document.querySelector<HTMLElement>(".social-hub")?.addEventListener("click", async event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!button || button.disabled) return;
    if (button.dataset.friendsFilter) {
      friendsFilter = button.dataset.friendsFilter as FriendFilter;
      homePane = {kind: friendsFilter === "incoming" ? "requests" : "friends"}; paintFriends(); return;
    }
    if (button.dataset.socialDm) { homePane = {kind:"dm",userId:Number(button.dataset.socialDm)}; await shellView(0,"",true); return; }
    const mode = button.dataset.socialAction;
    const id = Number(button.dataset.user);
    if (!mode || !id) return;
    if (mode === "remove" && !(await appConfirm("Удалить из друзей", "Личная переписка сохранится. Удалить друга?", true))) return;
    button.disabled = true;
    try {
      await community({}, {action:"friend",user_id:id,mode});
      await syncSocial();
      showAppNotice("Друзья", mode === "accept" ? "Заявка принята" : mode === "cancel" ? "Заявка отменена" : mode === "reject" ? "Заявка отклонена" : "Друг удалён");
    } catch (error) { await appAlert(error instanceof Error ? error.message : "Не удалось выполнить действие"); }
    finally { if (button.isConnected) button.disabled = false; }
  });

  const messageList = document.querySelector<HTMLElement>(".messages");
  let newMessagesButton: HTMLButtonElement | null = null;
  if (messageList) {
    newMessagesButton = document.createElement("button");
    newMessagesButton.type = "button";
    newMessagesButton.className = "new-messages-button";
    newMessagesButton.hidden = true;
    newMessagesButton.textContent = "Новые сообщения ↓";
    newMessagesButton.onclick = () => { messageList.scrollTo({ top: messageList.scrollHeight, behavior: "smooth" }); newMessagesButton!.hidden = true; };
    document.querySelector<HTMLElement>(".chat")?.append(newMessagesButton);
    messageList.addEventListener("scroll", () => {
      if (messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 120 && newMessagesButton) newMessagesButton.hidden = true;
    });
    requestAnimationFrame(() => { messageList.scrollTop = messageList.scrollHeight; });
  }
  document.querySelector('.rail button[data-tooltip="Загрузки"],.rail button[title="Загрузки"]')?.remove();
  if (active) {
    const header = document.querySelector<HTMLElement>(".channels > header")!;
    header.innerHTML = `<button class="server-menu-toggle" id="serverMenuToggle"><span><small>СЕРВЕР</small><b>${esc(active.name)}</b></span>${ico("chevron-down")}</button><div class="server-dropdown" id="serverDropdown" hidden><div class="server-dropdown-about"><b>${esc(active.name)}</b>${active.description ? `<p>${esc(active.description)}</p>` : "<p>Описание сервера пока не добавлено</p>"}</div>${canManageServer ? `<button id="serverSettings">${ico("gear")}Настройки сервера</button>` : ""}<button id="serverInviteMenu">${ico("users")}Пригласить друзей</button><button id="copyServerInvite">${ico("link")}Скопировать ссылку</button>${canManageServer && selected ? `<button id="clearChannel">${ico("delete")}Очистить канал</button>` : ""}${active.owner_id !== user.id && !isSupreme ? `<button class="danger" id="serverLeave">${ico("phone-down")}Выйти с сервера</button>` : ""}</div>`;
    const toggle = header.querySelector<HTMLButtonElement>("#serverMenuToggle")!;
    const dropdown = header.querySelector<HTMLElement>("#serverDropdown")!;
    toggle.onclick = (event) => { event.stopPropagation(); dropdown.hidden = !dropdown.hidden; toggle.classList.toggle("open", !dropdown.hidden); };
    document.addEventListener("pointerdown", (event) => { if (revision === viewRevision && !header.contains(event.target as Node)) { dropdown.hidden = true; toggle.classList.remove("open"); } });
  }
  const win = getCurrentWindow();
  document
    .querySelectorAll<HTMLButtonElement>(".titlebar button")
    .forEach(
      (button, index) =>
        (button.onclick = () =>
          index === 0
            ? win.minimize()
            : index === 1
              ? win.toggleMaximize()
              : win.close()),
    );
  document.querySelector<HTMLButtonElement>("#focusMode")?.addEventListener("click", () => {
    document.querySelector<HTMLElement>(".app-shell")?.classList.toggle("focus-mode");
  });
  document.querySelector<HTMLButtonElement>("#toggleNotifications")?.addEventListener("click", async () => {
    const enabled = localStorage.getItem("kitchat_notifications") !== "0";
    if (enabled) {
      localStorage.setItem("kitchat_notifications", "0");
      showAppNotice("Уведомления выключены", "Новые сообщения больше не будут отвлекать", "warning");
    } else {
      localStorage.setItem("kitchat_notifications", "1");
      notificationPermissionRequest = null;
      const granted = await ensureNotificationPermission();
      if (!granted) { await appAlert("Разрешение на системные уведомления не предоставлено."); return; }
      showAppNotice("Уведомления включены", "Сообщим о новых сообщениях и заявках", "success");
    }
    await shellView(active?.id || 0, selected?.slug || "");
  });
  document.querySelector<HTMLButtonElement>("#openSearch")?.addEventListener("click", () => {
    const results = (query: string) => state.messages
      .filter((message) => `${message.name} ${message.message}`.toLowerCase().includes(query.toLowerCase()))
      .slice(-30)
      .map((message) => `<button type="button" data-search-message="${message.id}"><b>${esc(message.name)}</b><small>${esc(message.message || "Вложение")}</small></button>`).join("") || "<p>Ничего не найдено</p>";
    const layer = modal("Поиск в канале", `<div class="friend-search">${ico("search")}<input id="channelSearch" placeholder="Поиск сообщений" autocomplete="off"></div><div class="search-results">${results("")}</div>`, "Закрыть", async () => {});
    const input = layer.querySelector<HTMLInputElement>("#channelSearch")!;
    const list = layer.querySelector<HTMLElement>(".search-results")!;
    input.addEventListener("input", () => { list.innerHTML = results(input.value.trim()); });
    list.addEventListener("click", (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>("[data-search-message]");
      const message = item && document.querySelector<HTMLElement>(`[data-message-id="${item.dataset.searchMessage}"]`);
      if (message) { message.scrollIntoView({ behavior: "smooth", block: "center" }); message.classList.add("search-hit"); window.setTimeout(() => message.classList.remove("search-hit"), 1200); }
      layer.querySelector<HTMLButtonElement>(".modal-close")?.click();
    });
  });
  document.querySelector<HTMLButtonElement>("#homeStart")?.addEventListener("click", () => {
    homePane = { kind: "friends" };
    void shellView(0, "", true);
  });
  document.querySelector<HTMLButtonElement>("#homeFriends")?.addEventListener("click", () => { homePane = { kind: "friends" }; void shellView(0, "", true); });
  document.querySelector<HTMLButtonElement>("#homeRequests")?.addEventListener("click", () => { homePane = { kind: "requests" }; void shellView(0, "", true); });
  document.querySelector<HTMLButtonElement>("#friendsTabAll")?.addEventListener("click", () => { homePane = { kind: "friends" }; void shellView(0, "", true); });
  document.querySelector<HTMLButtonElement>("#friendsTabRequests")?.addEventListener("click", () => { homePane = { kind: "requests" }; void shellView(0, "", true); });
  document.querySelectorAll<HTMLButtonElement>("[data-dm-user],[data-message-friend]").forEach((button) => button.addEventListener("click", () => { const id = Number(button.dataset.dmUser || button.dataset.messageFriend || 0); if (!id) return; homePane = { kind: "dm", userId: id }; void shellView(0, "", true); }));
  document.querySelector<HTMLElement>(".social-hub")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-social-add]");
    if (button) friendsModal(0, () => void syncSocial(), state.people, false);
  });
  const openFriendPicker = () => friendsModal(0, () => void syncSocial(), state.people, false);
  document.querySelector<HTMLButtonElement>("#homeAddFriend")?.addEventListener("click", openFriendPicker);
  document.querySelector<HTMLButtonElement>("#homeAddFriendSecondary")?.addEventListener("click", openFriendPicker);
  document.querySelector<HTMLButtonElement>("#homeAddFriendEmpty")?.addEventListener("click", openFriendPicker);
  document.querySelector<HTMLButtonElement>("#homeCreateServer")?.addEventListener("click", () => document.querySelector<HTMLButtonElement>("#createServer")?.click());
  document.querySelector<HTMLButtonElement>("#homeNewDm")?.addEventListener("click", async () => {
    friendsFilter = "all"; friendsQuery = ""; homePane = { kind: "friends" };
    await shellView(0, "", true);
    document.querySelector<HTMLInputElement>("#friendsFilter")?.focus();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-friend-request]").forEach((button) => button.addEventListener("click", async () => {
    const id = Number(button.dataset.user || 0);
    if (!id) return;
    button.disabled = true;
    try {
      const accepted = button.dataset.friendRequest === "accept";
      const person = state.people.find((item) => item.id === id);
      await community({}, { action: "friend", user_id: id, mode: button.dataset.friendRequest || "reject" });
      showAppNotice(accepted ? "Заявка принята" : "Заявка отклонена", accepted ? `${person?.name || "Пользователь"} теперь в списке друзей` : "Запрос удалён", accepted ? "success" : "message");
      await shellView(0, "", true);
    } catch (error) {
      button.disabled = false;
      appAlert(error instanceof Error ? error.message : "Не удалось обработать заявку");
    }
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-remove-friend]").forEach((button) => button.addEventListener("click", async () => {
    const id = Number(button.dataset.removeFriend || 0); if (!id) return;
    const person = state.people.find((p) => p.id === id);
    if (!(await appConfirm("Удалить из друзей", `Удалить ${person?.name || "пользователя"} из друзей?`, true))) return;
    await community({}, { action: "friend", user_id: id, mode: "remove" });
    if (homePane.kind === "dm" && homePane.userId === id) homePane = { kind: "friends" };
    await shellView(0, "", true);
  }));
  const editDirectMessage = async (messageId: number, text: string) => {
    if (!messageId) return;
    modal("Редактировать сообщение", `<label>Текст сообщения<textarea name="message" maxlength="2000" required>${esc(text)}</textarea></label>`, "Сохранить", async (form) => {
      const value = String(new FormData(form).get("message") || "").trim();
      if (!value) throw new Error("Сообщение не может быть пустым");
      await directMessages({}, { action: "edit", id: messageId, message: value });
      await shellView(0, "", true);
    });
  };
  const deleteDirectMessage = async (messageId: number) => {
    if (!messageId) return;
    if (!(await appConfirm("Удалить сообщение", "Сообщение будет удалено у вас и у собеседника без возможности восстановления.", true))) return;
    try {
      await directMessages({}, { action: "delete", id: messageId });
      await shellView(0, "", true);
    } catch (error) {
      appAlert(error instanceof Error ? error.message : "Не удалось удалить сообщение");
    }
  };
  document.querySelectorAll<HTMLButtonElement>("[data-dm-edit]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const item = button.closest<HTMLElement>("[data-dm-message-id]");
    void editDirectMessage(Number(button.dataset.dmEdit || 0), item?.dataset.dmMessageText || "");
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-dm-delete]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    void deleteDirectMessage(Number(button.dataset.dmDelete || 0));
  }));
  document.querySelectorAll<HTMLElement>("[data-dm-message-id]").forEach((item) => item.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const id = Number(item.dataset.dmMessageId || 0);
    const text = item.dataset.dmMessageText || "";
    const mine = item.dataset.dmMessageOwner === "1";
    const actions: ContextItem[] = [{ label: "Копировать текст", action: () => void navigator.clipboard?.writeText(text) }];
    if (mine) {
      actions.push({ label: "Редактировать", action: () => editDirectMessage(id, text) });
      actions.push({ label: "Удалить сообщение", danger: true, action: () => deleteDirectMessage(id) });
    }
    openAppContextMenu(event.clientX, event.clientY, actions);
  }));
  const dmForm = document.querySelector<HTMLFormElement>("#dmMessageForm");
  if (dmForm && homePane.kind === "dm" && homePane.userId) {
    const dmInput = dmForm.querySelector<HTMLTextAreaElement>("#dmMessageInput")!;
    dmInput.addEventListener("input", () => directMessageDrafts.set(homePane.userId!, dmInput.value));
    dmForm.addEventListener("submit", async (event) => {
      event.preventDefault(); const message = dmInput.value.trim(); if (!message) return;
      const targetId = homePane.userId!; dmInput.disabled = true;
      try { await directMessages({}, { action: "send", user_id: targetId, message }); directMessageDrafts.delete(targetId); dmInput.value = ""; playSound("send"); await shellView(0, "", true); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#dmMessageInput")?.focus()); }
      catch (error) { appAlert(error instanceof Error ? error.message : "Не удалось отправить сообщение"); }
      finally { dmInput.disabled = false; }
    });
    dmInput.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); dmForm.requestSubmit(); } });
    const dmBox = document.querySelector<HTMLElement>(".dm-messages"); if (dmBox) requestAnimationFrame(() => { dmBox.scrollTop = dmBox.scrollHeight; });
    const dmPollPeerId = homePane.userId;
    const pollDirectThread = async () => {
      if (revision !== viewRevision || homePane.kind !== "dm" || homePane.userId !== dmPollPeerId) return;
      try {
        const fresh = await directMessages({ action: "thread", user_id: dmPollPeerId });
        const currentIds = new Set((dmState.messages || []).map((message) => message.id));
        const incoming = (fresh.messages || []).filter((message) => !currentIds.has(message.id) && message.sender_id !== currentUser?.id);
        if (incoming.length) void notifyAboutDirectMessage(dmPeer, incoming[incoming.length - 1]);
        const ids = (fresh.messages || []).map((m) => `${m.id}:${m.read_at || ""}:${m.edited_at || ""}:${m.message}`).join(",");
        const current = (dmState.messages || []).map((m) => `${m.id}:${m.read_at || ""}:${m.edited_at || ""}:${m.message}`).join(",");
        if (ids !== current) { void shellView(0, "", true); return; }
      } catch {}
      window.setTimeout(pollDirectThread, 1800);
    };
    window.setTimeout(pollDirectThread, 1800);
  }
  document.querySelectorAll<HTMLButtonElement>("[data-home-server]").forEach((button) => {
    button.addEventListener("click", () => void shellView(Number(button.dataset.homeServer || 0), ""));
  });
  const directUnreadBaseline = new Map(dmState.threads.map((thread) => [thread.peer_id, thread.unread || 0]));
  const pollDirectNotifications = async () => {
    if (revision !== viewRevision) return;
    try {
      const fresh = await directMessages({ action: "list" });
      const threads = fresh.threads || [];
      for (const thread of threads) {
        const unread = thread.unread || 0;
        if (unread > (directUnreadBaseline.get(thread.peer_id) || 0) && !(homePane.kind === "dm" && homePane.userId === thread.peer_id)) {
          void notifyAboutDirectThread(state.people.find((person) => person.id === thread.peer_id), thread);
        }
        directUnreadBaseline.set(thread.peer_id, unread);
      }
      const changed = threads.map((thread) => `${thread.peer_id}:${thread.updated_at}:${thread.unread || 0}`).join("|") !== dmState.threads.map((thread) => `${thread.peer_id}:${thread.updated_at}:${thread.unread || 0}`).join("|");
      if (!active && changed && homePane.kind !== "dm") { void shellView(0, "", true); return; }
    } catch {}
    window.setTimeout(pollDirectNotifications, 3000);
  };
  window.setTimeout(pollDirectNotifications, 3000);

  // Reorder the actual DOM nodes while the pointer moves. This is more reliable
  // in WebView2 than HTML drag/drop and gives immediate visual feedback.
  const railServerButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".rail [data-server]"));
  let serverDrag: {
    id: number;
    pointerId: number;
    startY: number;
    button: HTMLButtonElement;
    moved: boolean;
    originalOrder: number[];
    ghost?: HTMLButtonElement;
  } | null = null;
  let suppressServerClickId = 0;

  const clearServerDropHints = () => {
    document.querySelectorAll(".rail .server.drop-before,.rail .server.drop-after,.rail .server.pointer-dragging")
      .forEach((node) => node.classList.remove("drop-before", "drop-after", "pointer-dragging"));
  };

  const moveServerDrag = (event: PointerEvent) => {
    const drag = serverDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.abs(event.clientY - drag.startY) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.button.classList.add("pointer-dragging");
      drag.ghost = drag.button.cloneNode(true) as HTMLButtonElement;
      drag.ghost.className = "server server-drag-ghost";
      drag.ghost.removeAttribute("data-server");
      document.body.append(drag.ghost);
      document.body.classList.add("reordering-servers");
    }
    event.preventDefault();
    if (drag.ghost) {
      drag.ghost.style.left = `${event.clientX}px`;
      drag.ghost.style.top = `${event.clientY}px`;
    }
    const candidates = Array.from(document.querySelectorAll<HTMLButtonElement>(".rail [data-server]"))
      .filter((candidate) => candidate !== drag.button);
    const insertBefore = candidates.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    document.querySelectorAll(".rail .server.drop-before,.rail .server.drop-after")
      .forEach((node) => node.classList.remove("drop-before", "drop-after"));
    if (insertBefore) {
      insertBefore.classList.add("drop-before");
      insertBefore.parentElement?.insertBefore(drag.button, insertBefore);
    } else {
      const last = candidates[candidates.length - 1];
      last?.classList.add("drop-after");
      document.querySelector(".rail")?.insertBefore(drag.button, document.querySelector("#createServer"));
    }
  };
  const finishServerDrag = (event: PointerEvent, persist = true) => {
    const drag = serverDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    serverDrag = null;
    try { drag.button.releasePointerCapture?.(event.pointerId); } catch {}
    document.removeEventListener("pointermove", moveServerDrag);
    document.removeEventListener("pointerup", finishServerDrag);
    document.removeEventListener("pointercancel", cancelServerDrag);
    document.body.classList.remove("reordering-servers");
    drag.ghost?.remove();
    clearServerDropHints();
    if (!drag.moved) return;
    event.preventDefault();
    suppressServerClickId = drag.id;
    if (persist) {
      saveServerOrder(Array.from(document.querySelectorAll<HTMLButtonElement>(".rail [data-server]"))
        .map((node) => Number(node.dataset.server || 0)).filter(Boolean));
    }
    window.setTimeout(() => { suppressServerClickId = 0; }, 120);
  };
  const cancelServerDrag = (event: PointerEvent) => {
    if (!serverDrag || serverDrag.pointerId !== event.pointerId) return;
    const moved = serverDrag.moved;
    const originalOrder = serverDrag.originalOrder;
    finishServerDrag(event, false);
    if (moved) {
      saveServerOrder(originalOrder);
      void shellView(active?.id || 0, selected?.slug || "", !active);
    }
  };
  railServerButtons.forEach((button) => {
    button.draggable = false;
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const id = Number(button.dataset.server || 0);
      if (!id) return;
      serverDrag = {
        id,
        pointerId: event.pointerId,
        startY: event.clientY,
        button,
        moved: false,
        originalOrder: railServerButtons.map((node) => Number(node.dataset.server || 0)).filter(Boolean),
      };
      button.setPointerCapture?.(event.pointerId);
      document.addEventListener("pointermove", moveServerDrag, { passive: false });
      document.addEventListener("pointerup", finishServerDrag);
      document.addEventListener("pointercancel", cancelServerDrag);
    });
  });

  document
    .querySelectorAll<HTMLButtonElement>("[data-server]")
    .forEach(
      (b) => (b.onclick = () => {
        const clickedServerId = Number(b.dataset.server || 0);
        if (suppressServerClickId && clickedServerId === suppressServerClickId) return;
        if (clickedServerId === active?.id) return;
        document.querySelectorAll("[data-server]").forEach((node) => node.classList.remove("active"));
        b.classList.add("active");
        document.querySelector<HTMLElement>(".chat")?.classList.add("navigating");
        void shellView(clickedServerId, "");
      }),
    );
  document.addEventListener("contextmenu", (event) => {
    if (revision !== viewRevision) return;
    event.preventDefault();
    const target = event.target as HTMLElement;
    const voiceTarget = target.closest<HTMLElement>("[data-voice-person],[data-livekit-user],[data-p2p-user]");
    const message = target.closest<HTMLElement>("[data-message-id]");
    const stickerButton = target.closest<HTMLElement>("[data-sticker]");
    const serverButton = target.closest<HTMLButtonElement>("[data-server]");
    const person = target.closest<HTMLElement>("[data-person]");
    if (voiceTarget && active) {
      const personId = Number(voiceTarget.dataset.voicePerson || voiceTarget.dataset.livekitUser || voiceTarget.dataset.p2pUser);
      if (personId && personId !== user.id) {
        const voiceUser = voiceDirectory.get(personId);
        const member = state.server_members.find((item) => item.id === personId);
        const voiceChannelId = Number(voiceTarget.closest<HTMLElement>("[data-channel-id]")?.dataset.channelId || voiceUser?.channel_id || activeVoiceChannel || 0);
        openVoiceUserMenu(event.clientX, event.clientY, { ...(member || voiceUser || { id: personId, name: "Участник" }), login: "" }, voiceChannelId, canModerate, active.id, () => shellView(active.id, selected?.slug || ""));
        return;
      }
    }
    if (message) {
      const author = message.dataset.messageAuthor || "пользователь";
      const text = message.dataset.messageText || message.querySelector("p")?.textContent || "";
      const messageId = Number(message.dataset.messageId);
      const messageOwner = Number(message.dataset.messageUser) === user.id;
      const items: ContextItem[] = [
        { label: "Ответить", action: () => { const input = document.querySelector<HTMLTextAreaElement>("#messageInput"); if (input) { input.value = `@${author}, `; input.focus(); input.dispatchEvent(new Event("input")); } } },
        { label: "Копировать текст", action: () => void navigator.clipboard?.writeText(text) },
      ];
      if (messageOwner && text) items.push({ label: "Редактировать", action: () => { modal("Редактировать сообщение", `<label>Текст сообщения<textarea name="message" maxlength="2000" required>${esc(text)}</textarea></label>`, "Сохранить", async (form) => { await community({}, { action: "edit_message", id: messageId, message: String(new FormData(form).get("message") || "") }); await shellView(active?.id || 0, selected?.slug || ""); }); } });
      if (messageOwner || canModerate) items.push({ label: "Удалить сообщение", danger: true, action: async () => { if (await appConfirm("Удалить сообщение", "Сообщение и прикреплённый файл будут удалены без возможности восстановления.", true)) { await community({}, { action: "delete_message", id: messageId }); await shellView(active?.id || 0, selected?.slug || ""); } } });
      const stickerId = Number(message.querySelector<HTMLElement>("[data-sticker-id]")?.dataset.stickerId || 0);
      const sticker = state.stickers.find((item) => item.id === stickerId);
      if (sticker && (sticker.user_id === user.id || canManageServer)) items.push({ label: "Удалить стикер с сервера", danger: true, action: async () => { if (await appConfirm("Удалить стикер", "Стикер и сообщения с ним будут удалены.", true)) { await community({}, { action: "delete_sticker", sticker_id: sticker.id }); await shellView(active?.id || 0, selected?.slug || ""); } } });
      openAppContextMenu(event.clientX, event.clientY, items);
      return;
    }
    if (stickerButton && active) {
      const sticker = state.stickers.find((item) => item.id === Number(stickerButton.dataset.sticker));
      if (sticker && (sticker.user_id === user.id || canManageServer)) {
        openAppContextMenu(event.clientX, event.clientY, [{ label: "Удалить стикер с сервера", danger: true, action: async () => { if (await appConfirm("Удалить стикер", "Стикер и отправленные с ним сообщения будут удалены.", true)) { await community({}, { action: "delete_sticker", sticker_id: sticker.id }); await shellView(active.id, selected?.slug || ""); } } }]);
        return;
      }
    }
    if (serverButton) {
      const id = Number(serverButton.dataset.server);
      const server = state.servers.find((item) => item.id === id);
      const items: ContextItem[] = [{ label: id === active?.id ? "Открыт этот сервер" : "Открыть сервер", action: () => { if (id !== active?.id) void shellView(id, ""); } }];
      if (id === active?.id) {
        items.push({ label: "Настройки сервера", action: () => document.querySelector<HTMLButtonElement>("#serverSettings")?.click() });
        items.push({ label: "Пригласить друзей", action: () => document.querySelector<HTMLButtonElement>("#serverInviteMenu")?.click() });
        if (server?.owner_id !== user.id) items.push({ label: "Выйти с сервера", danger: true, action: () => document.querySelector<HTMLButtonElement>("#serverLeave")?.click() });
      }
      openAppContextMenu(event.clientX, event.clientY, items);
      return;
    }
    if (person) {
      const personId = Number(person.dataset.person);
      const member = state.server_members.find((item) => item.id === personId);
      if (active && member && personId !== user.id) {
        const voiceUser = state.voice.find((item) => item.id === personId);
        openVoiceUserMenu(event.clientX, event.clientY, { ...member, login: "" }, voiceUser?.channel_id || 0, canModerate, active.id, () => shellView(active.id, selected?.slug || ""));
        return;
      }
      const friend = state.people.find((item) => item.id === personId && item.friend_status === 1);
      if (!friend) return;
      const items: ContextItem[] = [];
      if (active && canManageServer && !state.server_members.some((member) => member.id === personId)) items.push({ label: "Пригласить на сервер", action: async () => { await community({}, { action: "add_member", server_id: active.id, user_id: personId }); await shellView(active.id, selected?.slug || ""); } });
      items.push({ label: "Удалить из друзей", danger: true, action: async () => { await community({}, { action: "friend", user_id: personId, mode: "remove" }); await shellView(active?.id || 0, selected?.slug || ""); } });
      openAppContextMenu(event.clientX, event.clientY, items);
      return;
    }
    closeAppContextMenu();
  });
  document
    .querySelectorAll<HTMLButtonElement>("[data-channel]")
    .forEach(
      (b) =>
        (b.onclick = () => void shellView(active!.id, b.dataset.channel || "")),
    );
  document.querySelectorAll<HTMLElement>("[data-edit-channel]").forEach(
    (button) =>
      (button.onclick = (event) => {
        event.stopPropagation();
        const channel = state.channels.find(
          (item) => item.id === Number(button.dataset.editChannel),
        );
        if (!channel || !active) return;
        modal(
          "Управление каналом",
          `<p>${channel.type === "voice" ? "Голосовой" : "Текстовый"} канал</p><label>Название<input name="name" maxlength="60" value="${esc(channel.name)}" required></label><label>Описание<input name="topic" maxlength="180" value="${esc(channel.topic)}" placeholder="О чём этот канал"></label><button class="danger-action" type="button" data-delete-channel="${channel.id}" data-delete-channel-server="${active.id}">Удалить канал</button>`,
          "Сохранить",
          async (form) => {
            const values = new FormData(form);
            await community(
              {},
              {
                action: "update_channel",
                id: channel.id,
                name: String(values.get("name") || ""),
                topic: String(values.get("topic") || ""),
              },
            );
            await shellView(active.id, selected?.slug || "");
          },
        );
      }),
  );
  document
    .querySelectorAll<HTMLButtonElement>("[data-voice]")
    .forEach(
      (button) =>
        (button.onclick = () => {
          const channelId = Number(button.dataset.voice);
          if (channelId === activeVoiceChannel) return void callView(
            channelId,
            button.dataset.voiceName || "Голосовой канал",
            active?.name || "",
            active?.id || 0,
            button.dataset.voiceMode === "p2p" ? "p2p" : "livekit",
          );
          // Переключения выполняются строго по очереди: второй клик больше не может
          // обогнать отключение от предыдущего канала.
          voiceSwitchPromise = voiceSwitchPromise.catch(() => {}).then(() => callView(
            channelId,
            button.dataset.voiceName || "Голосовой канал",
            active?.name || "",
            active?.id || 0,
            button.dataset.voiceMode === "p2p" ? "p2p" : "livekit",
          ));
        }),
    );
  document.querySelector<HTMLButtonElement>("#selfMute")!.onclick = () => {
    if (activeVoiceMute) void activeVoiceMute();
    else toggleVoicePreferenceBeforeJoin("mute");
  };
  document.querySelector<HTMLButtonElement>("#selfDeafen")!.onclick = () => {
    if (activeVoiceDeafen) void activeVoiceDeafen();
    else toggleVoicePreferenceBeforeJoin("deafen");
  };
  paintVoicePreferenceButtons();
  document
    .querySelector<HTMLButtonElement>("#voiceDockLeave")
    ?.addEventListener("click", () => void activeVoiceLeave?.());
  document
    .querySelector<HTMLButtonElement>("#voiceQuality")
    ?.addEventListener("click", (event) => {
      event.stopPropagation();
      const popover = document.querySelector<HTMLElement>(
        "#voiceQualityPopover",
      );
      if (popover) popover.hidden = !popover.hidden;
    });
  document
    .querySelectorAll<HTMLButtonElement>(".voice-dock-actions button")
    .forEach(
      (button, index) =>
        (button.onclick = () =>
          void [activeVoiceCamera, activeVoiceShare][index]?.()),
    );
  const create = () =>
    modal(
      "Создайте сервер",
      `<label>Название сервера<input name="name" maxlength="80" placeholder="Например, Команда мечты" required></label>`,
      "Создать",
      async (form) => {
        const result = await community(
          {},
          {
            action: "create_server",
            name: new FormData(form).get("name") as string,
          },
        );
        void shellView(result.server_id, "");
      },
    );
  document.querySelector<HTMLButtonElement>("#createServer")!.onclick = create;
  document
    .querySelector<HTMLButtonElement>("#emptyCreate")
    ?.addEventListener("click", create);
  document
    .querySelector<HTMLButtonElement>("#serverSettings")
    ?.addEventListener("click", () => {
      const dropdown = document.querySelector<HTMLElement>("#serverDropdown");
      if (dropdown) dropdown.hidden = true;
      document.querySelector("#serverMenuToggle")?.classList.remove("open");
      const memberIds = new Set(
        state.server_members.map((member) => member.id),
      );
      const inviteable = state.people.filter(
        (person) => person.friend_status === 1 && !memberIds.has(person.id),
      );
      const settings = modal(
        "Управление сервером",
        `<div class="settings-layout"><aside class="settings-sidebar"><small>${esc(active!.name.toUpperCase())}</small><button type="button" data-settings-tab="profile">Профиль сервера</button><button type="button" data-settings-tab="members">Участники</button><button type="button" data-settings-tab="invites">Приглашения</button>${canDeleteServer ? '<button type="button" class="danger-link" data-settings-tab="danger">Удалить сервер</button>' : ""}</aside><div class="settings-pages"><section data-settings-panel="profile"><h2>Профиль сервера</h2><p>Настройте внешний вид и описание вашего пространства.</p><div class="server-preview-card" style="--server-banner:${esc(active!.banner || "#7567ff")}"><div class="server-icon-preview">${active!.icon ? `<img id="serverIconPreview" src="${esc(assetUrl(active!.icon))}" alt="">` : `<img id="serverIconPreview" alt="">`}</div><b>${esc(active!.name)}</b><small>${state.server_members.length} участников</small></div><div class="server-visual-settings"><label>Цвет баннера<input name="banner" type="color" value="${esc(active!.banner || "#7567ff")}"></label><label>Иконка сервера <small>PNG, WEBP или GIF до 5 МБ</small><input name="icon" data-preview="#serverIconPreview" type="file" accept="image/png,image/webp,image/gif"></label></div><label>Название<input name="name" maxlength="80" value="${esc(active!.name)}" required></label><label>Описание<textarea name="description" maxlength="500" placeholder="Расскажите о сервере">${esc(active!.description || "")}</textarea></label></section><section data-settings-panel="members"><h2>Участники — ${state.server_members.length}</h2><p>Люди, которым доступен этот сервер.</p><div class="settings-people">${state.server_members.map((member) => `<div><div class="avatar">${avatar(member)}</div><b>${esc(member.name)}</b><small>${member.global_role === "superadmin" ? "Самый главный" : member.role === "owner" ? "Владелец" : member.role === "admin" ? "Администратор" : member.role === "moderator" ? "Модератор" : "Участник"}</small></div>`).join("")}</div></section><section data-settings-panel="invites"><h2>Приглашения</h2><p>Добавьте друзей на сервер одним нажатием.</p><div class="settings-people">${inviteable.length ? inviteable.map((person) => `<div><div class="avatar">${avatar(person)}</div><b>${esc(person.name)}</b><button type="button" data-server-invite="${active!.id}" data-user="${person.id}">Пригласить</button></div>`).join("") : "<p>Все друзья уже приглашены</p>"}</div></section>${canDeleteServer ? `<section data-settings-panel="danger"><h2>Удаление сервера</h2><p>Это действие удалит каналы, сообщения и приглашения без возможности восстановления.</p><button class="danger-action" type="button" data-delete-server="${active!.id}">Удалить сервер</button></section>` : ""}</div></div>`,
        "Сохранить",
        async (form) => {
          const values = new FormData(form);
          await community(
            {},
            {
              action: "update_server",
              server_id: active!.id,
              name: String(values.get("name") || ""),
              description: String(values.get("description") || ""),
              banner: String(values.get("banner") || "#7567ff"),
            },
          );
          const icon = values.get("icon");
          if (icon instanceof File && icon.size) {
            const upload = new FormData();
            upload.set("action", "upload_server_icon");
            upload.set("server_id", String(active!.id));
            upload.set("icon", icon);
            await communityUpload(upload);
          }
          await shellView(active!.id, selected?.slug || "");
        },
      );
      bindSettings(settings);
      const serverIconInput = settings.querySelector<HTMLInputElement>('[name="icon"]');
      if (serverIconInput) serverIconInput.accept = "image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg";
      settings.querySelectorAll<HTMLElement>('[data-settings-panel="members"] .settings-people > div').forEach((row, index) => {
        const member = state.server_members[index];
        const label = row.querySelector("small");
        if (label && member) label.textContent = member.global_role === "superadmin" ? "Самый главный" : member.role === "owner" ? "Владелец" : member.role === "admin" ? "Администратор" : member.role === "moderator" ? "Модератор" : "Участник";
      });
      if (canManageRoles) {
        settings.querySelectorAll<HTMLElement>('[data-settings-panel="members"] .settings-people > div').forEach((row, index) => {
          const member = state.server_members[index];
          if (!member || member.global_role === "superadmin" || (member.id === user.id && !isSupreme)) return;
          const small = row.querySelector("small");
          const select = document.createElement("select");
          select.className = "member-role-select";
          select.innerHTML = `<option value="member">Участник</option><option value="moderator">Модератор</option><option value="admin">Администратор</option>`;
          select.value = member.role || "member";
          small?.replaceWith(select);
          select.onchange = async () => {
            await community({}, { action: "set_member_role", server_id: active!.id, user_id: member.id, role: select.value });
          };
        });
      }
    });
  const openFriends = () =>
    friendsModal(
      active?.id || 0,
      () => void shellView(active?.id || 0, selected?.slug || ""),
      state.people,
      canManageServer,
    );
  document
    .querySelector<HTMLButtonElement>("#openFriends")
    ?.addEventListener("click", openFriends);
  document
    .querySelector<HTMLButtonElement>("#membersFriends")
    ?.addEventListener("click", openFriends);
  document
    .querySelector<HTMLButtonElement>("#serverInviteMenu")
    ?.addEventListener("click", () => {
      const dropdown = document.querySelector<HTMLElement>("#serverDropdown");
      if (dropdown) dropdown.hidden = true;
      document.querySelector("#serverMenuToggle")?.classList.remove("open");
      openFriends();
    });
  document.querySelector<HTMLButtonElement>("#copyServerInvite")?.addEventListener("click", async () => {
    if (!active) return;
    const result = await community({}, { action: "create_invite", server_id: active.id });
    await navigator.clipboard.writeText(result.url);
    await appAlert("Ссылка-приглашение скопирована. Она действует 7 дней.");
  });
  document.querySelector<HTMLButtonElement>("#clearChannel")?.addEventListener("click", () => {
    if (!active || !selected) return;
    modal("Очистить канал", `<p>Оставьте дату пустой, чтобы удалить всю историю. Вложения также будут удалены с сервера.</p><label>Удалить сообщения по дату включительно<input name="before" type="date"></label>`, "Удалить", async (form) => {
      if (!(await appConfirm("Очистить канал", "Удалённые сообщения и файлы восстановить нельзя.", true))) return;
      await community({}, { action: "clear_channel", server_id: active.id, channel: selected.slug, before: String(new FormData(form).get("before") || "") });
      await shellView(active.id, selected.slug);
    });
  });
  document
    .querySelector<HTMLButtonElement>("#serverLeave")
    ?.addEventListener("click", async () => {
      if (!active || !(await appConfirm("Выйти с сервера", `Выйти с сервера «${active.name}»?`))) return;
      await community({}, { action: "leave_server", server_id: active.id });
      await activeVoiceLeave?.();
      await shellView();
    });
  document.querySelector<HTMLButtonElement>("#userSettings")!.onclick =
    async () => {
      let devices: MediaDeviceInfo[] = [];
      try {
        devices = await navigator.mediaDevices.enumerateDevices();
      } catch {
        devices = await navigator.mediaDevices
          .enumerateDevices()
          .catch(() => []);
      }
      const options = (kind: MediaDeviceKind, saved: string) =>
        `<option value="">Системное устройство</option>${devices
          .filter((device) => device.kind === kind)
          .map(
            (device, index) =>
              `<option value="${esc(device.deviceId)}" ${device.deviceId === saved ? "selected" : ""}>${esc(device.label || `Устройство ${index + 1}`)}</option>`,
          )
          .join("")}`;
      const ownAbout = await loadProfileAbout(user.id);
      const settings = modal(
        "Настройки профиля",
        `<div class="settings-layout"><aside class="settings-sidebar"><div class="settings-user"><div class="avatar">${avatar(user)}</div><span><b>${esc(user.name)}</b><small>${esc(user.login)}</small></span></div><button type="button" data-settings-tab="account">Мой аккаунт</button><button type="button" data-settings-tab="voice">Голос и видео</button><button type="button" data-settings-tab="notifications">Уведомления</button><button type="button" data-settings-tab="appearance">Внешний вид</button><button type="button" class="danger-link" id="settingsLogout">Выйти</button></aside><div class="settings-pages"><section data-settings-panel="account"><h2>Мой аккаунт</h2><div class="account-preview"><div class="avatar"><img id="avatarPreview" ${user.avatar ? `src="${esc(assetUrl(user.avatar))}"` : ""} alt=""></div><div><b>${esc(user.name)}</b><small>${esc(user.login)} · ID ${user.id}</small></div></div><label>Отображаемое имя<input name="name" maxlength="40" value="${esc(user.name)}" required></label><label class="profile-about-editor">О себе <small>До 190 символов · видно участникам в карточке профиля</small><textarea name="about" maxlength="190" placeholder="Например: люблю кооперативы, котов и ночные посиделки ✨">${esc(ownAbout)}</textarea><span class="about-counter" data-about-counter>${ownAbout.length}/190</span></label><label>Новая аватарка <small>JPG, PNG, WEBP или GIF до 5 МБ</small><input name="avatar" data-preview="#avatarPreview" type="file" accept="image/jpeg,image/png,image/webp,image/gif"></label></section><section data-settings-panel="voice"><h2>Голос и видео</h2><p>Выберите устройства и способ активации микрофона.</p><div class="device-grid"><label>Микрофон<select name="microphone">${options("audioinput", localStorage.getItem("kitchat_microphone") || "")}</select></label><label>Динамики<select name="speaker">${options("audiooutput", localStorage.getItem("kitchat_speaker") || "")}</select></label><label>Камера<select name="camera">${options("videoinput", localStorage.getItem("kitchat_camera") || "")}</select></label></div><div class="device-test"><video id="cameraPreview" muted autoplay playsinline></video><div><b>Проверка устройств</b><small>Вы увидите камеру и уровень микрофона до сохранения.</small><div class="mic-meter"><i id="micMeter"></i></div><button id="testDevices" type="button">Проверить микрофон и камеру</button></div></div><div class="range-grid"><label>Громкость микрофона<input name="mic_volume" type="range" min="0" max="100" value="${localStorage.getItem("kitchat_mic_volume") || "100"}"></label><label>Громкость динамиков<input name="speaker_volume" type="range" min="0" max="100" value="${localStorage.getItem("kitchat_speaker_volume") || "100"}"></label></div><h3>Режим ввода</h3><div class="input-mode"><label><input name="input_mode" type="radio" value="voice" ${localStorage.getItem("kitchat_input_mode") !== "ptt" ? "checked" : ""}><span><b>Активация по голосу</b><small>Микрофон включается автоматически</small></span></label><label><input name="input_mode" type="radio" value="ptt" ${localStorage.getItem("kitchat_input_mode") === "ptt" ? "checked" : ""}><span><b>Режим рации</b><small>Удерживайте выбранную клавишу, чтобы говорить</small></span></label></div><label>Клавиша рации<input name="ptt_key" value="${esc(localStorage.getItem("kitchat_ptt_key") || "Space")}" readonly></label><label class="check-setting"><input name="noise" type="checkbox" ${localStorage.getItem("kitchat_noise") !== "0" ? "checked" : ""}><span><b>Шумоподавление</b><small>Уменьшает постоянный фоновый шум</small></span></label><label class="check-setting"><input name="echo" type="checkbox" ${localStorage.getItem("kitchat_echo") !== "0" ? "checked" : ""}><span><b>Эхоподавление</b><small>Убирает звук динамиков из микрофона</small></span></label><label class="check-setting"><input name="gain" type="checkbox" ${localStorage.getItem("kitchat_gain") !== "0" ? "checked" : ""}><span><b>Автоматическая регулировка усиления</b><small>Выравнивает громкость голоса</small></span></label></section><section data-settings-panel="notifications"><h2>Уведомления</h2><p>Получайте сообщения и заявки, даже когда Kitchat работает в фоне.</p><label class="check-setting"><input name="notifications" type="checkbox" ${localStorage.getItem("kitchat_notifications") !== "0" ? "checked" : ""}><span><b>Системные уведомления</b><small>Windows и macOS попросят разрешение при первом запуске</small></span></label><div class="notification-test-card"><span>${ico("bell")}</span><div><b>Проверка уведомлений</b><small id="notificationTestStatus">Отправьте тест и убедитесь, что система показывает его.</small></div><button id="testNotification" type="button">Отправить тест</button></div><label class="check-setting"><input name="sounds" type="checkbox" ${localStorage.getItem("kitchat_sounds") !== "0" ? "checked" : ""}><span><b>Звуки интерфейса</b><small>Подключение, сообщения и трансляции</small></span></label></section><section data-settings-panel="appearance"><h2>Внешний вид</h2><p>Выберите оформление Kitchat.</p><div class="theme-picker">${([['standard','Стандартный','Оригинальное тёмное оформление Kitchat'],['pink','Фиолетовый','Мягкое сливово-фиолетовое оформление'],['hotpink','Ярко-розовый','Насыщенный hot-pink интерфейс'],['light','Светлая','Светлый и воздушный интерфейс'],['aurora','Северное сияние','Тёмная бирюзово-зелёная тема']] as const).map(([value,title,description]) => `<label class="theme-option theme-${value}"><input type="radio" name="theme" value="${value}" ${(localStorage.getItem("kitchat_theme") || "standard") === value ? "checked" : ""}><span class="theme-preview"><i></i><i></i><i></i></span><span><b>${title}</b><small>${description}</small></span></label>`).join("")}</div><label class="check-setting"><input name="compact" type="checkbox" ${localStorage.getItem("kitchat_compact") === "1" ? "checked" : ""}><span><b>Компактный режим</b><small>Больше сообщений на экране</small></span></label></section></div></div>`,
        "Сохранить",
        async (form) => {
          const values = new FormData(form);

          // Внешний вид и локальные настройки сохраняем ДО любых сетевых запросов.
          // Поэтому временно недоступный profile_about.php/desktop_auth.php больше
          // не может оставить тему в старом состоянии с ошибкой "Failed to fetch".
          for (const key of ["microphone", "speaker", "camera"])
            localStorage.setItem(`kitchat_${key}`, String(values.get(key) || ""));
          localStorage.setItem("kitchat_mic_volume", String(values.get("mic_volume") || "100"));
          localStorage.setItem("kitchat_speaker_volume", String(values.get("speaker_volume") || "100"));
          localStorage.setItem("kitchat_input_mode", String(values.get("input_mode") || "voice"));
          localStorage.setItem("kitchat_ptt_key", String(values.get("ptt_key") || "Space"));
          localStorage.setItem("kitchat_noise", values.has("noise") ? "1" : "0");
          localStorage.setItem("kitchat_echo", values.has("echo") ? "1" : "0");
          localStorage.setItem("kitchat_gain", values.has("gain") ? "1" : "0");
          localStorage.setItem("kitchat_camera_mirror", values.has("camera_mirror") ? "1" : "0");
          localStorage.setItem("kitchat_stream_fps", String(values.get("stream_fps") || "30"));
          localStorage.setItem("kitchat_screen_share_mode", String(values.get("screen_share_mode") || "webview"));
          localStorage.setItem("kitchat_compact", values.has("compact") ? "1" : "0");
          const selectedTheme = String(values.get("theme") || "standard");
          localStorage.setItem("kitchat_theme", selectedTheme);
          applyTheme(selectedTheme);
          localStorage.setItem("kitchat_sounds", values.has("sounds") ? "1" : "0");
          localStorage.setItem("kitchat_notifications", values.has("notifications") ? "1" : "0");
          localStorage.setItem("kitchat_low_performance", values.has("low_performance") ? "1" : "0");
          document.body.classList.toggle("compact", values.has("compact"));
          document.body.classList.toggle("low-performance", values.has("low_performance"));
          document.querySelectorAll<HTMLElement>(`[data-p2p-user="${currentUser?.id || 0}"]`).forEach((tile) =>
            tile.classList.toggle("self-camera-mirrored", values.has("camera_mirror")),
          );

          const previousGlobalRole = currentUser?.global_role;
          const profileAbout = String(values.get("about") || "").trim().slice(0, 190);
          const profile = await request("desktop_auth.php", {
            action: "update_profile",
            name: String(values.get("name") || ""),
            about: profileAbout,
          });
          currentUser = { ...profile.user, global_role: profile.user?.global_role || previousGlobalRole };
          await saveOwnProfileAbout(profileAbout);
          const picture = values.get("avatar");
          if (picture instanceof File && picture.size) {
            const upload = new FormData();
            upload.set("action", "upload_avatar");
            upload.set("avatar", picture);
            const uploadedUser = (await authUpload(upload)).user;
            currentUser = { ...uploadedUser, global_role: uploadedUser?.global_role || previousGlobalRole };
          }
          await syncGlobalPttShortcut();
          await activeVoiceSetMuted?.(String(values.get("input_mode") || "voice") === "ptt");
          if (values.has("notifications")) {
            notificationPermissionRequest = null;
            if (!(await ensureNotificationPermission())) {
              showAppNotice("Уведомления не включены", "Разрешите их для Kitchat в настройках системы", "warning");
            }
          }
          await shellView(active?.id || 0, selected?.slug || "");
        },
      );
      bindSettings(settings);
      const aboutInput = settings.querySelector<HTMLTextAreaElement>('textarea[name="about"]');
      const aboutCounter = settings.querySelector<HTMLElement>('[data-about-counter]');
      if (aboutInput && aboutCounter) {
        const updateAboutCounter = () => aboutCounter.textContent = `${aboutInput.value.length}/190`;
        aboutInput.addEventListener("input", updateAboutCounter);
        updateAboutCounter();
      }
      const testNotification = settings.querySelector<HTMLButtonElement>("#testNotification");
      if (testNotification) testNotification.onclick = async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        const status = settings.querySelector<HTMLElement>("#notificationTestStatus");
        if (!status) return;
        button.disabled = true;
        status.textContent = "Проверяем системное разрешение…";
        localStorage.setItem("kitchat_notifications", "1");
        notificationPermissionRequest = null;
        const granted = await ensureNotificationPermission();
        if (!granted) {
          status.textContent = "Разрешение отклонено. Включите уведомления для Kitchat в настройках системы.";
          button.disabled = false;
          return;
        }
        try { sendNotification({ title: "Тест Kitchat", body: "Всё работает — уведомления будут приходить в фоне." }); } catch {}
        status.textContent = "Тест отправлен. Уведомление должно появиться сейчас.";
        button.textContent = "Отправить ещё раз";
        button.disabled = false;
      };
      settings.querySelector<HTMLElement>('[data-settings-panel="account"]')?.insertAdjacentHTML(
        "beforeend",
        `<div class="app-version-card"><span>${ico("info")}</span><div><b>Kitchat ${esc(appVersion)}</b><small>Версия приложения · P2P-звонки</small></div></div>`,
      );
      settings.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach((input) => {
        input.addEventListener("change", () => {
          if (!input.checked) return;
          localStorage.setItem("kitchat_theme", input.value);
          applyTheme(input.value);
        });
      });
      const notificationsInput = settings.querySelector<HTMLInputElement>('[name="notifications"]');
      if (notificationsInput) {
        // Выбор пользователя сохраняется локально и не сбрасывается из-за
        // кратковременного ответа API разрешений при запуске WebView.
        notificationsInput.checked = localStorage.getItem("kitchat_notifications") !== "0";
      }
      settings.querySelector<HTMLElement>('[data-settings-panel="appearance"]')?.insertAdjacentHTML("beforeend", `<label class="check-setting"><input name="low_performance" type="checkbox" ${localStorage.getItem("kitchat_low_performance") === "1" ? "checked" : ""}><span><b>Экономия ресурсов</b><small>Камера 360p / 15 FPS, экран до 720p / 15 FPS, меньше эффектов. Параметры видео применяются при следующем включении.</small></span></label>`);
      settings.querySelector<HTMLElement>('[data-settings-panel="voice"]')?.querySelector(".range-grid")?.insertAdjacentHTML("afterend", `<label>Демонстрация экрана<select name="screen_share_mode"><option value="webview" ${localStorage.getItem("kitchat_screen_share_mode") !== "native" ? "selected" : ""}>Совместимый WebView2 — рекомендуется</option><option value="native" ${localStorage.getItem("kitchat_screen_share_mode") === "native" ? "selected" : ""}>Нативный H.264 (WGC) — тестовый</option></select><small>Совместимый режим открывает системный выбор окна и автоматически использует доступный кодер Windows.</small></label><label>Плавность трансляции<select name="stream_fps">${[15,30,60].map(fps => `<option value="${fps}" ${streamProfile(localStorage.getItem("kitchat_stream_fps"), false).fps === fps ? "selected" : ""}>${fps} FPS${fps === 60 ? " — плавное движение" : fps === 30 ? " — сбалансированно" : " — меньше нагрузка"}</option>`).join("")}</select><small>Применяется при следующем запуске. Экономия ресурсов ограничивает частоту до 15 FPS.</small></label>`);
      settings.querySelector<HTMLElement>('[data-settings-panel="voice"]')?.querySelector(".device-test")?.insertAdjacentHTML("afterend", `<label class="check-setting"><input name="camera_mirror" type="checkbox" ${cameraPreviewMirrored() ? "checked" : ""}><span><b>Зеркальное превью камеры</b><small>Отражает только ваше изображение на этом компьютере. Другие участники видят камеру без отражения.</small></span></label>`);
      const cameraMirrorInput = settings.querySelector<HTMLInputElement>('[name="camera_mirror"]');
      const cameraPreview = settings.querySelector<HTMLVideoElement>("#cameraPreview");
      const updateCameraPreviewMirror = () => cameraPreview?.classList.toggle("is-mirrored", cameraMirrorInput?.checked ?? true);
      cameraMirrorInput?.addEventListener("change", updateCameraPreviewMirror);
      updateCameraPreviewMirror();
      const deviceTest = settings.querySelector<HTMLElement>(".device-test > div")!;
      deviceTest.innerHTML = `<b>Проверка устройств</b><small>Доступ запрашивается отдельно для выбранного устройства через интерфейс Kitchat.</small><div class="mic-meter"><i id="micMeter"></i></div><div class="device-test-actions"><button id="testMicrophone" type="button">Проверить микрофон</button><button id="testCamera" type="button">Проверить камеру</button></div><small id="deviceTestStatus">Ничего не записывается и не отправляется.</small>`;
      let testAudioStream: MediaStream | null = null;
      let testCameraStream: MediaStream | null = null;
      let testAudioContext: AudioContext | null = null;
      let testFrame = 0;
      const stopMicrophoneTest = () => {
        testAudioStream?.getTracks().forEach((track) => track.stop());
        testAudioStream = null;
        testAudioContext?.close().catch(() => {});
        testAudioContext = null;
        cancelAnimationFrame(testFrame);
      };
      const stopCameraTest = () => {
        testCameraStream?.getTracks().forEach((track) => track.stop());
        testCameraStream = null;
        const preview = settings.querySelector<HTMLVideoElement>("#cameraPreview")!;
        preview.srcObject = null;
      };
      settings.querySelector<HTMLButtonElement>("#testMicrophone")!.onclick = async () => {
        stopMicrophoneTest();
        const form = settings.querySelector<HTMLFormElement>("form")!;
        const values = new FormData(form);
        const status = settings.querySelector<HTMLElement>("#deviceTestStatus")!;
        if (!(await requestMediaAccess("microphone"))) return;
        status.textContent = "Запрашиваем микрофон…";
        try {
          testAudioStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: (values.get("microphone") as string) || undefined, echoCancellation: values.has("echo"), noiseSuppression: values.has("noise"), autoGainControl: values.has("gain") },
          });
          localStorage.setItem("kitchat_microphone_granted", "1");
        } catch {
          status.textContent = "Доступ к микрофону не предоставлен.";
          return;
        }
        testAudioContext = new AudioContext();
        const analyser = testAudioContext.createAnalyser(), data = new Uint8Array(64);
        testAudioContext.createMediaStreamSource(testAudioStream).connect(analyser);
        status.textContent = "Микрофон активен — скажите что-нибудь.";
        const drawMeter = () => { analyser.getByteFrequencyData(data); const level = data.reduce((sum, value) => sum + value, 0) / data.length; settings.querySelector<HTMLElement>("#micMeter")!.style.width = `${Math.min(100, level)}%`; testFrame = requestAnimationFrame(drawMeter); };
        drawMeter();
      };
      settings.querySelector<HTMLButtonElement>("#testCamera")!.onclick = async () => {
        stopCameraTest();
        const form = settings.querySelector<HTMLFormElement>("form")!;
        const values = new FormData(form);
        const status = settings.querySelector<HTMLElement>("#deviceTestStatus")!;
        if (!(await requestMediaAccess("camera"))) return;
        status.textContent = "Запрашиваем камеру…";
        try {
          testCameraStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: (values.get("camera") as string) || undefined } });
          localStorage.setItem("kitchat_camera_granted", "1");
        } catch {
          status.textContent = "Доступ к камере не предоставлен.";
          return;
        }
        settings.querySelector<HTMLVideoElement>("#cameraPreview")!.srcObject = testCameraStream;
        status.textContent = "Камера активна. Изображение видно слева.";
      };
      settings.querySelectorAll<HTMLButtonElement>(".modal-close,.cancel").forEach((button) => button.addEventListener("click", () => { stopMicrophoneTest(); stopCameraTest(); }));
      const pttKey = settings.querySelector<HTMLInputElement>('[name="ptt_key"]');
      let stopPttCapture: (() => void) | null = null;
      const beginPttCapture = (event: Event) => {
        event.preventDefault();
        if (!pttKey || pttCaptureActive) return;
        pttCaptureActive = true;
        pttKey.value = "Нажмите клавишу…";
        pttKey.classList.add("is-capturing");
        const finish = (value: string) => {
          pttKey.value = value;
          pttCaptureActive = false;
          pttKey.classList.remove("is-capturing");
          stopPttCapture?.();
          stopPttCapture = null;
        };
        const onKey = (keyEvent: KeyboardEvent) => { keyEvent.preventDefault(); keyEvent.stopPropagation(); if (keyEvent.code !== "Escape") finish(keyEvent.code); else finish(localStorage.getItem("kitchat_ptt_key") || "Space"); };
        const onMouse = (mouseEvent: MouseEvent) => { mouseEvent.preventDefault(); mouseEvent.stopPropagation(); finish(`Mouse${mouseEvent.button}`); };
        stopPttCapture = () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("mousedown", onMouse, true); };
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("mousedown", onMouse, true);
      };
      pttKey?.addEventListener("click", beginPttCapture);
      pttKey?.closest("label")?.insertAdjacentHTML("beforeend", "<small class=\"ptt-capture-help\">Нажмите поле, затем нужную клавишу или кнопку мыши</small>");
      settings.querySelectorAll(".modal-close,.cancel").forEach((button) => button.addEventListener("click", () => { stopMicrophoneTest(); stopCameraTest(); pttCaptureActive = false; stopPttCapture?.(); }));
      settings.querySelector<HTMLButtonElement>("#settingsLogout")!.onclick =
        () => void logout();
    };
  document.body.classList.toggle(
    "compact",
    localStorage.getItem("kitchat_compact") === "1",
  );
  document.body.classList.toggle(
    "low-performance",
    localStorage.getItem("kitchat_low_performance") === "1",
  );
  document.querySelectorAll<HTMLButtonElement>("[data-create-channel]").forEach(
    (button) =>
      (button.onclick = () =>
        modal(
          button.dataset.createChannel === "voice"
            ? "Новый голосовой канал"
            : "Новый текстовый канал",
          `<div class="creation-intro channel-create-intro"><div class="creation-orb">${button.dataset.createChannel === "voice" ? "◖" : "#"}</div><div><p>${button.dataset.createChannel === "voice" ? "Голос, камера и демонстрация экрана через P2P." : "Текстовый канал для сообщений, файлов, GIF и стикеров."}</p><small>Канал появится в соответствующем разделе сервера.</small></div></div><label>Название канала<input name="name" maxlength="60" placeholder="новый-канал" required></label><label>Описание <small>Необязательно</small><input name="topic" maxlength="180" placeholder="О чём этот канал"></label>${button.dataset.createChannel === "voice" ? `<div class="voice-mode-picker"><label><input type="radio" name="voice_mode" value="p2p" checked><span><b>P2P-звонок</b><small>Прямая голосовая и видеосвязь, камера и демонстрация экрана.</small></span></label></div>` : ""}`,
          "Создать канал",
          async (form) => {
            const values = new FormData(form);
            await community(
              {},
              {
                action: "create_channel",
                server_id: active!.id,
                type: button.dataset.createChannel || "text",
                voice_mode: "p2p",
                name: String(values.get("name") || ""),
                topic: String(values.get("topic") || ""),
              },
            );
            void shellView(active!.id, "");
          },
        )),
  );
  const messageForm = document.querySelector<HTMLFormElement>("#messageForm");
  const composerInput = document.querySelector<HTMLTextAreaElement>("#messageInput");
  const composerSend = messageForm?.querySelector<HTMLButtonElement>(".send");
  const queuedFiles: File[] = [];
  const queue = document.querySelector<HTMLElement>("#composerQueue");
  const renderQueue = () => {
    if (!queue) return;
    queue.hidden = !queuedFiles.length;
    queue.innerHTML = queuedFiles.map((file, index) => { const image = file.type.startsWith("image/"); const video = file.type.startsWith("video/"); const preview = image ? `<img src="${URL.createObjectURL(file)}" alt="">` : `<span class="queued-file-icon">${video ? "▶" : "▤"}</span>`; return `<div class="queued-file ${image ? "is-image" : ""}"><div class="queued-file-preview">${preview}</div><div class="queued-file-meta"><b>${esc(file.name)}</b><small>${Math.max(1, Math.round(file.size / 1024))} КБ · ${image ? "Изображение" : video ? "Видео" : "Файл"}</small></div><button type="button" data-remove-file="${index}" aria-label="Убрать файл">×</button></div>`; }).join("");
    queue.querySelectorAll<HTMLButtonElement>("[data-remove-file]").forEach((button) => button.onclick = () => { queuedFiles.splice(Number(button.dataset.removeFile), 1); renderQueue(); updateComposer(); });
  };
  const resizeComposer = () => {
    if (!composerInput) return;
    composerInput.style.height = "0px";
    composerInput.style.height = `${Math.min(composerInput.scrollHeight, 132)}px`;
    composerInput.classList.toggle("has-scroll", composerInput.scrollHeight > 132);
  };
  const updateComposer = () => {
    if (composerSend) composerSend.disabled = !composerInput?.value.trim() && !queuedFiles.length;
    resizeComposer();
  };
  const channelDraftKey = active && selected ? `${active.id}:${selected.slug}` : "";
  composerInput?.addEventListener("input", () => {
    if (channelDraftKey) channelMessageDrafts.set(channelDraftKey, composerInput.value);
    updateComposer();
  });
  updateComposer();
  const addFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (queuedFiles.length >= 10) break;
      if (!queuedFiles.some((existing) => existing.name === file.name && existing.size === file.size)) queuedFiles.push(file);
    }
    renderQueue(); updateComposer();
  };
  if (messageForm) activeFileDropHandler = (files) => addFiles(files);
  const fileInput = document.querySelector<HTMLInputElement>("#messageFiles");
  document.querySelector<HTMLButtonElement>("#attachButton")?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", () => {
    addFiles(fileInput.files || []); fileInput.value = "";
  });
  messageForm?.addEventListener("dragover", (event) => { event.preventDefault(); messageForm.classList.add("dragging"); });
  messageForm?.addEventListener("dragleave", () => messageForm.classList.remove("dragging"));
  messageForm?.addEventListener("drop", (event) => {
    event.preventDefault(); event.stopPropagation(); messageForm.classList.remove("dragging");
    addFiles(event.dataTransfer?.files || []);
    dragDepth = 0; dropOverlay.classList.remove("show");
  });
  composerInput?.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files || []);
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  });
  messageForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.querySelector<HTMLTextAreaElement>("#messageInput")!;
    const message = input.value.trim();
    if ((!message && !queuedFiles.length) || !active || !selected) return;
    input.disabled = true;
    try {
      if (message) await community({}, { action: "send", server_id: active.id, channel: selected.slug, message });
      for (const file of queuedFiles) {
        const upload = new FormData();
        upload.set("action", "send_file"); upload.set("server_id", String(active.id)); upload.set("channel", selected.slug); upload.set("file", file);
        await communityUpload(upload);
      }
      input.value = "";
      if (channelDraftKey) channelMessageDrafts.delete(channelDraftKey);
      queuedFiles.splice(0); renderQueue();
      updateComposer();
      // Новое сообщение добавит фоновая синхронизация без пересоздания всего чата.
      // Так пользователь может сразу продолжать печатать и свободно листать историю.
      input.disabled = false;
      input.focus({ preventScroll: true });
    } catch (error) {
      input.disabled = false;
      input.focus({ preventScroll: true });
      appAlert(error instanceof Error ? error.message : "Сообщение не отправлено");
    }
  });
  document
    .querySelector<HTMLTextAreaElement>("#messageInput")
    ?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        messageForm?.requestSubmit();
      }
    });
  const stickerPopover = document.querySelector<HTMLElement>("#stickerPopover");
  document
    .querySelector<HTMLButtonElement>("#stickerButton")
    ?.addEventListener("click", (event) => {
      event.stopPropagation();
      if (stickerPopover) stickerPopover.hidden = !stickerPopover.hidden;
    });
  stickerPopover?.addEventListener("click", async (event) => {
    event.stopPropagation();
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-sticker]",
    );
    if (!button || !active || !selected) return;
    floatingTooltip.hidden = true;
    button.blur();
    if (stickerPopover) stickerPopover.hidden = true;
    await community(
      {},
      {
        action: "send_sticker",
        server_id: active.id,
        channel: selected.slug,
        sticker_id: Number(button.dataset.sticker),
      },
    );
    await shellView(active.id, selected.slug);
  });
  document
    .querySelector<HTMLInputElement>("#stickerUpload")
    ?.addEventListener("change", async (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      if (!file || !active) return;
      const upload = new FormData();
      upload.set("action", "upload_sticker");
      upload.set("server_id", String(active.id));
      upload.set("name", file.name.replace(/\.[^.]+$/, ""));
      upload.set("sticker", file);
      try {
        await communityUpload(upload);
        await shellView(active.id, selected?.slug || "");
      } catch (error) {
        appAlert(
          error instanceof Error ? error.message : "Не удалось добавить стикер",
        );
      }
    });
  async function logout() {
    socialCleanup();
    ++viewRevision;
    if (activeVoiceLeave) await activeVoiceLeave();
    await request("desktop_auth.php", { action: "logout" }).catch(() => {});
    localStorage.removeItem("kitchat_token");
    currentUser = null;
    authView();
  }
  if (active && selected) {
    let lastMessageId = state.messages.reduce(
      (max, message) => Math.max(max, message.id),
      0,
    );
    let lastRenderedMessage = state.messages[state.messages.length - 1];
    if (lastMessageId) void community({}, { action: "mark_read", server_id: active.id, channel: selected.slug, last_message_id: lastMessageId });
    const pollMessages = async () => {
      if (revision !== viewRevision || !document.querySelector("#messageForm"))
        return;
      try {
        const fresh: CommunityState = await community({
          server_id: active.id,
          channel: selected.slug,
          since: lastMessageId,
        });
        if (revision !== viewRevision) return;
        const freshSignature = JSON.stringify(
          fresh.servers.map((server) => [server.id, server.name, server.icon]),
        );
        if (freshSignature !== serverSignature) {
          await shellView(active.id, selected.slug);
          return;
        }
        const freshChannelSignature = JSON.stringify(fresh.channels.map((channel) => [channel.id, channel.slug, channel.name, channel.topic, channel.type, channel.voice_mode]));
        const freshMemberSignature = JSON.stringify([...fresh.server_members].sort((a,b) => a.id-b.id).map((member) => [member.id, member.role, member.global_role]));
        const freshStickerSignature = JSON.stringify(fresh.stickers.map((sticker) => [sticker.id, sticker.name, sticker.path]));
        if (freshChannelSignature !== channelSignature || freshMemberSignature !== memberSignature || freshStickerSignature !== stickerSignature) {
          fresh.people.filter((person) => person.friend_status === 0 && !person.sent_by_me).forEach((person) => void notifyAboutFriendRequest(person));
          await shellView(active.id, selected.slug);
          return;
        }
        const incomingSync = fresh.message_sync;
        // read_changed меняет только галочки доставки/прочтения. Полная перерисовка
        // из-за него сбивала фокус textarea и телепортировала историю в самый низ.
        if (incomingSync && incomingSync.max_id <= lastMessageId && (incomingSync.count !== messageCount || incomingSync.changed !== messageChanged)) {
          await shellView(active.id, selected.slug);
          return;
        }
        const unseen = fresh.messages.filter(
          (message) => message.id > lastMessageId,
        );
        if (unseen.length) {
          const list = messageList;
          const nearBottom = list
            ? list.scrollHeight - list.scrollTop - list.clientHeight < 120
            : false;
          list?.insertAdjacentHTML(
            "beforeend",
            messageBatchMarkup(unseen, lastRenderedMessage),
          );
          lastRenderedMessage = unseen[unseen.length - 1];
          lastMessageId = Math.max(
            lastMessageId,
            ...unseen.map((message) => message.id),
          );
          if (nearBottom && list) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
          else if (newMessagesButton) newMessagesButton.hidden = false;
          playSound("receive");
          const incoming = unseen.filter((message) => message.user_id !== currentUser?.id);
          if (incoming.length) void notifyAboutMessage(incoming[incoming.length - 1]);
        }
        if (incomingSync) { messageCount = incomingSync.count; messageChanged = incomingSync.changed; }
        if (document.hasFocus() && !document.hidden && lastMessageId) void community({}, { action: "mark_read", server_id: active.id, channel: selected.slug, last_message_id: lastMessageId });
        const freshVisibleVoice = visibleVoicePresence(fresh.voice);
        for (const channel of voiceChannels) {
          const users = freshVisibleVoice.filter(
            (person) => person.channel_id === channel.id,
          );
          const presence = document.querySelector<HTMLElement>(
            `.voice-presence[data-channel-id="${channel.id}"]`,
          );
          if (presence) presence.innerHTML = users.map(voicePerson).join("");
          const counter = document.querySelector<HTMLElement>(
            `[data-voice="${channel.id}"] small`,
          );
          if (counter) counter.textContent = `${users.length} в голосовом`;
        }

      } catch {
      } finally {
        if (revision === viewRevision) window.setTimeout(pollMessages, 1500);
      }
    };
    window.setTimeout(pollMessages, 1500);
  } else {
    const pollMembership = async () => {
      if (revision !== viewRevision) return;
      try {
        const fresh: CommunityState = await community({ server_id: active?.id || 0 });
        if (revision !== viewRevision) return;
        const freshSignature = JSON.stringify(
          fresh.servers.map((server) => [server.id, server.name, server.icon]),
        );
        if (freshSignature !== serverSignature) {
          await shellView(active?.id || fresh.servers[0]?.id || 0, "", !active);
          return;
        }
      } catch {
      } finally {
        if (revision === viewRevision)
          window.setTimeout(pollMembership, 1800);
      }
    };
    window.setTimeout(pollMembership, 1800);
  }
}
async function acceptOAuth(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "kitchat:" && parsed.hostname === "invite") {
      const code = parsed.searchParams.get("code") || "";
      if (!token()) { localStorage.setItem("kitchat_pending_invite", code); authView(); return; }
      if (!currentUser) currentUser = (await request("desktop_auth.php?action=me")).user;
      const joined = await community({}, { action: "join_invite", code });
      await shellView(joined.server_id, "");
      return;
    }
    if (parsed.protocol !== "kitchat:" || parsed.hostname !== "auth") return;
    authView();
    setError("Завершаем безопасный вход…", true);
    const data = await request("desktop_auth.php", {
      action: "oauth_exchange",
      code: parsed.searchParams.get("code") || "",
    });
    localStorage.setItem("kitchat_token", data.token);
    currentUser = data.user;
    void syncOwnProfileAbout();
    void ensureNotificationPermission();
    await shellView();
  } catch (error) {
    authView();
    setError(
      error instanceof Error ? error.message : "Не удалось завершить вход",
    );
  }
}
document.addEventListener("click", async (event) => {
  const messageLink = (event.target as HTMLElement).closest<HTMLAnchorElement>(".message-link");
  if (messageLink) { event.preventDefault(); await openUrl(messageLink.href); return; }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "[data-server-invite]",
  );
  if (!button) return;
  button.disabled = true;
  try {
    await community(
      {},
      {
        action: "add_member",
        server_id: Number(button.dataset.serverInvite),
        user_id: Number(button.dataset.user),
      },
    );
    button.textContent = "Приглашён";
  } catch (error) {
    button.disabled = false;
    appAlert(
      error instanceof Error ? error.message : "Не удалось пригласить друга",
    );
  }
});
document.addEventListener("click", async (event) => {
  const channelButton = (
    event.target as HTMLElement
  ).closest<HTMLButtonElement>("[data-delete-channel]");
  const serverButton = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "[data-delete-server]",
  );
  if (channelButton) {
    if (
      !(await appConfirm("Удалить канал", "Удалить канал и его сообщения? Это действие нельзя отменить.", true))
    )
      return;
    await community(
      {},
      {
        action: "delete_channel",
        id: Number(channelButton.dataset.deleteChannel),
      },
    );
    document.querySelector<HTMLElement>(".modal-layer")?.remove();
    if (activeVoiceChannel === Number(channelButton.dataset.deleteChannel)) await activeVoiceLeave?.();
    await shellView(Number(channelButton.dataset.deleteChannelServer) || 0, "");
  }
  if (serverButton) {
    if (
      !(await appConfirm("Удалить сервер", "Удалить сервер, все каналы и сообщения? Это действие нельзя отменить.", true))
    )
      return;
    await community(
      {},
      {
        action: "delete_server",
        server_id: Number(serverButton.dataset.deleteServer),
      },
    );
    document.querySelector<HTMLElement>(".modal-layer")?.remove();
    await shellView();
  }
});
document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const fullscreenControl = target.closest<HTMLButtonElement>("[data-fullscreen-call-action]");
  if (fullscreenControl) {
    const action = fullscreenControl.dataset.fullscreenCallAction || "";
    revealFullscreenCallControls();
    if (action === "exit") {
      void document.exitFullscreen().catch(() => {});
    } else if (action === "leave") {
      const leave = activeVoiceLeave;
      if (leave) {
        playSound("leave");
        void (async () => {
          if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
          await leave();
        })();
      }
    } else {
      document.querySelector<HTMLButtonElement>(fullscreenActionTargets[action])?.click();
      window.setTimeout(syncFullscreenCallControls, 0);
      window.setTimeout(syncFullscreenCallControls, 350);
    }
    return;
  }
  if (target.closest("[data-voice]") && !activeVoiceChannel) playSound("join");
  if (target.closest("#callLeave,#voiceDockLeave")) playSound("leave");
  if (target.closest("#callShare")) playSound("share");
});
document.addEventListener("pointermove", () => {
  if (document.fullscreenElement?.classList.contains("call-stage")) revealFullscreenCallControls();
}, { passive: true });
document.addEventListener("keydown", () => {
  if (document.fullscreenElement?.classList.contains("call-stage")) revealFullscreenCallControls();
});
document.addEventListener("fullscreenchange", () => {
  window.clearTimeout(fullscreenChromeTimer);
  if (document.fullscreenElement?.classList.contains("call-stage")) {
    revealFullscreenCallControls();
    return;
  }
  document.querySelectorAll<HTMLElement>(".call-stage.controls-hidden").forEach((stage) => stage.classList.remove("controls-hidden"));
});
document.addEventListener("submit", (event) => {
  if ((event.target as HTMLElement).matches("#messageForm")) playSound("send");
});
document.addEventListener("change", (event) => {
  const input = (event.target as HTMLElement).closest<HTMLInputElement>(
    'input[type="file"]',
  );
  const file = input?.files?.[0];
  if (!input || !file || !file.type.startsWith("image/")) return;
  const url = URL.createObjectURL(file);
  if (input.name === "avatar") {
    const preview = input
      .closest(".modal-card")
      ?.querySelector<HTMLElement>(".account-preview .avatar");
    if (preview) preview.innerHTML = `<img src="${url}" alt="Предпросмотр">`;
  }
  if (input.name === "icon") {
    const form = input.closest(".modal-card");
    let preview = form?.querySelector<HTMLElement>(".server-icon-preview");
    if (!preview && form) {
      preview = document.createElement("div");
      preview.className = "server-icon-preview";
      form.querySelector(".server-visual-settings")?.prepend(preview);
    }
    if (preview) preview.innerHTML = `<img src="${url}" alt="Предпросмотр">`;
  }
});
document.addEventListener("dblclick", (event) => {
  const tile = (event.target as HTMLElement).closest<HTMLElement>(
    ".video-tile.has-video",
  );
  if (tile?.requestFullscreen) void tile.requestFullscreen();
});
async function callViewLiveKit(
  channelId: number,
  name: string,
  serverName: string,
  serverId = 0,
) {
  const { ConnectionState, LocalVideoTrack, Room, RoomEvent, Track } = await import("livekit-client");
  if (activeVoiceChannel === channelId) {
    const saved = activeVoiceRoom,
      chat = document.querySelector<HTMLElement>(".chat");
    if (saved && chat) {
      const remoteAudio = document.querySelector<HTMLElement>("body > #remoteAudio");
      if (remoteAudio) saved.append(remoteAudio);
      chat.innerHTML = "";
      chat.append(saved);
    }
    return;
  }
  if (!(await requestMediaAccess("microphone"))) return;
  if (activeVoiceLeave) {
    changingVoiceChannel = true;
    try {
      await activeVoiceLeave();
    } finally {
      changingVoiceChannel = false;
    }
  }
  const host = document.querySelector<HTMLElement>(".chat") || app,
    me = currentUser!;
  const tokenResponse = await fetch(
      `${API}/livekit-token.php?channel_id=${channelId}`,
      { headers: token() ? { Authorization: `Bearer ${token()}` } : {} },
    ),
    credentials = await tokenResponse
      .json()
      .catch(() => ({ ok: false, error: "Некорректный ответ сервера" }));
  if (!tokenResponse.ok || !credentials.ok)
    throw new Error(credentials.error || "Не удалось получить токен LiveKit");
  activeVoiceChannel = channelId;
  activeVoiceMode = "livekit";
  activeVoiceMeta = { name, serverName };
  document.querySelectorAll("#voiceDockApp").forEach((node) => node.remove());
  document
    .querySelector<HTMLElement>(".profile")
    ?.insertAdjacentHTML("beforebegin", dockMarkup());
  const connectionLabel = document.querySelector<HTMLElement>(
    "#voiceConnectionLabel",
  );
  if (connectionLabel)
    connectionLabel.textContent = "Устанавливаем голосовую связь…";
  host.innerHTML = `<main class="call-screen embedded"><header class="embedded-call-header"><div><b>${esc(name)}</b><small>${esc(serverName)} · Голосовой канал</small></div><span class="online" id="roomState"><i></i>Подключение…</span></header><section class="call-stage" id="callStage">${fullscreenCallControls()}<div class="video-grid" id="videoGrid"></div></section><footer class="call-controls"><button id="callMic">${ico("mic")}</button><button id="callCamera">${ico("camera")}</button><button id="callShare">${ico("video-message")}</button><button id="callDeafen">${ico("headphones")}</button><button id="callFullscreen">${ico("focus")}</button><button id="callLeave" class="danger">${ico("phone-down")}</button></footer><div id="remoteAudio"></div></main>`;
  activeVoiceRoom = host.querySelector(".call-screen");
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    disconnectOnPageLeave: false,
  });
  const initialVoicePrefs = getVoicePreferences();
  let leaving = false,
    muted = initialVoicePrefs.muted,
    deafened = initialVoicePrefs.deafened,
    camera = false,
    sharing = false,
    mutedBeforeDeafen = localStorage.getItem(VOICE_PRE_DEAFEN_MUTE_KEY) === "1",
    heartbeat = 0,
    nativeTrack: LocalVideoTrack | null = null,
    stopNativeCapture: (() => void) | null = null;
  saveVoicePreferences(muted, deafened);
  paintVoicePreferenceButtons();
  const idOf = (p: Participant) =>
    Number(p.identity.replace(/^user_/, "")) || 0;
  const userOf = (p: Participant): User => {
    let meta: { avatar?: string } = {};
    try {
      meta = JSON.parse(p.metadata || "{}") || {};
    } catch {}
    return {
      id: idOf(p),
      name: p.name || p.identity,
      login: "",
      avatar: meta.avatar || "",
    };
  };
  const tile = (p: Participant) => {
    const id = idOf(p),
      user = p.isLocal ? me : userOf(p);
    let node = document.querySelector<HTMLElement>(
      `[data-livekit-user="${id}"]`,
    );
    if (!node) {
      node = document.createElement("article");
      node.className = `video-tile${p.isLocal ? " local-tile" : ""}`;
      node.dataset.livekitUser = String(id);
      node.innerHTML = `<video autoplay playsinline ${p.isLocal ? "muted" : ""}></video><div class="voice-avatar"><span class="avatar">${avatar(user)}</span></div><footer>${esc(user.name)}${p.isLocal ? " <small>(Вы)</small>" : ""}<i class="muted-badge" hidden>${ico("mic")}</i></footer>`;
      document.querySelector("#videoGrid")?.append(node);
    }
    return node;
  };
  const update = (p: Participant) => {
    const node = tile(p),
      mic = p.getTrackPublication(Track.Source.Microphone),
      cam = p.getTrackPublication(Track.Source.Camera),
      screen = p.getTrackPublication(Track.Source.ScreenShare),
      visual = p.isLocal && screen?.track && hideLocalScreenPreview ? cam?.track : screen?.track || cam?.track,
      video = node.querySelector<HTMLVideoElement>("video")!;
    node
      .querySelector<HTMLElement>(".muted-badge")
      ?.toggleAttribute("hidden", !!mic && !mic.isMuted);
    if (visual) {
      const current = video.srcObject as MediaStream | null;
      if (!current?.getTracks().some((track) => track.id === visual.mediaStreamTrack?.id))
        visual.attach(video);
      node.classList.add("has-video");
      node.classList.toggle("self-capture-hidden", p.isLocal && !!screen?.track && hideLocalScreenPreview);
    } else if (video.srcObject) {
      video.srcObject = null;
      node.classList.remove("has-video");
    }
  };
  const participants = () => [
    room.localParticipant,
    ...room.remoteParticipants.values(),
  ];
  const render = () => {
    const list = participants();
    list.forEach(update);
    const ids = new Set(list.map(idOf));
    document
      .querySelectorAll<HTMLElement>("[data-livekit-user]")
      .forEach((node) => {
        if (!ids.has(Number(node.dataset.livekitUser))) node.remove();
      });
    const presence = document.querySelector<HTMLElement>(
      `.voice-presence[data-channel-id="${channelId}"]`,
    );
    if (presence)
      presence.innerHTML = list
        .map((p) =>
          voicePerson({
            channel_id: channelId,
            ...userOf(p),
            muted:
              p.getTrackPublication(Track.Source.Microphone)?.isMuted ?? true,
            deafened: false,
            speaking: p.isSpeaking,
            sharing: !!p.getTrackPublication(Track.Source.ScreenShare),
            camera: !!p.getTrackPublication(Track.Source.Camera),
          }),
        )
        .join("");
    const count = document.querySelector<HTMLElement>(
      `[data-voice="${channelId}"] small`,
    );
    if (count) count.textContent = `${list.length} в голосовом`;
  };
  room.on(
    RoomEvent.TrackSubscribed,
    (track: RemoteTrack, _publication, participant: RemoteParticipant) => {
      if (track.kind === Track.Kind.Audio) {
        const element = track.attach();
        element.dataset.livekitAudio = "1";
        element.dataset.voiceUser = String(idOf(participant));
        setRemoteAudioVolume(element, Number(localStorage.getItem(`kitchat_user_volume_${idOf(participant)}`) || "100") / 100);
        setRemoteAudioMuted(element, deafened);
        const speaker = localStorage.getItem("kitchat_speaker") || "";
        if (speaker && "setSinkId" in element)
          void (
            element as HTMLMediaElement & {
              setSinkId: (id: string) => Promise<void>;
            }
          )
            .setSinkId(speaker)
            .catch(() => {});
        document.querySelector("#remoteAudio")?.append(element);
      }
      render();
    },
  );
  room
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((element) => element.remove());
      render();
    })
    .on(RoomEvent.ParticipantConnected, render)
    .on(RoomEvent.ParticipantDisconnected, render)
    .on(RoomEvent.LocalTrackPublished, render)
    .on(RoomEvent.LocalTrackUnpublished, render)
    .on(RoomEvent.TrackMuted, (_publication, p) => update(p))
    .on(RoomEvent.TrackUnmuted, (_publication, p) => update(p))
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const ids = new Set(speakers.map(idOf));
      document
        .querySelectorAll<HTMLElement>("[data-livekit-user]")
        .forEach((node) =>
          node.classList.toggle(
            "speaking",
            ids.has(Number(node.dataset.livekitUser)),
          ),
        );
      render();
    })
    .on(RoomEvent.Reconnecting, () => {
      if (connectionLabel) connectionLabel.textContent = "Переподключение…";
    })
    .on(RoomEvent.Reconnected, () => {
      if (connectionLabel)
        connectionLabel.textContent = "Голосовая связь подключена";
    })
    .on(RoomEvent.ConnectionStateChanged, (state) => {
      const el = document.querySelector<HTMLElement>("#roomState");
      if (el)
        el.lastChild!.textContent =
          state === ConnectionState.Connected
            ? "Подключено"
            : state === ConnectionState.Reconnecting
              ? "Переподключение…"
              : "Подключение…";
    });
  const publishPresence = async () => {
    const result = await community(
      {},
      {
        action: "voice_state",
        channel_id: channelId,
        muted: muted ? 1 : 0,
        deafened: deafened ? 1 : 0,
        speaking: room.localParticipant.isSpeaking ? 1 : 0,
        sharing: sharing ? 1 : 0,
        camera: camera ? 1 : 0,
      },
    ).catch(() => null);
    if (result && result.connected === false && !leaving) await leave();
  };
  const stopSharing = async () => {
    if (nativeTrack) {
      await room.localParticipant
        .unpublishTrack(nativeTrack, true)
        .catch(() => {});
      nativeTrack = null;
    }
    stopNativeCapture?.();
    stopNativeCapture = null;
    hideLocalScreenPreview = false;
    sharing = false;
    document.querySelector("#callShare")?.classList.remove("on");
  };
  const leave = async () => {
    if (leaving) return;
    leaving = true;
    stopVoiceDuration();
    window.clearInterval(heartbeat);
    await community({}, { action: "voice_leave", channel_id: channelId }).catch(
      () => {},
    );
    await stopSharing();
    await room.localParticipant.setCameraEnabled(false).catch(() => {});
    await room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
    await room.disconnect();
    document.querySelector("body > #remoteAudio")?.remove();
    document.querySelector("#voiceDockApp")?.remove();
    activeVoiceChannel = 0;
    activeVoiceSetMuted = null;
    activeVoiceLeave =
      activeVoiceMute =
      activeVoiceDeafen =
      activeVoiceCamera =
      activeVoiceShare =
        null;
    activeVoiceMeta = null;
    activeVoiceMode = null;
    activeVoiceSetUserVolume = null;
    activeVoiceRoom = null;
    if (!changingVoiceChannel) await shellView(serverId, "");
  };
  activeVoiceLeave = leave;
  const mute = async () => {
    if (deafened && muted) return;
    muted = !muted;
    saveVoicePreferences(muted, deafened);
    await room.localParticipant.setMicrophoneEnabled(!muted, {
      deviceId: localStorage.getItem("kitchat_microphone") || undefined,
    });
    document
      .querySelectorAll("#callMic,#selfMute")
      .forEach((el) => el.classList.toggle("off", muted));
    paintVoicePreferenceButtons();
    void publishPresence();
    render();
  };
  activeVoiceMute = mute;
  activeVoiceSetMuted = async (next) => {
    if (muted !== next) await mute();
  };
  const deafen = async () => {
    deafened = !deafened;
    if (deafened) {
      mutedBeforeDeafen = muted;
      localStorage.setItem(VOICE_PRE_DEAFEN_MUTE_KEY, mutedBeforeDeafen ? "1" : "0");
      if (!muted) await mute();
    } else if (!mutedBeforeDeafen && muted) await mute();
    saveVoicePreferences(muted, deafened);
    paintVoicePreferenceButtons();
    document
      .querySelectorAll("#callDeafen,#selfDeafen")
      .forEach((el) => el.classList.toggle("off", deafened));
    document
      .querySelectorAll<HTMLMediaElement>("[data-livekit-audio]")
      .forEach((el) => setRemoteAudioMuted(el, deafened));
    void publishPresence();
  };
  activeVoiceDeafen = deafen;
  activeVoiceSetUserVolume = (userId, volume) => {
    document.querySelectorAll<HTMLMediaElement>(`[data-livekit-audio][data-voice-user="${userId}"]`).forEach((element) => setRemoteAudioVolume(element, volume));
  };
  const cameraToggle = async () => {
    if (!camera && !(await requestMediaAccess("camera"))) return;
    camera = !camera;
    try {
      await room.localParticipant.setCameraEnabled(camera, {
        deviceId: localStorage.getItem("kitchat_camera") || undefined,
      });
      if (camera) localStorage.setItem("kitchat_camera_granted", "1");
    } catch (error) {
      camera = false;
      throw error;
    }
    document.querySelector("#callCamera")?.classList.toggle("on", camera);
    void publishPresence();
    render();
  };
  activeVoiceCamera = cameraToggle;
  const shareToggle = async () => {
    if (sharing) {
      await stopSharing();
      void publishPresence();
      render();
      return;
    }
    const choice = await capturePicker();
    if (!choice) return;
    hideLocalScreenPreview = /kitchat/i.test(choice.title);
    const capture = await nativeCapture(choice);
    nativeTrack = new LocalVideoTrack(capture.track);
    stopNativeCapture = capture.stop;
    capture.track.onended = () => void shareToggle();
    try {
      await room.localParticipant.publishTrack(nativeTrack, {
        source: Track.Source.ScreenShare,
        videoEncoding: {
          maxBitrate: choice.height >= 1080 ? 5_000_000 : 2_500_000,
          maxFramerate: choice.fps,
        },
      });
      sharing = true;
      document.querySelector("#callShare")?.classList.add("on");
      playSound("share");
      void publishPresence();
      render();
    } catch (error) {
      capture.stop();
      nativeTrack = null;
      stopNativeCapture = null;
      throw error;
    }
  };
  activeVoiceShare = shareToggle;
  document.querySelector<HTMLButtonElement>("#callMic")!.onclick = () =>
    void mute();
  document.querySelector<HTMLButtonElement>("#callDeafen")!.onclick = () =>
    void deafen();
  document.querySelector<HTMLButtonElement>("#callCamera")!.onclick = () =>
    void cameraToggle();
  document.querySelector<HTMLButtonElement>("#callShare")!.onclick = () =>
    void shareToggle();
  document.querySelector<HTMLButtonElement>("#callLeave")!.onclick = () =>
    void leave();
  document.querySelector<HTMLButtonElement>("#callFullscreen")!.onclick = () =>
    void document.querySelector<HTMLElement>("#callStage")?.requestFullscreen();
  document.querySelector<HTMLButtonElement>("#voiceDockLeave")!.onclick = () =>
    void leave();
  document.querySelector<HTMLButtonElement>("#voiceQuality")!.onclick = (
    event,
  ) => {
    event.stopPropagation();
    const popover = document.querySelector<HTMLElement>("#voiceQualityPopover");
    if (popover) popover.hidden = !popover.hidden;
  };
  document
    .querySelectorAll<HTMLButtonElement>(".voice-dock-actions button")
    .forEach(
      (button, index) =>
        (button.onclick = () => void [cameraToggle, shareToggle][index]?.()),
    );
  try {
    await community({}, { action: "voice_join", channel_id: channelId });
    await room.connect(credentials.url, credentials.token, {
      autoSubscribe: true,
    });
    await room.localParticipant.setMicrophoneEnabled(!muted, {
      deviceId: localStorage.getItem("kitchat_microphone") || undefined,
      noiseSuppression: localStorage.getItem("kitchat_noise") !== "0",
      echoCancellation: localStorage.getItem("kitchat_echo") !== "0",
    });
    localStorage.setItem("kitchat_microphone_granted", "1");
    saveVoicePreferences(muted, deafened);
    paintVoicePreferenceButtons();
    if (localStorage.getItem("kitchat_input_mode") === "ptt")
      await activeVoiceSetMuted?.(true);
    heartbeat = window.setInterval(() => void publishPresence(), 5000);
    void publishPresence();
    if (connectionLabel)
      connectionLabel.textContent = "Голосовая связь подключена";
    document.querySelector<HTMLElement>("#voiceDockApp")!.dataset.connection =
      "connected";
    render();
  } catch (error) {
    window.clearInterval(heartbeat);
    await community({}, { action: "voice_leave", channel_id: channelId }).catch(
      () => {},
    );
    room.disconnect();
    activeVoiceChannel = 0;
    activeVoiceMode = null;
    activeVoiceLeave = null;
    if (connectionLabel)
      connectionLabel.textContent = "Не удалось подключиться";
    throw error;
  }
}
async function callView(
  channelId: number,
  name: string,
  serverName: string,
  serverId = 0,
  voiceMode: "p2p" | "livekit" = "p2p",
) {
  if (!LIVEKIT_ENABLED) voiceMode = "p2p";
  if (activeVoiceChannel === channelId) {
    return voiceMode === "p2p"
      ? callViewP2P(channelId, name, serverName, serverId)
      : callViewLiveKit(channelId, name, serverName, serverId);
  }
  // Сначала полностью завершаем медиасоединение, затем удаляем серверное
  // присутствие из каждого канала и только после этого создаём новое.
  if (activeVoiceLeave) {
    changingVoiceChannel = true;
    try { await activeVoiceLeave(); } finally { changingVoiceChannel = false; }
  }
  document.querySelectorAll<HTMLElement>(".voice-presence").forEach((presence) => {
    presence.querySelectorAll(`[data-voice-person="${currentUser?.id || 0}"]`).forEach((node) => node.remove());
  });
  await Promise.all(knownVoiceChannelIds.map((id) =>
    community({}, { action: "voice_leave", channel_id: id }).catch(() => {}),
  ));
  return voiceMode === "p2p"
    ? callViewP2P(channelId, name, serverName, serverId)
    : callViewLiveKit(channelId, name, serverName, serverId);
}

async function callViewP2P(
  channelId: number,
  name: string,
  serverName: string,
  serverId = 0,
) {
  if (activeVoiceChannel === channelId) {
    const chat = document.querySelector<HTMLElement>(".chat");
    if (activeVoiceRoom && chat) { chat.innerHTML = ""; chat.append(activeVoiceRoom); }
    return;
  }
  if (!(await requestMediaAccess("microphone"))) return;
  if (activeVoiceLeave) {
    changingVoiceChannel = true;
    try { await activeVoiceLeave(); } finally { changingVoiceChannel = false; }
  }
  const host = document.querySelector<HTMLElement>(".chat") || app;
  const me = currentUser!;
  const local = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: localStorage.getItem("kitchat_microphone") || undefined,
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48_000 },
      sampleSize: { ideal: 16 },
      noiseSuppression: localStorage.getItem("kitchat_noise") !== "0",
      echoCancellation: localStorage.getItem("kitchat_echo") !== "0",
      autoGainControl: localStorage.getItem("kitchat_gain") !== "0",
    },
    video: false,
  });
  localStorage.setItem("kitchat_microphone_granted", "1");
  activeVoiceChannel = channelId;
  activeVoiceMode = "p2p";
  activeVoiceMeta = { name, serverName };
  paintActiveVoiceChannel();
  document.querySelectorAll("#voiceDockApp").forEach((node) => node.remove());
  document.querySelector<HTMLElement>(".profile")?.insertAdjacentHTML("beforebegin", dockMarkup());
  host.innerHTML = `<main class="call-screen embedded p2p-call"><header class="embedded-call-header"><div><b>${esc(name)}</b><small>${esc(serverName)} · P2P · Камера и демонстрация экрана</small></div><span class="online" id="roomState"><i></i>Подключение…</span></header><section class="call-stage" id="callStage">${fullscreenCallControls()}<div class="p2p-screen-grid" id="p2pScreens"></div><div class="video-grid voice-only-grid" id="videoGrid"></div><aside class="roulette-panel" id="roulettePanel" hidden><header><div><small>ВЕЧЕРНИЙ ХАОС</small><b>Рулетка ников</b></div><button type="button" id="rouletteClose" aria-label="Закрыть">×</button></header><div class="roulette-live" id="rouletteLive"><div class="roulette-machine" id="rouletteMachine"><div class="roulette-machine-light"></div><div class="roulette-reel-block word-reel"><small>СЛОВО</small><div class="roulette-reel-window"><div class="roulette-reel-edge top"></div><div class="roulette-reel-track" id="rouletteWordReel"><span class="roulette-reel-ghost" data-reel-prev>—</span><b data-reel-current>Добавьте слова</b><span class="roulette-reel-ghost" data-reel-next>—</span></div><div class="roulette-reel-focus"></div></div></div><div class="roulette-link">×</div><div class="roulette-reel-block user-reel"><small>УЧАСТНИК</small><div class="roulette-reel-window"><div class="roulette-reel-edge top"></div><div class="roulette-reel-track" id="rouletteUserReel"><span class="roulette-reel-ghost" data-reel-prev>—</span><b data-reel-current>Кто попадётся?</b><span class="roulette-reel-ghost" data-reel-next>—</span></div><div class="roulette-reel-focus"></div></div></div><div class="roulette-spin-status" id="rouletteSpinStatus">Готовы к хаосу</div></div><div class="roulette-result" id="rouletteResult" aria-live="polite"></div></div><div class="roulette-locked" id="rouletteLocked"></div><form class="roulette-word-form" id="rouletteWordForm"><label><span>Слово / ник</span><input name="word" maxlength="32" placeholder="например: ПЕЛЬМЕНЬ" required></label><div class="roulette-form-row"><label><span>На сколько</span><select name="duration"><option value="30">30 сек</option><option value="60" selected>1 мин</option><option value="180">3 мин</option><option value="300">5 мин</option><option value="600">10 мин</option></select></label><label class="roulette-color"><span>Цвет</span><input name="color" type="color" value="#a970ff"></label><button type="submit">Добавить</button></div></form><div class="roulette-word-list" id="rouletteWordList"></div><button type="button" class="roulette-spin" id="rouletteSpin">КРУТИТЬ РУЛЕТКУ</button><div class="roulette-history" id="rouletteHistory"></div></aside></section><footer class="call-controls"><button id="callMic" title="Выключить микрофон">${ico("mic")}</button><button id="callCamera" title="Включить камеру">${ico("camera")}</button><button id="callShare" title="Демонстрация экрана">${ico("video-message")}</button><button id="callRoulette" title="Рулетка ников">🎡</button><button id="callDeafen" title="Не слышать других">${ico("headphones")}</button><button id="callFullscreen" title="Развернуть сцену">${ico("focus")}</button><button id="callLeave" class="danger" title="Отключиться">${ico("phone-down")}</button></footer><div id="remoteAudio"></div></main>`;
  activeVoiceRoom = host.querySelector(".call-screen");
  const callHeader = host.querySelector<HTMLElement>(".embedded-call-header")!;
  const roomState = host.querySelector<HTMLElement>("#roomState")!;
  const callHeaderActions = document.createElement("div");
  callHeaderActions.className = "call-header-actions";
  const gridViewButton = document.createElement("button");
  gridViewButton.type = "button";
  gridViewButton.id = "callGridView";
  gridViewButton.hidden = true;
  gridViewButton.innerHTML = `${ico("grid_view")}<span>Сетка</span>`;
  callHeaderActions.append(gridViewButton, roomState);
  callHeader.append(callHeaderActions);
  const shareControl = host.querySelector("#callShare");
  shareControl?.insertAdjacentHTML("afterend", '<label class="stream-fps-control"><span>Трансляция</span><select id="streamFps" aria-label="Частота кадров трансляции"><option value="15">15 FPS</option><option value="30">30 FPS</option><option value="60">60 FPS</option></select></label>');
  const fpsSelect = host.querySelector<HTMLSelectElement>("#streamFps")!;
  fpsSelect.value = String(streamProfile(localStorage.getItem("kitchat_stream_fps"), false).fps);
  fpsSelect.onchange = () => {
    localStorage.setItem("kitchat_stream_fps", fpsSelect.value);
    showAppNotice("Качество трансляции", lowResourceMode() ? "В экономии ресурсов действует ограничение 15 FPS. Выключите её для 60 FPS." : "Частота кадров применится при следующем запуске трансляции.");
  };
  const peers = new Map<number, RTCPeerConnection>();
  const cameraPeers = new Map<number, RTCPeerConnection>();
  const cameraOfferTasks = new Map<number, Promise<void>>();
  const pendingCameraIce = new Map<number, RTCIceCandidateInit[]>();
  const remoteCameraStreams = new Map<number, MediaStream>();
  const cameraPeerStartedAt = new Map<number, number>();
  const cameraRecoveryTimers = new Map<number, number>();
  const cameraSyncRequestedAt = new Map<number, number>();
  // Camera media shares the already established voice transport. Some NATs
  // allow the first P2P allocation (voice) but keep a second, independent
  // camera PeerConnection in ICE checking forever.
  const cameraVoiceSenders = new Map<number, RTCRtpSender>();
  const remoteCameraStreamIds = new Map<number, string>();
  let cameraStream: MediaStream | null = null;
  let camera = false;
  let focusedUserId: number | null = null;
  const peerOffers = new Map<number, (iceRestart?: boolean) => Promise<void>>();
  const pendingPeerRenegotiations = new Map<number, number>();
  const pendingIce = new Map<number, RTCIceCandidateInit[]>();
  const peerStartedAt = new Map<number, number>();
  const screenRequestAt = new Map<number, number>();
  const screenAnnouncedTo = new Set<number>();
  const screenWatchers = new Set<number>();
  const watchingScreens = new Set<number>();
  const nativeScreenPeers = new Map<number, RTCPeerConnection>();
  const nativeScreenDebugTimers = new Map<number, number>();
  const nativeScreenReconnectTimers = new Map<number, number>();
  const nativeScreenHealthTimers = new Map<number, number>();
  const nativeScreenReconnectAttempts = new Map<number, number>();
  const pendingNativeStreamerIce = new Map<number, RTCIceCandidateInit[]>();
  const screenAudioSenders = new Map<number, RTCRtpSender>();
  const fallbackScreenSenders = new Map<number, RTCRtpSender>();
  const remoteScreenModes = new Map<number, "native" | "webrtc">();
  let screenAudioCapture: Awaited<ReturnType<typeof startSystemAudioTrack>> | null = null;
  let screenAudioStream: MediaStream | null = null;
  type CompatibleScreenCapture = { track: MediaStreamTrack; stop: () => void };
  let fallbackScreenCapture: CompatibleScreenCapture | null = null;
  let fallbackScreenStream: MediaStream | null = null;
  let compatibleScreenIsWebView = false;
  let sharingMode: "native" | "webrtc" | null = null;
  type NativeViewerQuality = { at: number; lossPct: number; jitterMs: number; rttMs: number; fps: number; packets: number; bytes: number };
  const nativeViewerQuality = new Map<number, NativeViewerQuality>();
  let nativeAdaptiveTimer = 0;
  let nativeAdaptiveChoice: CaptureChoice | null = null;
  let nativeAdaptiveLevel = 0;
  let nativeAdaptiveBadTicks = 0;
  let nativeAdaptiveGoodTicks = 0;
  let nativeAdaptivePrev: { at: number; encoded: number; captured: number; dropped: number } | null = null;
  let nativeLocalDebugTimer = 0;
  let nativeLocalPreviewPc: RTCPeerConnection | null = null;
  let nativeLocalDebugPrev: { at: number; captured: number; encoded: number; writer: number; bytes: number } | null = null;
  type NativeStreamDebugStatus = {
    running: boolean; viewers: number; current_fps: number; current_bitrate: number; captured_frames: number; encoded_frames: number; encoded_bytes: number;
    dropped_frames: number; writer_samples: number; writer_bytes: number; writer_errors: number;
    h264_sps_frames: number; h264_pps_frames: number; h264_idr_frames: number; h264_last_nal_mask: number;
    last_error?: string | null;
  };
  const ensureNativeDebugBox = (tile: HTMLElement, className = "native-stream-debug") => {
    let box = tile.querySelector<HTMLElement>(`.${className}`);
    if (!box) {
      box = document.createElement("pre");
      box.className = className;
      tile.append(box);
    }
    return box;
  };
  const stopNativeViewerDebug = (id: number) => {
    const timer = nativeScreenDebugTimers.get(id);
    if (timer) window.clearInterval(timer);
    nativeScreenDebugTimers.delete(id);
  };
  const startNativeViewerDebug = (id: number, pc: RTCPeerConnection) => {
    stopNativeViewerDebug(id);
    let lastQualitySignalAt = 0;
    const update = async () => {
      const tile = document.querySelector<HTMLElement>(`[data-p2p-screen="${id}"]`);
      if (!tile) return;
      const box = ensureNativeDebugBox(tile);
      try {
        const stats = await pc.getStats();
        let inbound: any = null, pair: any = null, codec: any = null;
        stats.forEach((report: any) => {
          if (report.type === "inbound-rtp" && report.kind === "video") inbound = report;
          if (report.type === "candidate-pair" && report.state === "succeeded" && (report.nominated || report.selected)) pair = report;
        });
        if (inbound?.codecId) codec = stats.get(inbound.codecId);
        const loss = inbound ? Number(inbound.packetsLost || 0) : 0;
        const received = inbound ? Number(inbound.packetsReceived || 0) : 0;
        const lossPct = received + Math.max(0, loss) > 0 ? Math.max(0, loss) * 100 / (received + Math.max(0, loss)) : 0;
        const jitterMs = inbound?.jitter != null ? Math.round(Number(inbound.jitter) * 1000) : 0;
        const rttMs = pair?.currentRoundTripTime != null ? Math.round(Number(pair.currentRoundTripTime) * 1000) : 0;
        const decodedFps = Math.round(Number(inbound?.framesPerSecond || 0));
        if (inbound && pc.connectionState === "connected" && Date.now() - lastQualitySignalAt >= 2200) {
          lastQualitySignalAt = Date.now();
          void signal(id, { kind: "native-screen-quality", lossPct, jitterMs, rttMs, fps: decodedFps, packets: received, bytes: Number(inbound.bytesReceived || 0) }).catch(() => {});
        }
        box.textContent = [
          `P2P: ${pc.connectionState} / ICE ${pc.iceConnectionState}`,
          `Track: ${inbound ? "VIDEO RTP OK" : "waiting RTP"}${codec?.mimeType ? ` · ${codec.mimeType}` : ""}`,
          `Packets: ${inbound?.packetsReceived ?? 0} · Loss: ${loss} · Jitter: ${jitterMs} ms`,
          `Decoded: ${inbound?.framesDecoded ?? 0} · FPS: ${decodedFps}`,
          `RTT: ${rttMs || "—"} ms · Bytes: ${Math.round(Number(inbound?.bytesReceived || 0) / 1024)} KB`,
        ].join("\n");
      } catch (error) {
        box.textContent = `Viewer stats error: ${String(error)}`;
      }
    };
    void update();
    nativeScreenDebugTimers.set(id, window.setInterval(() => void update(), 1000));
  };
  const startNativeLocalDebug = () => {
    if (nativeLocalDebugTimer) window.clearInterval(nativeLocalDebugTimer);
    nativeLocalDebugPrev = null;
    const update = async () => {
      const tile = document.querySelector<HTMLElement>('[data-p2p-screen="self"]');
      if (!tile) return;
      const box = ensureNativeDebugBox(tile);
      try {
        const status = await invoke<NativeStreamDebugStatus>("native_stream_status");
        const now = performance.now();
        const prev = nativeLocalDebugPrev;
        const seconds = prev ? Math.max(.001, (now - prev.at) / 1000) : 1;
        const capturedFps = prev ? Math.round((status.captured_frames - prev.captured) / seconds) : 0;
        const encodedFps = prev ? Math.round((status.encoded_frames - prev.encoded) / seconds) : 0;
        const writerFps = prev ? Math.round((status.writer_samples - prev.writer) / seconds) : 0;
        const mbps = prev ? ((status.writer_bytes - prev.bytes) * 8 / seconds / 1_000_000).toFixed(2) : "0.00";
        nativeLocalDebugPrev = { at: now, captured: status.captured_frames, encoded: status.encoded_frames, writer: status.writer_samples, bytes: status.writer_bytes };
        const nalNames: string[] = [];
        for (const [type, name] of [[1, "P"], [5, "IDR"], [6, "SEI"], [7, "SPS"], [8, "PPS"], [9, "AUD"]] as Array<[number,string]>) {
          if ((status.h264_last_nal_mask & (2 ** type)) !== 0) nalNames.push(name);
        }
        let localWebrtc = "Local WebRTC: not started";
        const previewPc = nativeLocalPreviewPc;
        if (previewPc) {
          try {
            const stats = await previewPc.getStats();
            let inbound: any = null, codec: any = null, pair: any = null;
            stats.forEach((report: any) => {
              if (report.type === "inbound-rtp" && (report.kind === "video" || report.mediaType === "video")) inbound = report;
              if (report.type === "candidate-pair" && report.state === "succeeded" && (report.nominated || report.selected)) pair = report;
            });
            if (inbound?.codecId) codec = stats.get(inbound.codecId);
            const video = tile.querySelector<HTMLVideoElement>("video");
            localWebrtc = [
              `Local WebRTC: ${previewPc.connectionState} / ICE ${previewPc.iceConnectionState}`,
              `RTP: ${inbound?.packetsReceived ?? 0} pkt · ${Math.round(Number(inbound?.bytesReceived || 0) / 1024)} KB · codec ${codec?.mimeType || "—"}`,
              `Decode: recv ${inbound?.framesReceived ?? 0} · decoded ${inbound?.framesDecoded ?? 0} · key ${inbound?.keyFramesDecoded ?? 0} · drop ${inbound?.framesDropped ?? 0}`,
              `Video: ${video?.videoWidth || 0}x${video?.videoHeight || 0} · readyState ${video?.readyState ?? "—"} · RTT ${pair?.currentRoundTripTime != null ? Math.round(Number(pair.currentRoundTripTime) * 1000) : "—"} ms`,
            ].join("\n");
          } catch (error) { localWebrtc = `Local WebRTC stats error: ${String(error)}`; }
        }
        box.textContent = [
          `WGC: ${capturedFps} fps (${status.captured_frames})`,
          `H.264 encoder: ${encodedFps} fps (${status.encoded_frames})`,
          `WebRTC writer: ${writerFps} fps · ${mbps} Mbps`,
          `Adaptive: ${status.current_fps || "—"} FPS · ${status.current_bitrate ? (status.current_bitrate / 1_000_000).toFixed(1) : "—"} Mbps · level ${nativeAdaptiveLevel}`,
          `H264: SPS ${status.h264_sps_frames} · PPS ${status.h264_pps_frames} · IDR ${status.h264_idr_frames} · last [${nalNames.join(",") || "—"}]`,
          `Viewers: ${status.viewers} · Drop: ${status.dropped_frames} · Writer errors: ${status.writer_errors}`,
          status.last_error ? `ERROR: ${status.last_error}` : "Pipeline: OK",
          localWebrtc,
        ].join("\n");
      } catch (error) {
        box.textContent = `Native status error: ${String(error)}`;
      }
    };
    void update();
    nativeLocalDebugTimer = window.setInterval(() => void update(), 1000);
  };
  const stopNativeLocalDebug = () => {
    if (nativeLocalDebugTimer) window.clearInterval(nativeLocalDebugTimer);
    nativeLocalDebugTimer = 0; nativeLocalDebugPrev = null;
  };
  let after = 0, pollTimer = 0, meterTimer = 0, heartbeatTimer = 0, leaving = false;
  let missingSelfPolls = 0;
  const initialVoicePrefs = getVoicePreferences();
  let muted = initialVoicePrefs.muted, deafened = initialVoicePrefs.deafened, mutedBeforeDeafen = localStorage.getItem(VOICE_PRE_DEAFEN_MUTE_KEY) === "1", speaking = false, sharing = false;
  local.getAudioTracks().forEach((track) => { track.enabled = !muted; track.contentHint = "speech"; });
  saveVoicePreferences(muted, deafened);
  paintVoicePreferenceButtons();
  let iceServers: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] }];
  try {
    const turn = await fetch(`${API}/turn_credentials.php`, { headers: token() ? { Authorization: `Bearer ${token()}` } : {} }).then((response) => response.json());
    if (turn.ok && turn.iceServer) iceServers.push(turn.iceServer);
  } catch {}
  const signal = (to: number, payload: unknown) => community({}, {
    action: "voice_signal", channel_id: channelId, to, payload: JSON.stringify(payload),
  });
  const tuneVoiceSdp = (description: RTCSessionDescriptionInit, bitrate = 64_000): RTCSessionDescriptionInit => {
    if (!description.sdp) return description;
    const opusMatch = description.sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
    if (!opusMatch) return description;
    const payload = opusMatch[1];
    const additions = `minptime=10;useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;maxaveragebitrate=${bitrate};maxplaybackrate=48000`;
    const fmtpPattern = new RegExp(`a=fmtp:${payload} ([^\\r\\n]*)`, "i");
    const sdp = fmtpPattern.test(description.sdp)
      ? description.sdp.replace(fmtpPattern, (_line, values: string) => `a=fmtp:${payload} ${values};${additions}`)
      : description.sdp.replace(new RegExp(`(a=rtpmap:${payload} opus/48000/2\\r?\\n)`, "i"), `$1a=fmtp:${payload} ${additions}\r\n`);
    return { type: description.type, sdp };
  };
  let voiceNetworkTimer = 0;
  let voiceNetworkLevel = 0;
  let voiceBadTicks = 0;
  let voiceGoodTicks = 0;
  let voiceRealRtt = 0;
  let voiceRealLoss = 0;
  let voiceRealJitter = 0;
  const voiceBitrates = [64_000, 48_000, 32_000, 24_000];
  const configureVoiceSender = async (sender: RTCRtpSender) => {
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0].maxBitrate = voiceBitrates[voiceNetworkLevel];
    parameters.encodings[0].priority = "high";
    (parameters.encodings[0] as RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType }).networkPriority = "high";
    await sender.setParameters(parameters).catch(() => {});
  };
  const applyVoiceNetworkLevel = async (level: number) => {
    const next = Math.max(0, Math.min(voiceBitrates.length - 1, level));
    if (next === voiceNetworkLevel) return;
    voiceNetworkLevel = next; voiceBadTicks = 0; voiceGoodTicks = 0;
    await Promise.all([...peers.values()].flatMap((pc) => pc.getSenders().filter((sender) => sender.track?.kind === "audio").map(configureVoiceSender)));
    await Promise.all([...cameraPeers.values()].flatMap((pc) => pc.getSenders().filter((sender) => sender.track?.kind === "video").map(async (sender) => {
      const parameters = sender.getParameters();
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      parameters.encodings[0].maxBitrate = lowResourceMode() ? 300_000 : next >= 3 ? 220_000 : next === 2 ? 350_000 : next === 1 ? 600_000 : 1_000_000;
      parameters.encodings[0].maxFramerate = lowResourceMode() || next >= 2 ? 15 : 30;
      parameters.encodings[0].priority = "low";
      await sender.setParameters(parameters).catch(() => {});
    })));
  };
  // Game activity is global and server-backed; it is not sent through voice signaling.

  const adaptiveProfile = (choice: CaptureChoice, level: number) => {
    const baseFps = choice.fps >= 60 ? 60 : choice.fps >= 30 ? 30 : 15;
    const factors = [1, 0.78, 0.58, 0.40, 0.27];
    // A high configured frame rate is the common failure mode on hybrid and
    // older laptops. Lower the capture cadence at the first sustained problem
    // instead of spending several adaptation rounds lowering bitrate only.
    const fps = baseFps >= 60 && level >= 1 ? 30 : baseFps >= 30 && level >= 1 ? 15 : baseFps;
    const bitrate = Math.max(900_000, Math.round(choice.bitrate * factors[Math.min(level, factors.length - 1)]));
    return { fps, bitrate };
  };
  const stopNativeAdaptive = () => {
    if (nativeAdaptiveTimer) window.clearInterval(nativeAdaptiveTimer);
    nativeAdaptiveTimer = 0; nativeAdaptiveChoice = null; nativeAdaptiveLevel = 0;
    nativeAdaptiveBadTicks = 0; nativeAdaptiveGoodTicks = 0; nativeAdaptivePrev = null; nativeViewerQuality.clear();
  };
  const applyNativeAdaptiveLevel = async (level: number) => {
    const choice = nativeAdaptiveChoice;
    if (!choice || sharingMode !== "native" || !sharing) return;
    const next = Math.max(0, Math.min(4, level));
    if (next === nativeAdaptiveLevel) return;
    const profile = adaptiveProfile(choice, next);
    try {
      await invoke("native_stream_reconfigure", { fps: profile.fps, bitrate: profile.bitrate });
      nativeAdaptiveLevel = next; nativeAdaptiveBadTicks = 0; nativeAdaptiveGoodTicks = 0; nativeAdaptivePrev = null;
      console.info(`[Kitchat adaptive] level ${next}: ${profile.fps} FPS / ${(profile.bitrate / 1_000_000).toFixed(1)} Mbps`);
    } catch (error) { console.warn("Adaptive stream reconfigure failed", error); }
  };
  const startNativeAdaptive = (choice: CaptureChoice) => {
    stopNativeAdaptive();
    nativeAdaptiveChoice = choice; nativeAdaptiveLevel = 0;
    const tick = async () => {
      if (!sharing || sharingMode !== "native" || !nativeAdaptiveChoice) return;
      try {
        const status = await invoke<NativeStreamDebugStatus>("native_stream_status");
        const now = performance.now();
        let recentDrops = 0;
        if (nativeAdaptivePrev) {
          recentDrops = Math.max(0, status.dropped_frames - nativeAdaptivePrev.dropped);
        }
        nativeAdaptivePrev = { at: now, encoded: status.encoded_frames, captured: status.captured_frames, dropped: status.dropped_frames };
        const fresh = [...nativeViewerQuality.values()].filter((q) => Date.now() - q.at < 5500);
        const worstLoss = fresh.reduce((m, q) => Math.max(m, q.lossPct), 0);
        const worstRtt = fresh.reduce((m, q) => Math.max(m, q.rttMs), 0);
        const worstJitter = fresh.reduce((m, q) => Math.max(m, q.jitterMs), 0);
        // A software encoder deliberately emits fewer frames than WGC receives,
        // and a static source may emit almost none. Only real queue drops mean
        // local pressure; decoded FPS alone is not evidence of bad networking.
        const localPressure = recentDrops >= 5;
        const networkBad = worstLoss >= 6 || worstRtt >= 240 || worstJitter >= 45;
        const networkVeryBad = worstLoss >= 12 || worstRtt >= 450 || worstJitter >= 90;
        if (localPressure || networkBad) { nativeAdaptiveBadTicks += networkVeryBad ? 2 : 1; nativeAdaptiveGoodTicks = 0; }
        else { nativeAdaptiveGoodTicks += 1; nativeAdaptiveBadTicks = Math.max(0, nativeAdaptiveBadTicks - 1); }
        if (nativeAdaptiveBadTicks >= 2 && nativeAdaptiveLevel < 4) await applyNativeAdaptiveLevel(nativeAdaptiveLevel + 1);
        else if (nativeAdaptiveGoodTicks >= 7 && nativeAdaptiveLevel > 0) await applyNativeAdaptiveLevel(nativeAdaptiveLevel - 1);
      } catch (error) { console.warn("Adaptive stream monitor failed", error); }
    };
    void tick(); nativeAdaptiveTimer = window.setInterval(() => void tick(), 2500);
  };

  // --- Synchronized nickname roulette ------------------------------------
  type RouletteWord = { id: string; text: string; duration: number; color: string; creatorId: number; creatorName: string };
  type RouletteLock = { userId: number; word: string; color: string; duration: number; expiresAt: number };
  type RouletteHistory = { at: number; userId: number; originalName: string; word: string; color: string; duration: number };
  const rouletteWords = new Map<string, RouletteWord>();
  const rouletteLocks = new Map<number, RouletteLock>();
  const rouletteHistory: RouletteHistory[] = [];
  const rouletteKnownUsers = new Set<number>();
  let rouletteUsers: VoiceUser[] = [];
  let rouletteRevision = Date.now();
  let rouletteSpinning = false;
  let rouletteTickTimer = 0;
  const roulettePanel = document.querySelector<HTMLElement>("#roulettePanel")!;
  const rouletteBroadcast = async (payload: unknown) => {
    await Promise.all(rouletteUsers.filter((user) => user.id !== me.id).map((user) => signal(user.id, payload).catch(() => {})));
  };
  const rouletteDisplayName = (user: VoiceUser) => {
    const lock = rouletteLocks.get(user.id);
    if (lock && lock.expiresAt > Date.now()) return { name: lock.word, color: lock.color, original: user.name };
    if (lock) rouletteLocks.delete(user.id);
    return { name: user.name, color: "", original: user.name };
  };
  const rouletteSnapshot = () => ({
    kind: "roulette-state",
    revision: rouletteRevision,
    words: [...rouletteWords.values()],
    locks: [...rouletteLocks.values()].filter((lock) => lock.expiresAt > Date.now()).map((lock) => ({ ...lock, remaining: Math.max(0, lock.expiresAt - Date.now()) })),
    history: rouletteHistory.slice(0, 8),
    activeSpin: rouletteActiveSpin && (rouletteActiveSpin.startAt + rouletteActiveSpin.totalMs > Date.now() - 1500) ? rouletteActiveSpin : null,
  });
  const renderRoulette = () => {
    const now = Date.now();
    for (const [id, lock] of rouletteLocks) if (lock.expiresAt <= now) rouletteLocks.delete(id);
    const list = document.querySelector<HTMLElement>("#rouletteWordList");
    if (list) list.innerHTML = rouletteWords.size ? [...rouletteWords.values()].map((word) => `<div class="roulette-word" style="--roulette-color:${esc(word.color)}"><i></i><span><b>${esc(word.text)}</b><small>${word.duration < 60 ? `${word.duration} сек` : `${Math.round(word.duration / 60)} мин`} · ${esc(word.creatorName)}</small></span>${word.creatorId === me.id ? `<button type="button" data-roulette-remove="${esc(word.id)}" title="Удалить">×</button>` : ""}</div>`).join("") : `<div class="roulette-empty">Пока нет слов. Добавьте первое 👀</div>`;
    list?.querySelectorAll<HTMLButtonElement>("[data-roulette-remove]").forEach((button) => button.onclick = () => {
      const id = button.dataset.rouletteRemove || "";
      if (!rouletteWords.has(id)) return;
      rouletteWords.delete(id); rouletteRevision = Date.now(); renderRoulette(); void rouletteBroadcast({ kind: "roulette-word-remove", id, revision: rouletteRevision });
    });
    const locked = document.querySelector<HTMLElement>("#rouletteLocked");
    const activeLocks = [...rouletteLocks.values()].filter((lock) => lock.expiresAt > now);
    if (locked) locked.innerHTML = activeLocks.length ? `<small>Сейчас отдыхают от рулетки</small><div>${activeLocks.map((lock) => { const user = rouletteUsers.find((item) => item.id === lock.userId); const left = Math.max(1, Math.ceil((lock.expiresAt - now) / 1000)); return `<span style="--roulette-color:${esc(lock.color)}"><i></i><b>${esc(lock.word)}</b><small>${esc(user?.name || "Участник")} · ${left}с</small></span>`; }).join("")}</div>` : "";
    const history = document.querySelector<HTMLElement>("#rouletteHistory");
    if (history) history.innerHTML = rouletteHistory.length ? `<small>Последние превращения</small>${rouletteHistory.slice(0, 5).map((entry) => `<div><i style="background:${esc(entry.color)}"></i><span>${esc(entry.originalName)} → <b>${esc(entry.word)}</b></span></div>`).join("")}` : "";
    const eligible = rouletteUsers.filter((user) => !rouletteLocks.has(user.id));
    const spin = document.querySelector<HTMLButtonElement>("#rouletteSpin");
    if (spin) { spin.disabled = rouletteSpinning || !rouletteWords.size || !eligible.length; spin.textContent = rouletteSpinning ? "РУЛЕТКА КРУТИТСЯ…" : !eligible.length ? "ВСЕ НА ТАЙМЕРЕ" : "КРУТИТЬ РУЛЕТКУ"; }
  };
  type RouletteSpinStep = { at: number; wordId: string; userId: number };
  type RouletteSpinPlan = {
    id: string;
    by: number;
    startAt: number;
    totalMs: number;
    winnerId: number;
    word: RouletteWord;
    duration: number;
    originalName: string;
    expiresAt: number;
    steps: RouletteSpinStep[];
  };
  let rouletteActiveSpin: RouletteSpinPlan | null = null;
  const rouletteSpinTimers: number[] = [];
  const rouletteAppliedSpinIds = new Set<string>();

  const clearRouletteSpinTimers = () => {
    while (rouletteSpinTimers.length) window.clearTimeout(rouletteSpinTimers.pop());
  };
  const rouletteWordById = (id: string) => rouletteWords.get(id) || null;
  const rouletteUserById = (id: number) => rouletteUsers.find((user) => user.id === id) || null;
  const setRouletteReel = (selector: string, current: string, prev = "", next = "", color = "") => {
    const reel = document.querySelector<HTMLElement>(selector);
    if (!reel) return;
    const currentNode = reel.querySelector<HTMLElement>('[data-reel-current]');
    const prevNode = reel.querySelector<HTMLElement>('[data-reel-prev]');
    const nextNode = reel.querySelector<HTMLElement>('[data-reel-next]');
    if (currentNode) {
      currentNode.textContent = current || "—";
      currentNode.style.color = color || "";
    }
    if (prevNode) prevNode.textContent = prev || "·";
    if (nextNode) nextNode.textContent = next || "·";
    reel.classList.remove("tick"); void reel.offsetWidth; reel.classList.add("tick");
  };
  const paintRouletteStep = (plan: RouletteSpinPlan, index: number) => {
    const step = plan.steps[Math.max(0, Math.min(plan.steps.length - 1, index))];
    if (!step) return;
    const before = plan.steps[Math.max(0, index - 1)] || step;
    const after = plan.steps[Math.min(plan.steps.length - 1, index + 1)] || step;
    const word = rouletteWordById(step.wordId) || (step.wordId === plan.word.id ? plan.word : null);
    const prevWord = rouletteWordById(before.wordId) || (before.wordId === plan.word.id ? plan.word : null);
    const nextWord = rouletteWordById(after.wordId) || (after.wordId === plan.word.id ? plan.word : null);
    const user = rouletteUserById(step.userId);
    const prevUser = rouletteUserById(before.userId);
    const nextUser = rouletteUserById(after.userId);
    setRouletteReel("#rouletteWordReel", word?.text || plan.word.text, prevWord?.text || "", nextWord?.text || "", word?.color || plan.word.color);
    setRouletteReel("#rouletteUserReel", user?.name || (step.userId === plan.winnerId ? plan.originalName : "Участник"), prevUser?.name || "", nextUser?.name || "");
  };
  const applyRouletteResult = (result: { id: string; winnerId: number; word: RouletteWord; duration: number; originalName?: string; expiresAt?: number }, announce = true) => {
    const user = rouletteUsers.find((item) => item.id === result.winnerId);
    const originalName = result.originalName || user?.name || "Участник";
    const expiresAt = Math.max(Date.now() + 1000, Number(result.expiresAt || (Date.now() + result.duration * 1000)));
    rouletteLocks.set(result.winnerId, { userId: result.winnerId, word: result.word.text, color: result.word.color, duration: result.duration, expiresAt });
    const alreadyApplied = rouletteAppliedSpinIds.has(result.id);
    rouletteAppliedSpinIds.add(result.id);
    if (!alreadyApplied) {
      rouletteHistory.unshift({ at: Date.now(), userId: result.winnerId, originalName, word: result.word.text, color: result.word.color, duration: result.duration });
      rouletteHistory.splice(8);
    }
    rouletteRevision = Math.max(rouletteRevision, Date.now());
    rouletteSpinning = false;
    rouletteActiveSpin = null;
    roulettePanel.hidden = false;
    const machine = document.querySelector<HTMLElement>("#rouletteMachine");
    machine?.classList.remove("spinning");
    machine?.classList.add("settled");
    setRouletteReel("#rouletteWordReel", result.word.text, "", "", result.word.color);
    setRouletteReel("#rouletteUserReel", originalName, "", "");
    const status = document.querySelector<HTMLElement>("#rouletteSpinStatus"); if (status) status.textContent = "ВЫПАЛО!";
    const resultNode = document.querySelector<HTMLElement>("#rouletteResult");
    if (resultNode) {
      resultNode.innerHTML = `<strong style="--roulette-color:${esc(result.word.color)}"><span>${esc(originalName)}</span><i>→</i><em>${esc(result.word.text)}</em></strong><small>Новый ник на ${result.duration < 60 ? `${result.duration} секунд` : `${Math.round(result.duration / 60)} мин.`} · повторно участвовать можно после таймера</small>`;
      resultNode.classList.remove("pop"); void resultNode.offsetWidth; resultNode.classList.add("pop");
    }
    renderRoulette(); renderUsers(rouletteUsers);
    window.clearTimeout(rouletteTickTimer);
    rouletteTickTimer = window.setTimeout(function tick() { renderRoulette(); renderUsers(rouletteUsers); rouletteTickTimer = window.setTimeout(tick, 1000); }, 1000);
    if (announce) void rouletteBroadcast({ kind: "roulette-result", result: { ...result, originalName, expiresAt }, revision: rouletteRevision });
  };
  const runRouletteSpin = (plan: RouletteSpinPlan, announceFinal = false) => {
    clearRouletteSpinTimers();
    rouletteActiveSpin = plan;
    rouletteSpinning = true;
    roulettePanel.hidden = false;
    renderRoulette();
    const machine = document.querySelector<HTMLElement>("#rouletteMachine");
    machine?.classList.remove("settled");
    machine?.classList.add("spinning");
    const resultNode = document.querySelector<HTMLElement>("#rouletteResult"); if (resultNode) resultNode.innerHTML = "";
    const status = document.querySelector<HTMLElement>("#rouletteSpinStatus"); if (status) status.textContent = "КРУТИМ…";

    const now = Date.now();
    let latestPastIndex = -1;
    plan.steps.forEach((step, index) => {
      const delay = plan.startAt + step.at - now;
      if (delay <= 0) { latestPastIndex = index; return; }
      rouletteSpinTimers.push(window.setTimeout(() => paintRouletteStep(plan, index), delay));
    });
    if (latestPastIndex >= 0) paintRouletteStep(plan, latestPastIndex);
    else if (plan.steps[0]) paintRouletteStep(plan, 0);

    const finishDelay = Math.max(0, plan.startAt + plan.totalMs - now);
    rouletteSpinTimers.push(window.setTimeout(() => {
      setRouletteReel("#rouletteWordReel", plan.word.text, "", "", plan.word.color);
      setRouletteReel("#rouletteUserReel", plan.originalName, "", "");
      applyRouletteResult({ id: plan.id, winnerId: plan.winnerId, word: plan.word, duration: plan.duration, originalName: plan.originalName, expiresAt: plan.expiresAt }, announceFinal);
    }, finishDelay));
  };
  const buildRouletteSpinPlan = (winner: VoiceUser, word: RouletteWord, eligible: VoiceUser[], words: RouletteWord[]): RouletteSpinPlan => {
    const totalMs = 5200;
    const startAt = Date.now() + 900;
    const count = 31;
    const steps: RouletteSpinStep[] = [];
    for (let index = 0; index < count; index += 1) {
      const progress = index / (count - 1);
      const at = Math.round(totalMs * Math.pow(progress, 1.35));
      const pickWord = index === count - 1 ? word : words[Math.floor(Math.random() * words.length)];
      const pickUser = index === count - 1 ? winner : eligible[Math.floor(Math.random() * eligible.length)];
      steps.push({ at, wordId: pickWord.id, userId: pickUser.id });
    }
    const id = `${me.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return { id, by: me.id, startAt, totalMs, winnerId: winner.id, word, duration: word.duration, originalName: winner.name, expiresAt: startAt + totalMs + word.duration * 1000, steps };
  };
  const startRouletteSpin = async () => {
    if (rouletteSpinning) return;
    const words = [...rouletteWords.values()];
    const eligible = rouletteUsers.filter((user) => !rouletteLocks.has(user.id));
    if (!words.length || !eligible.length) return;
    const winner = eligible[Math.floor(Math.random() * eligible.length)];
    const word = words[Math.floor(Math.random() * words.length)];
    const plan = buildRouletteSpinPlan(winner, word, eligible, words);
    rouletteSpinning = true; roulettePanel.hidden = false; renderRoulette();
    // План целиком рассылается до начала анимации. У всех клиентов одинаковая
    // последовательность, абсолютное startAt и один финальный результат.
    await rouletteBroadcast({ kind: "roulette-spin-plan", plan });
    runRouletteSpin(plan, true);
  };
  document.querySelector<HTMLButtonElement>("#callRoulette")!.onclick = () => { roulettePanel.hidden = !roulettePanel.hidden; if (!roulettePanel.hidden) { renderRoulette(); void rouletteBroadcast({ kind: "roulette-hello" }); } };
  document.querySelector<HTMLButtonElement>("#rouletteClose")!.onclick = () => { roulettePanel.hidden = true; };
  document.querySelector<HTMLButtonElement>("#rouletteSpin")!.onclick = () => void startRouletteSpin();
  document.querySelector<HTMLFormElement>("#rouletteWordForm")!.onsubmit = (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement; const values = new FormData(form);
    const text = String(values.get("word") || "").trim().slice(0, 32); if (!text) return;
    const duration = Math.max(10, Math.min(3600, Number(values.get("duration") || 60)));
    const color = /^#[0-9a-f]{6}$/i.test(String(values.get("color") || "")) ? String(values.get("color")) : "#a970ff";
    const word: RouletteWord = { id: `${me.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, duration, color, creatorId: me.id, creatorName: me.name };
    rouletteWords.set(word.id, word); rouletteRevision = Date.now(); form.reset(); (form.elements.namedItem("color") as HTMLInputElement).value = color; renderRoulette(); void rouletteBroadcast({ kind: "roulette-word-add", word, revision: rouletteRevision });
  };

  const applyFocusedLayout = (users: VoiceUser[]) => {
    const grid = document.querySelector<HTMLElement>("#videoGrid");
    if (!grid) return;
    if (document.querySelector("#p2pScreens > *")) focusedUserId = null;
    focusedUserId = resolveCallFocus(users, focusedUserId);
    const focused = focusedUserId !== null;
    grid.classList.toggle("focused-view", focused);
    grid.querySelectorAll<HTMLElement>("[data-p2p-user]").forEach((tile) => {
      const selected = focused && Number(tile.dataset.p2pUser) === focusedUserId;
      tile.classList.toggle("is-focused", selected);
      tile.classList.toggle("is-thumbnail", focused && !selected);
      tile.setAttribute("aria-pressed", String(selected));
    });
    const button = document.querySelector<HTMLButtonElement>("#callGridView");
    if (button) {
      button.hidden = !focused;
      button.onclick = () => { focusedUserId = null; applyFocusedLayout(rouletteUsers); };
    }
  };
  const focusUserTile = (userId: number) => {
    focusedUserId = userId;
    applyFocusedLayout(rouletteUsers);
  };
  const attachCameraVideo = (userId: number) => {
    const stream = remoteCameraStreams.get(userId);
    const tile = document.querySelector<HTMLElement>(`[data-p2p-user="${userId}"]`);
    if (!tile || !stream || !stream.getVideoTracks().some((track) => track.readyState === "live" && !track.muted)) return;
    let video = tile.querySelector<HTMLVideoElement>("video");
    if (!video) {
      video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true; // Camera peers carry video only.
      tile.prepend(video);
    }
    if (video.srcObject !== stream) video.srcObject = stream;
    tile.classList.remove("voice-only-tile");
    tile.classList.add("has-video", "camera-tile");
    if (video.paused) void video.play().catch(() => {});
  };
  const renderUsers = (users: VoiceUser[]) => {
    rouletteUsers = users;
    users.forEach((user) => voiceDirectory.set(user.id, user));
    const grid = document.querySelector<HTMLElement>("#videoGrid");
    if (grid) {
      const ids = new Set(users.map((user) => String(user.id)));
      grid.querySelectorAll<HTMLElement>("[data-p2p-user]").forEach((tile) => {
        if (!ids.has(tile.dataset.p2pUser!)) tile.remove();
      });
      for (const user of users) {
        const display = rouletteDisplayName(user);
        let tile = grid.querySelector<HTMLElement>(`[data-p2p-user="${user.id}"]`);
        if (!tile) {
          tile = document.createElement("article");
          tile.className = "video-tile";
          tile.dataset.p2pUser = String(user.id);
          tile.tabIndex = 0;
          tile.setAttribute("role", "button");
          tile.setAttribute("aria-label", `Выделить участника ${user.name}`);
          tile.addEventListener("click", () => focusUserTile(Number(tile!.dataset.p2pUser)));
          tile.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault(); focusUserTile(Number(tile!.dataset.p2pUser));
          });
          tile.innerHTML = '<div class="voice-avatar"><span class="avatar"></span></div><footer></footer>';
          grid.append(tile);
        }
        const hasCamera = !!remoteCameraStreams.get(user.id)?.getVideoTracks().some((track) => track.readyState === "live" && !track.muted);
        tile.classList.toggle("speaking", user.speaking && !user.muted);
        tile.classList.toggle("voice-only-tile", !hasCamera);
        tile.classList.toggle("has-video", hasCamera);
        tile.classList.toggle("camera-tile", hasCamera);
        tile.classList.toggle("self-camera-mirrored", user.id === me.id && cameraPreviewMirrored());
        tile.classList.toggle("camera-connecting", user.camera && !hasCamera);
        tile.style.setProperty("--roulette-user-color", display.color || "inherit");
        tile.toggleAttribute("data-roulette-renamed", !!display.color);
        tile.setAttribute("aria-label", `${hasCamera ? "Камера" : "Участник"} ${display.name}. Нажмите, чтобы показать крупно`);
        const face = tile.querySelector<HTMLElement>(".avatar")!;
        const faceHtml = avatar(user);
        if (face.dataset.content !== faceHtml) { face.innerHTML = faceHtml; face.dataset.content = faceHtml; }
        const footer = tile.querySelector("footer")!;
        const html = `<span class="roulette-user-name">${esc(display.name)}</span>${display.name !== display.original ? '<small class="roulette-original-name">'+esc(display.original)+'</small>' : ''}${user.id === me.id ? ' <small>(Вы)</small>' : ''}${user.camera && !hasCamera ? '<small class="camera-connecting-label">Подключаем камеру…</small>' : ''}<i class="muted-badge" ${user.muted ? '' : 'hidden'}>${ico("mic-off")}</i>`;
        if (footer.innerHTML !== html) footer.innerHTML = html;
        if (!hasCamera) { const video = tile.querySelector("video"); if (video) { video.srcObject = null; video.remove(); } }
      }
      applyFocusedLayout(users);
      remoteCameraStreams.forEach((_stream, userId) => attachCameraVideo(userId));
    }
    const presence = document.querySelector<HTMLElement>(`.voice-presence[data-channel-id="${channelId}"]`);
    if (presence) presence.innerHTML = users.map((user) => { const display = rouletteDisplayName(user); return `<div class="voice-person ${user.speaking && !user.muted ? "speaking" : ""}" data-voice-person="${user.id}" ${display.color ? `style="--roulette-user-color:${esc(display.color)}" data-roulette-renamed="1"` : ""}><div class="avatar">${avatar(user)}</div><span>${esc(display.name)}</span><i>${user.sharing ? ico("video-message") : user.deafened ? ico("headphones-off") : user.muted ? ico("mic-off") : ""}</i></div>`; }).join("");
    const count = document.querySelector<HTMLElement>(`[data-voice="${channelId}"] small`);
    if (count) count.textContent = `${users.length} в голосовом · P2P`;
  };
  const closeCameraPeer = (id: number, expected?: RTCPeerConnection) => {
    const pc = cameraPeers.get(id);
    if (!pc || (expected && pc !== expected)) return;
    cameraPeers.delete(id);
    cameraPeerStartedAt.delete(id);
    pendingCameraIce.delete(id);
    pc.close();
  };
  const requestCameraSync = (id: number) => {
    const last = cameraSyncRequestedAt.get(id) || 0;
    if (Date.now() - last < 4000 || leaving) return;
    cameraSyncRequestedAt.set(id, Date.now());
    void signal(id, { kind: "camera-sync-request", transport: "voice" }).catch(() => {});
  };
  const recoverCameraPeer = (id: number, pc: RTCPeerConnection, delay = 300) => {
    if (cameraPeers.get(id) !== pc || leaving) return;
    closeCameraPeer(id, pc);
    const previous = cameraRecoveryTimers.get(id); if (previous) window.clearTimeout(previous);
    cameraRecoveryTimers.set(id, window.setTimeout(() => {
      cameraRecoveryTimers.delete(id);
      const remoteHasCamera = !!rouletteUsers.find((user) => user.id === id)?.camera;
      if (camera && (me.id < id || !remoteHasCamera)) void makeCameraOffer(id, true).catch(() => requestCameraSync(id));
      else requestCameraSync(id);
    }, delay));
  };
  const cameraPeerFor = async (id: number) => {
    const existing = cameraPeers.get(id);
    if (existing && existing.connectionState !== "closed" && existing.connectionState !== "failed") return existing;
    if (existing) closeCameraPeer(id, existing);
    const pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceCandidatePoolSize: 2,
    });
    if (cameraStream) {
      cameraStream.getVideoTracks().forEach((track) => {
        const sender = pc.addTrack(track, cameraStream!);
        const parameters = sender.getParameters();
        parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
        parameters.encodings[0].maxBitrate = lowResourceMode() ? 300_000 : voiceNetworkLevel >= 3 ? 220_000 : voiceNetworkLevel === 2 ? 350_000 : voiceNetworkLevel === 1 ? 600_000 : 1_000_000;
        parameters.encodings[0].maxFramerate = lowResourceMode() || voiceNetworkLevel >= 2 ? 15 : 30;
        parameters.encodings[0].priority = "low";
        void sender.setParameters(parameters).catch(() => {});
      });
    } else {
      pc.addTransceiver("video", { direction: "recvonly" });
    }
    pc.onicecandidate = (event) => {
      if (event.candidate) void signal(id, { kind: "camera-ice", candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      if (event.track.kind !== "video") return;
      const stream = event.streams[0] || new MediaStream([event.track]);
      remoteCameraStreams.set(id, stream);
      event.track.onunmute = () => { cameraSyncRequestedAt.delete(id); attachCameraVideo(id); renderUsers(rouletteUsers); };
      event.track.onmute = () => window.setTimeout(() => { if (event.track.muted) renderUsers(rouletteUsers); }, 1200);
      if (!event.track.muted) attachCameraVideo(id);
      event.track.addEventListener("ended", () => {
        if (remoteCameraStreams.get(id) === stream) remoteCameraStreams.delete(id);
        renderUsers(rouletteUsers);
      }, { once: true });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") { cameraSyncRequestedAt.delete(id); const timer = cameraRecoveryTimers.get(id); if (timer) window.clearTimeout(timer); cameraRecoveryTimers.delete(id); }
      if (pc.connectionState === "closed" && cameraPeers.get(id) === pc) { cameraPeers.delete(id); cameraPeerStartedAt.delete(id); }
      if (pc.connectionState === "failed") recoverCameraPeer(id, pc);
      if (pc.connectionState === "disconnected") {
        const previous = cameraRecoveryTimers.get(id); if (previous) window.clearTimeout(previous);
        cameraRecoveryTimers.set(id, window.setTimeout(() => {
          cameraRecoveryTimers.delete(id);
          if (pc.connectionState === "disconnected") recoverCameraPeer(id, pc, 100);
        }, 3500));
      }
    };
    cameraPeers.set(id, pc);
    cameraPeerStartedAt.set(id, Date.now());
    return pc;
  };
  const makeCameraOffer = (id: number, iceRestart = false): Promise<void> => {
    const pending = cameraOfferTasks.get(id);
    if (pending) return pending;
    const task = (async () => {
      if (leaving) return;
      const pc = await cameraPeerFor(id);
      // A signaling packet can be lost while the peer remains in
      // `have-local-offer`. Re-send the same offer when the viewer asks for a
      // camera sync instead of silently leaving both sides stuck forever.
      if (pc.signalingState === "have-local-offer" && pc.localDescription?.type === "offer") {
        await signal(id, { kind: "camera-offer", sdp: pc.localDescription, camera, retry: true });
        return;
      }
      if (pc.signalingState !== "stable") return;
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (leaving || pc.signalingState !== "stable") return;
      await pc.setLocalDescription(offer);
      await signal(id, { kind: "camera-offer", sdp: pc.localDescription, camera });
    })().finally(() => cameraOfferTasks.delete(id));
    cameraOfferTasks.set(id, task);
    return task;
  };
  const stopCamera = async (announce = true) => {
    camera = false;
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    remoteCameraStreams.delete(me.id);
    // Stop legacy camera senders without disconnecting the other
    // participant's camera.
    await Promise.all([...cameraPeers.values()].flatMap((pc) => pc.getSenders()
      .filter((sender) => sender.track?.kind === "video")
      .map((sender) => sender.replaceTrack(null).catch(() => {}))));
    // Remove our camera from the existing voice transport and renegotiate.
    await Promise.all([...cameraVoiceSenders].map(async ([id, sender]) => {
      const pc = peers.get(id);
      if (pc && pc.connectionState !== "closed") {
        try { pc.removeTrack(sender); } catch {}
        await signal(id, { kind: "camera-main-track", enabled: false }).catch(() => {});
        await requestPeerRenegotiation(id).catch(() => {});
      }
      cameraVoiceSenders.delete(id);
    }));
    document.querySelector<HTMLButtonElement>("#callCamera")?.classList.remove("on");
    document.querySelector<HTMLButtonElement>("#callCamera")?.setAttribute("title", "Включить камеру");
    if (announce) {
      await Promise.all(rouletteUsers.filter((user) => user.id !== me.id).map((user) =>
        signal(user.id, { kind: "camera-stopped" }).catch(() => {}),
      ));
    }
    renderUsers(rouletteUsers);
    void publishPresence();
  };
  let cameraBusy = false;
  const toggleCamera = async () => {
    if (cameraBusy || leaving) return;
    cameraBusy = true;
    try {
    if (camera) {
      await stopCamera();
      return;
    }
    if (!(await requestMediaAccess("camera"))) return;
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: localStorage.getItem("kitchat_camera") || undefined,
          width: { ideal: lowResourceMode() ? 640 : 1280, max: lowResourceMode() ? 640 : 1280 },
          height: { ideal: lowResourceMode() ? 360 : 720, max: lowResourceMode() ? 360 : 720 },
          frameRate: { ideal: lowResourceMode() ? 15 : 30, max: lowResourceMode() ? 15 : 30 },
        },
        audio: false,
      });
      if (leaving) { cameraStream.getTracks().forEach((track) => track.stop()); cameraStream = null; return; }
      cameraStream.getVideoTracks()[0]?.addEventListener("ended", () => { if (camera && !leaving) void stopCamera(); }, { once: true });
      camera = true;
      localStorage.setItem("kitchat_camera_granted", "1");
      remoteCameraStreams.set(me.id, cameraStream);
      const button = document.querySelector<HTMLButtonElement>("#callCamera");
      button?.classList.add("on");
      button?.setAttribute("title", "Выключить камеру");
      renderUsers(rouletteUsers);
      await Promise.all(rouletteUsers.filter((user) => user.id !== me.id).map((user) =>
        attachCameraToVoicePeer(user.id).catch((error) => console.warn("P2P camera attach failed", error)),
      ));
      void publishPresence();
    } catch (error) {
      await stopCamera(false);
      showAppNotice("Камера", `Не удалось включить камеру: ${String(error)}`);
    }
    } finally { cameraBusy = false; }
  };
  const requestPeerRenegotiation = async (id: number, attempt = 0): Promise<void> => {
    if (leaving) return;
    const pc = peers.get(id);
    if (!pc || pc.connectionState === "closed") return;
    if (pc.signalingState !== "stable") {
      if (attempt >= 12) {
        console.warn("Screen renegotiation timed out", id, pc.signalingState);
        pendingPeerRenegotiations.delete(id);
        return;
      }
      const old = pendingPeerRenegotiations.get(id); if (old) window.clearTimeout(old);
      const timer = window.setTimeout(() => void requestPeerRenegotiation(id, attempt + 1), 250);
      pendingPeerRenegotiations.set(id, timer);
      return;
    }
    const pending = pendingPeerRenegotiations.get(id); if (pending) window.clearTimeout(pending);
    pendingPeerRenegotiations.delete(id);
    await peerOffers.get(id)?.();
  };
  const attachCameraToVoicePeer = async (id: number) => {
    if (!cameraStream || !camera || leaving) return;
    const track = cameraStream.getVideoTracks()[0];
    if (!track || track.readyState !== "live") return;
    const pc = await peerFor(id);
    let sender = cameraVoiceSenders.get(id);
    if (sender && pc.getSenders().includes(sender)) await sender.replaceTrack(track);
    else {
      sender = pc.addTrack(track, cameraStream);
      cameraVoiceSenders.set(id, sender);
      const parameters = sender.getParameters();
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      parameters.encodings[0].maxBitrate = lowResourceMode() ? 300_000 : 1_000_000;
      parameters.encodings[0].maxFramerate = lowResourceMode() ? 15 : 30;
      parameters.encodings[0].priority = "low";
      await sender.setParameters(parameters).catch(() => {});
    }
    // This announcement is inserted before the SDP offer, so the receiver can
    // distinguish a camera track from a screen-share track in ontrack.
    await signal(id, { kind: "camera-main-track", enabled: true, stream_id: cameraStream.id });
    await requestPeerRenegotiation(id);
  };
  const peerFor = async (id: number, createOffer = false) => {
    const existing = peers.get(id);
    if (existing) return existing;
    const pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceCandidatePoolSize: 4,
    });
    local.getAudioTracks().forEach((track) => {
      const sender = pc.addTrack(track, local);
      void configureVoiceSender(sender);
    });
    let initialCameraStreamId = "";
    if (camera && cameraStream) {
      const track = cameraStream.getVideoTracks()[0];
      if (track?.readyState === "live") {
        const sender = pc.addTrack(track, cameraStream);
        cameraVoiceSenders.set(id, sender);
        initialCameraStreamId = cameraStream.id;
      }
    }
    if (screenWatchers.has(id) && screenAudioCapture?.track && screenAudioCapture.track.readyState === "live") {
      const stream = screenAudioStream || new MediaStream([screenAudioCapture.track]);
      screenAudioStream = stream;
      const sender = pc.addTrack(screenAudioCapture.track, stream);
      screenAudioSenders.set(id, sender);
      const parameters = sender.getParameters();
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      parameters.encodings[0].maxBitrate = 192_000;
      parameters.encodings[0].priority = "high";
      void sender.setParameters(parameters).catch(() => {});
    }
    if (screenWatchers.has(id) && fallbackScreenCapture?.track && fallbackScreenCapture.track.readyState === "live") {
      const stream = fallbackScreenStream || new MediaStream([fallbackScreenCapture.track]);
      fallbackScreenStream = stream;
      const sender = pc.addTrack(fallbackScreenCapture.track, stream);
      fallbackScreenSenders.set(id, sender);
      const parameters = sender.getParameters();
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      parameters.encodings[0].maxBitrate = compatibleScreenIsWebView ? 5_000_000 : 3_000_000;
      parameters.encodings[0].maxFramerate = compatibleScreenIsWebView ? 30 : 15;
      parameters.encodings[0].priority = "high";
      void sender.setParameters(parameters).catch(() => {});
    }
    pc.onicecandidate = (event) => { if (event.candidate) void signal(id, { kind: "ice", candidate: event.candidate.toJSON() }); };
    pc.ontrack = (event) => {
      if (event.track.kind === "video") {
        const incoming = event.streams[0] || new MediaStream([event.track]);
        const announcedCameraStream = remoteCameraStreamIds.get(id);
        if (incoming.id === announcedCameraStream || !watchingScreens.has(id)) {
          remoteCameraStreams.set(id, incoming);
          event.track.onunmute = () => { cameraSyncRequestedAt.delete(id); attachCameraVideo(id); renderUsers(rouletteUsers); };
          event.track.onmute = () => window.setTimeout(() => { if (event.track.muted) renderUsers(rouletteUsers); }, 1200);
          event.track.addEventListener("ended", () => {
            if (remoteCameraStreams.get(id) === incoming) remoteCameraStreams.delete(id);
            renderUsers(rouletteUsers);
          }, { once: true });
          if (!event.track.muted) { attachCameraVideo(id); renderUsers(rouletteUsers); }
          return;
        }
        if (!watchingScreens.has(id)) return;
        const screens = document.querySelector<HTMLElement>("#p2pScreens");
        if (!screens) return;
        screens.querySelector(`[data-p2p-screen="${id}"]`)?.remove();
        const tile = document.createElement("article");
        tile.className = "p2p-screen-tile"; tile.dataset.p2pScreen = String(id);
        tile.insertAdjacentHTML("beforeend", `<div class="stream-overlay"><span>Трансляция участника</span><div class="stream-overlay-actions"><button type="button" data-stop-watching title="Перестать смотреть">${ico("phone-down")}</button><button type="button" data-stream-fullscreen title="На весь экран">${ico("focus")}</button></div></div>`);
        const video = document.createElement("video");
        video.autoplay = true; video.playsInline = true;
        video.srcObject = incoming;
        tile.prepend(video); screens.append(tile);
        tile.querySelector<HTMLButtonElement>("[data-stream-fullscreen]")!.onclick = () => {
          if (document.fullscreenElement === tile) void document.exitFullscreen();
          else void tile.requestFullscreen();
        };
        tile.querySelector<HTMLButtonElement>("[data-stop-watching]")!.onclick = () => void stopWatchingScreen(id);
        const removeStoppedScreen = () => tile.remove();
        event.track.addEventListener("ended", removeStoppedScreen, { once: true });
        return;
      }
      if (event.track.kind !== "audio") return;
      const resilientReceiver = event.receiver as RTCRtpReceiver & { playoutDelayHint?: number; jitterBufferTarget?: number };
      // A small managed buffer absorbs mobile/Wi-Fi jitter without making a
      // normal connection feel sluggish. Chromium ignores unsupported hints.
      try { resilientReceiver.playoutDelayHint = 0.12; resilientReceiver.jitterBufferTarget = 120; } catch {}
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.dataset.p2pAudio = `${id}-${event.track.id}`;
      audio.dataset.voiceUser = String(id);
      audio.srcObject = event.streams[0] || new MediaStream([event.track]);
      setRemoteAudioMuted(audio, deafened);
      setRemoteAudioVolume(audio, Number(localStorage.getItem(`kitchat_user_volume_${id}`) || "100") / 100);
      const speaker = localStorage.getItem("kitchat_speaker") || "";
      if (speaker && "setSinkId" in audio) void (audio as HTMLMediaElement & { setSinkId(id: string): Promise<void> }).setSinkId(speaker).catch(() => {});
      document.querySelector("#remoteAudio")?.append(audio);
    };
    let reconnectTimer = 0;
    const makeOffer = async (iceRestart = false) => {
      if (pc.signalingState !== "stable" || pc.connectionState === "closed") return;
      const offer = tuneVoiceSdp(await pc.createOffer({ offerToReceiveAudio: true, iceRestart }), voiceBitrates[voiceNetworkLevel]);
      await pc.setLocalDescription(offer);
      await signal(id, { kind: "offer", sdp: pc.localDescription });
    };
    peerOffers.set(id, makeOffer);
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === "stable" && pendingPeerRenegotiations.has(id)) {
        void requestPeerRenegotiation(id);
      }
    };
    pc.onconnectionstatechange = () => {
      window.clearTimeout(reconnectTimer);
      if (pc.connectionState === "connected") return;
      if (pc.connectionState === "closed") {
        peers.delete(id);
        peerOffers.delete(id);
        document.querySelectorAll(`[data-voice-user="${id}"]`).forEach((node) => node.remove());
        return;
      }
      if (["failed", "disconnected"].includes(pc.connectionState) && me.id < id) {
        reconnectTimer = window.setTimeout(() => {
          if (["failed", "disconnected"].includes(pc.connectionState)) void makeOffer(true).catch(console.warn);
        }, pc.connectionState === "failed" ? 300 : 3000);
      }
    };
    peers.set(id, pc);
    peerStartedAt.set(id, Date.now());
    if (initialCameraStreamId) {
      await signal(id, { kind: "camera-main-track", enabled: true, stream_id: initialCameraStreamId });
    }
    if (createOffer) {
      await makeOffer();
    }
    return pc;
  };
  const applyPendingIce = async (id: number, pc: RTCPeerConnection) => {
    for (const candidate of pendingIce.get(id) || []) await pc.addIceCandidate(candidate);
    pendingIce.delete(id);
  };
  const startVoiceNetworkMonitor = () => {
    if (voiceNetworkTimer) window.clearInterval(voiceNetworkTimer);
    const tick = async () => {
      const samples: Array<{ loss: number; jitter: number; rtt: number }> = [];
      for (const pc of peers.values()) {
        if (pc.connectionState !== "connected") continue;
        try {
          const stats = await pc.getStats();
          let remoteInbound: any = null;
          let pair: any = null;
          stats.forEach((report: any) => {
            if (report.type === "remote-inbound-rtp" && (report.kind === "audio" || report.mediaType === "audio")) remoteInbound = report;
            if (report.type === "candidate-pair" && report.state === "succeeded" && (report.nominated || report.selected)) pair = report;
          });
          const loss = Math.max(0, Math.min(100, Number(remoteInbound?.fractionLost || 0) * 100));
          const jitter = Math.max(0, Number(remoteInbound?.jitter || 0) * 1000);
          const rtt = Math.max(0, Number(remoteInbound?.roundTripTime ?? pair?.currentRoundTripTime ?? 0) * 1000);
          samples.push({ loss, jitter, rtt });
        } catch {}
      }
      if (!samples.length) return;
      voiceRealLoss = Math.max(...samples.map((sample) => sample.loss));
      voiceRealJitter = Math.max(...samples.map((sample) => sample.jitter));
      voiceRealRtt = Math.max(...samples.map((sample) => sample.rtt));
      const veryBad = voiceRealLoss >= 15 || voiceRealJitter >= 100 || voiceRealRtt >= 650;
      const bad = voiceRealLoss >= 7 || voiceRealJitter >= 45 || voiceRealRtt >= 300;
      const healthy = voiceRealLoss < 2.5 && voiceRealJitter < 25 && voiceRealRtt < 190;
      if (bad) { voiceBadTicks += veryBad ? 2 : 1; voiceGoodTicks = 0; }
      else if (healthy) { voiceGoodTicks += 1; voiceBadTicks = Math.max(0, voiceBadTicks - 1); }
      else { voiceGoodTicks = 0; voiceBadTicks = Math.max(0, voiceBadTicks - 1); }
      if (voiceBadTicks >= 2 && voiceNetworkLevel < voiceBitrates.length - 1) await applyVoiceNetworkLevel(voiceNetworkLevel + 1);
      else if (voiceGoodTicks >= 10 && voiceNetworkLevel > 0) await applyVoiceNetworkLevel(voiceNetworkLevel - 1);
      const level = veryBad || voiceNetworkLevel >= 3 ? "bad" : bad || voiceNetworkLevel > 0 ? "fair" : "good";
      document.querySelector<HTMLElement>("#voiceQualityPopover")?.setAttribute("data-level", level);
      const ping = document.querySelector<HTMLElement>("#qualityPing");
      const quality = document.querySelector<HTMLElement>("#qualityState");
      const description = document.querySelector<HTMLElement>("#voiceQualityPopover header small");
      if (ping) ping.textContent = voiceRealRtt ? `${Math.round(voiceRealRtt)} мс` : "—";
      if (quality) quality.textContent = level === "good" ? "Хорошо" : level === "fair" ? "Адаптация" : "Слабая сеть";
      if (description) description.textContent = level === "good"
        ? "Соединение стабильно"
        : `Opus ${Math.round(voiceBitrates[voiceNetworkLevel] / 1000)} кбит/с · потери ${voiceRealLoss.toFixed(1)}%`;
    };
    void tick();
    voiceNetworkTimer = window.setInterval(() => void tick(), 2500);
  };
  const publishPresence = () => community({}, {
    action: "voice_state", channel_id: channelId, muted: muted ? 1 : 0,
    deafened: deafened ? 1 : 0, speaking: speaking && !muted ? 1 : 0, sharing: sharing ? 1 : 0, camera: camera ? 1 : 0,
  }).catch(() => {});
  const waitForIce = (pc: RTCPeerConnection, timeoutMs = 2500) => new Promise<void>((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener("icegatheringstatechange", changed);
      window.clearTimeout(timer);
      resolve();
    };
    const changed = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    pc.addEventListener("icegatheringstatechange", changed);
  });
  const stopNativeLocalPreview = async () => {
    const pc = nativeLocalPreviewPc;
    nativeLocalPreviewPc = null;
    if (pc) pc.close();
    await invoke("native_stream_remove_peer", { viewerId: "__local_preview__" }).catch(() => {});
  };
  const startNativeLocalPreview = async () => {
    await stopNativeLocalPreview();
    const tile = document.querySelector<HTMLElement>('[data-p2p-screen="self"]');
    const setState = (title: string, detail: string) => {
      if (!tile) return;
      let state = tile.querySelector<HTMLElement>(".native-stream-local-state");
      if (!state) {
        state = document.createElement("div");
        state.className = "native-stream-local-state";
        tile.append(state);
      }
      state.innerHTML = `${ico("video-message")}<b>${esc(title)}</b><span>${esc(detail)}</span>`;
    };
    setState("Подключаем локальный preview…", "Создаём WebRTC loopback");

    // Local preview is a loopback connection on the same machine.
    // Do not contact public STUN/TURN servers here: WebView2 may emit ICE 701
    // for an unusable adapter even though host candidates are sufficient.
    const localPreviewIceServers: RTCIceServer[] = [];
    const pc = new RTCPeerConnection({
      iceServers: localPreviewIceServers,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceCandidatePoolSize: 0,
    });
    nativeLocalPreviewPc = pc;
    const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
    let gotTrack = false;

    const stateLine = () => `PC ${pc.connectionState} · ICE ${pc.iceConnectionState} · signaling ${pc.signalingState}`;
    pc.oniceconnectionstatechange = () => {
      if (nativeLocalPreviewPc !== pc || gotTrack) return;
      setState("Локальный preview", stateLine());
    };
    pc.onconnectionstatechange = () => {
      if (nativeLocalPreviewPc !== pc || gotTrack) return;
      if (pc.connectionState === "failed") {
        setState("WebRTC соединение не установлено", stateLine());
        return;
      }
      setState("Локальный preview", stateLine());
    };
    pc.onicecandidateerror = (event) => {
      // icecandidateerror is advisory. In particular, code 701 only means that
      // one STUN/TURN URL could not be reached from one local candidate. Do not
      // treat it as a fatal connection failure. The real failure signal is
      // iceConnectionState/connectionState === "failed".
      console.warn("Native local preview ICE candidate warning", event);
      if (!gotTrack && pc.iceConnectionState !== "failed") {
        setState("Локальный preview", `${stateLine()} · ICE warning ${event.errorCode}`);
      }
    };
    pc.ontrack = async (event) => {
      if (event.track.kind !== "video" || nativeLocalPreviewPc !== pc) return;
      gotTrack = true;
      const currentTile = document.querySelector<HTMLElement>('[data-p2p-screen="self"]');
      if (!currentTile) return;
      currentTile.querySelector(".native-stream-local-state")?.remove();
      currentTile.querySelector("video")?.remove();
      currentTile.querySelector(".stream-overlay")?.remove();
      const video = document.createElement("video");
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = event.streams[0] || new MediaStream([event.track]);
      video.onloadedmetadata = () => void video.play().catch((error) => console.warn("Native preview play failed", error));
      video.onerror = () => setState("Видео получено, но не декодируется", `readyState=${video.readyState} · ${stateLine()}`);
      video.addEventListener("playing", () => console.info("Native preview video playing", video.videoWidth, video.videoHeight), { once: true });
      currentTile.prepend(video);
      window.setTimeout(() => {
        if (nativeLocalPreviewPc !== pc || video.videoWidth > 0) return;
        setState("H.264 RTP есть, но кадр не декодирован", `video=${video.videoWidth}x${video.videoHeight} · readyState=${video.readyState} · ${stateLine()}`);
      }, 4000);
      currentTile.insertAdjacentHTML("beforeend", `<div class="stream-overlay"><span>Ваша P2P-трансляция · реальный WebRTC preview</span><button type="button" data-stream-fullscreen title="На весь экран">${ico("focus")}</button></div>`);
      currentTile.querySelector<HTMLButtonElement>("[data-stream-fullscreen]")!.onclick = () => document.fullscreenElement === currentTile ? void document.exitFullscreen() : void currentTile.requestFullscreen();
    };

    try {
      const offer = await pc.createOffer({ offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      await waitForIce(pc);
      setState("Локальный preview", `Offer готов · ${stateLine()}`);
      const answer = await invoke<{ sdp: string }>("native_stream_accept_offer", {
        viewerId: "__local_preview__",
        sdp: pc.localDescription?.sdp || offer.sdp,
        iceServers: localPreviewIceServers,
      });
      if (nativeLocalPreviewPc !== pc) return;
      const videoMLine = answer.sdp.split(/\r?\n/).find((line) => line.startsWith("m=video")) || "m=video отсутствует";
      console.info("Native local preview answer", videoMLine, answer.sdp);
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      setState("Локальный preview", `Answer принят · ${videoMLine} · ${stateLine()}`);
      window.setTimeout(() => {
        if (nativeLocalPreviewPc !== pc || gotTrack) return;
        const receiver = transceiver.receiver;
        setState(
          "H.264 track не появился",
          `${videoMLine} · direction=${transceiver.currentDirection || "—"} · track=${receiver.track?.readyState || "—"} · ${stateLine()}`,
        );
      }, 2500);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Native local preview failed", error);
      setState("Ошибка локального preview", message);
      throw error;
    }
  };
  const screenUserLabel = (id: number) => voiceDirectory.get(id)?.name || `Участник #${id}`;
  const updateLocalWatcherBadge = () => {
    const tile = document.querySelector<HTMLElement>('[data-p2p-screen="self"]');
    if (!tile) return;
    let badge = tile.querySelector<HTMLElement>('[data-stream-watchers]');
    if (!badge) {
      badge = document.createElement('span');
      badge.dataset.streamWatchers = '1';
      badge.className = 'stream-watchers-badge';
      tile.append(badge);
    }
    const count = screenWatchers.size;
    badge.textContent = count ? `👁 ${count}` : '👁 Никто не смотрит';
  };
  const renderAvailableScreen = (id: number, mode: "native" | "webrtc") => {
    if (id === me.id || watchingScreens.has(id)) return;
    const screens = document.querySelector<HTMLElement>("#p2pScreens");
    if (!screens) return;
    let tile = screens.querySelector<HTMLElement>(`[data-p2p-screen="${id}"]`);
    if (tile?.querySelector('video')) return;
    if (!tile) {
      tile = document.createElement('article');
      tile.className = 'p2p-screen-tile stream-available';
      tile.dataset.p2pScreen = String(id);
      screens.append(tile);
    }
    const user = voiceDirectory.get(id);
    const title = esc(screenUserLabel(id));
    const avatarHtml = user ? avatar(user) : title.slice(0, 1).toUpperCase();
    tile.className = 'p2p-screen-tile stream-available';
    tile.innerHTML = `<div class="stream-available-card"><div class="stream-live-pill"><i></i> LIVE</div><div class="stream-available-avatar avatar">${avatarHtml}</div><div class="stream-available-copy"><b>${title} ведёт трансляцию</b><span>${mode === "native" ? 'Нативная P2P-трансляция' : 'Совместимый режим'} · подключение только по запросу</span></div><button type="button" class="stream-watch-button" data-watch-stream>Смотреть</button></div>`;
    tile.querySelector<HTMLButtonElement>('[data-watch-stream]')!.onclick = async () => {
      if (watchingScreens.has(id)) return;
      watchingScreens.add(id);
      tile!.className = 'p2p-screen-tile pending';
      tile!.innerHTML = `<div class="native-stream-local-state">${ico("video-message")}<b>Подключение к трансляции…</b><span>Запрашиваем поток у ${title}</span></div>`;
      try {
        await signal(id, { kind: 'screen-watch-start' });
        if (mode === 'native') {
          screenRequestAt.set(id, Date.now());
          await requestNativeScreen(id);
        }
      } catch (error) {
        console.warn('Screen watch start failed', error);
        watchingScreens.delete(id);
        renderAvailableScreen(id, mode);
      }
    };
  };
  const stopWatchingScreen = async (id: number, notify = true) => {
    watchingScreens.delete(id);
    const reconnect = nativeScreenReconnectTimers.get(id); if (reconnect) window.clearTimeout(reconnect);
    nativeScreenReconnectTimers.delete(id); nativeScreenReconnectAttempts.delete(id);
    stopNativeScreenHealth(id); stopNativeViewerDebug(id);
    const pc = nativeScreenPeers.get(id); if (pc) { try { pc.close(); } catch {} }
    nativeScreenPeers.delete(id); screenRequestAt.delete(id); pendingNativeStreamerIce.delete(id);
    document.querySelector(`[data-p2p-screen="${id}"]`)?.remove();
    if (notify) await signal(id, { kind: 'screen-watch-stop' }).catch(() => {});
    const mode = remoteScreenModes.get(id); if (mode) renderAvailableScreen(id, mode);
  };
  const attachScreenAudioToPeer = async (id: number) => {
    const track = screenAudioCapture?.track;
    if (!track || track.readyState !== 'live' || screenAudioSenders.has(id)) return;
    const pc = await peerFor(id);
    if (pc.connectionState === 'closed') return;
    const stream = screenAudioStream || new MediaStream([track]); screenAudioStream = stream;
    const sender = pc.addTrack(track, stream); screenAudioSenders.set(id, sender);
    const parameters = sender.getParameters(); parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0].maxBitrate = 192_000; parameters.encodings[0].priority = 'high';
    await sender.setParameters(parameters).catch(() => {}); await requestPeerRenegotiation(id);
  };
  const attachFallbackScreenToPeer = async (id: number) => {
    const track = fallbackScreenCapture?.track;
    if (!track || track.readyState !== 'live' || fallbackScreenSenders.has(id)) return;
    const pc = await peerFor(id); if (pc.connectionState === 'closed') return;
    const stream = fallbackScreenStream || new MediaStream([track]); fallbackScreenStream = stream;
    const sender = pc.addTrack(track, stream); fallbackScreenSenders.set(id, sender);
    const parameters = sender.getParameters(); parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0].maxBitrate = compatibleScreenIsWebView ? 5_000_000 : 3_000_000; parameters.encodings[0].maxFramerate = compatibleScreenIsWebView ? 30 : 15; parameters.encodings[0].priority = 'high';
    await sender.setParameters(parameters).catch(() => {}); await requestPeerRenegotiation(id);
  };
  const detachScreenMediaFromPeer = async (id: number) => {
    const pc = peers.get(id); let changed = false;
    const audioSender = screenAudioSenders.get(id); if (audioSender) { try { if (pc && pc.connectionState !== 'closed') pc.removeTrack(audioSender); } catch {} screenAudioSenders.delete(id); changed = true; }
    const videoSender = fallbackScreenSenders.get(id); if (videoSender) { try { if (pc && pc.connectionState !== 'closed') pc.removeTrack(videoSender); } catch {} fallbackScreenSenders.delete(id); changed = true; }
    if (changed) await requestPeerRenegotiation(id).catch(() => {});
  };
  const stopNativeScreenHealth = (id: number) => {
    const timer = nativeScreenHealthTimers.get(id);
    if (timer) window.clearInterval(timer);
    nativeScreenHealthTimers.delete(id);
  };
  const updateNativeReconnectTile = (id: number, text: string) => {
    const tile = document.querySelector<HTMLElement>(`[data-p2p-screen="${id}"]`);
    if (!tile) return;
    let state = tile.querySelector<HTMLElement>(".native-stream-reconnect");
    if (!state) {
      state = document.createElement("div");
      state.className = "native-stream-reconnect";
      tile.append(state);
    }
    state.textContent = text;
  };
  const scheduleNativeScreenReconnect = (id: number, reason = "Связь восстанавливается") => {
    if (sharing || !watchingScreens.has(id) || remoteScreenModes.get(id) !== "native" || nativeScreenReconnectTimers.has(id)) return;
    stopNativeScreenHealth(id);
    const previous = nativeScreenPeers.get(id);
    if (previous) { previous.onconnectionstatechange = null; previous.ontrack = null; try { previous.close(); } catch {} }
    nativeScreenPeers.delete(id);
    stopNativeViewerDebug(id);
    const attempt = (nativeScreenReconnectAttempts.get(id) || 0) + 1;
    nativeScreenReconnectAttempts.set(id, attempt);
    const delay = Math.min(4000, 350 * Math.pow(1.7, Math.min(attempt - 1, 5)));
    updateNativeReconnectTile(id, `${reason} · ${Math.ceil(delay / 100) / 10} сек`);
    const timer = window.setTimeout(() => {
      nativeScreenReconnectTimers.delete(id);
      if (!watchingScreens.has(id) || remoteScreenModes.get(id) !== "native" || sharing) return;
      screenRequestAt.set(id, Date.now());
      void requestNativeScreen(id, true).catch((error) => {
        console.warn("Native screen reconnect failed", error);
        scheduleNativeScreenReconnect(id, "Повторное подключение");
      });
    }, delay);
    nativeScreenReconnectTimers.set(id, timer);
  };
  const startNativeScreenHealth = (id: number, pc: RTCPeerConnection) => {
    stopNativeScreenHealth(id);
    const timer = window.setInterval(async () => {
      if (nativeScreenPeers.get(id) !== pc || pc.connectionState === "closed") return stopNativeScreenHealth(id);
      if (pc.connectionState !== "connected") return;
      try {
        const stats = await pc.getStats();
        let inboundFound = false;
        stats.forEach((report) => {
          if (report.type === "inbound-rtp" && report.kind === "video") inboundFound = true;
        });
        // A static source legitimately sends no new bytes. Connection-state
        // handles actual route failures without reconnecting a still image.
        if (!inboundFound && pc.connectionState === "connected") updateNativeReconnectTile(id, "Ожидаем первый видеокадр…");
      } catch {}
    }, 1000);
    nativeScreenHealthTimers.set(id, timer);
  };
  const showNativeScreen = (id: number, event: RTCTrackEvent) => {
    const screens = document.querySelector<HTMLElement>("#p2pScreens");
    if (!screens || event.track.kind !== "video") return;
    screens.querySelector(`[data-p2p-screen="${id}"]`)?.remove();
    const tile = document.createElement("article");
    tile.className = "p2p-screen-tile"; tile.dataset.p2pScreen = String(id);
    tile.insertAdjacentHTML("beforeend", `<div class="stream-overlay"><span>Нативная P2P-трансляция</span><div class="stream-overlay-actions"><button type="button" data-stop-watching title="Перестать смотреть">${ico("phone-down")}</button><button type="button" data-stream-fullscreen title="На весь экран">${ico("focus")}</button></div></div>`);
    const video = document.createElement("video");
    video.autoplay = true; video.playsInline = true;
    video.srcObject = event.streams[0] || new MediaStream([event.track]);
    tile.prepend(video); screens.append(tile);
    void video.play().catch(() => {});
    nativeScreenReconnectAttempts.set(id, 0);
    startNativeViewerDebug(id, nativeScreenPeers.get(id)!);
    tile.querySelector<HTMLButtonElement>("[data-stream-fullscreen]")!.onclick = () => document.fullscreenElement === tile ? void document.exitFullscreen() : void tile.requestFullscreen();
    tile.querySelector<HTMLButtonElement>("[data-stop-watching]")!.onclick = () => void stopWatchingScreen(id);
    event.track.addEventListener("ended", () => scheduleNativeScreenReconnect(id, "Поток прервался"), { once: true });
  };
  const requestNativeScreen = async (id: number, force = false) => {
    if (!watchingScreens.has(id)) return;
    if (nativeScreenPeers.has(id) && !force) return;
    if (force) {
      const old = nativeScreenPeers.get(id); if (old) { try { old.close(); } catch {} }
      nativeScreenPeers.delete(id); stopNativeViewerDebug(id); stopNativeScreenHealth(id);
    }
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle", rtcpMuxPolicy: "require", iceCandidatePoolSize: 2 });
    nativeScreenPeers.set(id, pc);
    // TURN/VPN/Wi-Fi candidates can arrive after the initial SDP. Forward them
    // explicitly instead of leaving the native peer with an incomplete route.
    pc.onicecandidate = (event) => {
      if (event.candidate) void signal(id, {
        kind: "native-screen-viewer-ice",
        candidate: event.candidate.toJSON(),
      }).catch(() => {});
    };
    const screens = document.querySelector<HTMLElement>("#p2pScreens");
    let pendingTile = screens?.querySelector<HTMLElement>(`[data-p2p-screen="${id}"]`) || null;
    if (screens && !pendingTile) {
      pendingTile = document.createElement("article");
      pendingTile.className = "p2p-screen-tile pending"; pendingTile.dataset.p2pScreen = String(id);
      screens.append(pendingTile);
    }
    if (pendingTile && !pendingTile.querySelector("video")) pendingTile.innerHTML = `<div class="native-stream-local-state">${ico("video-message")}<b>Подключение к трансляции…</b><span>Настраиваем защищённый P2P-поток</span></div>`;
    startNativeViewerDebug(id, pc);
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (event) => { showNativeScreen(id, event); startNativeScreenHealth(id, pc); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        nativeScreenReconnectAttempts.set(id, 0);
        document.querySelector(`[data-p2p-screen="${id}"] .native-stream-reconnect`)?.remove();
        startNativeScreenHealth(id, pc);
      } else if (pc.connectionState === "disconnected") {
        window.setTimeout(() => {
          if (nativeScreenPeers.get(id) === pc && pc.connectionState === "disconnected") scheduleNativeScreenReconnect(id, "Нестабильная сеть");
        }, 2200);
      } else if (pc.connectionState === "failed") {
        scheduleNativeScreenReconnect(id, "Соединение потеряно");
      }
    };
    const offer = await pc.createOffer({ iceRestart: force });
    await pc.setLocalDescription(offer);
    // Native broadcaster currently exchanges ICE inside SDP. Give relay
    // candidates enough time to appear; 1.8 s was too short on another network.
    await waitForIce(pc, 4000);
    await signal(id, { kind: "native-screen-offer", sdp: pc.localDescription?.sdp || offer.sdp });
    // A PC waiting for an answer stays `new` and never fires failed/disconnected.
    // Turn that formerly infinite state into a bounded automatic retry.
    window.setTimeout(() => {
      if (nativeScreenPeers.get(id) !== pc || !watchingScreens.has(id)) return;
      if (pc.signalingState === "have-local-offer" || pc.connectionState === "new") {
        scheduleNativeScreenReconnect(id, "Ответ на трансляцию не получен");
      }
    }, 8000);
  };
  const setMuted = async (next: boolean) => {
    if (deafened && !next) return;
    if (muted === next) return;
    muted = next;
    saveVoicePreferences(muted, deafened);
    local.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    document.querySelectorAll("#callMic,#selfMute").forEach((node) => node.classList.toggle("off", muted));
    paintVoicePreferenceButtons();
    await publishPresence();
  };
  const toggleMute = () => setMuted(!muted);
  const toggleDeafen = async () => {
    deafened = !deafened;
    if (deafened) {
      mutedBeforeDeafen = muted;
      localStorage.setItem(VOICE_PRE_DEAFEN_MUTE_KEY, mutedBeforeDeafen ? "1" : "0");
      await setMuted(true);
    }
    else if (!mutedBeforeDeafen) await setMuted(false);
    saveVoicePreferences(muted, deafened);
    paintVoicePreferenceButtons();
    document.querySelectorAll("#callDeafen,#selfDeafen").forEach((node) => node.classList.toggle("off", deafened));
    document.querySelectorAll<HTMLMediaElement>("[data-p2p-audio]").forEach((audio) => setRemoteAudioMuted(audio, deafened));
    await publishPresence();
  };
  const attachScreenAudioToPeers = async () => {
    const track = screenAudioCapture?.track;
    if (!track || track.readyState !== "live") return;
    const stream = screenAudioStream || new MediaStream([track]);
    screenAudioStream = stream;
    for (const [id, pc] of peers) {
      if (!screenWatchers.has(id) || pc.connectionState === "closed" || screenAudioSenders.has(id)) continue;
      try {
        const sender = pc.addTrack(track, stream);
        screenAudioSenders.set(id, sender);
        const parameters = sender.getParameters();
        parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
        parameters.encodings[0].maxBitrate = 192_000;
        parameters.encodings[0].priority = "high";
        await sender.setParameters(parameters).catch(() => {});
        await requestPeerRenegotiation(id);
      } catch (error) {
        console.warn("Не удалось добавить звук трансляции для peer", id, error);
      }
    }
  };
  const stopScreenAudio = async () => {
    const capture = screenAudioCapture;
    screenAudioCapture = null;
    screenAudioStream = null;
    for (const [id, sender] of [...screenAudioSenders]) {
      const pc = peers.get(id);
      try { if (pc && pc.connectionState !== "closed") pc.removeTrack(sender); } catch {}
      screenAudioSenders.delete(id);
      try { await requestPeerRenegotiation(id); } catch {}
    }
    await capture?.stop().catch(() => {});
  };
  let activeScreenProfile = streamProfile(localStorage.getItem("kitchat_stream_fps"), lowResourceMode());
  const attachFallbackScreenToPeers = async () => {
    const track = fallbackScreenCapture?.track;
    if (!track || track.readyState !== "live") return;
    const stream = fallbackScreenStream || new MediaStream([track]);
    fallbackScreenStream = stream;
    for (const [id, pc] of peers) {
      if (!screenWatchers.has(id) || pc.connectionState === "closed" || fallbackScreenSenders.has(id)) continue;
      const sender = pc.addTrack(track, stream);
      fallbackScreenSenders.set(id, sender);
      const parameters = sender.getParameters();
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      parameters.encodings[0].maxBitrate = activeScreenProfile.bitrate;
      parameters.encodings[0].maxFramerate = activeScreenProfile.fps;
      parameters.encodings[0].priority = "high";
      await sender.setParameters(parameters).catch(() => {});
      await requestPeerRenegotiation(id);
    }
  };
  const stopFallbackScreen = async () => {
    const capture = fallbackScreenCapture;
    fallbackScreenCapture = null;
    fallbackScreenStream = null;
    compatibleScreenIsWebView = false;
    for (const [id, sender] of [...fallbackScreenSenders]) {
      const pc = peers.get(id);
      try { if (pc && pc.connectionState !== "closed") pc.removeTrack(sender); } catch {}
      fallbackScreenSenders.delete(id);
      try { await requestPeerRenegotiation(id); } catch {}
    }
    capture?.stop();
  };
  const startFallbackScreen = async (choice: CaptureChoice) => {
    stopNativeAdaptive();
    await invoke("native_stream_stop").catch(() => {});
    stopNativeLocalDebug();
    await stopNativeLocalPreview();
    const fallbackChoice: CaptureChoice = {
      ...choice,
      // Last-resort mode must remain usable on old integrated graphics rather
      // than attempting 1080p JPEG IPC and freezing the application.
      width: Math.min(choice.width, 1280),
      height: Math.min(choice.height, 720),
      fps: Math.min(choice.fps, 15),
      bitrate: Math.min(choice.bitrate, 3_000_000),
      jpegQuality: 80,
    };
    fallbackScreenCapture = await nativeCapture(fallbackChoice);
    compatibleScreenIsWebView = false;
    fallbackScreenStream = new MediaStream([fallbackScreenCapture.track]);
    sharingMode = "webrtc";
    await attachFallbackScreenToPeers();
    const tile = document.querySelector<HTMLElement>('[data-p2p-screen="self"]');
    if (tile) {
      tile.innerHTML = "";
      const video = document.createElement("video");
      video.autoplay = true; video.muted = true; video.playsInline = true;
      video.srcObject = fallbackScreenStream;
      tile.append(video);
      tile.insertAdjacentHTML("beforeend", `<div class="stream-overlay"><span>Ваша трансляция · совместимый режим</span><button type="button" data-stream-fullscreen title="На весь экран">${ico("focus")}</button></div>`);
      tile.querySelector<HTMLButtonElement>("[data-stream-fullscreen]")!.onclick = () => document.fullscreenElement === tile ? void document.exitFullscreen() : void tile.requestFullscreen();
    }
  };
  const startWebViewScreen = async (stream: MediaStream) => {
    stopNativeAdaptive();
    await invoke("native_stream_stop").catch(() => {});
    stopNativeLocalDebug();
    await stopNativeLocalPreview();
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("Windows не передала видеопоток выбранного экрана");
    track.contentHint = "detail";
    fallbackScreenCapture = { track, stop: () => stream.getTracks().forEach((item) => item.stop()) };
    fallbackScreenStream = new MediaStream([track]);
    compatibleScreenIsWebView = true;
    sharingMode = "webrtc";
    await attachFallbackScreenToPeers();
    const tile = document.querySelector<HTMLElement>('[data-p2p-screen="self"]');
    if (tile) {
      tile.innerHTML = "";
      const video = document.createElement("video");
      video.autoplay = true; video.muted = true; video.playsInline = true;
      video.srcObject = fallbackScreenStream;
      tile.append(video);
      tile.insertAdjacentHTML("beforeend", `<div class="stream-overlay"><span>Ваша трансляция · WebView2 · ${activeScreenProfile.fps} FPS</span><button type="button" data-stream-fullscreen title="На весь экран">${ico("focus")}</button></div>`);
      tile.querySelector<HTMLButtonElement>("[data-stream-fullscreen]")!.onclick = () => document.fullscreenElement === tile ? void document.exitFullscreen() : void tile.requestFullscreen();
    }
  };
  const stopScreen = async () => {
    if (!sharing) return;
    sharing = false;
    stopNativeAdaptive();
    await stopNativeLocalPreview();
    await stopFallbackScreen();
    await stopScreenAudio();
    await invoke("native_stream_stop").catch((error) => console.warn("Native stream stop failed", error));
    stopNativeLocalDebug();
    document.querySelector<HTMLElement>('[data-p2p-screen="self"]')?.remove();
    document.querySelector("#callShare")?.classList.remove("on");
    await Promise.all([...peers.keys()].map((id) => signal(id, { kind: "screen-stopped" }).catch(() => {})));
    screenAnnouncedTo.clear();
    screenWatchers.clear();
    sharingMode = null;
    await publishPresence();
  };
  let screenBusy = false;
  const toggleScreen = async () => {
    if (screenBusy || leaving) return;
    screenBusy = true;
    try {
    if (sharing) { await stopScreen(); return; }
    activeScreenProfile = streamProfile(localStorage.getItem("kitchat_stream_fps"), lowResourceMode());
    const screenSharePreference = localStorage.getItem("kitchat_screen_share_mode") === "native" ? "native" : "webview";
    if (screenSharePreference === "webview") {
      // Call getDisplayMedia directly from the button handler. WebView2 requires
      // this transient user activation and will then select Intel/AMD/NVIDIA
      // hardware acceleration itself instead of our CPU OpenH264 fallback.
      let browserStream: MediaStream;
      try {
        browserStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: activeScreenProfile.width, max: activeScreenProfile.width }, height: { ideal: activeScreenProfile.height, max: activeScreenProfile.height },
            frameRate: { ideal: activeScreenProfile.fps, max: activeScreenProfile.fps }, displaySurface: "monitor",
          },
          audio: false,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotAllowedError") return;
        await appAlert(`Не удалось открыть системный выбор экрана.\n\n${String(error)}`);
        return;
      }
      try {
        if (leaving) { browserStream.getTracks().forEach((track) => track.stop()); return; }
        sharing = true;
        const screens = document.querySelector<HTMLElement>("#p2pScreens");
        if (screens) {
          const tile = document.createElement("article");
          tile.className = "p2p-screen-tile local"; tile.dataset.p2pScreen = "self";
          tile.innerHTML = `<div class="native-stream-local-state">${ico("video-message")}<b>Выбранный экран</b><span>WebView2 · аппаратный кодер Windows</span></div>`;
          screens.append(tile);
          updateLocalWatcherBadge();
        }
        await startWebViewScreen(browserStream);
        browserStream.getVideoTracks()[0]?.addEventListener("ended", () => void stopScreen(), { once: true });
        try {
          screenAudioCapture = await startSystemAudioTrack();
          screenAudioStream = new MediaStream([screenAudioCapture.track]);
          await attachScreenAudioToPeers();
        } catch (audioError) {
          console.warn("System audio capture unavailable; stream continues without sound", audioError);
        }
        document.querySelector("#callShare")?.classList.add("on");
        await publishPresence();
        await Promise.all([...peers.keys()].map(async (id) => {
          await signal(id, { kind: "screen-started", mode: "webrtc" }).catch(() => {});
          screenAnnouncedTo.add(id);
        }));
      } catch (error) {
        browserStream.getTracks().forEach((track) => track.stop());
        await stopScreen();
        await appAlert(`Не удалось начать демонстрацию экрана.\n\n${String(error)}`);
      }
      return;
    }
    const choice = await p2pStreamPicker();
    if (!choice || leaving) return;
    activeScreenProfile = streamProfile(String(choice.fps), lowResourceMode());
    if (lowResourceMode()) {
      choice.width = Math.min(choice.width, 1280);
      choice.height = Math.min(choice.height, 720);
      choice.fps = Math.min(choice.fps, 15);
      choice.bitrate = Math.min(choice.bitrate, 1_200_000);
    }
    try {
      let nativeStarted = false;
      let nativeNeedsFallback = false;
      try {
        await invoke("native_stream_start", { config: {
          sourceKind: choice.kind, sourceId: choice.id, width: choice.width, height: choice.height,
          fps: choice.fps, bitrate: choice.bitrate, systemAudio: true,
        }});
        nativeStarted = true;
        sharingMode = "native";
      } catch (nativeError) {
        // Starting WGC/NVENC can fail immediately on Intel/AMD laptops. This
        // must not abort screen sharing: the compatible sender works on those
        // machines and uses the same custom source picker.
        console.warn("Native screen pipeline could not start; using compatible sender", nativeError);
        nativeNeedsFallback = true;
      }
      try {
        screenAudioCapture = await startSystemAudioTrack();
        screenAudioStream = new MediaStream([screenAudioCapture.track]);
        await attachScreenAudioToPeers();
      } catch (audioError) {
        screenAudioCapture = null;
        screenAudioStream = null;
        console.warn("System audio capture unavailable; stream continues without sound", audioError);
      }
      sharing = true;
      const screens = document.querySelector<HTMLElement>("#p2pScreens");
      if (screens) {
        const tile = document.createElement("article");
        tile.className = "p2p-screen-tile local"; tile.dataset.p2pScreen = "self";
        tile.innerHTML = `<div class="native-stream-local-state">${ico("video-message")}<b>${esc(choice.title)}</b><span>WGC · ${choice.width}×${choice.height} · ${choice.fps} FPS</span></div>`;
        screens.append(tile);
        updateLocalWatcherBadge();
      }
      if (nativeNeedsFallback) await startFallbackScreen(choice);
      // NVENC is unavailable on many Intel/AMD PCs. Detect a native pipeline
      // that produced no frames and transparently switch that participant to
      // the compatible WGC/WebRTC sender instead of leaving a 0 FPS stream.
      if (nativeStarted) {
        let nativeStatus: NativeStreamDebugStatus | null = null;
        // Encoder creation happens on the first WGC callback. Older laptops and
        // Optimus systems need longer than one second while the driver wakes up.
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 400));
          nativeStatus = await invoke<NativeStreamDebugStatus>("native_stream_status").catch(() => null);
          if (nativeStatus?.last_error || (nativeStatus && nativeStatus.captured_frames > 0 && nativeStatus.encoded_frames > 0)) break;
        }
        if (!nativeStatus || nativeStatus.captured_frames === 0 || nativeStatus.encoded_frames === 0 || nativeStatus.last_error) {
          console.warn("Native encoder unavailable; enabling compatible screen sender", nativeStatus?.last_error || nativeStatus);
          await startFallbackScreen(choice);
        } else {
          startNativeAdaptive(choice);
          startNativeLocalDebug();
          await startNativeLocalPreview().catch((error) => console.warn("Native local preview failed", error));
        }
      }
      document.querySelector("#callShare")?.classList.add("on");
      await publishPresence();
      // Presence polling can lag or be stale. Explicitly announce the native
      // stream to already connected voice peers so viewers can request it now.
      await Promise.all([...peers.keys()].map(async (id) => {
        await signal(id, { kind: "screen-started", mode: sharingMode }).catch(() => {});
        screenAnnouncedTo.add(id);
      }));
    } catch (error) {
      sharing = false;
      await stopScreenAudio();
      await invoke("native_stream_stop").catch(() => {});
      await appAlert(`Не удалось начать P2P-трансляцию. Голосовая связь продолжает работать.\n\n${String(error)}`);
      console.warn(error);
    }
    } finally { screenBusy = false; }
  };
  const poll = async () => {
    const started = performance.now();
    const batch = await community({ action: "voice_poll", channel_id: channelId, after });
    if (leaving || activeVoiceChannel !== channelId) return;
    syncVoiceDuration(batch.elapsed_seconds);
    for (const item of batch.signals || []) {
      after = Math.max(after, Number(item.id));
      const peerId = Number(item.from);
      try {
        if (item.payload?.kind === "roulette-hello") {
          await signal(peerId, rouletteSnapshot()).catch(() => {});
          continue;
        }
        if (item.payload?.kind === "roulette-state") {
          const incomingRevision = Number(item.payload.revision || 0);
          if (incomingRevision >= rouletteRevision) {
            for (const word of (item.payload.words || []) as RouletteWord[]) rouletteWords.set(word.id, word);
            for (const raw of (item.payload.locks || []) as Array<RouletteLock & { remaining?: number }>) {
              const remaining = Math.max(0, Number(raw.remaining ?? (raw.expiresAt - Date.now())));
              if (remaining > 0) rouletteLocks.set(raw.userId, { ...raw, expiresAt: Date.now() + remaining });
            }
            if (!rouletteHistory.length && Array.isArray(item.payload.history)) rouletteHistory.push(...item.payload.history.slice(0, 8));
            rouletteRevision = incomingRevision; renderRoulette(); renderUsers(rouletteUsers);
            const activeSpin = item.payload.activeSpin as RouletteSpinPlan | null | undefined;
            if (activeSpin && activeSpin.id && !rouletteAppliedSpinIds.has(activeSpin.id) && activeSpin.startAt + activeSpin.totalMs > Date.now() - 1000) runRouletteSpin(activeSpin, false);
          }
          continue;
        }
        if (item.payload?.kind === "roulette-word-add" && item.payload.word) {
          const word = item.payload.word as RouletteWord; rouletteWords.set(word.id, word); rouletteRevision = Math.max(rouletteRevision, Number(item.payload.revision || Date.now())); renderRoulette();
          continue;
        }
        if (item.payload?.kind === "roulette-word-remove") {
          rouletteWords.delete(String(item.payload.id || "")); rouletteRevision = Math.max(rouletteRevision, Number(item.payload.revision || Date.now())); renderRoulette();
          continue;
        }
        if (item.payload?.kind === "roulette-spin-plan" && item.payload.plan) {
          const plan = item.payload.plan as RouletteSpinPlan;
          if (plan.id && !rouletteAppliedSpinIds.has(plan.id)) runRouletteSpin(plan, false);
          continue;
        }
        if (item.payload?.kind === "roulette-result" && item.payload.result) {
          applyRouletteResult(item.payload.result, false); rouletteRevision = Math.max(rouletteRevision, Number(item.payload.revision || Date.now()));
          continue;
        }
        if (item.payload?.kind === "native-screen-quality") {
          if (sharing && sharingMode === "native") {
            nativeViewerQuality.set(peerId, {
              at: Date.now(),
              lossPct: Math.max(0, Number(item.payload.lossPct || 0)),
              jitterMs: Math.max(0, Number(item.payload.jitterMs || 0)),
              rttMs: Math.max(0, Number(item.payload.rttMs || 0)),
              fps: Math.max(0, Number(item.payload.fps || 0)),
              packets: Math.max(0, Number(item.payload.packets || 0)),
              bytes: Math.max(0, Number(item.payload.bytes || 0)),
            });
          }
          continue;
        }
        if (item.payload?.kind === "screen-started") {
          const mode = item.payload.mode === "webrtc" ? "webrtc" : "native";
          remoteScreenModes.set(peerId, mode);
          if (peerId !== me.id && !sharing && !watchingScreens.has(peerId)) renderAvailableScreen(peerId, mode);
          continue;
        }
        if (item.payload?.kind === "screen-watch-start" && sharing) {
          screenWatchers.add(peerId);
          updateLocalWatcherBadge();
          await attachScreenAudioToPeer(peerId).catch((error) => console.warn("Screen audio subscribe failed", error));
          if (sharingMode === "webrtc") await attachFallbackScreenToPeer(peerId).catch((error) => console.warn("Fallback screen subscribe failed", error));
          continue;
        }
        if (item.payload?.kind === "screen-watch-stop" && sharing) {
          screenWatchers.delete(peerId);
          pendingNativeStreamerIce.delete(peerId);
          updateLocalWatcherBadge();
          await detachScreenMediaFromPeer(peerId).catch((error) => console.warn("Screen unsubscribe failed", error));
          if (sharingMode === "native") await invoke("native_stream_remove_peer", { viewerId: String(peerId) }).catch(() => {});
          continue;
        }
        if (item.payload?.kind === "screen-stopped") {
          remoteScreenModes.delete(peerId);
          watchingScreens.delete(peerId);
          const reconnectTimer = nativeScreenReconnectTimers.get(peerId); if (reconnectTimer) window.clearTimeout(reconnectTimer); nativeScreenReconnectTimers.delete(peerId);
          stopNativeScreenHealth(peerId); nativeScreenReconnectAttempts.delete(peerId);
          document.querySelector(`[data-p2p-screen="${peerId}"]`)?.remove();
          nativeScreenPeers.get(peerId)?.close(); nativeScreenPeers.delete(peerId); stopNativeViewerDebug(peerId);
          screenRequestAt.delete(peerId);
          continue;
        }
        if (item.payload?.kind === "native-screen-offer" && sharing && sharingMode === "native") {
          screenWatchers.add(peerId); updateLocalWatcherBadge();
          await attachScreenAudioToPeer(peerId).catch(() => {});
          try {
            const answer = await invoke<{ sdp: string }>("native_stream_accept_offer", {
              viewerId: String(peerId), sdp: String(item.payload.sdp || ""), iceServers,
            });
            for (const candidate of pendingNativeStreamerIce.get(peerId) || []) {
              await invoke("native_stream_add_ice", { viewerId: String(peerId), candidate }).catch(() => {});
            }
            pendingNativeStreamerIce.delete(peerId);
            await signal(peerId, { kind: "native-screen-answer", sdp: answer.sdp });
          } catch (error) {
            console.warn("Native screen offer failed", error);
            await signal(peerId, { kind: "native-screen-error", message: String(error) }).catch(() => {});
          }
          continue;
        }
        if (item.payload?.kind === "native-screen-viewer-ice" && sharing && sharingMode === "native") {
          const candidate = item.payload.candidate as RTCIceCandidateInit;
          try {
            await invoke("native_stream_add_ice", { viewerId: String(peerId), candidate });
          } catch {
            // Candidate messages can precede the offer in a polling batch.
            const queued = pendingNativeStreamerIce.get(peerId) || [];
            queued.push(candidate);
            pendingNativeStreamerIce.set(peerId, queued.slice(-32));
          }
          continue;
        }
        if (item.payload?.kind === "native-screen-answer") {
          const screenPc = nativeScreenPeers.get(peerId);
          if (screenPc?.signalingState === "have-local-offer") {
            try {
              await screenPc.setRemoteDescription({ type: "answer", sdp: item.payload.sdp });
            } catch (error) {
              console.warn("Native screen answer rejected", error);
              scheduleNativeScreenReconnect(peerId, "Ответ WebRTC несовместим");
            }
          }
          continue;
        }
        if (item.payload?.kind === "native-screen-error") {
          console.warn("Streamer rejected native screen offer", item.payload.message);
          updateNativeReconnectTile(peerId, "Повторяем подключение к трансляции…");
          scheduleNativeScreenReconnect(peerId, "Стример не принял запрос");
          continue;
        }
        if (item.payload?.kind === "camera-main-track") {
          if (item.payload.enabled === false) {
            remoteCameraStreamIds.delete(peerId);
            remoteCameraStreams.delete(peerId);
            renderUsers(rouletteUsers);
          } else {
            const streamId = String(item.payload.stream_id || "");
            if (streamId) remoteCameraStreamIds.set(peerId, streamId);
          }
          continue;
        }
        if (item.payload?.kind === "camera-stopped") {
          remoteCameraStreamIds.delete(peerId);
          remoteCameraStreams.delete(peerId);
          renderUsers(rouletteUsers);
          continue;
        }
        if (item.payload?.kind === "camera-sync-request") {
          if (camera) {
            // Prefer the voice PeerConnection, which is already known to work
            // through this participant's NAT. Legacy camera-only peers remain
            // accepted below for clients that have not updated yet.
            await attachCameraToVoicePeer(peerId).catch(() => {});
            if (item.payload.transport === "voice") continue;
            const existing = cameraPeers.get(peerId);
            const age = Date.now() - (cameraPeerStartedAt.get(peerId) || Date.now());
            if (existing && (existing.connectionState === "failed" || existing.connectionState === "closed" || age > 15_000)) {
              closeCameraPeer(peerId, existing);
            }
            await makeCameraOffer(peerId, true);
          }
          continue;
        }
        if (item.payload?.kind === "camera-offer") {
          await cameraOfferTasks.get(peerId)?.catch(() => {});
          let cameraPc = await cameraPeerFor(peerId);
          if (cameraPc.signalingState !== "stable") {
            if (me.id < peerId) continue;
            await cameraPc.setLocalDescription({ type: "rollback" });
          }
          await cameraPc.setRemoteDescription(item.payload.sdp);
          const remoteTrack = cameraPc.getReceivers().find((receiver) => receiver.track.kind === "video")?.track;
          if (remoteTrack && item.payload.camera !== false) {
            const current = remoteCameraStreams.get(peerId);
            if (!current?.getVideoTracks().includes(remoteTrack)) remoteCameraStreams.set(peerId, new MediaStream([remoteTrack]));
            attachCameraVideo(peerId);
          }
          for (const candidate of pendingCameraIce.get(peerId) || []) await cameraPc.addIceCandidate(candidate).catch(() => {});
          pendingCameraIce.delete(peerId);
          const answer = await cameraPc.createAnswer();
          await cameraPc.setLocalDescription(answer);
          await signal(peerId, { kind: "camera-answer", sdp: cameraPc.localDescription, camera });
          continue;
        }
        if (item.payload?.kind === "camera-answer") {
          const cameraPc = cameraPeers.get(peerId);
          if (cameraPc?.signalingState === "have-local-offer") {
            await cameraPc.setRemoteDescription(item.payload.sdp);
            if (item.payload.camera === false) { remoteCameraStreams.delete(peerId); renderUsers(rouletteUsers); }
            for (const candidate of pendingCameraIce.get(peerId) || []) await cameraPc.addIceCandidate(candidate).catch(() => {});
            pendingCameraIce.delete(peerId);
          }
          continue;
        }
        if (item.payload?.kind === "camera-ice" && item.payload.candidate) {
          const cameraPc = cameraPeers.get(peerId);
          if (cameraPc?.remoteDescription) await cameraPc.addIceCandidate(item.payload.candidate).catch(() => {});
          else pendingCameraIce.set(peerId, [...(pendingCameraIce.get(peerId) || []).slice(-31), item.payload.candidate]);
          continue;
        }
        const pc = await peerFor(peerId);
        if (item.payload?.kind === "offer") {
          if (pc.signalingState !== "stable") await pc.setLocalDescription({ type: "rollback" });
          await pc.setRemoteDescription(item.payload.sdp);
          await applyPendingIce(peerId, pc);
          const answer = tuneVoiceSdp(await pc.createAnswer(), voiceBitrates[voiceNetworkLevel]);
          await pc.setLocalDescription(answer);
          await signal(peerId, { kind: "answer", sdp: pc.localDescription });
        } else if (item.payload?.kind === "answer") {
          if (pc.signalingState === "have-local-offer") {
            await pc.setRemoteDescription(item.payload.sdp);
            await applyPendingIce(peerId, pc);
          }
        } else if (item.payload?.kind === "ice" && item.payload.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(item.payload.candidate).catch(() => {});
          else pendingIce.set(peerId, [...(pendingIce.get(peerId) || []).slice(-31), item.payload.candidate]);
        }
      } catch (error) {
        console.warn(`P2P signal from ${peerId} failed`, error);
      }
    }
    const users: VoiceUser[] = batch.users || [];
    rouletteUsers = users;
    for (const user of users) {
      if (user.id === me.id || rouletteKnownUsers.has(user.id)) continue;
      rouletteKnownUsers.add(user.id);
      void signal(user.id, rouletteSnapshot()).catch(() => {});
      void signal(user.id, { kind: "roulette-hello" }).catch(() => {});
    }
    if (!users.some((user) => user.id === me.id)) {
      missingSelfPolls += 1;
      console.warn(`P2P presence: self missing (${missingSelfPolls}/4)`);
      if (missingSelfPolls >= 4) {
        await leave();
        return;
      }
    } else {
      missingSelfPolls = 0;
    }
    renderUsers(users);
    // If we are currently streaming, announce it to users that joined after
    // the stream started. This also makes the feature independent of the
    // server-side `sharing` presence flag being perfectly fresh.
    if (sharing) {
      for (const user of users) {
        if (user.id === me.id || screenAnnouncedTo.has(user.id)) continue;
        await signal(user.id, { kind: "screen-started", mode: sharingMode }).catch(() => {});
        screenAnnouncedTo.add(user.id);
      }
    }
    // A participant who joins after the camera was enabled must receive a
    // fresh offer; presence polling is the reliable late-join trigger.
    if (camera) {
      for (const user of users) {
        if (user.id === me.id || cameraVoiceSenders.has(user.id)) continue;
        void attachCameraToVoicePeer(user.id).catch((error) => console.warn("Late P2P camera attach failed", error));
      }
    }
    // Presence is the source of truth if a signaling packet was lost. A viewer
    // with no live track explicitly asks the camera owner to renegotiate.
    for (const user of users) {
      if (user.id === me.id) continue;
      const stream = remoteCameraStreams.get(user.id);
      const hasLiveTrack = !!stream?.getVideoTracks().some((track) => track.readyState === "live" && !track.muted);
      if (!user.camera) {
        if (stream) { remoteCameraStreams.delete(user.id); renderUsers(users); }
        continue;
      }
      if (!hasLiveTrack) requestCameraSync(user.id);
      const cameraPc = cameraPeers.get(user.id);
      const age = Date.now() - (cameraPeerStartedAt.get(user.id) || Date.now());
      if (cameraPc && cameraPc.connectionState !== "connected" && age > 12_000) recoverCameraPeer(user.id, cameraPc);
    }
    // Discord-like opt-in: announcing a stream only shows a card. Media is
    // requested after the viewer presses “Смотреть”, so idle participants do
    // not consume the streamer's upload or decoder resources.
    for (const user of users) {
      if (user.id === me.id || !user.sharing || watchingScreens.has(user.id)) continue;
      const mode = remoteScreenModes.get(user.id);
      if (mode) renderAvailableScreen(user.id, mode);
    }
    // Если отдельная грань mesh зависла на signaling/ICE, пересоздаём только её.
    // Инициатором снова будет пользователь с меньшим id, поэтому glare не возникает.
    for (const [id, pc] of peers) {
      const age = Date.now() - (peerStartedAt.get(id) || Date.now());
      if (pc.connectionState !== "connected" && age > 12_000) {
        pc.close();
        peers.delete(id);
        peerOffers.delete(id);
        peerStartedAt.delete(id);
        pendingIce.delete(id);
        document.querySelectorAll(`[data-voice-user="${id}"]`).forEach((node) => node.remove());
      }
    }
    for (const user of users) if (user.id !== me.id && me.id < user.id && !peers.has(user.id)) await peerFor(user.id, true);
    for (const [id, pc] of peers) if (!users.some((user) => user.id === id)) { pc.close(); peers.delete(id); peerOffers.delete(id); peerStartedAt.delete(id); pendingIce.delete(id); screenRequestAt.delete(id); screenAnnouncedTo.delete(id); screenWatchers.delete(id); watchingScreens.delete(id); screenAudioSenders.delete(id); fallbackScreenSenders.delete(id); remoteScreenModes.delete(id); cameraVoiceSenders.delete(id); remoteCameraStreamIds.delete(id); closeCameraPeer(id); const cameraTimer=cameraRecoveryTimers.get(id); if(cameraTimer)window.clearTimeout(cameraTimer); cameraRecoveryTimers.delete(id); cameraSyncRequestedAt.delete(id); remoteCameraStreams.delete(id); document.querySelectorAll(`[data-voice-user="${id}"]`).forEach((node) => node.remove()); stopNativeViewerDebug(id); document.querySelector(`[data-p2p-screen="${id}"]`)?.remove(); }
    // До появления WebRTC-статистики показываем только задержку signaling.
    if (!voiceRealRtt) {
      const latency = Math.round(performance.now() - started);
      const ping = document.querySelector<HTMLElement>("#qualityPing");
      if (ping) ping.textContent = `${latency} мс`;
    }
  };
  const leave = async () => {
    if (leaving) return;
    leaving = true;
    nativeScreenReconnectTimers.forEach((timer) => window.clearTimeout(timer)); nativeScreenReconnectTimers.clear();
    stopVoiceDuration();
    nativeScreenHealthTimers.forEach((timer) => window.clearInterval(timer)); nativeScreenHealthTimers.clear();
    pendingPeerRenegotiations.forEach((timer) => window.clearTimeout(timer)); pendingPeerRenegotiations.clear();
    cameraRecoveryTimers.forEach((timer) => window.clearTimeout(timer)); cameraRecoveryTimers.clear();
    clearTimeout(pollTimer); clearInterval(meterTimer); clearInterval(heartbeatTimer); clearInterval(voiceNetworkTimer); clearTimeout(rouletteTickTimer);
    stopNativeAdaptive();
    await audioContext.close().catch(() => {});
    if (sharing) { await stopNativeLocalPreview(); await stopFallbackScreen(); await stopScreenAudio(); await invoke("native_stream_stop").catch(() => {}); }
    if (camera) await stopCamera(true);
    stopNativeLocalDebug();
    nativeScreenDebugTimers.forEach((timer) => window.clearInterval(timer)); nativeScreenDebugTimers.clear();
    await community({}, { action: "voice_leave", channel_id: channelId }).catch(() => {});
    peers.forEach((pc) => pc.close()); cameraPeers.forEach((pc) => pc.close()); nativeScreenPeers.forEach((pc) => pc.close()); local.getTracks().forEach((track) => track.stop());
    document.querySelector("#voiceDockApp")?.remove();
    activeVoiceChannel = 0; activeVoiceMode = null; activeVoiceMeta = null; activeVoiceRoom = null;
    activeVoiceLeave = activeVoiceMute = activeVoiceDeafen = activeVoiceCamera = activeVoiceShare = null;
    activeVoiceSetUserVolume = null;
    activeVoiceSetMuted = null;
    if (!changingVoiceChannel) await shellView(serverId, "");
  };
  activeVoiceLeave = leave; activeVoiceMute = toggleMute; activeVoiceSetMuted = setMuted;
  activeVoiceDeafen = toggleDeafen; activeVoiceCamera = toggleCamera; activeVoiceShare = toggleScreen;
  activeVoiceSetUserVolume = (userId, volume) => {
    document.querySelectorAll<HTMLMediaElement>(`[data-voice-user="${userId}"]`).forEach((element) => setRemoteAudioVolume(element, volume));
  };
  document.querySelector<HTMLButtonElement>("#callMic")!.onclick = () => void toggleMute();
  document.querySelector<HTMLButtonElement>("#callCamera")!.onclick = () => void toggleCamera();
  document.querySelector<HTMLButtonElement>("#callShare")!.onclick = () => void toggleScreen();
  document.querySelector<HTMLButtonElement>("#callDeafen")!.onclick = () => void toggleDeafen();
  document.querySelector<HTMLButtonElement>("#callLeave")!.onclick = () => void leave();
  document.querySelector<HTMLButtonElement>("#voiceDockLeave")!.onclick = () => void leave();
  document.querySelector<HTMLButtonElement>("#callFullscreen")!.onclick = () => void document.querySelector<HTMLElement>("#callStage")?.requestFullscreen();
  document.querySelector<HTMLButtonElement>("#voiceQuality")!.onclick = (event) => { event.stopPropagation(); const popover = document.querySelector<HTMLElement>("#voiceQualityPopover"); if (popover) popover.hidden = !popover.hidden; };
  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser(), levels = new Uint8Array(128);
  audioContext.createMediaStreamSource(local).connect(analyser);
  meterTimer = window.setInterval(() => {
    analyser.getByteFrequencyData(levels);
    const next = !muted && levels.reduce((sum, value) => sum + value, 0) / levels.length > 28;
    if (next !== speaking) { speaking = next; void publishPresence(); }
  }, lowResourceMode() ? 400 : 180);
  try {
    const joined = await community({}, { action: "voice_join", channel_id: channelId });
    startVoiceDuration(joined.elapsed_seconds);
  } catch (error) {
    await leave();
    throw error;
  }
  startVoiceNetworkMonitor();
  // Keep presence alive independently from screen-share ICE/SDP work. A slow
  // native negotiation must never make the server think the user left voice.
  heartbeatTimer = window.setInterval(() => {
    if (!leaving && activeVoiceChannel === channelId) void publishPresence();
  }, 2500);
  if (localStorage.getItem("kitchat_input_mode") === "ptt") await setMuted(true);
  const status = document.querySelector<HTMLElement>("#roomState"); if (status) status.lastChild!.textContent = "Подключено";
  const label = document.querySelector<HTMLElement>("#voiceConnectionLabel"); if (label) label.textContent = "Голосовая P2P-связь подключена";
  const loop = async () => {
    if (leaving || activeVoiceChannel !== channelId) return;
    try { await poll(); } catch (error) { console.warn("P2P voice poll failed", error); }
    if (!leaving && activeVoiceChannel === channelId) pollTimer = window.setTimeout(() => void loop(), 900);
  };
  await loop();
}

async function callViewLegacy(
  channelId: number,
  name: string,
  serverName: string,
  serverId = 0,
) {
  if (activeVoiceChannel === channelId) {
    const room =
        activeVoiceRoom || document.querySelector<HTMLElement>(".call-screen"),
      chat = document.querySelector<HTMLElement>(".chat");
    if (room && chat) {
      activeVoiceRoom = room;
      chat.innerHTML = "";
      chat.append(room);
    }
    return;
  }
  if (activeVoiceLeave) {
    changingVoiceChannel = true;
    try {
      await activeVoiceLeave();
    } finally {
      changingVoiceChannel = false;
    }
  }
  activeVoiceRoom = null;
  const host = document.querySelector<HTMLElement>(".chat") || app;
  const meData = await request("desktop_auth.php?action=me");
  currentUser = meData.user;
  const me = currentUser!;
  let local: MediaStream;
  try {
    local = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch {
    host.innerHTML = `<main class="media-error"><img src="/kitchat-icon.png"><h1>Не удалось включить микрофон</h1><p>Разрешите Kitchat использовать микрофон в настройках Windows.</p><button id="closeCall">Вернуться в чат</button></main>`;
    document.querySelector<HTMLButtonElement>("#closeCall")!.onclick = () =>
      void shellView(serverId, "");
    return;
  }
  activeVoiceChannel = channelId;
  activeVoiceMeta = { name, serverName };
  document.querySelectorAll("#voiceDockApp").forEach((node) => node.remove());
  const profile = document.querySelector<HTMLElement>(".profile");
  profile?.insertAdjacentHTML("beforebegin", dockMarkup());
  document.querySelector<HTMLElement>("#voiceDockApp")!.dataset.connection =
    "joining";
  document.querySelector<HTMLElement>("#voiceConnectionLabel")!.textContent =
    "Подключение к голосовому каналу…";
  host.innerHTML = `<main class="call-screen embedded"><header class="embedded-call-header"><div><b>${esc(name)}</b><small>${esc(serverName)} · Голосовой канал</small></div><span class="online"><i></i>Подключено</span></header><section class="call-stage" id="callStage">${fullscreenCallControls()}<div class="video-grid" id="videoGrid"><article class="video-tile local-tile" data-user="${me.id}"><video id="localVideo" autoplay muted playsinline></video><div class="voice-avatar"><span class="avatar">${avatar(me)}</span></div><footer>${esc(me.name)} <small>(Вы)</small><i class="muted-badge" hidden>⌁</i></footer></article></div></section><footer class="call-controls"><button id="callMic" title="Выключить микрофон">${ico("mic")}</button><button id="callCamera" title="Включить камеру">${ico("camera")}</button><button id="callShare" title="Демонстрация экрана">${ico("video-message")}</button><button id="callDeafen" title="Не слышать других">${ico("headphones")}</button><button id="callFullscreen" title="Развернуть сцену">${ico("focus")}</button><button id="callLeave" class="danger" title="Отключиться">${ico("phone-down")}</button></footer><div id="remoteAudio"></div></main>`;
  const peers = new Map<number, RTCPeerConnection>();
  const streams = new Map<number, MediaStream>();
  const initialVoicePrefs = getVoicePreferences();
  let after = 0,
    timer = 0,
    meterTimer = 0,
    muted = initialVoicePrefs.muted,
    deafened = initialVoicePrefs.deafened,
    camera = false,
    sharing = false,
    speaking = false,
    visualTrack: MediaStreamTrack | null = null;
  local.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  saveVoicePreferences(muted, deafened);
  paintVoicePreferenceButtons();
  let iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  try {
    const turn = await fetch(
      "https://oliverkitchen.ru/turn_credentials.php",
    ).then((r) => r.json());
    if (turn.ok && turn.iceServer) iceServers.push(turn.iceServer);
  } catch {}
  const post = (data: Record<string, string | number>) => community({}, data);
  const signal = (to: number, payload: unknown) =>
    post({
      action: "voice_signal",
      channel_id: channelId,
      to,
      payload: JSON.stringify(payload),
    });
  function showStream(id: number, stream: MediaStream, user?: VoiceUser) {
    streams.set(id, stream);
    const profile = user || voiceDirectory.get(id);
    let tile = document.querySelector<HTMLElement>(`[data-user="${id}"]`);
    if (!tile) {
      tile = document.createElement("article");
      tile.className = "video-tile";
      tile.dataset.user = String(id);
      tile.innerHTML = `<video autoplay playsinline></video><div class="voice-avatar"><span class="avatar">${avatar(profile || { name: "?" })}</span></div><footer>${esc(profile?.name || "Участник")}</footer>`;
      document.querySelector("#videoGrid")!.append(tile);
    } else if (profile) {
      tile.querySelector<HTMLElement>(".voice-avatar .avatar")!.innerHTML =
        avatar(profile);
      tile.querySelector<HTMLElement>("footer")!.childNodes[0].textContent =
        profile.name;
    }
    const video = tile.querySelector("video")!;
    video.srcObject = stream;
    tile.classList.toggle("has-video", stream.getVideoTracks().length > 0);
  }
  async function peerFor(id: number, offer = false) {
    if (peers.has(id)) return peers.get(id)!;
    const pc = new RTCPeerConnection({ iceServers });
    local.getTracks().forEach((track) => pc.addTrack(track, local));
    pc.onicecandidate = (e) => {
      if (e.candidate) void signal(id, { kind: "ice", candidate: e.candidate });
    };
    pc.ontrack = (e) => showStream(id, e.streams[0]);
    pc.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(pc.connectionState)) {
        pc.close();
        peers.delete(id);
      }
    };
    peers.set(id, pc);
    if (offer) {
      const description = await pc.createOffer();
      await pc.setLocalDescription(description);
      await signal(id, { kind: "offer", sdp: description });
    }
    return pc;
  }
  async function syncTrack(track: MediaStreamTrack | null) {
    if (visualTrack) {
      local.removeTrack(visualTrack);
      visualTrack.stop();
    }
    visualTrack = track;
    if (track) local.addTrack(track);
    showStream(me.id, local);
    for (const [id, pc] of peers) {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(track);
      else if (track) {
        pc.addTrack(track, local);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await signal(id, { kind: "offer", sdp: offer });
      }
    }
  }
  async function setState() {
    await post({
      action: "voice_state",
      channel_id: channelId,
      muted: muted ? 1 : 0,
      deafened: deafened ? 1 : 0,
      speaking: speaking ? 1 : 0,
      camera: camera ? 1 : 0,
      sharing: sharing ? 1 : 0,
    });
  }
  const pendingIce = new Map<number, RTCIceCandidateInit[]>();
  async function applyIce(id: number, pc: RTCPeerConnection) {
    for (const candidate of pendingIce.get(id) || [])
      await pc.addIceCandidate(candidate);
    pendingIce.delete(id);
  }
  async function poll() {
    const started = performance.now();
    try {
      const batch = await community({
        action: "voice_poll",
        channel_id: channelId,
        after,
      });
      (batch.users || []).forEach((user: VoiceUser) =>
        voiceDirectory.set(user.id, user),
      );
      for (const item of batch.signals) {
        after = Math.max(after, item.id);
        const pc = await peerFor(item.from);
        const payload = item.payload;
        if (payload.kind === "offer") {
          await pc.setRemoteDescription(payload.sdp);
          await applyIce(item.from, pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await signal(item.from, { kind: "answer", sdp: answer });
        } else if (payload.kind === "answer") {
          await pc.setRemoteDescription(payload.sdp);
          await applyIce(item.from, pc);
        } else if (payload.kind === "ice" && payload.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(payload.candidate);
          else
            pendingIce.set(item.from, [
              ...(pendingIce.get(item.from) || []),
              payload.candidate,
            ]);
        }
      }
      const state: CommunityState = await community({
        server_id: serverId,
        channel: "",
      });
      const users = state.voice.filter((u) => u.channel_id === channelId);
      users.forEach((user) => voiceDirectory.set(user.id, user));
      const presence = document.querySelector<HTMLElement>(
        `.voice-presence[data-channel-id="${channelId}"]`,
      );
      if (presence) presence.innerHTML = users.map(voicePerson).join("");
      const voiceButton = document.querySelector<HTMLElement>(
        `[data-voice="${channelId}"] small`,
      );
      if (voiceButton) voiceButton.textContent = `${users.length} в голосовом`;
      for (const user of users) {
        let tile = document.querySelector<HTMLElement>(
          `[data-user="${user.id}"]`,
        );
        if (!tile && user.id !== me.id) {
          showStream(user.id, new MediaStream(), user);
          tile = document.querySelector<HTMLElement>(
            `[data-user="${user.id}"]`,
          );
        }
        if (tile) {
          tile.classList.toggle("speaking", user.speaking && !user.muted);
          const label = tile.querySelector<HTMLElement>("footer");
          if (label) label.childNodes[0].textContent = user.name;
          const picture = tile.querySelector<HTMLElement>(
            ".voice-avatar .avatar",
          );
          if (picture) picture.innerHTML = avatar(user);
        }
        tile
          ?.querySelector<HTMLElement>(".muted-badge")
          ?.toggleAttribute("hidden", !user.muted);
        if (user.id !== me.id && me.id < user.id && !peers.has(user.id))
          await peerFor(user.id, true);
      }
      for (const tile of document.querySelectorAll<HTMLElement>(
        ".video-tile:not(.local-tile)",
      )) {
        if (!users.some((u) => u.id === Number(tile.dataset.user))) {
          tile.remove();
          peers.get(Number(tile.dataset.user))?.close();
          peers.delete(Number(tile.dataset.user));
        }
      }
      const latency = Math.round(performance.now() - started),
        level = latency < 250 ? "good" : latency < 700 ? "fair" : "bad";
      document
        .querySelector<HTMLElement>("#voiceQuality")
        ?.setAttribute("data-level", level);
      document
        .querySelector<HTMLElement>("#voiceQualityPopover")
        ?.setAttribute("data-level", level);
      const ping = document.querySelector<HTMLElement>("#qualityPing"),
        quality = document.querySelector<HTMLElement>("#qualityState");
      if (ping) ping.textContent = `${latency} мс`;
      if (quality)
        quality.textContent =
          level === "good" ? "Хорошо" : level === "fair" ? "Средне" : "Плохо";
    } catch {
      document
        .querySelector<HTMLElement>("#voiceQualityPopover")
        ?.setAttribute("data-level", "bad");
    }
  }
  document.querySelector<HTMLButtonElement>("#callFullscreen")!.onclick =
    () => {
      const stage = document.querySelector<HTMLElement>("#callStage");
      if (document.fullscreenElement) void document.exitFullscreen();
      else if (stage?.requestFullscreen) void stage.requestFullscreen();
    };
  const toggleMute = async () => {
    if (deafened && muted) return;
    muted = !muted;
    saveVoicePreferences(muted, deafened);
    local.getAudioTracks().forEach((t) => (t.enabled = !muted));
    document
      .querySelectorAll("#callMic,#selfMute")
      .forEach((button) => button.classList.toggle("off", muted));
    paintVoicePreferenceButtons();
    await setState();
  };
  const toggleDeafen = async () => {
    deafened = !deafened;
    if (deafened) {
      localStorage.setItem(VOICE_PRE_DEAFEN_MUTE_KEY, muted ? "1" : "0");
      muted = true;
      local.getAudioTracks().forEach((t) => (t.enabled = false));
    }
    saveVoicePreferences(muted, deafened);
    paintVoicePreferenceButtons();
    document
      .querySelectorAll("#callMic,#selfMute")
      .forEach((button) => button.classList.toggle("off", muted));
    document
      .querySelectorAll("#callDeafen,#selfDeafen")
      .forEach((button) => button.classList.toggle("off", deafened));
    document
      .querySelectorAll<HTMLMediaElement>(
        "#remoteAudio audio,.video-tile:not(.local-tile) video",
      )
      .forEach((media) => (media.muted = deafened));
    await setState();
  };
  activeVoiceMute = toggleMute;
  activeVoiceSetMuted = async (next) => {
    if (muted !== next) await toggleMute();
  };
  activeVoiceDeafen = toggleDeafen;
  document.querySelector<HTMLButtonElement>("#callMic")!.onclick = () =>
    void toggleMute();
  document.querySelector<HTMLButtonElement>("#callDeafen")!.onclick = () =>
    void toggleDeafen();
  document.querySelector<HTMLButtonElement>("#selfMute")!.onclick = () =>
    void toggleMute();
  document.querySelector<HTMLButtonElement>("#selfDeafen")!.onclick = () =>
    void toggleDeafen();
  document.querySelector<HTMLButtonElement>("#callCamera")!.onclick = async (
    e,
  ) => {
    if (camera) {
      camera = false;
      sharing = false;
      await syncTrack(null);
    } else {
      if (!(await requestMediaAccess("camera"))) return;
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      localStorage.setItem("kitchat_camera_granted", "1");
      camera = true;
      sharing = false;
      await syncTrack(stream.getVideoTracks()[0]);
      visualTrack!.onended = () => {
        camera = false;
        void syncTrack(null);
        void setState();
      };
    }
    (e.currentTarget as HTMLElement).classList.toggle("on", camera);
    document.querySelector("#callShare")?.classList.remove("on");
    await setState();
  };
  document.querySelector<HTMLButtonElement>("#callShare")!.onclick =
    async () => {
      if (sharing) {
        const extra =
          (
            visualTrack as
              (MediaStreamTrack & { screenAudio?: MediaStreamTrack[] }) | null
          )?.screenAudio || [];
        for (const pc of peers.values())
          for (const sender of pc.getSenders())
            if (sender.track && extra.includes(sender.track))
              pc.removeTrack(sender);
        extra.forEach((track) => {
          local.removeTrack(track);
          track.stop();
        });
        sharing = false;
        camera = false;
        await syncTrack(null);
        document.querySelector("#callShare")?.classList.remove("on");
        await setState();
        return;
      }
      modal(
        "Настройка трансляции",
        `<p>Выберите качество изображения. Передачу системного звука также потребуется подтвердить в окне Windows.</p><div class="stream-quality-grid"><label><input type="radio" name="quality" value="720" checked><span><b>HD</b><small>1280×720 · 30 FPS</small></span></label><label><input type="radio" name="quality" value="1080"><span><b>Full HD</b><small>1920×1080 · 30 FPS</small></span></label><label><input type="radio" name="quality" value="60"><span><b>Плавная</b><small>1280×720 · 60 FPS</small></span></label></div><label class="check-setting"><input name="audio" type="checkbox" checked><span><b>Системный звук</b><small>Передавать звук выбранного окна или экрана</small></span></label>`,
        "Начать трансляцию",
        async (form) => {
          const values = new FormData(form),
            quality = String(values.get("quality") || "720"),
            full = quality === "1080",
            fps = quality === "60" ? 60 : 30;
          const selected = await capturePicker();
          if (!selected) throw new Error("Экран не выбран");
          const capture = await nativeCapture({
            ...selected,
            width: full ? 1920 : 1280,
            height: full ? 1080 : 720,
            fps,
          });
          const video = capture.track;
          sharing = true;
          camera = false;
          await syncTrack(video);
          const audioTracks: MediaStreamTrack[] = [];
          (
            visualTrack as MediaStreamTrack & {
              screenAudio?: MediaStreamTrack[];
            }
          ).screenAudio = audioTracks;
          audioTracks.forEach((track) => local.addTrack(track));
          for (const [id, pc] of peers) {
            audioTracks.forEach((track) => pc.addTrack(track, new MediaStream([track])));
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await signal(id, { kind: "offer", sdp: offer });
          }
          visualTrack!.onended = () => {
            document.querySelector<HTMLButtonElement>("#callShare")?.click();
          };
          document.querySelector("#callShare")?.classList.add("on");
          document.querySelector("#callCamera")?.classList.remove("on");
          playSound("share");
          await setState();
        },
      );
    };
  document
    .querySelectorAll<HTMLButtonElement>(".voice-dock-actions button")
    .forEach(
      (button, index) =>
        (button.onclick = () =>
          ["#callCamera", "#callShare"][index]
            ? document
                .querySelector<HTMLButtonElement>(
                  ["#callCamera", "#callShare"][index],
                )
                ?.click()
            : undefined),
    );
  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  audioContext.createMediaStreamSource(local).connect(analyser);
  const levels = new Uint8Array(analyser.frequencyBinCount);
  meterTimer = window.setInterval(() => {
    analyser.getByteFrequencyData(levels);
    const level = levels.reduce((sum, value) => sum + value, 0) / levels.length;
    const next = !muted && level > 28;
    if (next !== speaking) {
      speaking = next;
      document
        .querySelector(".local-tile")
        ?.classList.toggle("speaking", speaking);
      void setState();
    }
  }, 180);
  let leaving = false;
  const leave = async () => {
    if (leaving) return;
    leaving = true;
    clearTimeout(timer);
    clearInterval(meterTimer);
    await audioContext.close().catch(() => {});
    await post({ action: "voice_leave", channel_id: channelId }).catch(
      () => {},
    );
    peers.forEach((pc) => pc.close());
    local.getTracks().forEach((t) => t.stop());
    document.querySelector("#voiceDockApp")?.remove();
    activeVoiceChannel = 0;
    activeVoiceLeave = null;
    activeVoiceMute = null;
    activeVoiceSetMuted = null;
    activeVoiceDeafen = null;
    activeVoiceCamera = null;
    activeVoiceShare = null;
    activeVoiceMeta = null;
    activeVoiceRoom = null;
    host.classList.remove("call-expanded");
    if (!changingVoiceChannel) await shellView(serverId, "");
  };
  activeVoiceLeave = leave;
  document.querySelector<HTMLButtonElement>("#callLeave")!.onclick = leave;
  document.querySelector<HTMLButtonElement>("#voiceDockLeave")!.onclick = leave;
  document.querySelector<HTMLButtonElement>("#voiceQuality")!.onclick = (
    event,
  ) => {
    event.stopPropagation();
    const popover = document.querySelector<HTMLElement>("#voiceQualityPopover");
    if (popover) popover.hidden = !popover.hidden;
  };
  await post({ action: "voice_join", channel_id: channelId });
  document.querySelector<HTMLElement>("#voiceDockApp")!.dataset.connection =
    "connected";
  document.querySelector<HTMLElement>("#voiceConnectionLabel")!.textContent =
    "Голосовая связь подключена";
  showStream(me.id, local);
  if (localStorage.getItem("kitchat_input_mode") === "ptt")
    await activeVoiceSetMuted?.(true);
  const pollLoop = async () => {
    if (leaving || activeVoiceChannel !== channelId) return;
    await poll();
    if (!leaving && activeVoiceChannel === channelId)
      timer = window.setTimeout(() => void pollLoop(), 1200);
  };
  await pollLoop();
}
void callViewLegacy;
type UpdateArtwork = { src: string; alt: string };
function safeUpdateArtwork(value: unknown, alt = "Новое в Kitchat"): UpdateArtwork | null {
  const raw = typeof value === "string" ? value : value && typeof value === "object" ? String((value as { url?: unknown; src?: unknown }).url || (value as { src?: unknown }).src || "") : "";
  try {
    const url = new URL(raw, "https://oliverkitchen.ru");
    if (url.protocol !== "https:" || !/(^|\.)oliverkitchen\.ru$/i.test(url.hostname)) return null;
    const label = value && typeof value === "object" ? String((value as { alt?: unknown }).alt || alt) : alt;
    return { src: url.href, alt: label.slice(0, 120) };
  } catch { return null; }
}
function updateNotesMarkup(value: string) {
  const lines = value.replace(/!\[[^\]]*\]\([^)]*\)/g, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bullets = lines.filter((line) => /^[-*•]\s+/.test(line));
  const paragraphs = lines.filter((line) => !/^[-*•]\s+/.test(line));
  return `${paragraphs.map((line) => `<p>${esc(line)}</p>`).join("")}${bullets.length ? `<ul>${bullets.map((line) => `<li>${esc(line.replace(/^[-*•]\s+/, ""))}</li>`).join("")}</ul>` : ""}`;
}
async function updatePresentation(version: string, notes: string): Promise<{ title: string; images: UpdateArtwork[] }> {
  const markdownImages = [...notes.matchAll(/!\[([^\]]*)\]\((https:\/\/[^)]+)\)/g)]
    .map((match) => safeUpdateArtwork(match[2], match[1]))
    .filter((item): item is UpdateArtwork => !!item);
  try {
    const response = await fetch(`https://oliverkitchen.ru/downloads/kitchat/latest.json?presentation=${Date.now()}`, { cache: "no-store" });
    const manifest = await response.json();
    if (String(manifest.version || "") !== version) throw new Error("Manifest version mismatch");
    const configured: UpdateArtwork[] = (Array.isArray(manifest.images) ? manifest.images : [])
      .map((image: unknown) => safeUpdateArtwork(image))
      .filter((item: UpdateArtwork | null): item is UpdateArtwork => !!item);
    return { title: String(manifest.title || `Kitchat ${version}`).slice(0, 90), images: configured.length ? configured : markdownImages };
  } catch {
    return { title: `Kitchat ${version}`, images: markdownImages };
  }
}
async function checkForUpdates() {
  try {
    const update = await check({ timeout: 15000 });
    if (!update) return;
    const notes = update.body || "Новая версия Kitchat готова к установке.";
    const presentation = await updatePresentation(update.version, notes);
    const artwork = presentation.images[0] || { src: "/kitchat-update-hero.svg", alt: "Обновление Kitchat" };
    const layer = document.createElement("div");
    layer.className = "modal-layer update-layer";
    layer.innerHTML = `<section class="modal-card update-card"><button class="modal-close" type="button" aria-label="Закрыть">×</button><div class="update-hero"><img src="${esc(artwork.src)}" alt="${esc(artwork.alt)}"><div class="update-version-pill">НОВАЯ ВЕРСИЯ · ${esc(update.version)}</div><div class="update-hero-copy"><span>Обновление Kitchat</span><h2>${esc(presentation.title)}</h2></div></div>${presentation.images.length > 1 ? `<div class="update-gallery" aria-label="Изображения обновления">${presentation.images.map((image, index) => `<button type="button" class="${index === 0 ? "active" : ""}" data-update-image="${esc(image.src)}" data-update-alt="${esc(image.alt)}"><img src="${esc(image.src)}" alt=""></button>`).join("")}</div>` : ""}<div class="update-content"><div class="update-notes"><h3>Что нового</h3>${updateNotesMarkup(notes)}</div><div class="update-progress" hidden><i></i></div><small id="updateStatus">Подпись обновления будет проверена автоматически</small><div class="modal-actions"><button class="cancel" type="button">Напомнить позже</button><button class="primary" type="button">Обновить сейчас</button></div></div></section>`;
    document.body.append(layer);
    const heroImage = layer.querySelector<HTMLImageElement>(".update-hero img")!;
    heroImage.onerror = () => { heroImage.onerror = null; heroImage.src = "/kitchat-update-hero.svg"; };
    const close = () => layer.remove();
    layer.querySelector<HTMLButtonElement>(".cancel")!.onclick = close;
    layer.querySelector<HTMLButtonElement>(".modal-close")!.onclick = close;
    layer.querySelectorAll<HTMLButtonElement>("[data-update-image]").forEach((thumbnail) => {
      thumbnail.onclick = () => {
        layer.querySelector<HTMLImageElement>(".update-hero img")!.src = thumbnail.dataset.updateImage || artwork.src;
        layer.querySelector<HTMLImageElement>(".update-hero img")!.alt = thumbnail.dataset.updateAlt || artwork.alt;
        layer.querySelectorAll("[data-update-image]").forEach((item) => item.classList.toggle("active", item === thumbnail));
      };
    });
    layer.querySelector<HTMLButtonElement>(".primary")!.onclick = async (
      event,
    ) => {
      const button = event.currentTarget as HTMLButtonElement,
        status = layer.querySelector<HTMLElement>("#updateStatus")!,
        progress = layer.querySelector<HTMLElement>(".update-progress")!,
        bar = progress.querySelector<HTMLElement>("i")!;
      button.disabled = true;
      progress.hidden = false;
      let downloaded = 0,
        total = 0;
      try {
        await update.downloadAndInstall((progress) => {
          if (progress.event === "Started")
            total = progress.data.contentLength || 0;
          if (progress.event === "Progress") {
            downloaded += progress.data.chunkLength;
            bar.style.width = total
              ? `${Math.min(100, (downloaded / total) * 100)}%`
              : "55%";
            status.textContent = total
              ? `Загружено ${Math.round((downloaded / total) * 100)}%`
              : "Загружаем обновление…";
          }
          if (progress.event === "Finished")
            status.textContent = "Проверяем подпись и запускаем установку…";
        });
        status.textContent = "Обновление готово — перезапускаем Kitchat…";
        bar.style.width = "100%";
        await relaunch();
      } catch (error) {
        console.error("Update installation failed", error);
        status.textContent = `Не удалось установить обновление: ${String(error)}`;
        bar.style.width = "0";
        button.disabled = false;
        button.textContent = "Попробовать снова";
      }
    };
  } catch (error) {
    console.warn("Update check failed", error);
  }
}
async function start() {
  appVersion = await getVersion().catch(() => appVersion);
  const appWindow = getCurrentWindow();
  await appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    await appWindow.hide();
  });
  await listen("kitchat://app-exiting", () => void markDesktopOffline());
  await listen("kitchat://check-update", () => void checkForUpdates());
  await onOpenUrl((urls) => {
    if (urls[0]) void acceptOAuth(urls[0]);
  });
  const opened = await getCurrent();
  if (opened?.[0]) {
    await acceptOAuth(opened[0]);
    return;
  }
  if (!token()) {
    authView();
    return;
  }
  try {
    const data = await request("desktop_auth.php?action=me");
    currentUser = data.user;
    void syncOwnProfileAbout();
    void ensureNotificationPermission();
    await shellView(0, "", true);
    window.setTimeout(() => void checkForUpdates(), 2500);
  } catch {
    localStorage.removeItem("kitchat_token");
    authView();
  }
}
void start();





