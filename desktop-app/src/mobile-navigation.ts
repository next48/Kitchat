import { phoneLayout } from './mobile-ui';

// Keep the actual chat and member elements mounted: scrolling, drafts and handlers survive back navigation.
export function mountMobileLayers(shell: HTMLElement) {
  if (!phoneLayout.matches || shell.querySelector('.mobile-chat-screen')) return;
  const chat = shell.querySelector<HTMLElement>(':scope > .chat');
  const bar = shell.querySelector<HTMLElement>(':scope > .mobile-chat-bar');
  const members = shell.querySelector<HTMLElement>(':scope > .members');
  const infoBar = shell.querySelector<HTMLElement>(':scope > .mobile-members-bar');
  if (!chat || !bar || !members || !infoBar) return;
  const screen = document.createElement('section');
  screen.className = 'mobile-chat-screen';
  screen.setAttribute('aria-label', 'Переписка');
  shell.append(screen); screen.append(bar, chat);
  const backdrop = document.createElement('button');
  backdrop.type = 'button'; backdrop.className = 'mobile-info-backdrop';
  backdrop.dataset.mobilePane = 'chat'; backdrop.setAttribute('aria-label', 'Закрыть информацию о канале');
  const sheet = document.createElement('section');
  sheet.className = 'mobile-info-sheet'; sheet.setAttribute('aria-label', 'Информация о канале');
  shell.append(backdrop, sheet); sheet.append(infoBar, members);
  shell.dataset.pane = 'channels';
  // Establish the underneath screen before the first pushed route is shown.
  void screen.getBoundingClientRect();
}

export function setMobileLayerState(shell: HTMLElement, pane: string) {
  if (!phoneLayout.matches) return;
  shell.querySelector<HTMLElement>('.mobile-home')?.toggleAttribute('inert', pane !== 'channels');
  shell.querySelector<HTMLElement>('.mobile-chat-screen')?.toggleAttribute('inert', pane !== 'chat');
  shell.querySelector<HTMLElement>('.mobile-info-sheet')?.toggleAttribute('inert', pane !== 'members');
  shell.querySelector<HTMLElement>('.mobile-info-backdrop')?.toggleAttribute('inert', pane !== 'members');
}
