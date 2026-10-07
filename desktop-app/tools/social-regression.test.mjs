import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFriends, socialSignature, friendRows } from '../src/social-ui.ts';
import { streamProfile } from '../src/stream-preferences.ts';
import { SocialSnapshotClient } from '../src/social-sync.ts';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const people=[
  {id:1,name:'Олег',online:false,friend_status:1},
  {id:2,name:'Анна',online:true,friend_status:1},
  {id:3,name:'Мария',online:true,friend_status:0,sent_by_me:false},
  {id:4,name:'Иван',online:false,friend_status:0,sent_by_me:true},
];
test('friends, online, incoming and outgoing are disjoint where required',()=>{
  assert.deepEqual(selectFriends(people,'all').map(p=>p.id),[2,1]);
  assert.deepEqual(selectFriends(people,'online').map(p=>p.id),[2]);
  assert.deepEqual(selectFriends(people,'incoming').map(p=>p.id),[3]);
  assert.deepEqual(selectFriends(people,'outgoing').map(p=>p.id),[4]);
});
test('search supports Cyrillic case, whitespace and numeric ID without changing the snapshot',()=>{
  assert.deepEqual(selectFriends(people,'all',' оЛЕГ ').map(p=>p.id),[1]);
  assert.deepEqual(selectFriends(people,'all','2').map(p=>p.id),[2]);
  assert.equal(people[0].id,1);
});
test('signature ignores response ordering, but tracks online transitions, rename and avatar changes',()=>{
  assert.equal(socialSignature(people),socialSignature([...people].reverse()));
  for(const change of [{online:true},{name:'Новый'},{avatar:'/new.jpg'},{about:'Новое описание'}]) {
    assert.notEqual(socialSignature(people),socialSignature([{...people[0],...change},...people.slice(1)]));
  }
});
test('friend names cannot inject HTML, outgoing requests have cancellation',()=>{
  const markup=friendRows([{...people[3],name:'<img src=x onerror=alert(1)>'}],'outgoing','',()=>'?');
  assert.ok(!markup.includes('<img')); assert.ok(markup.includes('&lt;img')); assert.ok(markup.includes('data-social-action="cancel"'));
});
test('60 FPS reaches the screen profile; economy caps without overwriting the saved choice',()=>{
  assert.equal(streamProfile('60',false).fps,60);
  assert.equal(streamProfile('60',false).bitrate,6_000_000);
  assert.equal(streamProfile('60',true).fps,15);
  assert.equal(streamProfile('60',true).width,1280);
  assert.equal(streamProfile('garbage',false).fps,30);
  assert.equal(streamProfile('60',false).fps,60);
});
const source=fs.readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const sessionPhp=fs.readFileSync(new URL('../../bd/desktop_session.php',import.meta.url),'utf8');
const communityPhp=fs.readFileSync(new URL('../../api/community.php',import.meta.url),'utf8');
const communitySocialPhp=fs.readFileSync(new URL('../../api/community_social.php',import.meta.url),'utf8');
const profileAboutPhp=fs.readFileSync(new URL('../../api/profile_about.php',import.meta.url),'utf8');
const desktopAuthPhp=fs.readFileSync(new URL('../../api/desktop_auth.php',import.meta.url),'utf8');
const tauriLib=fs.readFileSync(new URL('../src-tauri/src/lib.rs',import.meta.url),'utf8');
const tauriConfig=fs.readFileSync(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8');
const macInfo=fs.readFileSync(new URL('../src-tauri/Info.plist',import.meta.url),'utf8');
const trayHtml=fs.readFileSync(new URL('../tray.html',import.meta.url),'utf8');
const traySource=fs.readFileSync(new URL('../src/tray.ts',import.meta.url),'utf8');
const run=(code,context)=>vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,context);
test('60 FPS is applied to the actual screen sender, not just its picker',async()=>{
  const start=source.indexOf('  const attachFallbackScreenToPeers');
  const end=source.indexOf('  const stopFallbackScreen',start);
  let params;
  const track={readyState:'live'};
  const sender={getParameters:()=>({encodings:[{}]}),setParameters:async p=>{params=p;}};
  const attach=run(source.slice(start,end)+'\nattachFallbackScreenToPeers;',{
    fallbackScreenCapture:{track},fallbackScreenStream:{},peers:new Map([[2,{connectionState:'connected',addTrack:()=>sender}]]),
    screenWatchers:new Set([2]),fallbackScreenSenders:new Map(),activeScreenProfile:streamProfile('60',false),requestPeerRenegotiation:async()=>{},
  });
  await attach(); assert.equal(params.encodings[0].maxFramerate,60); assert.equal(params.encodings[0].maxBitrate,6_000_000);
});
test('a presence response arriving after navigation cannot update the new screen',async()=>{
  const start=source.indexOf('  const syncSocial = async');
  const end=source.indexOf('  const socialLoop',start);
  let resolve;
  const context={syncBusy:false,syncStopped:false,socialRefreshRequested:false,revision:1,viewRevision:1,currentUser:{id:1},socialAbort:null,AbortController,
    socialSnapshotClient:new SocialSnapshotClient(),
    window:{setTimeout,clearTimeout},clearTimeout,API:'http://test',active:null,token:()=>'',
    fetch:()=>new Promise(r=>resolve=r),document:{querySelector:()=>{throw Error('stale reply touched DOM');}},state:{people:[]},
  };
  const sync=run(source.slice(start,end)+'\nsyncSocial;',context);
  const pending=sync(); context.viewRevision=2;
  resolve({ok:true,status:200,json:async()=>({ok:true,people,server_members:[]})}); await pending;
  assert.equal(context.state.people.length,0); assert.equal(context.syncBusy,false);
});
test('CORS failure on the optional endpoint falls back and is retried only after cooldown',async()=>{
  let clock=1000,primaryCalls=0,legacyCalls=0;
  const client=new SocialSnapshotClient(()=>clock), signal=new AbortController().signal;
  const snapshot={people,server_members:[]};
  const primary=async()=>{primaryCalls++;throw new TypeError('Failed to fetch');};
  const legacy=async()=>{legacyCalls++;return snapshot;};
  assert.equal(await client.load(primary,legacy,signal),snapshot);
  assert.equal(await client.load(primary,legacy,signal),snapshot);
  assert.equal(primaryCalls,1);assert.equal(legacyCalls,2);
  clock+=60001;
  assert.equal(await client.load(async()=>{primaryCalls++;return snapshot;},legacy,signal),snapshot);
  assert.equal(primaryCalls,2);assert.equal(legacyCalls,2);
});
test('invalid primary payload falls back, but both API failures remain visible',async()=>{
  const signal=new AbortController().signal;
  const snapshot={people,server_members:[]};
  assert.equal(await new SocialSnapshotClient().load(async()=>({ok:true}),async()=>snapshot,signal),snapshot);
  await assert.rejects(new SocialSnapshotClient().load(async()=>{throw Error('HTTP 404');},async()=>{throw Error('Network offline');},signal),/Network offline/);
});
test('aborting navigation never starts a fallback request',async()=>{
  const controller=new AbortController();let fallbackCalls=0;
  await assert.rejects(new SocialSnapshotClient().load(async()=>{controller.abort();throw Error('cancelled');},async()=>{fallbackCalls++;return {people:[],server_members:[]};},controller.signal));
  assert.equal(fallbackCalls,0);
});
test('member grouping uses each user identity even when server role sorting differs',()=>{
  const start=source.indexOf('function memberSidebarRoleLabel');
  const end=source.indexOf('async function shellView',start);
  const render=run(source.slice(start,end)+'\nmemberRows;',{esc:String,avatar:()=>'?'});
  const markup=render([{id:1,name:'Admin',online:true,global_role:'superadmin'},{id:2,name:'Owner',online:false,role:'owner'},{id:3,name:'Member',online:true}]);
  assert.ok(markup.indexOf('data-person="3"')<markup.indexOf('data-person="2"'));
  assert.match(markup, /class="member online [^"]*" data-person="3"/);
  assert.match(markup, /class="member offline [^"]*" data-person="2"/);
});
test('online presence uses fresh desktop sessions and explicit app shutdown',()=>{
  assert.match(sessionPhp,/last_seen_at>=DATE_SUB\(NOW\(\),INTERVAL 20 SECOND\)/);
  assert.match(sessionPhp,/desktop_session_presence_leave/);
  assert.match(communityPhp,/action==='presence_leave'/);
  assert.match(source,/onCloseRequested/);
  assert.match(source,/markDesktopOffline/);
  assert.match(communityPhp,/function_exists\('desktop_online_expression'\)/);
});
test('voice timer client remains compatible with the restored stable server API',()=>{
  assert.match(source,/syncVoiceDuration\(batch\.elapsed_seconds\)/);
  assert.doesNotMatch(communityPhp,/community_voice_sessions/);
});
test('profile about is persisted centrally and included in shared user snapshots',()=>{
  assert.match(profileAboutPhp,/desktop_profile_about/);
  assert.match(profileAboutPhp,/desktop_session_user/);
  assert.match(desktopAuthPhp,/COALESCE\(p\.about/);
  assert.match(communityPhp,/COALESCE\(pa\.about/);
  assert.match(communitySocialPhp,/COALESCE\(pa\.about/);
  assert.match(source,/person\.about/);
  assert.match(source,/syncOwnProfileAbout/);
  assert.match(source,/savedLocally.*saveOwnProfileAbout/s);
});
test('notifications initialize through the native plugin and include an in-app test',()=>{
  assert.match(source,/ensureNotificationPermission/);
  assert.match(source,/id="testNotification"/);
  assert.match(source,/sendNotification\(\{ title: "Тест Kitchat"/);
  assert.doesNotMatch(source,/sendNotification\(\{ title, body, icon:/);
});
test('server settings cannot be interrupted by profile-only controls',()=>{
  const serverStart=source.indexOf('"Управление сервером"');
  const userStart=source.indexOf('"Настройки профиля"',serverStart);
  const serverSettings=source.slice(serverStart,userStart);
  const userSettings=source.slice(userStart,source.indexOf('\n  document.body.classList.toggle',userStart));
  assert.doesNotMatch(serverSettings,/#testNotification|textarea\[name="about"\]/);
  assert.match(serverSettings,/bindSettings\(settings\)/);
  assert.match(userSettings,/bindSettings\(settings\)[\s\S]*#testNotification/);
});
test('macOS has media permission text and keeps background synchronization active',()=>{
  assert.match(macInfo,/NSCameraUsageDescription/);
  assert.match(macInfo,/NSMicrophoneUsageDescription/);
  assert.match(macInfo,/NSScreenCaptureUsageDescription/);
  assert.match(macInfo,/NSAudioCaptureUsageDescription/);
  assert.match(tauriConfig,/"backgroundThrottling": "disabled"/);
});
test('update dialog supports trusted release artwork and an image gallery',()=>{
  assert.match(source,/safeUpdateArtwork/);
  assert.match(source,/manifest\.images/);
  assert.match(source,/class="update-gallery"/);
  assert.match(source,/kitchat-update-hero\.svg/);
});
test('custom tray keeps open, update and full-exit actions available',()=>{
  assert.match(trayHtml,/data-action="open"/);
  assert.match(trayHtml,/data-action="updates"/);
  assert.match(trayHtml,/data-action="quit"/);
  assert.match(tauriLib,/fn tray_action/);
  assert.match(tauriLib,/get_webview_window\("tray"\)/);
  assert.match(tauriLib,/WindowEvent::Focused\(false\).*window\.label\(\) == "tray"/s);
  assert.match(traySource,/addEventListener\("pointerdown"/);
  assert.match(traySource,/fallbackAction/);
  assert.match(tauriLib,/MouseButton::Left/);
  assert.match(tauriLib,/MouseButton::Right/);
  assert.match(tauriLib,/get_webview_window\("main"\).*window\.show\(\).*window\.unminimize\(\).*window\.set_focus\(\)/s);
  assert.match(source,/onCloseRequested[\s\S]*appWindow\.hide\(\)/);
  assert.doesNotMatch(source,/onCloseRequested[\s\S]{0,240}appWindow\.destroy\(\)/);
});
test('a slow old friend search cannot replace a newer result',async()=>{
  const start=source.indexOf('  input.oninput = () => {',source.indexOf('function friendsModal'));
  const end=source.indexOf('  results.onclick',start);
  const callbacks=[], replies=[], rendered=[];
  const context={timer:0,searchRevision:0,input:{value:'Анна'},results:{innerHTML:''},layer:{isConnected:true},serverId:0,
    clearTimeout:()=>{},window:{setTimeout:fn=>{callbacks.push(fn);return callbacks.length;}},
    community:()=>new Promise(resolve=>replies.push(resolve)),render:people=>rendered.push(people),
  };
  run(source.slice(start,end),context);
  context.input.oninput(); const old=callbacks[0]();
  context.input.value='Мария'; context.input.oninput(); const latest=callbacks[1]();
  replies[1]({search:[{name:'Мария'}]}); await latest;
  replies[0]({search:[{name:'Анна'}]}); await old;
  assert.deepEqual(rendered,[[{name:'Мария'}]]);
});
