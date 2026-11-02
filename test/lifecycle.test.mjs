import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../session.mjs';
import {openChat} from '../adapter.mjs';
import {withBrowser} from '../browser-lifecycle.mjs';

test('successive operations reuse one browser and explicit close releases it',async()=>{
 let launches=0,closes=0,armed=0;
 const session={page:null,idleTimeoutMs:180000,cancelIdleClose(){},armIdleClose(){armed++;},async status(){return {running:!!this.page};},async start(){if(!this.page){launches++;this.page={isClosed:()=>false};}},async close(){closes++;this.page=null;return {closed:true};}};
 await withBrowser(session,'vk_start',{},async()=>({}));
 await withBrowser(session,'vk_status',{},async()=>({}));
 assert.equal(launches,1);assert.equal(closes,0);assert.equal(armed,1);
 await withBrowser(session,'vk_close',{},async()=>{});assert.equal(closes,1);
});
test('idle timer closes the dedicated browser',async()=>{
 const s=new Session();s.idleTimeoutMs=10;let closed=0;
 s.context={close:async()=>{closed++;}};
 s.page={isClosed:()=>false};s.frame=async()=>({locator:()=>({count:async()=>0})});
 s.armIdleClose();
 const deadline=Date.now()+2000;
 while(!closed && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
 assert.equal(closed,1);assert.equal(s.context,null);assert.equal(s.idleTimer,null);
});
test('active operations cancel idle shutdown; unfinished drafts are retained',async()=>{
 const s=new Session();s.idleTimeoutMs=10;let closed=0;
 s.context={close:async()=>{closed++;}};s.page={isClosed:()=>false};
 s.frame=async()=>({locator:()=>({count:async()=>1,nth(){return this;},inputValue:async()=>'unfinished'})});
 s.armIdleClose();await new Promise(r=>setTimeout(r,25));assert.equal(closed,0);
 s.cancelIdleClose();assert.equal(s.idleTimer,null);await s.close();assert.equal(closed,1);
});
test('opens exact new match when no existing conversation exists',async()=>{
 let clicked='';const frame={locator:selector=>({count:async()=>selector.includes('new_chats_list')?1:0,click:async()=>{clicked=selector;},waitFor:async()=>{}})};
 assert.equal((await openChat(frame,'10001')).conversationReady,true);
 assert.ok(clicked.includes('new_chats_list'));assert.ok(clicked.includes('10001'));
});
test('never guesses among ambiguous matches',async()=>{
 const frame={locator:()=>({count:async()=>2,click:async()=>{throw Error('must not click');}})};
 await assert.rejects(openChat(frame,'42'),/ambiguous/);
});
