// Drag only the sheet header so scrolling content and form controls stay usable.
export function installMobileSheets() {
  let edge: {x:number; y:number} | null = null;
  document.addEventListener("touchstart", event => {
    if (event.touches.length !== 1 || event.touches[0].clientX > 28 || document.querySelector(".modal-layer")) { edge = null; return; }
    edge = {x:event.touches[0].clientX, y:event.touches[0].clientY};
  }, {passive:true});
  document.addEventListener("touchend", event => {
    if (!edge || !event.changedTouches.length) return;
    const start = edge; edge = null;
    const point = event.changedTouches[0];
    if (point.clientX - start.x < 70 || Math.abs(point.clientY-start.y) > 45 || window.getSelection()?.toString()) return;
    const voice = document.querySelector<HTMLElement>("#phoneVoiceHost:not([hidden]) .mobile-call-back");
    const shell = document.querySelector<HTMLElement>(".phone-shell");
    const back = voice || shell?.querySelector<HTMLElement>(shell.dataset.pane === "members" ? ".mobile-members-bar [data-mobile-pane=chat]" : ".mobile-chat-bar [data-mobile-pane=channels]");
    back?.click();
  }, {passive:true});
  let card: HTMLElement | null = null;
  let startY = 0;
  let distance = 0;
  let moving: HTMLElement[] = [];
  document.addEventListener("pointerdown", (event) => {
    if (!matchMedia("(max-width:760px), (pointer: coarse) and (max-width:1366px)").matches || !(event.target instanceof Element)) return;
    const header = event.target.closest(".modal-titlebar, .mobile-members-bar, #phoneVoiceHost .embedded-call-header");
    if (!header || event.target.closest("button, input, textarea")) return;
    card = header.closest<HTMLElement>(".modal-card, .call-screen") || header as HTMLElement;
    moving = card.matches(".mobile-members-bar")
      ? [...card.parentElement!.querySelectorAll<HTMLElement>(":scope > .mobile-members-bar, :scope > .members, :scope > .mobile-channel-media")]
      : [card];
    moving.forEach(node => node.classList.add("sheet-dragging"));
    startY = event.clientY;
    distance = 0;
    card.setPointerCapture(event.pointerId);
  });
  document.addEventListener("pointermove", (event) => {
    if (!card) return;
    distance = Math.max(0, event.clientY - startY);
    moving.forEach(node => { node.style.transform = `translateY(${distance}px)`; });
  });
  const finish = () => {
    if (!card) return;
    const target = card;
    card = null;
    moving.forEach(node => { node.style.removeProperty("transform"); node.classList.remove("sheet-dragging"); });
    moving = [];
    if (distance > 90) {
      const close = target.querySelector<HTMLButtonElement>(".modal-close, [data-mobile-pane=chat], .mobile-call-back");
      close?.click();
    }
  };
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", () => { distance = 0; finish(); });
}
