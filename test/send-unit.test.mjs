import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sendMessage} from '../send-message.mjs';
function fixture() {
 const state={draft:'',clicks:0,name:'Test',sendCount:1,timeout:false};
 const node=(kind)=>({
 count:async()=>kind==='drafts'?0:kind==='send'?state.sendCount:1,
 waitFor:async()=>{},and(){return this;},nth(){return this;},
 locator:s=>node(s.includes('childrenText')?'header':s.includes('textarea')?'editor':'send'),
 filter(){return this;},isEditable:async()=>true,isEnabled:async()=>true,
 inputValue:async()=>state.draft,getAttribute:async()=> '1000',innerText:async()=>state.name,
 fill:async text=>{state.draft=text;},
 click:async()=>{if(kind==='send'){state.clicks++;if(state.timeout)throw Error('timeout');state.draft='';}},
 });
 return {state,frame:{locator:s=>node(s.includes('textarea')?'drafts':'root')}};
}
const args={userId:'42',expectedName:'Test',text:'Hello 👋\nSecond line'};
test('preview leaves draft untouched; explicit send dispatches once; repeated request is suppressed',async()=>{
 const {state,frame}=fixture(),attempts=new Map();
 assert.equal((await sendMessage(frame,args,attempts)).dryRun,true);
 assert.equal(state.draft,'');assert.equal(state.clicks,0);
 assert.equal((await sendMessage(frame,{...args,execute:true,requestId:'a'},attempts)).clicked,true);
 assert.equal((await sendMessage(frame,{...args,execute:true,requestId:'a'},attempts)).duplicateRequest,true);
 assert.equal(state.clicks,1);
});
test('wrong name, existing draft, and ambiguous controls never dispatch',async()=>{
 const {state,frame}=fixture();state.name='Other';
 await assert.rejects(sendMessage(frame,args,new Map()),/name/);
 state.name='Test';state.draft='personal draft';
 await assert.rejects(sendMessage(frame,args,new Map()),/draft/);
 state.draft='';state.sendCount=2;
 await assert.rejects(sendMessage(frame,{...args,execute:true,requestId:'b'},new Map()),/Send control/);
 assert.equal(state.clicks,0);assert.equal(state.draft,args.text);
});
test('uncertain click is recorded and cannot automatically dispatch again',async()=>{
 const {state,frame}=fixture(),attempts=new Map();state.timeout=true;
 const input={...args,execute:true,requestId:'c'};
 assert.equal((await sendMessage(frame,input,attempts)).clicked,'unknown');
 assert.equal((await sendMessage(frame,input,attempts)).duplicateRequest,true);
 assert.equal(state.clicks,1);
});
test('empty/oversize messages and missing request IDs are rejected',async()=>{
 for(const input of [{...args,text:' '},{...args,text:'x'.repeat(1001)},{...args,execute:true}])
 await assert.rejects(sendMessage(null,input,new Map()));
});
