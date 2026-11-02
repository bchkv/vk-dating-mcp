import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getConversations,sendMessages,validateBatch} from '../conversations.mjs';
import {validate,toolDefinitions} from '../mcp-tools.mjs';
const messages=[{userId:'42',expectedName:'Anna',text:'Friday at seven',requestId:'a'},{userId:'43',expectedName:'Maria',text:'Friday at seven',requestId:'b'}];
function fixture(){
 const calls=[],sent=[];
 const read=async(_f,id)=>{calls.push('read:'+id);return {userId:id,name:id==='42'?'Anna':'Maria',messages:[],loading:false,draftPresent:false};};
 const send=async(_f,m,attempts)=>{calls.push('send:'+m.userId);sent.push(m.userId);const r={userId:m.userId,requestId:m.requestId,clicked:true,attempted:true};attempts.set(m.requestId,r);return r;};
 return {calls,sent,read,send,verify:async()=>true};
}
test('new compact tools are registered; arrays and nested messages are validated',()=>{
 for(const name of ['vk_get_conversations','vk_send_messages'])assert.ok(toolDefinitions.some(t=>t.name===name));
 validate('vk_get_conversations',{userIds:['42']});validate('vk_send_messages',{messages,execute:false});
 for(const userIds of [[],['x'],['42','42'],Array.from({length:26},(_,i)=>String(i))])assert.throws(()=>validateBatch('vk_get_conversations',{userIds}));
 assert.throws(()=>validate('vk_send_messages',{messages:[{...messages[0],execute:true}]}));
 assert.throws(()=>validate('vk_send_messages',{messages:[messages[0],{...messages[1],requestId:'a'}]}));
});
test('batch previews do not send and preflight every recipient',async()=>{
 const f=fixture(),r=await sendMessages(null,{messages},new Map(),f);
 assert.equal(r.dryRun,true);assert.deepEqual(f.calls,['read:42','read:43']);assert.deepEqual(f.sent,[]);
});
test('wrong second recipient prevents all sends',async()=>{
 const f=fixture();await assert.rejects(sendMessages(null,{messages:[messages[0],{...messages[1],expectedName:'Other'}],execute:true},new Map(),f),/Recipient mismatch/);assert.deepEqual(f.sent,[]);
});
test('loading or unfinished draft prevents all sends',async()=>{
 for(const flag of ['loading','draftPresent']){
  const f=fixture(),original=f.read;f.read=async(...a)=>({...await original(...a),[flag]:true});
  await assert.rejects(sendMessages(null,{messages,execute:true},new Map(),f));assert.deepEqual(f.sent,[]);
 }
});
test('all recipients checked first; dispatch and verification are sequential',async()=>{
 const f=fixture();f.verify=async()=>{f.calls.push('verify');return true;};
 const r=await sendMessages(null,{messages,execute:true},new Map(),f);
 assert.deepEqual(f.calls,['read:42','read:43','send:42','verify','send:43','verify']);assert.equal(r.stopped,false);assert.ok(r.results.every(x=>x.verifiedInView));
});
test('uncertain outcome stops remaining sends; retry is refused',async()=>{
 const f=fixture(),attempts=new Map();f.verify=async()=>false;
 const r=await sendMessages(null,{messages,execute:true},attempts,f);
 assert.equal(r.stopped,true);assert.deepEqual(r.remainingUserIds,['43']);assert.deepEqual(f.sent,['42']);
 await assert.rejects(sendMessages(null,{messages,execute:true},attempts,f),/already attempted/);assert.deepEqual(f.sent,['42']);
});
test('compact reads stop on error without continuing blindly',async()=>{
 const read=async(_f,id)=>{if(id==='43')throw Error('draft');return {userId:id,name:'Anna',messages:[]};};
 const r=await getConversations(null,{userIds:['42','43','44']},read);
 assert.equal(r.conversations.length,1);assert.equal(r.stoppedAt,'43');assert.deepEqual(r.remainingUserIds,['44']);
});
