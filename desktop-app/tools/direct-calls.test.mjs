import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const code=ts.transpileModule(fs.readFileSync('src/direct-calls.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function setup({deferMedia=false,loggedIn=true}={}){
 const timers=new Map(),requests=[],errors=[];let serial=0,stops=0,release;let account=loggedIn?'account-a':'';
 class Node{nodes=new Map();hidden=false;paused=false;srcObject=null;classList={add(){},remove(){}};querySelector(s){if(!this.nodes.has(s))this.nodes.set(s,new Node());return this.nodes.get(s);}setAttribute(){}addEventListener(){}play(){return Promise.resolve();}}
 const track={stop(){stops++;},enabled:true};const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
 const media=deferMedia?new Promise(resolve=>release=()=>resolve(stream)):Promise.resolve(stream);
 class Peer{addTrack(){}close(){}async createOffer(){return {type:'offer',sdp:'offer'};}async setLocalDescription(value){this.localDescription={toJSON:()=>value};}}
 const exports={};const timer=fn=>{timers.set(++serial,fn);return serial;};
 const invoke=async(command,args)=>{requests.push({command,args});return {ok:true,pending:null,signals:[]};};
 const document={hidden:false,createElement:()=>new Node(),body:{append(){}},addEventListener(){}};
 vm.runInNewContext(code,{exports,require:p=>p.includes('icons')?{ico:()=>''}:{invoke,isTauri:()=>true},document,window:{setTimeout:timer,addEventListener(){}},clearTimeout:id=>timers.delete(id),navigator:{userAgent:'desktop',mediaDevices:{getUserMedia:()=>media}},crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000001'},RTCPeerConnection:Peer,fetch:async()=>({json:async()=>({ok:false})}),AbortSignal,console,Date});
 const controller=exports.createDirectCalls({api:'/api',token:()=>account,user:()=>account?{id:1,name:'One'}:null,busy:()=>false,error:e=>errors.push(e)});
 return {controller,requests,errors,release,stops:()=>stops,login:()=>account='account-a',tick:async()=>{const first=timers.entries().next().value;if(first){timers.delete(first[0]);await first[1]();await new Promise(setImmediate);}}};
}
test('cancelling while microphone permission is pending stops the late stream',async()=>{const s=setup({deferMedia:true});const starting=s.controller.start({id:2,name:'Two'});await s.controller.end();s.release();await starting;assert.equal(s.stops(),1);assert.equal(s.controller.active(),false);assert.ok(!s.requests.some(r=>JSON.parse(r.args.data?.signal||'{}').kind==='offer'));});
test('double call tap sends only one offer',async()=>{const s=setup();await Promise.all([s.controller.start({id:2,name:'Two'}),s.controller.start({id:2,name:'Two'})]);assert.equal(s.requests.filter(r=>JSON.parse(r.args.data?.signal||'{}').kind==='offer').length,1);await s.controller.end();assert.equal(s.stops(),1);});
test('incoming polling resumes after login rather than stopping at the auth screen',async()=>{const s=setup({loggedIn:false});await s.tick();assert.equal(s.requests.length,0);s.login();await s.tick();assert.equal(s.requests.filter(r=>r.args.query?.pending==='1').length,1);});
