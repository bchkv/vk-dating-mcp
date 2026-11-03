import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConversationStore} from '../store.mjs';
import {scanOverview,scrollOverview} from '../overview-scan.mjs';
function setup(){const s=new ConversationStore(':memory:');s.observeMatch('1',{name:'A'});s.observeMatch('2',{name:'B'});s.observeConversation({userId:'2',name:'B',messages:[{messageId:'m1',text:'Keep me',outgoing:false}],history:{complete:false}});return s;}
test('only repeated complete scans hide missing chats; retained histories and statistics stay accurate',()=>{
 const s=setup();try{
 s.reconcileOverview(['1'],{complete:false,scanId:'partial'});assert.equal(s.availability('2').status,'present');
 s.reconcileOverview(['1'],{complete:true,scanId:'first'});assert.equal(s.availability('2').status,'possibly_missing');assert.equal(s.list().length,2);
 assert.equal(s.reconcileOverview(['1'],{complete:true,scanId:'first'}).duplicateScan,true);assert.equal(s.availability('2').missingScans,1);
 s.reconcileOverview(['1'],{complete:true,scanId:'second'});assert.equal(s.availability('2').status,'not_visible');
 assert.equal(s.get('2').state.stage,'inactive');assert.equal(s.get('2').messages[0].text,'Keep me');assert.equal(s.list().length,1);
 assert.equal(s.list({includeInactive:true}).length,2);assert.equal(s.list({stage:'inactive'}).length,1);
 assert.equal(s.stats().active_conversations,1);assert.equal(s.stats().historical_conversations,2);
 assert.equal(s.stats().messages,1);assert.equal(s.events({userId:'2'}).some(e=>e.event_type==='unmatch.result'),false);
 }finally{s.close()}
});
test('reappearance restores prior conversation state without losing manually recorded decisions',()=>{
 const s=setup();try{
 s.setState('2',{stage:'scheduling',next_action:'offer_time'},{manual:true});
 s.reconcileOverview(['1'],{complete:true,scanId:'a'});s.reconcileOverview(['1'],{complete:true,scanId:'b'});
 s.observeMatch('2',{name:'B'});assert.equal(s.get('2').state.stage,'scheduling');assert.equal(s.get('2').state.next_action,'offer_time');assert.equal(s.availability('2').status,'present');
 }finally{s.close()}
});
test('known plugin unmatches are distinct from observed disappearance and history remains',()=>{
 const s=setup();try{s.markUnmatched('2');assert.equal(s.availability('2').status,'unmatched_by_me');assert.equal(s.list().length,1);assert.equal(s.get('2').messages.length,1);s.reconcileOverview(['1'],{complete:true,scanId:'x'});assert.equal(s.availability('2').status,'unmatched_by_me');s.observePreview({userId:'2',name:'B',previewText:'Hello'});assert.equal(s.availability('2').status,'present');}finally{s.close()}
});
function fakeScan(snapshots,{filtered=false,end=true}={}){let index=0;return {locator:()=>({evaluate:async(fn,arg)=>{
 if(fn===scrollOverview)return {atEnd:end,geometry:[0],filtered};
 return snapshots[Math.min(index++,snapshots.length-1)];
}})}}
const row=id=>({userId:id,name:id});
const shot=(ids,extra={})=>({conversations:ids.map(row),loading:false,retry:false,empty:!ids.length,...extra});
test('scan accumulates virtualized rows, waits for late arrivals, and never opens a chat',async()=>{
 const frame=fakeScan([shot(['1']),shot(['2']),shot(['3']),shot(['3']),shot(['3']),shot(['3'])]);
 const result=await scanOverview(frame,()=>{}, {pause:async()=>{}});
 assert.equal(result.complete,true);assert.deepEqual(result.conversations.map(r=>r.userId),['1','2','3']);assert.equal(result.serverVerified,false);
});
test('filtered, failed, loading and bounded scans never authorize missing-chat reconciliation',async()=>{
 for(const [frame,options] of [[fakeScan([shot(['1'])],{filtered:true}),{}],[fakeScan([shot(['1'],{retry:true})]),{}],[fakeScan([shot(['1'],{loading:true})]),{maxSteps:5}],[fakeScan([shot(['1'])],{end:false}),{maxSteps:5}]]){
  const result=await scanOverview(frame,()=>{}, {pause:async()=>{},...options});assert.equal(result.complete,false);
 }
});
test('an explicit stable empty overview is valid, but a blank unrecognized page is not',async()=>{
 assert.equal((await scanOverview(fakeScan([shot([])]),()=>{},{pause:async()=>{}})).complete,true);
 assert.equal((await scanOverview(fakeScan([shot([],{empty:false})]),()=>{},{pause:async()=>{},maxSteps:5})).complete,false);
});
test('compact inbox exposes scan coverage and changes before pagination',async()=>{
 const {callPublicTool}=await import('../public-tools.mjs');const s=setup();
 try{
 const changes={complete:true,changes:[{userId:'2',status:'not_visible'}]};
 const result=await callPublicTool({},'vk_inbox',{limit:1},async()=>({conversations:[{userId:'1',name:'A'},{userId:'2',name:'B'}],complete:true,scope:'exhausted_overview_scan',coverage:{complete:true},reconciliation:changes}),{legacy:[],store:()=>s});
 assert.equal(result.complete,true);assert.equal(result.openedChats,0);assert.equal(result.nextOffset,1);assert.deepEqual(result.reconciliation,changes);assert.equal(result.conversations[0].availability.status,'present');
 }finally{s.close()}
});
