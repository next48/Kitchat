import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const compiled=ts.transpileModule(readFileSync('src/mobile-voice-preview.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
function setup(reduced=false) {
  const handlers={},buttons={}; let finish,joins=0,closed=0;
  const finished=new Promise(resolve=>{finish=resolve;});
  const dialog={classList:{add(){}},querySelector:s=>({addEventListener:(_,fn)=>buttons[s]=fn}),addEventListener:(name,fn)=>handlers[name]=fn,getAnimations:()=>[{finished}],showModal(){},close(){closed++;},remove(){},getBoundingClientRect:()=>({top:500})};
  const exports={}; vm.runInNewContext(compiled,{exports,matchMedia:()=>({matches:reduced}),document:{body:{append(){}}}});
  exports.presentVoicePreview(dialog,()=>joins++);
  return {buttons,handlers,finish,state:()=>({joins,closed})};
}
test('join waits for exit animation and double taps join only once',async()=>{
  const s=setup();s.buttons['[data-voice-join]']();s.buttons['[data-voice-join]']();
  assert.deepEqual(s.state(),{joins:0,closed:0});
  s.finish();await new Promise(setImmediate);
  assert.deepEqual(s.state(),{joins:1,closed:1});
});
test('system dismissal animates without connecting to voice',async()=>{
  const s=setup();let prevented=false;s.handlers.cancel({preventDefault(){prevented=true;}});
  assert.ok(prevented);s.finish();await new Promise(setImmediate);
  assert.deepEqual(s.state(),{joins:0,closed:1});
});
test('reduced motion does not wait for an animation that cannot run',()=>{
  const s=setup(true);s.buttons['[data-voice-join]']();
  assert.deepEqual(s.state(),{joins:1,closed:1});
});
