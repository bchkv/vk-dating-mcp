import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ActivityGuard,detectSecurityPage} from '../activity-guard.mjs';
function fixture(options={}){const dir=mkdtempSync(join(tmpdir(),'vk-guard-'));const guard=new ActivityGuard(dir,options);return {guard,dir,close:()=>rmSync(dir,{recursive:true,force:true})};}
test('security pause survives a restart and makes zero requests until manual resume after the unlock time',async()=>{
 let now=Date.parse('2026-11-02T20:00:00Z');const f=fixture({now:()=>now});let calls=0;
 try{f.guard.pause('vk_security_lock',{notBefore:'2026-11-03T19:39:00Z'});const restarted=new ActivityGuard(f.dir,{now:()=>now});
 await assert.rejects(restarted.run('vk_inbox',{},async()=>calls++),/paused/);assert.equal(calls,0);
 assert.throws(()=>restarted.resume(false),/confirmResolved/);assert.throws(()=>restarted.resume(true),/not arrived/);
 now=Date.parse('2026-11-03T19:40:00Z');await assert.rejects(restarted.run('vk_inbox',{},async()=>calls++),/paused/);assert.equal(calls,0);
 assert.equal(restarted.resume(true).browserRequests,0);await restarted.run('vk_inbox',{},async()=>calls++);assert.equal(calls,1);
 }finally{f.close()}
});
test('rate limits and write budgets survive restarts; no automatic retries',async()=>{
 let now=1000000;const f=fixture({now:()=>now,maxHourlyOperations:3,maxDailySends:1});let calls=0;
 try{await f.guard.run('vk_send_message',{execute:true},async()=>calls++);
 const g=new ActivityGuard(f.dir,{now:()=>now,maxHourlyOperations:3,maxDailySends:1});await assert.rejects(g.run('vk_inbox',{},async()=>calls++),/close together/);
 now+=60001;await assert.rejects(g.run('vk_send_message',{execute:true},async()=>calls++),/send budget/);assert.equal(calls,1);
 await g.run('vk_inbox',{},async()=>calls++);now+=6000;await g.run('vk_history',{},async()=>calls++);now+=6000;
 await assert.rejects(g.run('vk_history',{},async()=>calls++),/hourly/);assert.equal(calls,3);
 }finally{f.close()}
});
test('bulk dispatch and concurrent plugin processes do not open additional browser sessions',async()=>{
 const f=fixture();let calls=0;try{
 for(const [name,args]of [['vk_send_messages',{execute:true}],['vk_react',{execute:true}],['vk_get_conversations',{userIds:['1','2']}]])await assert.rejects(f.guard.run(name,args,async()=>calls++));
 const release=f.guard.acquire();const other=new ActivityGuard(f.dir);await assert.rejects(other.run('vk_inbox',{},async()=>calls++),/Another plugin process/);release();assert.equal(calls,0);
 }finally{f.close()}
});
test('cache remains available while paused and corrupt activity state fails closed',async()=>{
 const f=fixture();try{f.guard.cacheInbox({conversations:[{userId:'1'}]});f.guard.pause('security');assert.equal(f.guard.cachedInbox().result.conversations.length,1);
 writeFileSync(f.guard.file,'bad json');assert.throws(()=>f.guard.assertAllowed(),/unreadable/);
 }finally{f.close()}
});
test('known blocked URL and device challenge are recognized without clicking verification',async()=>{
 const page=(url,text)=>({url:()=>url,frames(){return [this]},locator:()=>({innerText:async()=>text})});
 assert.equal((await detectSecurityPage(page('https://m.vk.ru/vkui/blocked/',''))).reason,'vk_security_check');
 assert.equal((await detectSecurityPage(page('https://vk.ru/','Did you sign in from this device?'))).reason,'vk_security_check');
 assert.equal(await detectSecurityPage(page('https://vk.ru/dating','Normal chats')),null);
 assert.equal(await detectSecurityPage(page('https://unrelated.example/blocked/','captcha')),null);
});
