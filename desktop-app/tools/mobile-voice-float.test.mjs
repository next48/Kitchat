import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=ts.transpileModule(readFileSync('src/mobile-voice-float.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {settleVoiceFloat,VOICE_FLOAT_SIZE}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const phone={left:12,top:59,right:378,bottom:810};
test('floating call snaps to closest edge and stays inside safe area',()=>{
 assert.deepEqual(settleVoiceFloat(32,20,phone),{x:12,y:59,tucked:''});
 assert.deepEqual(settleVoiceFloat(220,900,phone),{x:250,y:682,tucked:''});
});
test('both edges retain a reachable 24px return handle',()=>{
 const left=settleVoiceFloat(-80,150,phone),right=settleVoiceFloat(350,150,phone);
 assert.equal(left.tucked,'left');assert.equal(left.x+VOICE_FLOAT_SIZE,phone.left+24);
 assert.equal(right.tucked,'right');assert.equal(phone.right-right.x,24);
});
test('a return-handle tap restores the window instead of tucking again',()=>{
 assert.deepEqual(settleVoiceFloat(phone.left,150,phone,false),{x:12,y:150,tucked:''});
 assert.deepEqual(settleVoiceFloat(phone.right-VOICE_FLOAT_SIZE,150,phone,false),{x:250,y:150,tucked:''});
});
test('keyboard and rotation bounds keep the window reachable',()=>{
 assert.deepEqual(settleVoiceFloat(250,682,{left:12,top:59,right:378,bottom:430}),{x:250,y:302,tucked:''});
 const narrow=settleVoiceFloat(900,900,{left:12,top:12,right:100,bottom:80},false);
 assert.equal(narrow.x,12);assert.equal(narrow.y,12);
});
test('shrinking the viewport never stashes an otherwise visible call',()=>{
 assert.deepEqual(settleVoiceFloat(290,90,phone,false),{x:250,y:90,tucked:''});
});
