const mobileQuery = '(max-width:760px), (pointer: coarse) and (max-width:1366px)';
type Gesture = { pointer:number; x:number; y:number; axis:'x'|'y'; target:HTMLElement; close:HTMLElement; distance:number; started:number; locked:boolean };

// One recognizer owns each gesture. Vertical content scrolling remains native; back swipes follow the finger.
export function installMobileSheets() {
  let gesture: Gesture | null = null;
  let suppressClick = false;
  document.addEventListener('click', event => {
    if (!suppressClick) return;
    event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false;
  }, true);
  document.addEventListener('pointerdown', event => {
    if (!matchMedia(mobileQuery).matches || !event.isPrimary || event.button !== 0 || !(event.target instanceof Element)) return;
    if (event.target.closest('.voice-floating')) return;
    if (event.target.closest('input,textarea,select,[contenteditable=true],video,audio')) return;
    const element = event.target;
    const modal = element.closest<HTMLElement>('.modal-card');
    const actions = element.closest<HTMLElement>('.mobile-action-sheet');
    const info = element.closest<HTMLElement>('.mobile-info-sheet');
    const voice = element.closest<HTMLElement>('#phoneVoiceHost:not([hidden])');
    const chat = element.closest<HTMLElement>('.mobile-chat-screen');
    let target:HTMLElement | null = null;
    let close:HTMLElement | null = null;
    let axis:'x'|'y' = 'x';
    if (actions && element.closest('header') && !element.closest('button')) {
      target = actions; close = actions.querySelector('[data-voice-close]'); axis = 'y';
    } else if (modal && element.closest('.modal-titlebar') && !element.closest('button')) {
      target = modal; close = modal.querySelector('.modal-close'); axis = 'y';
    } else if (info && element.closest('.mobile-members-bar') && !element.closest('button')) {
      target = info; close = info.querySelector('[data-mobile-pane=chat]'); axis = 'y';
    } else if (!document.querySelector('.modal-layer') && !info && (voice || chat)) {
      // The edge is usable even beside a message. Elsewhere avoid horizontal controls and selectable text.
      if (event.clientX > 32 && (element.closest('button,a,.message-body,.messages,.dm-messages') || !element.closest('.mobile-chat-bar,.embedded-call-header,.call-stage'))) return;
      target = voice || chat;
      close = target?.querySelector(voice ? '.mobile-call-back' : '[data-mobile-pane=channels]') || null;
    }
    if (!target || !close) return;
    gesture = {pointer:event.pointerId,x:event.clientX,y:event.clientY,axis,target,close,distance:0,started:performance.now(),locked:false};
  });
  document.addEventListener('pointermove', event => {
    const g = gesture;
    if (!g || event.pointerId !== g.pointer || !g.target.isConnected) return;
    const dx = event.clientX-g.x, dy = event.clientY-g.y;
    const along = g.axis === 'x' ? dx : dy, across = g.axis === 'x' ? dy : dx;
    if (!g.locked) {
      if (Math.abs(across) > 12 && Math.abs(across) > Math.abs(along)) { gesture = null; return; }
      if (along < -10) { gesture = null; return; }
      if (along < 7) return;
      g.locked = true; g.target.classList.add('sheet-dragging');
      g.target.setPointerCapture(event.pointerId);
    }
    g.distance = Math.max(0, along);
    g.target.style.transform = `translate${g.axis.toUpperCase()}(${g.distance}px)`;
    if (event.cancelable) event.preventDefault();
  }, {passive:false});
  const finish = (event:PointerEvent, cancelled = false) => {
    const g = gesture;
    if (!g || event.pointerId !== g.pointer) return;
    gesture = null;
    if (!g.locked) return;
    const size = g.axis === 'x' ? g.target.clientWidth : g.target.clientHeight;
    const velocity = g.distance / Math.max(1, performance.now()-g.started);
    const dismiss = !cancelled && (g.distance > Math.min(120,size*.3) || g.distance > 45 && velocity > .5);
    g.target.classList.remove('sheet-dragging');
    if (dismiss) {
      // Set the route first; the inline transform keeps the layer at the finger's release position.
      g.close.click();
    }
    // CSS interpolates back to the resting route position on cancellation as well.
    g.target.style.removeProperty('transform');
    suppressClick = true; window.setTimeout(() => { suppressClick = false; }, 0);
  };
  document.addEventListener('pointerup', event => finish(event));
  document.addEventListener('pointercancel', event => finish(event, true));
}
