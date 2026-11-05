type Action = {label:string; danger?:boolean; action:()=>void|Promise<void>};
export function openMobileActionSheet(items:Action[], reportError:(error:unknown)=>void) {
  document.querySelectorAll<HTMLDialogElement>('dialog.mobile-action-sheet').forEach(dialog=>dialog.close());
  const dialog=document.createElement('dialog');
  dialog.className='mobile-voice-preview mobile-action-sheet';
  dialog.setAttribute('aria-label','Действия');
  const header=document.createElement('header');
  const close=document.createElement('button');close.type='button';close.dataset.voiceClose='';close.textContent='Закрыть';
  header.append(close);dialog.append(header);
  let closing=false;
  const dismiss=async(action?:Action)=>{
    if(closing)return;closing=true;dialog.classList.add('is-closing');
    if(!matchMedia('(prefers-reduced-motion:reduce)').matches) await Promise.allSettled(dialog.getAnimations().map(a=>a.finished));
    dialog.close();dialog.remove();
    try {await action?.action();} catch(error){reportError(error);}
  };
  close.onclick=()=>void dismiss();
  for(const item of items){const button=document.createElement('button');button.type='button';button.textContent=item.label;button.className=item.danger?'action-danger':'';button.onclick=()=>void dismiss(item);dialog.append(button);}
  dialog.addEventListener('cancel',event=>{event.preventDefault();void dismiss();});
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  document.body.append(dialog);dialog.showModal();
}
