import {invoke,isTauri} from '@tauri-apps/api/core';
import {ico} from './icons';
type Person={id:number;name:string};
type Signal={kind:string;call_id?:string;description?:RTCSessionDescriptionInit;candidate?:RTCIceCandidateInit;name?:string};
type Envelope={id:number;fromId:number;signal:Signal};
type Reply={ok:boolean;error?:string;pending?:{sender_id:number;signal_id:number}|null;signals?:Envelope[];last_id?:number};
type Call={id:string;peer:Person;account:string;incoming:boolean;accepted:boolean;after:number;offer?:RTCSessionDescriptionInit;pc?:RTCPeerConnection;stream?:MediaStream;ice:RTCIceCandidateInit[];timer:number;started:number};
export function createDirectCalls(options:{api:string;token:()=>string;user:()=>Person|null;busy:()=>boolean;error:(message:string)=>void}) {
  let call:Call|null=null,polling=false,muted=false,pollTimer=0,failures=0;
  const handled=new Set<string>();
  const host=document.createElement('section');host.className='personal-call';host.hidden=true;host.setAttribute('aria-label','Личный звонок');
  host.innerHTML=`<header><button data-call-minimize aria-label="Свернуть звонок">${ico('chevron-down')}</button><b>Личный звонок</b></header><main><span class="personal-call-avatar"></span><h2></h2><p role="status"></p></main><footer><button data-call-mute aria-label="Микрофон">${ico('mic')}</button><button data-call-answer aria-label="Ответить">${ico('phone-call')}</button><button data-call-end aria-label="Завершить звонок">${ico('phone-down')}</button></footer><audio autoplay playsinline></audio>`;
  document.body.append(host);
  const label=host.querySelector('p')!,title=host.querySelector('h2')!,audio=host.querySelector('audio')!;
  const answer=host.querySelector<HTMLButtonElement>('[data-call-answer]')!,mute=host.querySelector<HTMLButtonElement>('[data-call-mute]')!;
  const restore=document.createElement('button');restore.className='personal-call-restore';restore.hidden=true;restore.type='button';document.body.append(restore);
  restore.onclick=()=>{host.hidden=false;restore.hidden=true;};
  host.querySelector<HTMLButtonElement>('[data-call-minimize]')!.onclick=()=>{host.hidden=true;restore.hidden=false;};
  const ios=isTauri()&&/iPhone|iPad/.test(navigator.userAgent);
  const native=(action:string,c:Call)=>ios?invoke('mobile_system_call',{action,id:c.id,name:c.peer.name,incoming:c.incoming}).catch(error=>console.warn('System call',error)):Promise.resolve();
  async function request(query:Record<string,string>={},data?:Record<string,string>,account=options.token()):Promise<Reply>{
    let result:Reply;
    if(isTauri())result=await invoke('call_signal_request',{token:account,query,data});
    else {const response=await fetch(`${options.api}/call_signal.php?${new URLSearchParams(query)}`,{method:data?'POST':'GET',headers:{Authorization:`Bearer ${account}`},body:data?new URLSearchParams(data):undefined,signal:AbortSignal.timeout(12000)});result=await response.json();}
    if(!result.ok)throw Error(result.error||'Сервер звонков недоступен');return result;
  }
  const send=(c:Call,signal:Signal)=>request({},{target_id:String(c.peer.id),signal:JSON.stringify({...signal,call_id:c.id})},c.account);
  const current=(c:Call)=>call===c&&c.account===options.token();
  function render(c:Call,status:string){title.textContent=c.peer.name;label.textContent=status;host.querySelector('.personal-call-avatar')!.textContent=c.peer.name.slice(0,1).toUpperCase();answer.hidden=!c.incoming||c.accepted;mute.hidden=!c.accepted&&!c.pc;restore.textContent=`${c.peer.name} · ${status}`;}
  async function end(notify=true,reason=''){
    const c=call;if(!c)return;call=null;clearTimeout(c.timer);handled.add(c.id);
    c.pc?.close();c.stream?.getTracks().forEach(track=>track.stop());audio.srcObject=null;host.hidden=true;restore.hidden=true;
    void native('end',c);if(ios)void invoke('mobile_audio_route',{active:false,speaker:null}).catch(()=>{});
    if(notify)void send(c,{kind:c.incoming&&!c.accepted?'decline':'hangup'}).catch(()=>{});
    if(reason)options.error(reason);
  }
  const fail=(c:Call,error:unknown)=>{if(current(c))void end(true,error instanceof Error?error.message:String(error));};
  function make(peer:Person,id:string,incoming:boolean,after=0):Call{
    const c:Call={id,peer,account:options.token(),incoming,accepted:false,after,ice:[],timer:0,started:0};call=c;muted=false;mute.setAttribute('aria-pressed','false');
    host.hidden=false;restore.hidden=true;render(c,incoming?'Входящий звонок':'Вызываем…');
    c.timer=window.setTimeout(()=>{if(current(c))void end(true,'Нет ответа на звонок');},45000);return c;
  }
  async function prepare(c:Call){
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(!current(c)){stream.getTracks().forEach(track=>track.stop());return null;}c.stream=stream;
    if(ios)await invoke('mobile_audio_route',{active:true,speaker:false});
    if(!current(c)){if(ios&&!call)void invoke('mobile_audio_route',{active:false,speaker:null}).catch(()=>{});return null;}
    const iceServers:RTCIceServer[]=[{urls:'stun:stun.l.google.com:19302'}];
    try{const response=await fetch(`${options.api}/turn_credentials.php`,{headers:{Authorization:`Bearer ${c.account}`},signal:AbortSignal.timeout(5000)});const turn=await response.json();if(turn.ok&&turn.iceServer)iceServers.push(turn.iceServer);}catch{}
    if(!current(c))return null;
    const pc=new RTCPeerConnection({iceServers});c.pc=pc;
    stream.getTracks().forEach(track=>pc.addTrack(track,stream));
    pc.onicecandidate=event=>{if(event.candidate&&current(c))void send(c,{kind:'ice',candidate:event.candidate.toJSON()}).catch(error=>fail(c,error));};
    pc.ontrack=event=>{if(!current(c))return;audio.srcObject=event.streams[0]||new MediaStream([event.track]);void audio.play().catch(()=>{label.textContent='Нажмите на экран, чтобы включить звук';});};
    pc.onconnectionstatechange=()=>{
      if(!current(c))return;
      if(pc.connectionState==='connected'){clearTimeout(c.timer);c.accepted=true;c.started=Date.now();render(c,'На связи');void native('connected',c);}
      if(pc.connectionState==='disconnected'){render(c,'Восстанавливаем связь…');clearTimeout(c.timer);c.timer=window.setTimeout(()=>{if(current(c)&&pc.connectionState!=='connected')void end(true,'Соединение прервано');},15000);}
      if(pc.connectionState==='failed')void end(true,'Не удалось установить аудиосвязь');
    };
    return pc;
  }
  async function remote(c:Call,description:RTCSessionDescriptionInit){
    await c.pc!.setRemoteDescription(description);
    for(const candidate of c.ice.splice(0))await c.pc!.addIceCandidate(candidate);
  }
  async function accept(){
    const c=call;if(!c||!c.incoming||c.accepted||!c.offer)return;
    c.accepted=true;render(c,'Соединяем…');
    try{const pc=await prepare(c);if(!pc||!current(c))return;await native('start',c);await remote(c,c.offer);await pc.setLocalDescription(await pc.createAnswer());if(current(c))await send(c,{kind:'answer',description:pc.localDescription!.toJSON()});}catch(error){fail(c,error);}
  }
  answer.onclick=()=>void accept();
  host.querySelector<HTMLButtonElement>('[data-call-end]')!.onclick=()=>void end();
  mute.onclick=()=>{muted=!muted;call?.stream?.getAudioTracks().forEach(track=>track.enabled=!muted);mute.setAttribute('aria-pressed',String(muted));mute.innerHTML=ico(muted?'mic-off':'mic');};
  host.addEventListener('pointerup',()=>{if(audio.paused&&audio.srcObject)void audio.play().catch(()=>{});});
  window.addEventListener('kitchat-system-call',event=>{const data=(event as CustomEvent).detail;if(!call||data.id!==call.id)return;if(data.action==='answer')void accept();if(data.action==='end')void end();if(data.action==='mute'&&Boolean(data.muted)!==muted)mute.click();});
  async function signals(c:Call){
    const result=await request({peer_id:String(c.peer.id),after_id:String(c.after)},undefined,c.account);
    if(!current(c))return;c.after=result.last_id||c.after;
    for(const envelope of result.signals||[]){
      const s=envelope.signal;if(s.call_id!==c.id)continue;
      if(s.kind==='ice'&&s.candidate){if(c.pc?.remoteDescription)await c.pc.addIceCandidate(s.candidate);else c.ice.push(s.candidate);}
      if(s.kind==='answer'&&s.description&&c.pc&&!c.incoming&&!c.pc.remoteDescription){await remote(c,s.description);render(c,'Соединяем…');}
      if(['decline','hangup','busy'].includes(s.kind)){await end(false,s.kind==='busy'?'Собеседник занят':s.kind==='decline'?'Звонок отклонён':'');return;}
    }
  }
  async function poll(){
    if(polling)return;clearTimeout(pollTimer);
    if(!options.token()||!options.user()){pollTimer=window.setTimeout(()=>void poll(),5000);return;}polling=true;
    try{
      const c=call;if(c){if(c.account!==options.token()){await end(false);return;}await signals(c);failures=0;if(current(c)&&c.started)render(c,`${Math.floor((Date.now()-c.started)/60000)}:${String(Math.floor((Date.now()-c.started)/1000)%60).padStart(2,'0')}`);return;}
      if(document.hidden)return;
      const account=options.token(),pending=await request({pending:'1'});failures=0;
      if(account!==options.token()||call||!pending.pending)return;
      const p=pending.pending,result=await request({peer_id:String(p.sender_id),after_id:String(p.signal_id-1)},undefined,account);
      if(account!==options.token()||call)return;
      const offer=result.signals?.find(item=>item.id===p.signal_id&&item.signal.kind==='offer');
      if(!offer?.signal.description)return;
      const id=offer.signal.call_id;if(!id||handled.has(id))return;
      if(result.signals?.some(item=>['hangup','decline','busy'].includes(item.signal.kind)&&item.signal.call_id===id)){handled.add(id);return;}
      if(options.busy()){handled.add(id);await request({},{target_id:String(p.sender_id),signal:JSON.stringify({kind:'busy',call_id:id})},account);return;}
      const incoming=make({id:p.sender_id,name:offer.signal.name||'Входящий звонок'},id,true,result.last_id||p.signal_id);
      incoming.offer=offer.signal.description;incoming.ice=(result.signals||[]).filter(item=>item.signal.kind==='ice'&&item.signal.call_id===id).map(item=>item.signal.candidate!).filter(Boolean);
      void native('incoming',incoming);
    }catch(error){failures++;if(call&&failures>=3)fail(call,error);else console.debug('Incoming call check unavailable');}
    finally{polling=false;pollTimer=window.setTimeout(()=>void poll(),failures?Math.min(30000,failures*5000):call?1000:5000);}
  }
  pollTimer=window.setTimeout(()=>void poll(),1500);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll();});
  return {
    active:()=>Boolean(call),
    async start(peer:Person){
      if(call||options.busy()){options.error('Сначала завершите текущий звонок или выйдите из голосового канала');return;}
      const c=make(peer,crypto.randomUUID(),false);
      try{const pc=await prepare(c);if(!pc||!current(c))return;await native('start',c);await pc.setLocalDescription(await pc.createOffer());if(current(c))await send(c,{kind:'offer',description:pc.localDescription!.toJSON(),name:options.user()?.name||'KitChat'});}catch(error){fail(c,error);}
    },
    end,
  };
}
