import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const code=ts.transpileModule(fs.readFileSync('src/mobile-long-press.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
function setup(){
 const handlers={},timers=new Map();let serial=0,menus=0;
 const element={isConnected:true,dispatchEvent(){menus++;},contains:target=>target===element,closest:s=>s.startsWith('.channel')?element:null};
 const exports={};const doc={addEventListener:(name,fn)=>handlers[name]=fn};
 const setTimeout=fn=>{timers.set(++serial,fn);return serial;};
 vm.runInNewContext(code,{exports,document:doc,window:{setTimeout},clearTimeout:id=>timers.delete(id),matchMedia:()=>({matches:true}),performance:{now:()=>0},MouseEvent:class{constructor(name,options){Object.assign(this,options);}}});exports.installMobileLongPress();
 const event={isPrimary:true,pointerType:'touch',pointerId:1,clientX:40,clientY:100,target:element};
 return {handlers,event,fire(){for(const [id,fn] of timers){timers.delete(id);fn();}},menus:()=>menus};
}
test('quick channel tap opens no context menu',()=>{const s=setup();s.handlers.pointerdown(s.event);s.handlers.pointerup(s.event);s.fire();assert.equal(s.menus(),0);});
test('stationary hold opens once and consumes the release click',()=>{const s=setup();s.handlers.pointerdown(s.event);s.fire();assert.equal(s.menus(),1);let blocked=0;s.handlers.click({target:s.event.target,preventDefault(){blocked++;},stopImmediatePropagation(){blocked++;}});assert.equal(blocked,2);});
test('scroll and a moving finger cancel editing intent',()=>{for(const action of ['scroll','pointermove','pointercancel']){const s=setup();s.handlers.pointerdown(s.event);s.handlers[action]({...s.event,clientY:130});s.fire();assert.equal(s.menus(),0);}});
test('mouse press keeps desktop behavior',()=>{const s=setup();s.handlers.pointerdown({...s.event,pointerType:'mouse'});s.fire();assert.equal(s.menus(),0);});
