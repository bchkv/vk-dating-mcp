import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConversationStore} from '../store.mjs';
import {cachedProfile,persistProfile,fetchProfile,enrichProfiles,snapshotProfile} from '../profiles.mjs';
import {buildContextPack} from '../context-pack.mjs';
import {callPublicTool,selectTools} from '../public-tools.mjs';
const data=(name='Test',bio='Actual bio')=>({name,bio,bioStatus:bio===null?'not_displayed':bio?'present':'empty',age:45,sections:[{heading:'Passions',text:'Tennis'}],bioMayBeTruncated:false,ready:true});
function setup(now=()=>new Date().toISOString()){const s=new ConversationStore(':memory:',{now});s.observeMatch('1',{name:'Test'});return s;}
test('profiles are persisted with provenance and freshness and included in cached reply context',()=>{
 const s=setup();try{
 persistProfile('1',data(),s);const p=cachedProfile('1',s);assert.equal(p.bio,'Actual bio');assert.equal(p.age,45);assert.equal(p.source,'observed_profile');assert.equal(p.stale,false);
 assert.equal(buildContextPack({userId:'1'},s).profile.bio,'Actual bio');assert.equal(buildContextPack({userId:'1'},s).coverage.profileAvailable,true);
 assert.equal(cachedProfile('1',s,Date.now()+8*24*60*60*1000).stale,true);
 }finally{s.close()}
});
test('absent, empty and present bios are distinguished; stale data survives failed refreshes',()=>{
 const s=setup();try{
 persistProfile('1',data('Test',null),s);assert.equal(cachedProfile('1',s).bioStatus,'not_displayed');assert.equal(cachedProfile('1',s).bio,null);
 persistProfile('1',data('Test',''),s);assert.equal(cachedProfile('1',s).bioStatus,'empty');
 assert.throws(()=>persistProfile('1',{...data(),ready:false},s));assert.equal(cachedProfile('1',s).bioStatus,'empty');
 }finally{s.close()}
});
function ui({headerName='Test',profileName='Test',draft='',existingDialog=false}={}){
 let opened=false;const clicks=[];
 const loc=(count=1,extra={})=>({count:async()=>count,waitFor:async()=>{},...extra});
 const close=loc(1,{click:async()=>{clicks.push('close profile');opened=false}});
 const dialog={count:async()=>opened?1:0,waitFor:async()=>{},evaluate:async()=>data(profileName),locator:s=>{assert.equal(s,'.vkuiModalOutsideButton__host');return close}};
 const panel={locator:s=>s==='.vkuiPanelHeaderContent__childrenText'?loc(1,{innerText:async()=>headerName}):s==='.vkuiPanelHeaderContent__host'?loc(1,{click:async()=>{clicks.push('open profile');opened=true}}):assert.fail('Unexpected panel locator '+s)};
 const frame={locator:s=>{
 if(s==='textarea[data-testid="write-bar"]')return loc(draft?1:0,{nth(){return this},inputValue:async()=>draft});
 if(s==='[role="dialog"]:visible')return {count:async()=>existingDialog||opened?1:0};
 if(s==='#chat:visible')return panel;
 if(s==='#chat_user_card:visible')return dialog;
 assert.fail('Unexpected frame locator '+s);
 }};
 return {frame,clicks};
}
test('exact person profile is fetched and only its profile dialog is opened and closed',async()=>{
 const s=setup();try{
 const {frame,clicks}=ui();const r=await fetchProfile(frame,{userId:'1',inCurrentChat:true},s);
 assert.equal(r.profile.bio,'Actual bio');assert.equal(r.mayMarkRead,true);assert.deepEqual(clicks,['open profile','close profile']);
 const second=await fetchProfile({locator(){throw Error('fresh cache must not access browser')}},{userId:'1'},s);assert.equal(second.cached,true);assert.equal(second.openedChats,0);
 }finally{s.close()}
});
test('wrong chat name, wrong profile name, unfinished drafts and unrelated dialogs cannot contaminate the cache',async()=>{
 for(const options of [{headerName:'Wrong'},{profileName:'Wrong'},{draft:'Keep this'},{existingDialog:true}]){
 const s=setup();try{const {frame}=ui(options);await assert.rejects(fetchProfile(frame,{userId:'1',inCurrentChat:true},s));assert.equal(cachedProfile('1',s),null);}finally{s.close()}
 }
});
test('automatic enrichment is bounded, caches successful reads, and continues the backlog next time',async()=>{
 const s=setup();try{
 const rows=['1','2','3','4'].map(userId=>({userId,name:'Test'}));rows.forEach(r=>s.observeMatch(r.userId,{name:r.name}));let calls=0;
 const read=async(f,args,store)=>{calls++;persistProfile(args.userId,data(),store);return {openedChats:1}};
 const a=await enrichProfiles({},rows,{limit:3,read},s);assert.equal(a.attempts,3);assert.equal(a.pending,1);assert.equal(a.openedChats,3);
 const b=await enrichProfiles({},rows,{limit:3,read},s);assert.equal(b.attempts,1);assert.equal(b.pending,0);assert.equal(calls,4);
 }finally{s.close()}
});
test('failure cooldown prevents repeated profile clicks while preserving previous bios',async()=>{
 const s=setup(()=>new Date(Date.now()-8*24*60*60*1000).toISOString());try{
 persistProfile('1',data(),s);s.now=()=>new Date().toISOString();
 const frame={locator:()=>({count:async()=>0})};let calls=0;const read=async()=>{calls++;throw Error('network failure')};
 const a=await enrichProfiles(frame,[{userId:'1',name:'Test'}],{read},s);assert.equal(a.results[0].status,'stale');assert.equal(cachedProfile('1',s).bio,'Actual bio');
 const b=await enrichProfiles(frame,[{userId:'1',name:'Test'}],{read},s);assert.equal(b.attempts,0);assert.equal(calls,1);
 }finally{s.close()}
});
test('preview-only inbox mode reaches the internal reader and profile refresh has an explicit tool',async()=>{
 const s=setup();try{
 let received;
 const dispatch=async(_s,name,args)=>{received={name,args};return name==='vk_get_profile'?{profile:data()}:{conversations:[],openedChats:0,mayMarkRead:false}};
 await callPublicTool({},'vk_inbox',{includeProfiles:false},dispatch,{legacy:[],store:()=>s});assert.equal(received.args.includeProfiles,false);
 await callPublicTool({},'vk_profile',{userId:'1',refresh:true},dispatch,{legacy:[],store:()=>s});assert.deepEqual(received,{name:'vk_get_profile',args:{userId:'1',refresh:true}});
 assert.equal(selectTools([]).find(t=>t.name==='vk_inbox').annotations.readOnlyHint,false);
 }finally{s.close()}
});
test('profile extraction separates dialog fields and rejects a loading card instead of inventing an empty bio',()=>{
 const bio={innerText:'  Actual\n biography  ',scrollHeight:50,clientHeight:20,scrollWidth:100,clientWidth:100};
 const nodes={'.h1aLTqhe .MWrUXww6':{innerText:'Test'},'.h1aLTqhe .ozp3w7rI':{innerText:', 45'},'.Ax9AsHXa .QLecl7_H':bio,'.BhMlvjdk':{}};
 let loading=false;
 const dialog={querySelector:s=>nodes[s],querySelectorAll:s=>s==='.h1aLTqhe .MWrUXww6'?[nodes[s]]:s==='.BhMlvjdk section'?[{innerText:'Passions\nTennis',querySelector:()=>({innerText:'Passions'})}]:(loading?[{getClientRects:()=>[{}]}]:[])};
 const result=snapshotProfile(dialog);assert.equal(result.name,'Test');assert.equal(result.age,45);assert.equal(result.bio,'Actual\n biography');assert.equal(result.bioMayBeTruncated,true);assert.equal(result.sections[0].heading,'Passions');assert.equal(result.ready,true);
 delete nodes['.Ax9AsHXa .QLecl7_H'];assert.equal(snapshotProfile(dialog).bioStatus,'not_displayed');assert.equal(snapshotProfile(dialog).bio,null);
 loading=true;assert.equal(snapshotProfile(dialog).ready,false);
});
