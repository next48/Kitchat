import { ico } from "./icons";

export const phoneLayout = matchMedia("(max-width: 760px), (pointer: coarse) and (max-width: 1366px)");

export function mobileHomeMarkup(profile: { name: string; login: string; avatar: string }) {
  return `<section class="mobile-servers-empty" aria-labelledby="mobileServersTitle">
    <div class="mobile-page-title-block">
      <small>KitChat</small>
      <h1 id="mobileServersTitle">Серверы</h1>
      <p>Здесь будут ваши серверы и приглашения.</p>
    </div>
    <button type="button" data-mobile-forward="createServer">Создать сервер</button>
  </section>
  <section class="mobile-profile" aria-labelledby="mobileProfileTitle">
    <header class="mobile-page-title-block"><small>Профиль</small><h1 id="mobileProfileTitle">Вы</h1></header>
    <div class="mobile-profile-identity"><div class="avatar">${profile.avatar}</div><div><b>${profile.name}</b><small>${profile.login}</small></div></div>
    <div class="mobile-profile-actions">
      <button type="button" data-mobile-forward="userSettings">${ico("gear")}<span>Настройки аккаунта</span>${ico("chevron-right")}</button>
      <button type="button" data-mobile-forward="homeRequests">${ico("bell")}<span>Заявки в друзья</span>${ico("chevron-right")}</button>
      <button type="button" data-mobile-forward="logout">${ico("phone-down")}<span>Выйти</span>${ico("chevron-right")}</button>
    </div>
  </section>
`;
}

export function trackMobileKeyboard() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const update = () => {
    const editing = document.activeElement?.matches("textarea, input:not([type=range]):not([type=file]), [contenteditable=true]");
    const keyboardOpen = Boolean(editing && viewport.scale === 1 && window.innerHeight - viewport.height > 100);
    document.body.classList.toggle("mobile-keyboard-open", keyboardOpen);
    if (keyboardOpen) document.body.style.setProperty("--mobile-viewport-height", `${viewport.height}px`);
    else document.body.style.removeProperty("--mobile-viewport-height");
  };
  viewport.addEventListener("resize", update);
  document.addEventListener("focusin", update);
  document.addEventListener("focusout", () => requestAnimationFrame(update));
}

type MobileServerScreen = {
  title: string;
  servers: string;
  requestCount: number;
  serverSettings: boolean;
  isServer: boolean;
  channelContent: string;
  profileMarkup: string;
  voiceDock: string;
};

export function mobileServerScreen(screen: MobileServerScreen) {
  return `<section class="phone-server-screen mobile-home" aria-label="Серверы и каналы">
    <nav class="rail phone-server-rail" aria-label="Серверы">
      <button class="home active-home" id="homeStart" type="button" aria-label="Личные сообщения">${ico("chat")}${screen.requestCount ? `<em>${screen.requestCount}</em>` : ""}</button>
      <i aria-hidden="true"></i><div class="mobile-server-list">${screen.servers}</div>
      <button class="add" id="createServer" type="button" aria-label="Создать сервер">+</button>
    </nav>
    <aside class="channels phone-channel-panel ${screen.isServer ? "is-server" : "is-inbox"}" aria-label="${screen.title}">
      <header class="phone-server-heading">
        <h1>${screen.title}</h1>
        ${screen.serverSettings ? `<button id="serverSettings" type="button" aria-label="Меню сервера">${ico("chevron-down")}</button>` : ""}
      </header>
      <div class="phone-server-actions">
        <button type="button" data-mobile-command-search>${ico("search")}<span>Поиск</span></button>
        ${screen.isServer
          ? `<button type="button" data-mobile-invite aria-label="Пригласить участников">${ico("user-plus")}</button>`
          : `<button id="mobileAddFriend" type="button" aria-label="Добавить друга">${ico("user-plus")}</button>`}
      </div>
      <div class="channel-scroll phone-channel-list">${screen.channelContent}</div>
    </aside>
    <footer class="phone-server-dock">${screen.voiceDock}${screen.profileMarkup}</footer>
  </section>`;
}

