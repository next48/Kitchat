export type FloatBounds = { left:number; top:number; right:number; bottom:number };
export type FloatPosition = { x:number; y:number; tucked:'left'|'right'|'' };
export const VOICE_FLOAT_SIZE = 128;
const HANDLE = 24;
const clamp = (value:number,min:number,max:number) => Math.max(min,Math.min(value,max));

// Pure geometry also covers keyboard/rotation bounds and both stashed edges.
export function settleVoiceFloat(x:number,y:number,b:FloatBounds,tuck=true):FloatPosition {
  const maxX = Math.max(b.left,b.right-VOICE_FLOAT_SIZE);
  const top = clamp(y,b.top,Math.max(b.top,b.bottom-VOICE_FLOAT_SIZE));
  if (tuck && x < b.left-VOICE_FLOAT_SIZE*.3) return {x:b.left-VOICE_FLOAT_SIZE+HANDLE,y:top,tucked:'left'};
  if (tuck && x > maxX+VOICE_FLOAT_SIZE*.3) return {x:b.right-HANDLE,y:top,tucked:'right'};
  return {x:x < (b.left+maxX)/2 ? b.left : maxX,y:top,tucked:''};
}

export function installMobileVoiceFloat(host:HTMLElement) {
  const lifecycle = new AbortController();
  const listen = {signal:lifecycle.signal};
  let position:FloatPosition | null = null;
  let animation:Animation | undefined;
  const tabStops=new Map<HTMLElement,string|null>();
  let dragging:{pointer:number; x:number; y:number; origin:FloatPosition; moved:boolean} | null = null;
  let suppressClickUntil = 0;
  const bounds = ():FloatBounds => {
    const v = window.visualViewport;
    const body = getComputedStyle(document.body);
    const x = v?.offsetLeft || 0, y = v?.offsetTop || 0;
    return {left:x+12,top:y+Math.max(12,parseFloat(body.paddingTop)||0),right:x+(v?.width||innerWidth)-12,bottom:y+(v?.height||innerHeight)-Math.max(12,parseFloat(body.paddingBottom)||0)};
  };
  const applyPosition = (p:FloatPosition) => {
    position=p; host.style.setProperty('--voice-float-x',`${p.x}px`); host.style.setProperty('--voice-float-y',`${p.y}px`);
    host.dataset.tucked=p.tucked;
    host.querySelector('.voice-float-open')?.setAttribute('aria-label',p.tucked ? 'Вернуть окошко звонка' : 'Развернуть голосовой канал');
    const indicator = host.querySelector<HTMLElement>('.voice-float-handle');
    if (indicator) indicator.textContent=p.tucked==='left' ? '›' : '‹';
  };
  const animateFrom = (before:DOMRect) => {
    animation?.cancel();
    if (matchMedia('(prefers-reduced-motion:reduce)').matches) return;
    const after=host.getBoundingClientRect();
    if (!after.width || !before.width) return;
    animation=host.animate([
      {transform:`translate(${before.left-after.left}px,${before.top-after.top}px) scale(${before.width/after.width},${before.height/after.height})`,borderRadius:'24px'},
      {transform:'none',borderRadius:host.classList.contains('voice-floating')?'22px':'0px'}
    ],{duration:320,easing:'cubic-bezier(.22,.72,.2,1)'});
  };
  const chooseTile = () => {
    if (!host.classList.contains('voice-floating')) return;
    const tile=host.querySelector<HTMLElement>('.p2p-screen-tile:not(.stream-available) video')?.closest('.p2p-screen-tile')
      || host.querySelector('.video-tile.has-video:not(.local-tile)') || host.querySelector('.video-tile.has-video') || host.querySelector('.video-tile');
    host.querySelectorAll<HTMLElement>('[data-float-selected]').forEach(node=>{if(node!==tile) node.removeAttribute('data-float-selected');});
    if(tile && !tile.hasAttribute('data-float-selected')) tile.setAttribute('data-float-selected','');
    const preview=host.querySelector<HTMLElement>('.voice-float-avatar');
    const face=tile?.querySelector<HTMLElement>('.voice-avatar .avatar');
    if(preview) {
      preview.hidden=!!tile?.querySelector('video') || !face;
      if(face && preview.dataset.face!==face.outerHTML) {
        preview.replaceChildren(face.cloneNode(true)); preview.dataset.face=face.outerHTML;
      }
    }
    const room=host.querySelector<HTMLElement>('.call-screen');
    if(room) {
      // Keep the live media subtree paintable. Only the overlay button is interactive in mini mode.
      room.querySelectorAll<HTMLElement>('button,[tabindex],a,input,select,textarea').forEach(node=>{
        if(!tabStops.has(node)) tabStops.set(node,node.getAttribute('tabindex'));
        if(node.getAttribute('tabindex')!=='-1') node.setAttribute('tabindex','-1');
      });
    }
  };
  const ensureControl = () => {
    if(host.querySelector('.voice-float-open')) return;
    const button=document.createElement('button');
    button.type='button'; button.className='voice-float-open';
    button.setAttribute('aria-label','Развернуть голосовой канал');
    button.innerHTML='<span class="voice-float-avatar" aria-hidden="true"></span><span class="voice-float-handle" aria-hidden="true">‹</span>';
    host.append(button);
  };
  const minimize = () => {
    if (host.classList.contains('voice-floating')) return;
    const before=host.getBoundingClientRect();
    animation?.cancel(); host.style.removeProperty('transform');
    host.classList.remove('voice-dismissed','sheet-dragging');
    host.classList.add('voice-floating'); host.hidden=false; host.inert=false;
    ensureControl();
    const b=bounds();
    const p=position || {x:b.right-VOICE_FLOAT_SIZE,y:b.top+78,tucked:''};
    applyPosition(settleVoiceFloat(p.x,p.y,b,Boolean(p.tucked)));
    chooseTile(); animateFrom(before);
  };
  const expand = () => {
    const floating=host.classList.contains('voice-floating');
    const before=host.getBoundingClientRect();
    animation?.cancel(); host.hidden=false; host.inert=false;
    host.classList.remove('voice-floating','voice-dismissed','phone-controls-hidden');
    host.querySelectorAll<HTMLElement>('[data-float-selected]').forEach(node=>node.removeAttribute('data-float-selected'));
    host.querySelector('.call-screen')?.removeAttribute('aria-hidden');
    tabStops.forEach((value,node)=>{ if(value===null) node.removeAttribute('tabindex'); else node.setAttribute('tabindex',value); });
    tabStops.clear();
    host.dispatchEvent(new Event('voice-show'));
    if (floating) animateFrom(before);
  };
  host.addEventListener('click',event=>{
    if(performance.now()<suppressClickUntil) {event.preventDefault();event.stopImmediatePropagation();return;}
    if(!host.classList.contains('voice-floating')) return;
    if(position?.tucked) {
      const before=host.getBoundingClientRect(); const b=bounds();
      applyPosition(settleVoiceFloat(position.tucked==='left'?b.left:b.right-VOICE_FLOAT_SIZE,position.y,b,false));
      animateFrom(before);
    } else expand();
  },{...listen,capture:true});
  host.addEventListener('pointerdown',event=>{
    if(!host.classList.contains('voice-floating') || !position || !event.isPrimary || event.button!==0) return;
    event.stopPropagation();
    suppressClickUntil=0;
    animation?.cancel();
    dragging={pointer:event.pointerId,x:event.clientX,y:event.clientY,origin:{...position},moved:false};
    host.setPointerCapture(event.pointerId);
  },listen);
  host.addEventListener('pointermove',event=>{
    const d=dragging; if(!d || d.pointer!==event.pointerId) return;
    const dx=event.clientX-d.x,dy=event.clientY-d.y;
    if(!d.moved && Math.hypot(dx,dy)<6) return;
    d.moved=true; event.preventDefault(); event.stopPropagation();
    const b=bounds();
    applyPosition({x:clamp(d.origin.x+dx,b.left-VOICE_FLOAT_SIZE+HANDLE,b.right-HANDLE),y:clamp(d.origin.y+dy,b.top,Math.max(b.top,b.bottom-VOICE_FLOAT_SIZE)),tucked:''});
  },{...listen,passive:false});
  const finish=(event:PointerEvent,cancelled=false)=>{
    const d=dragging; if(!d || d.pointer!==event.pointerId) return;
    dragging=null; event.stopPropagation();
    if(!d.moved || !position) return;
    suppressClickUntil=performance.now()+350;
    const before=host.getBoundingClientRect();
    applyPosition(cancelled ? settleVoiceFloat(d.origin.x,d.origin.y,bounds()) : settleVoiceFloat(position.x,position.y,bounds()));
    animateFrom(before);
  };
  host.addEventListener('pointerup',e=>finish(e),listen);
  host.addEventListener('pointercancel',e=>finish(e,true),listen);
  const resize=()=>{
    if(!host.classList.contains('voice-floating') || !position || dragging) return;
    const b=bounds();
    const x=position.tucked==='left'?b.left-VOICE_FLOAT_SIZE:position.tucked==='right'?b.right:position.x;
    applyPosition(settleVoiceFloat(x,position.y,b,Boolean(position.tucked)));
  };
  window.addEventListener('resize',resize,listen);
  window.visualViewport?.addEventListener('resize',resize,listen);
  window.visualViewport?.addEventListener('scroll',resize,listen);
  const contents=new MutationObserver(chooseTile);
  contents.observe(host,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  const removed=new MutationObserver(()=>{
    if(host.isConnected) return;
    animation?.cancel(); lifecycle.abort(); contents.disconnect(); removed.disconnect();
  });
  removed.observe(document.body,{childList:true});
  return {minimize,expand};
}
