import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const source=ts.transpileModule(readFileSync('src/mobile-sheets.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function setup(kind='chat') {
 const handlers={}, classes=new Set(), styles={}; let closes=0;
 class Element { closest(selector) {return null;} }
 const target=new Element(); target.isConnected=true;target.clientWidth=390;target.clientHeight=800;target.classList={add:s=>classes.add(s),remove:s=>classes.delete(s)};
 target.style={set transform(v){styles.transform=v;},get transform(){return styles.transform;},removeProperty:k=>delete styles[k]};target.setPointerCapture=()=>{};
 const document={addEventListener:(name,fn)=>{handlers[name]=fn;},querySelector:()=>null};
 const close={click:()=>{let prevented=false;handlers.click({preventDefault:()=>prevented=true,stopImmediatePropagation(){}});if(!prevented)closes++;}};
 target.querySelector=()=>close;
 const element=new Element(); element.closest=selector=> selector===(kind==='modal'?'.modal-card':kind==='info'?'.mobile-info-sheet':kind==='voice'?'#phoneVoiceHost:not([hidden])':'.mobile-chat-screen') ? target : selector===(kind==='modal'?'.modal-titlebar':kind==='info'?'.mobile-members-bar':'.mobile-chat-bar,.embedded-call-header,.call-stage') ? element : null;
 const exports={};vm.runInNewContext(source,{exports,document,Element,matchMedia:()=>({matches:true}),performance:{now:()=>100},window:{setTimeout(){} }});exports.installMobileSheets();
 const event=(x,y)=>({target:element,pointerId:1,clientX:x,clientY:y,isPrimary:true,button:0,cancelable:true,preventDefault(){}});
 return {handlers,event,styles,classes,closed:()=>closes};
}
test('chat back swipe moves the real layer and invokes back once',()=>{const t=setup();t.handlers.pointerdown(t.event(8,200));t.handlers.pointermove(t.event(220,203));assert.equal(t.styles.transform,'translateX(212px)');t.handlers.pointerup(t.event(220,203));assert.equal(t.closed(),1);assert.equal(t.styles.transform,undefined);});
test('voice back swipe closes the view through its own back action',()=>{const t=setup('voice');t.handlers.pointerdown(t.event(8,200));t.handlers.pointermove(t.event(220,202));t.handlers.pointerup(t.event(220,202));assert.equal(t.closed(),1);});
test('member sheet follows a downward drag and dismisses',()=>{const t=setup('info');t.handlers.pointerdown(t.event(190,50));t.handlers.pointermove(t.event(190,300));assert.equal(t.styles.transform,'translateY(250px)');t.handlers.pointerup(t.event(190,300));assert.equal(t.closed(),1);});
test('cancelled swipe snaps back without navigation',()=>{const t=setup();t.handlers.pointerdown(t.event(8,200));t.handlers.pointermove(t.event(220,202));t.handlers.pointercancel(t.event(220,202));assert.equal(t.closed(),0);assert.equal(t.styles.transform,undefined);assert.equal(t.classes.size,0);});
test('vertical scrolling at chat edge never triggers back',()=>{const t=setup();t.handlers.pointerdown(t.event(8,200));t.handlers.pointermove(t.event(10,250));t.handlers.pointerup(t.event(180,260));assert.equal(t.closed(),0);assert.equal(t.styles.transform,undefined);});