export function mobileIconButton(icon: string, label: string, attributes: string) {
  return `<button class="phone-icon-button" type="button" aria-label="${label}" ${attributes}>${ico(icon)}</button>`;
}

export function mobileChannelGroup(kind: string, title: string, rows: string, canCreate: boolean) {
  return `<section class="phone-channel-group">
    <header>
      <button type="button" data-phone-collapse="${kind}" aria-expanded="true">${ico("chevron-down")}<span>${title}</span></button>
      ${canCreate ? `<button type="button" data-create-channel="${kind}" aria-label="Создать канал">+</button>` : ""}
    </header>
    <div data-phone-channel-rows>${rows || "<p>Здесь пока нет каналов</p>"}</div>
  </section>`;
}

export function mobileInbox(rows: string, online: number, _incoming: number) {
  return `<div class="phone-inbox">
    <div class="phone-inbox-shortcuts">
      <button id="homeFriends" type="button">${ico("users")}<span><b>Друзья</b><small>${online} сейчас в сети</small></span>${ico("chevron-right")}</button>
    </div>
    <section class="phone-inbox-threads">
      <header><h2>Личные сообщения</h2></header>
      <div class="dm-thread-list">${rows || `<div class="phone-empty-state">${ico("chat")}<b>Диалогов пока нет</b><small>Выберите друга, чтобы начать переписку</small><button type="button" data-mobile-forward="homeFriends">Открыть друзей</button></div>`}</div>
    </section>
  </div>`;
}

// Receives escaped presentation data. Actions retain the existing app handlers.
export function mobileConversation(row: { id: number; name: string; avatar: string; online: boolean; preview: string; time: string; unread: number }) {
  return `<button type="button" class="dm-thread mobile-conversation ${row.unread ? "is-unread" : ""}" data-dm-user="${row.id}">
    <span class="avatar">${row.avatar}${row.online ? '<i></i>' : ''}</span>
    <span class="mobile-conversation-copy"><b>${row.name}</b><small>${row.preview}</small></span>
    <span class="mobile-conversation-meta"><time>${row.time}</time>${row.unread ? `<em>${row.unread}</em>` : ''}</span>
  </button>`;
}

export function mobileAccount(name: string, face: string, muted: boolean, deafened: boolean) {
  return `<section class="profile mobile-account">
    <button id="userSettings" type="button" class="mobile-account-identity" aria-label="Настройки профиля">
      <span class="avatar">${face}<i></i></span><span><b>${name}</b><small>В сети</small></span>${ico("chevron-down")}
    </button>
    <div class="mobile-account-actions">
      <button type="button" id="mobileAccountRequests" class="mobile-account-requests" aria-label="Уведомления">${ico("bell")}</button>
      <button id="selfMute" hidden aria-pressed="${muted}">${ico("mic")}</button>
      <button id="selfDeafen" hidden aria-pressed="${deafened}">${ico("headphones")}</button>
      <button id="logout" hidden>${ico("phone-down")}</button>
    </div>
  </section>`;
}

export function mobileChatHeader(title: string, server: boolean, online: number) {
  return `<header class="mobile-chat-bar">
    ${mobileIconButton("chevron-right", "Назад к каналам", 'data-mobile-pane="channels"')}
    <div class="mobile-chat-title"><b>${title}</b><small>${server ? `<span data-mobile-online>${online} в сети</span>` : title === "Уведомления" ? "Заявки в друзья" : "Личный диалог"}</small></div>
    <div class="mobile-chat-actions">${server ? mobileIconButton("search", "Поиск", 'data-mobile-action="search"') + mobileIconButton("users", "Участники", 'data-mobile-pane="members"') : ""}</div>
  </header>`;
}
