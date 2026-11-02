import {test} from 'node:test';
import assert from 'node:assert/strict';
import {editMessage} from '../edit-message.mjs';
import {toolDefinitions,validate} from '../mcp-tools.mjs';
const args={userId:'42',expectedName:'Test',messageId:'msg-42',expectedText:'Old invitation?',text:'New invitation'};
function fixture() {
 const state={name:'Test',text:args.expectedText,draft:'',own:true,saveCount:1,saves:0,timeout:false,verifyTimeout:false,saveLabel:'Готово',editable:true};
 const node=kind=>({
  count:async()=>kind==='drafts'?0:kind==='bubble'?Number(state.own):kind==='save'?(state.saveMatches?state.saveCount:0):1,
  waitFor:async()=>{if(kind==='body'&&state.verifyTimeout)throw Object.assign(Error('timeout'),{name:'TimeoutError'});},and(){return this;},nth(){return this;},first(){return this;},or(){return this;},filter(){return this;},
  locator:s=>node(s.includes('childrenText')?'header':s.includes('data-list-item')?'row':s.includes('message-bubble')?'bubble':s.includes('UUBlt8')?'body':s.includes('textarea')?'editor':'other'),
  getByRole:(_r,o)=>{if(String(o.name).includes('Save')){state.saveMatches=o.name.test(state.saveLabel);return node('save');}return node(o.name==='Actions'?'actions':'edit');},
  innerText:async()=>kind==='header'?state.name:state.text,
  inputValue:async()=>state.draft,isEnabled:async()=>true,isEditable:async()=>state.editable,
  fill:async v=>{state.draft=v;},
  click:async()=>{if(kind==='edit')state.draft=state.text;if(kind==='save'){state.saves++;if(state.timeout)throw Error('timeout');state.text=state.draft;state.draft='';}},
 });
 return {state,frame:{locator:s=>node(s.includes('textarea')?'drafts':'panel'),getByRole:(_r,o)=>node('edit')}};
}
test('registered tool validates exact message guards',()=>{
 assert.ok(toolDefinitions.some(t=>t.name==='vk_edit_message'));
 validate('vk_edit_message',args);
 assert.throws(()=>validate('vk_edit_message',{...args,messageId:'bad"id'}));
});
test('preview does not alter text or draft',async()=>{
 const {state,frame}=fixture();assert.equal((await editMessage(frame,args,new Map())).dryRun,true);
 assert.equal(state.draft,'');assert.equal(state.text,args.expectedText);assert.equal(state.saves,0);
});
test('wrong person, changed original, and incoming messages are rejected',async()=>{
 for(const changes of [{name:'Other'},{text:'Changed'},{own:false}]) {
  const {state,frame}=fixture();Object.assign(state,changes);
  await assert.rejects(editMessage(frame,args,new Map()));assert.equal(state.saves,0);
 }
});
test('explicit edit saves once and verifies the same message',async()=>{
 const {state,frame}=fixture(),attempts=new Map(),input={...args,execute:true,requestId:'one'};
 assert.equal((await editMessage(frame,input,attempts)).verifiedInView,true);
 assert.equal((await editMessage(frame,input,attempts)).duplicateRequest,true);assert.equal(state.saves,1);
});
test('uncertain save is never repeated',async()=>{
 const {state,frame}=fixture(),attempts=new Map(),input={...args,execute:true,requestId:'two'};state.timeout=true;
 assert.equal((await editMessage(frame,input,attempts)).clicked,'unknown');
 assert.equal((await editMessage(frame,input,attempts)).duplicateRequest,true);assert.equal(state.saves,1);
});
test('ambiguous Save never dispatches; invalid input rejected',async()=>{
 const {state,frame}=fixture();state.saveCount=2;
 await assert.rejects(editMessage(frame,{...args,execute:true,requestId:'three'},new Map()),/Save/);assert.equal(state.saves,0);
 for(const input of [{...args,text:' '},{...args,text:'x'.repeat(1001)},{...args,execute:true}])await assert.rejects(editMessage(null,input,new Map()));
});

test('all supported save labels dispatch; unrelated buttons never do',async()=>{
 for(const saveLabel of ['Готово','Done','Save','Save changes','Сохранить','Сохранить изменения']) {
  const {state,frame}=fixture();state.saveLabel=saveLabel;
  assert.equal((await editMessage(frame,{...args,execute:true,requestId:saveLabel},new Map())).verifiedInView,true);
  assert.equal(state.saves,1);
 }
 for(const saveLabel of ['Send','Отправить','Not Done','Готово отправить']) {
  const {state,frame}=fixture();state.saveLabel=saveLabel;
  await assert.rejects(editMessage(frame,{...args,execute:true,requestId:saveLabel},new Map()),/Save/);
  assert.equal(state.saves,0);
 }
});
test('readonly edit composer never dispatches',async()=>{
 const {state,frame}=fixture();state.editable=false;
 await assert.rejects(editMessage(frame,{...args,execute:true,requestId:'readonly'},new Map()),/composer/);assert.equal(state.saves,0);
});

test('verification failure retains click state and reports unchanged message without retrying',async()=>{
 const {state,frame}=fixture(),attempts=new Map(),input={...args,execute:true,requestId:'verify-failed'};
 state.verifyTimeout=true;
 const result=await editMessage(frame,input,attempts);
 assert.equal(result.clicked,true);assert.equal(result.stage,'verify_message');assert.equal(result.errorType,'TimeoutError');
 assert.equal(result.messageUnchanged,false);
 assert.equal((await editMessage(frame,input,attempts)).duplicateRequest,true);assert.equal(state.saves,1);
});
