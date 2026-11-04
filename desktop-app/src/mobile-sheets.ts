// Drag only the sheet header so scrolling content and form controls stay usable.
export function installMobileSheets() {
  let card: HTMLElement | null = null;
  let startY = 0;
  let distance = 0;
  let moving: HTMLElement[] = [];
  document.addEventListener("pointerdown", (event) => {
    if (!matchMedia("(max-width:760px), (pointer: coarse) and (max-width:1366px)").matches || !(event.target instanceof Element)) return;
    const header = event.target.closest(".modal-titlebar, .mobile-members-bar");
    if (!header || event.target.closest("button, input, textarea")) return;
    card = header.closest<HTMLElement>(".modal-card") || header as HTMLElement;
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
      const close = target.querySelector<HTMLButtonElement>(".modal-close, [data-mobile-pane=chat]");
      close?.click();
    }
  };
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", () => { distance = 0; finish(); });
}
