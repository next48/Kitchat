import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { streamProfile } from '../src/stream-preferences.ts';
import { formatVoiceDuration, resolveCallFocus, voiceStartedAtFromElapsed } from '../src/voice-session.ts';

// Execute production closures with deterministic media/DOM doubles. No devices or server needed.
const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start, source.indexOf('async function callViewP2P'));
  assert.ok(from >= 0, start);
  const to = source.indexOf(end, from);
  assert.ok(to > from, end);
  return source.slice(from, to);
}
function evaluate(code, context) {
  return vm.runInNewContext(ts.transpileModule(code, {compilerOptions: {target: ts.ScriptTarget.ES2020}}).outputText, context);
}
class Element {
  children = []; dataset = {}; attrs = new Set(); paused = true; plays = 0; writes = 0;
  style = {setProperty() {}};
  classList = {add() {}, remove() {}, toggle() {}};
  constructor(tag) { this.tag = tag; }
  set innerHTML(html) {
    this.html = html; this.writes++; this.children = [];
    if (html.includes('voice-avatar')) { this.append(new Element('avatar')); this.append(new Element('footer')); }
  }
  get innerHTML() { return this.html || ''; }
  append(child) { child.parent = this; this.children.push(child); }
  prepend(child) { child.parent = this; this.children.unshift(child); }
  addEventListener() {}
  setAttribute(name, value) { this[name] = value; }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  toggleAttribute(name, enabled) { if (enabled) this.attrs.add(name); else this.attrs.delete(name); }
  querySelector(selector) {
    if (selector === '.avatar') return this.children.find(child => child.tag === 'avatar');
    const id = selector.match(/data-p2p-user="(\d+)"/);
    return this.children.find(child => id ? child.dataset.p2pUser === id[1] : child.tag === selector);
  }
  querySelectorAll() { return this.children; }
  play() { this.paused = false; this.plays++; return Promise.resolve(); }
}
function renderFixture() {
  const grid = new Element('grid');
  const document = {
    createElement: tag => new Element(tag),
    querySelector: selector => selector === '#videoGrid' ? grid : selector.startsWith('[data-p2p-user') ? grid.querySelector(selector) : null,
  };
  const streams = new Map();
  const context = { document, remoteCameraStreams: streams, rouletteUsers: [], voiceDirectory: new Map(), focusedUserId:null, me: {id: 1}, channelId: 7,
    resolveCallFocus, cameraPreviewMirrored:()=>true, rouletteDisplayName: user => ({name:user.name, original:user.name}), avatar: user => user.name, esc: String, ico: String };
  const render = evaluate(section('  const applyFocusedLayout', '  const cameraPeerFor') + '\nrenderUsers;', context);
  return {render, grid, streams};
}
const user = {id: 1, name:'Alice', muted:false, speaking:false};
test('voice duration uses Discord-like mm:ss and switches to h:mm:ss', () => {
  assert.equal(formatVoiceDuration(0),'0:00');
  assert.equal(formatVoiceDuration(78),'1:18');
  assert.equal(formatVoiceDuration(3671),'1:01:11');
});
test('voice duration starts from the shared server session', () => {
  assert.equal(voiceStartedAtFromElapsed(100_000, 54), 46_000);
  assert.equal(voiceStartedAtFromElapsed(100_000, -1), 0);
  assert.equal(voiceStartedAtFromElapsed(100_000, 'invalid'), 0);
});
test('fullscreen call view exposes complete Discord-like controls and auto-hides them', () => {
  assert.equal((source.match(/\$\{fullscreenCallControls\(\)\}/g) || []).length, 3);
  for (const action of ['mic','camera','share','roulette','deafen','exit','leave']) {
    assert.match(source, new RegExp(`data-fullscreen-call-action="${action}"`));
  }
  assert.match(source, /document\.addEventListener\("pointermove"/);
  assert.match(source, /fullscreenChromeTimer = window\.setTimeout/);
  assert.match(source, /classList\.add\("controls-hidden"\)/);
  assert.match(source, /document\.exitFullscreen\(\)/);
});
test('participant focus remains valid only while the participant and filmstrip exist', () => {
  assert.equal(resolveCallFocus([{id:1},{id:2}],2),2);
  assert.equal(resolveCallFocus([{id:1}],1),null);
  assert.equal(resolveCallFocus([{id:1},{id:2}],3),null);
});
test('presence and name updates preserve the same playing video and MediaStream', () => {
  const {render, grid, streams} = renderFixture();
  const stream = {getVideoTracks: () => [{readyState:'live'}]}; streams.set(1, stream);
  render([user]);
  const tile = grid.children[0], video = tile.querySelector('video');
  for (let i=0; i<20; i++) render([{...user, speaking:i%2 === 0, name:'Renamed'}]);
  assert.equal(grid.children[0], tile);
  assert.equal(tile.querySelector('video'), video);
  assert.equal(video.srcObject, stream);
  assert.equal(video.plays, 1);
  assert.equal(video.muted, true);
});
test('camera stop removes only its video; participant departure removes the tile', () => {
  const {render, grid, streams} = renderFixture();
  streams.set(1, {getVideoTracks: () => [{readyState:'live'}]});
  render([user]); const tile = grid.children[0];
  streams.delete(1); render([user]);
  assert.equal(grid.children[0], tile); assert.equal(tile.querySelector('video'), undefined);
  render([]); assert.equal(grid.children.length, 0);
});
test('duplicate concurrent offers serialize into one negotiation', async () => {
  let offers=0, signals=0;
  const pc={signalingState:'stable', createOffer:async()=>{offers++; return {type:'offer'};}, setLocalDescription:async function(d){this.localDescription=d;}};
  const offer = evaluate(section('  const makeCameraOffer', '  const stopCamera')+'\nmakeCameraOffer;', {
    cameraOfferTasks:new Map(), leaving:false, camera:true, cameraPeerFor:async()=>pc, signal:async()=>{signals++;},
  });
  await Promise.all([offer(2),offer(2),offer(2)]);
  assert.equal(offers,1); assert.equal(signals,1);
});
test('a camera sync request resends an unanswered offer instead of remaining stuck', async () => {
  let offers=0, signals=0, retry=false;
  const pc={signalingState:'have-local-offer',localDescription:{type:'offer',sdp:'camera-sdp'},createOffer:async()=>{offers++;}};
  const offer=evaluate(section('  const makeCameraOffer', '  const stopCamera')+'\nmakeCameraOffer;',{
    cameraOfferTasks:new Map(),leaving:false,camera:true,cameraPeerFor:async()=>pc,
    signal:async(_id,payload)=>{signals++;retry=payload.retry===true;},console,
  });
  await offer(2,true);
  assert.equal(offers,0); assert.equal(signals,1); assert.equal(retry,true);
});
test('missing remote camera requests one resync per cooldown instead of signaling every poll', async () => {
  let now=10_000, signals=0;
  const requestSync=evaluate(section('  const requestCameraSync', '  const recoverCameraPeer')+'\nrequestCameraSync;', {
    cameraSyncRequestedAt:new Map(), leaving:false, Date:{now:()=>now}, signal:async()=>{signals++;},
  });
  requestSync(2); requestSync(2); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(signals,1);
  now+=3999; requestSync(2); await new Promise(resolve=>setImmediate(resolve)); assert.equal(signals,1);
  now+=2; requestSync(2); await new Promise(resolve=>setImmediate(resolve)); assert.equal(signals,2);
});
test('camera signaling supports viewer-driven recovery and ICE restart', () => {
  const signaling=section('  const poll = async', '  const leave = async');
  assert.match(signaling,/camera-sync-request/);
  assert.match(signaling,/makeCameraOffer\(peerId, true\)/);
  assert.match(signaling,/requestCameraSync\(user\.id\)/);
  const offers=section('  const makeCameraOffer', '  const stopCamera');
  assert.match(offers,/iceRestart: true/);
});
test('stopping local camera leaves remote peer and stream intact', async () => {
  let stopped=0, detached=0;
  const pc={getSenders:()=>[{track:{kind:'video'}, replaceTrack:async track=>{assert.equal(track,null); detached++;}}]};
  const peers=new Map([[2,pc]]), remote=new Map([[1,{}],[2,{}]]);
  const stop=evaluate(section('  const stopCamera', '  let cameraBusy')+'\nstopCamera;', {
    camera:true,cameraStream:{getTracks:()=>[{stop:()=>stopped++}]},cameraPeers:peers,remoteCameraStreams:remote,me:{id:1},
    cameraVoiceSenders:new Map(),peers:new Map(),document:{querySelector:()=>null},rouletteUsers:[user,{id:2}],signal:async()=>{},
    requestPeerRenegotiation:async()=>{},renderUsers:()=>{},publishPresence:async()=>{},
  });
  await stop(); assert.equal(stopped,1); assert.equal(detached,1);
  assert.equal(peers.get(2),pc); assert.equal(remote.has(2),true); assert.equal(remote.has(1),false);
});
test('camera reuses the established voice PeerConnection', async () => {
  let announced=null, renegotiated=0;
  const sender={getParameters:()=>({encodings:[]}),setParameters:async()=>{},replaceTrack:async()=>{}};
  const pc={getSenders:()=>[],addTrack:()=>sender};
  const attach=evaluate(section('  const attachCameraToVoicePeer', '  const peerFor')+'\nattachCameraToVoicePeer;', {
    camera:true,leaving:false,cameraStream:{id:'camera-stream',getVideoTracks:()=>[{readyState:'live'}]},
    cameraVoiceSenders:new Map(),peerFor:async()=>pc,lowResourceMode:()=>false,
    signal:async(_id,payload)=>{announced=payload;},requestPeerRenegotiation:async()=>{renegotiated++;},
  });
  await attach(2);
  assert.equal(announced.kind,'camera-main-track');
  assert.equal(announced.stream_id,'camera-stream');
  assert.equal(renegotiated,1);
});
test('incoming camera tracks are handled by the voice peer before screen sharing', () => {
  const voicePeer=section('  const peerFor', '  const applyPendingIce');
  assert.match(voicePeer,/remoteCameraStreamIds\.get\(id\)/);
  assert.match(voicePeer,/remoteCameraStreams\.set\(id, incoming\)/);
  assert.match(voicePeer,/if \(incoming\.id === announcedCameraStream \|\| !watchingScreens\.has\(id\)\)/);
});
test('only the local camera preview is mirrored and the preference defaults on', () => {
  assert.match(source, /cameraPreviewMirrored = \(\) => localStorage\.getItem\("kitchat_camera_mirror"\) !== "0"/);
  assert.match(source, /user\.id === me\.id && cameraPreviewMirrored\(\)/);
  assert.match(source, /name="camera_mirror"/);
  const styles=fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /camera-tile\.self-camera-mirrored video/);
  assert.match(styles, /#cameraPreview\.is-mirrored/);
});
test('camera permission cancelled: busy guard resets for next attempt', async () => {
  let requests=0;
  const toggle=evaluate(section('  let cameraBusy', '  const requestPeerRenegotiation')+'\ntoggleCamera;', {
    leaving:false,camera:false,requestMediaAccess:async()=>{requests++; return false;},
  });
  await Promise.all([toggle(),toggle()]); assert.equal(requests,1);
  await toggle(); assert.equal(requests,2);
});
test('capture finishing after leaving closes acquired tracks', async () => {
  let resolveCapture, stopped=0;
  const context={leaving:false,camera:false,cameraStream:null,requestMediaAccess:async()=>true,
    lowResourceMode:()=>true,localStorage:{getItem:()=>null}, navigator:{mediaDevices:{getUserMedia:()=>new Promise(resolve=>resolveCapture=resolve)}}};
  const toggle=evaluate(section('  let cameraBusy', '  const requestPeerRenegotiation')+'\ntoggleCamera;', context);
  const pending=toggle(); await new Promise(resolve=>setImmediate(resolve));
  context.leaving=true;
  resolveCapture({getTracks:()=>[{stop:()=>stopped++}]}); await pending;
  assert.equal(stopped,1); assert.equal(context.cameraStream,null); assert.equal(context.camera,false);
});
test('old auto preference uses WebView2; concurrent screen picker requests are blocked', async () => {
  let calls=0, constraints;
  const toggle=evaluate(section('  let screenBusy', '  const poll = async')+'\ntoggleScreen;', {
    leaving:false,sharing:false,activeScreenProfile:null,streamProfile,lowResourceMode:()=>true,localStorage:{getItem:()=> 'auto'},DOMException,
    navigator:{mediaDevices:{getDisplayMedia:async options=>{calls++; constraints=options; throw new DOMException('cancelled','NotAllowedError');}}},
  });
  await Promise.all([toggle(),toggle()]);
  assert.equal(calls,1); assert.equal(constraints.video.width.max,1280); assert.equal(constraints.video.frameRate.max,15);
  await toggle(); assert.equal(calls,2);
});
