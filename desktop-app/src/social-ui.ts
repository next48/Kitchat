export type FriendFilter = "all" | "online" | "incoming" | "outgoing";
export type SocialPerson = { id: number; name: string; avatar?: string | null; about?: string; online?: boolean; friend_status: number; sent_by_me?: boolean };
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
export function selectFriends(people: SocialPerson[], filter: FriendFilter, query = "") {
  const needle = query.trim().toLocaleLowerCase('ru');
  return people.filter(person => {
    const match = filter === "incoming" ? person.friend_status === 0 && !person.sent_by_me
      : filter === "outgoing" ? person.friend_status === 0 && person.sent_by_me
      : person.friend_status === 1 && (filter !== "online" || person.online);
    return match && (!needle || person.name.toLocaleLowerCase('ru').includes(needle) || String(person.id).includes(needle));
  }).sort((a,b) => Number(!!b.online) - Number(!!a.online) || a.name.localeCompare(b.name, 'ru') || a.id-b.id);
}
export function socialSignature(people: SocialPerson[]) {
  return JSON.stringify([...people].sort((a,b)=>a.id-b.id).map(p=>[p.id,p.name,p.avatar,p.about,!!p.online,p.friend_status,p.sent_by_me]));
}
export function friendRows(people: SocialPerson[], filter: FriendFilter, query: string, avatar: (person: SocialPerson) => string) {
  const rows = selectFriends(people,filter,query);
  if (!rows.length) {
    const title = query ? 'Никого не нашли' : filter === 'online' ? 'Сейчас здесь тихо' : filter === 'incoming' ? 'Вы со всеми на связи' : filter === 'outgoing' ? 'Нет отправленных заявок' : 'Хорошая компания начинается с друга';
    const description = query ? 'Попробуйте другое имя или ID.' : filter === 'online' ? 'Когда друзья появятся в сети, вы увидите их здесь.' : filter === 'incoming' ? 'Новые приглашения появятся здесь автоматически.' : filter === 'outgoing' ? 'Найдите человека по имени или ID и отправьте приглашение.' : 'Добавьте друзей, общайтесь лично и собирайтесь в голосовых каналах.';
    return `<div class="friends-empty"><div class="friends-empty-symbol" aria-hidden="true">✦</div><h2>${title}</h2><p>${description}</p>${!query && filter === 'all' ? '<button type="button" data-social-add>Добавить первого друга</button>' : ''}</div>`;
  }
  return rows.map(person => `<article class="home-friend-row ${person.online ? 'is-online' : ''}" data-person="${person.id}"><div class="avatar">${avatar(person)}<i class="presence-dot ${person.online ? 'online' : 'offline'}"></i></div><div class="friend-identity"><b>${escape(person.name)}</b><small>${filter === 'incoming' ? 'Хочет добавить вас в друзья' : filter === 'outgoing' ? 'Ожидает ответа' : person.online ? 'В сети' : 'Не в сети'}<span> · ID ${person.id}</span></small></div><div class="friend-row-actions">${filter === 'incoming' ? `<button class="friend-accept" type="button" data-social-action="accept" data-user="${person.id}">Принять</button><button type="button" data-social-action="reject" data-user="${person.id}">Отклонить</button>` : filter === 'outgoing' ? `<button type="button" data-social-action="cancel" data-user="${person.id}">Отменить заявку</button>` : `<button class="friend-message" type="button" data-social-dm="${person.id}" aria-label="Написать ${escape(person.name)}">Написать <span aria-hidden="true">↗</span></button><button class="friend-more" type="button" data-social-action="remove" data-user="${person.id}" aria-label="Удалить ${escape(person.name)} из друзей" title="Удалить из друзей">×</button>`}</div></article>`).join('');
}
export function friendsView(people: SocialPerson[], filter: FriendFilter, avatar: (person: SocialPerson) => string) {
  return `<div class="friends-home social-hub"><header class="social-heading"><div><span class="eyebrow">ВАША КОМПАНИЯ</span><h1>Друзья</h1><p>Ближе, даже когда вы далеко.</p></div><button class="social-add-button" type="button" data-social-add><span aria-hidden="true">＋</span> Добавить друга</button></header><section class="friends-panel"><div class="friends-toolbar"><div class="friends-tabs" role="tablist" aria-label="Список друзей">${([['all','Все'],['online','В сети'],['incoming','Входящие'],['outgoing','Отправленные']] as const).map(([key,label])=>`<button type="button" role="tab" aria-selected="${key===filter}" data-friends-filter="${key}" class="${key===filter?'active':''}">${label}<span data-friends-count="${key}">${selectFriends(people,key).length}</span></button>`).join('')}</div><label class="friends-filter-search"><span aria-hidden="true">⌕</span><input id="friendsFilter" type="search" placeholder="Найти друга" aria-label="Поиск по друзьям" autocomplete="off"></label></div><div class="friends-list-heading"><span id="friendsListCount">${selectFriends(people,filter).length} в списке</span><span class="social-sync" id="socialSync" role="status"><i></i>Синхронизировано</span></div><div class="home-friends-list">${friendRows(people,filter,'',avatar)}</div></section><footer class="social-footer">Ваш ID <b>${''}</b><span>Совет: друга можно найти по имени или числовому ID.</span></footer></div>`;
}
