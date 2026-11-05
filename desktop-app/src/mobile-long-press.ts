// Only a stationary touch opens actions; ordinary taps and scrolling stay native.
export function installMobileLongPress() {
  let hold: {element:HTMLElement; pointer:number; x:number; y:number; timer:number} | null = null;
  let consumed: {element:HTMLElement; until:number} | null = null;
  const cancel = () => { if (hold) clearTimeout(hold.timer); hold = null; };
  document.addEventListener('pointerdown', event => {
    cancel();
    if (!event.isPrimary || event.pointerType === 'mouse' || !matchMedia('(max-width:760px), (pointer:coarse) and (max-width:1366px)').matches) return;
    const target=event.target as Element;
    const element = target.closest<HTMLElement>('.channel[data-channel-id],[data-message-id],[data-dm-message-id]');
    if (!element || target.closest('button:not(.channel),input,textarea,video,audio')) return;
    const pending = {element,pointer:event.pointerId,x:event.clientX,y:event.clientY,timer:0};
    pending.timer = window.setTimeout(() => {
      if (hold !== pending || !element.isConnected) return;
      consumed = {element,until:Infinity};
      element.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:pending.x,clientY:pending.y}));
      cancel();
    },480);
    hold = pending;
  }, {passive:true});
  document.addEventListener('pointermove', event => {
    if (hold && (event.pointerId !== hold.pointer || Math.hypot(event.clientX-hold.x,event.clientY-hold.y)>9)) cancel();
  }, {passive:true});
  document.addEventListener('pointerup', () => {if(consumed)consumed.until=performance.now()+700;cancel();}, {passive:true});
  document.addEventListener('pointercancel', () => {consumed=null;cancel();}, {passive:true});
  document.addEventListener('contextmenu', event => {
    if(event.isTrusted && consumed && performance.now()<consumed.until && consumed.element.contains(event.target as Node)) {
      event.preventDefault();event.stopImmediatePropagation();
    }
  },true);
  document.addEventListener('scroll', cancel, {capture:true,passive:true});
  document.addEventListener('click', event => {
    if (consumed && performance.now()<consumed.until && consumed.element.contains(event.target as Node)) {
      event.preventDefault(); event.stopImmediatePropagation(); consumed=null;
    }
  },true);
}
