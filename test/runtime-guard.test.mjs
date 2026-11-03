import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
function modules(){
 const dir=mkdtempSync(join(tmpdir(),'vk-runtime-'));
 for(const name of ['session.mjs','activity-guard.mjs','public-tools.mjs','unmatch.mjs','store.mjs'])cpSync(new URL('../'+name,import.meta.url),join(dir,name));
 writeFileSync(join(dir,'adapter.mjs'),"export async function appFrame(){return {locator(){return {count:async()=>0}}}};export async function inspect(){return {}};export async function navigate(){};export async function openChat(){};");
 writeFileSync(join(dir,'event-log.mjs'),"export async function logEvent(){};export async function logOutcome(){return true};export async function loggedCall(n,a,fn){return fn()};");
 writeFileSync(join(dir,'diagnostics.mjs'),"export function observePage(){return {}};export async function captureFailure(){return {}};");
 writeFileSync(join(dir,'authentication.mjs'),"export class AuthenticationRequiredError extends Error{};export async function isAuthenticationPage(){return false};");
 mkdirSync(join(dir,'node_modules/playwright'),{recursive:true});
 writeFileSync(join(dir,'node_modules/playwright/package.json'),JSON.stringify({type:'module',exports:'./index.mjs'}));
 writeFileSync(join(dir,'node_modules/playwright/index.mjs'),`export const chromium={async launchPersistentContext(profile,options){globalThis.testLaunches.push({profile,options});const page={testUrl:'about:blank',url(){return this.testUrl},frames(){return [this]},isClosed(){return false},locator(){return {innerText:async()=> 'Normal page',count:async()=>0}},async goto(url){this.testUrl=url},async bringToFront(){}};return {pages(){return [page]},async close(){}}}};`);
 return {dir,close:()=>rmSync(dir,{recursive:true,force:true}),import:async file=>import(pathToFileURL(join(dir,file)).href)};
}
test('normal calls reuse installed Chrome, keep the same profile and do not idle-close or relaunch after manual sign-in',async()=>{
 const f=modules();globalThis.testLaunches=[];
 try{const {Session}=await f.import('session.mjs');const s=new Session();await s.start();await s.start();
 assert.equal(globalThis.testLaunches.length,1);assert.equal(globalThis.testLaunches[0].options.channel,'chrome');assert.equal(globalThis.testLaunches[0].options.headless,true);
 s.armIdleClose();assert.equal(s.idleTimer,null);assert.equal(s.idleTimeoutMs,0);
 s.authPending=true;s.headless=false;const context=s.context;await s.start();assert.equal(s.context,context);assert.equal(s.authPending,false);assert.equal(globalThis.testLaunches.length,1);await s.close();
 }finally{f.close()}
});
test('detected security page pauses persistently before the app reader runs',async()=>{
 const f=modules();globalThis.testLaunches=[];try{const {Session}=await f.import('session.mjs');const s=new Session();await s.start();s.page.testUrl='https://m.vk.ru/vkui/blocked/';let reads=0;s.findAppFrame=async()=>{reads++};await assert.rejects(s.frame(),/security check/);assert.equal(reads,0);assert.equal(s.guard.status().paused,true);await assert.rejects(s.start(),/paused/);assert.equal(globalThis.testLaunches.length,1);await s.close();}finally{f.close()}
});
test('paused inbox returns labeled stale cache and does not call browser tools; defaults do not fetch profiles',async()=>{
 const f=modules();try{const {callPublicTool}=await f.import('public-tools.mjs');const {ActivityGuard}=await f.import('activity-guard.mjs');const guard=new ActivityGuard(join(f.dir,'guard'));
 guard.cacheInbox({conversations:[{userId:'1',name:'Test',previewText:'Cached'}],complete:true});guard.pause('vk_security_lock');let calls=0;
 const result=await callPublicTool({guard},'vk_inbox',{},async()=>{calls++;throw Error('must not browse')},{legacy:[],store:()=>({get:()=>null})});assert.equal(calls,0);assert.equal(result.cached,true);assert.equal(result.security.paused,true);assert.equal(result.openedChats,0);
 const empty=new ActivityGuard(join(f.dir,'empty'));empty.pause('locked');await assert.rejects(callPublicTool({guard:empty},'vk_inbox',{},async()=>calls++,{legacy:[]}),/paused/);assert.equal(calls,0);
 const active=new ActivityGuard(join(f.dir,'active'));await callPublicTool({guard:active},'vk_inbox',{},async(s,name,args)=>{assert.equal(args.includeProfiles,false);return {conversations:[],complete:true}},{legacy:[]});
 }finally{f.close()}
});
