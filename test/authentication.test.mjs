import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../session.mjs';
import {AuthenticationRequiredError,isAuthenticationPage} from '../authentication.mjs';

const page=(url,visible=false)=>({url:()=>url,isClosed:()=>false,bringToFront:async()=>{},getByRole:()=>({count:async()=>visible?1:0,nth(){return this;},isVisible:async()=>visible})});
test('detects VK authentication, but not unrelated pages or arbitrary app loading failures',async()=>{
 assert.equal(await isAuthenticationPage(page('https://id.vk.com/auth')),true);
 assert.equal(await isAuthenticationPage(page('https://vk.ru/dating',true)),true);
 assert.equal(await isAuthenticationPage(page('https://vk.ru/dating')),false);
 assert.equal(await isAuthenticationPage(page('https://example.test/login',true)),false);
});
test('missing app on a sign-in page opens one headed session and does not retry the action',async()=>{
 const s=new Session();s.page=page('https://id.vk.com/auth');s.context={close:async()=>{}};
 s.findAppFrame=async()=>{throw Error('missing app');};
 const launches=[];
 s.start=async options=>{launches.push(options);s.headless=options.headless;s.page=page('https://id.vk.com/auth');s.context={close:async()=>{}};};
 await assert.rejects(s.frame(),AuthenticationRequiredError);
 assert.deepEqual(launches,[{headless:false}]);assert.equal(s.authPending,true);
 s.armIdleClose();assert.equal(s.idleTimer,null);
 await assert.rejects(s.frame(),AuthenticationRequiredError);assert.equal(launches.length,1);
 await s.close();assert.equal(s.authPending,false);
});
test('failed visible launch gives actionable guidance without pretending a window exists',async()=>{
 const s=new Session();s.page=page('https://id.vk.com/auth');s.context={close:async()=>{}};
 s.start=async()=>{throw Error('missing headed browser');};
 await assert.rejects(s.requireAuthentication(),/visible browser could not open/);
 assert.equal(s.authPending,false);
});
test('unrelated layout failure does not open a login window',async()=>{
 const s=new Session();s.page=page('https://vk.ru/dating');s.context={close:async()=>{}};
 s.findAppFrame=async()=>{throw Error('missing app');};
 s.start=async()=>{throw Error('must not start a login window');};
 await assert.rejects(s.frame(),/No sign-in screen was detected/);
 assert.equal(s.authPending,false);await s.close();
});
test('pending authentication is reused without launching another browser',async()=>{
 const s=new Session();s.page=page('https://id.vk.com/auth');s.context={close:async()=>{}};s.authPending=true;s.headless=false;
 s.findAppFrame=async()=>{throw Error('not signed in yet');};
 const result=await s.start();assert.equal(result.authentication,'required');assert.equal(result.visible,true);
 await s.close();
});

test('completed authentication closes headed browser before restarting headless',async()=>{
 const s=new Session();s.page=page('https://vk.ru/dating');let closed=0;
 s.context={close:async()=>{closed++;}};s.authPending=true;s.headless=false;
 s.findAppFrame=async()=>({});
 let options;s.start=async value=>{options=value;return {started:true};};
 await Session.prototype.start.call(s);
 assert.equal(closed,1);assert.deepEqual(options,{headless:true});assert.equal(s.authPending,false);
});
