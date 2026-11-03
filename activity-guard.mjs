import {mkdirSync,readFileSync,writeFileSync,renameSync,rmSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
export class ActivityPausedError extends Error {constructor(message,state){super(message);this.name='ActivityPausedError';this.state=state;this.retryAutomatically=false;}}
export class ActivityGuard {
 constructor(directory,{now=()=>Date.now(),minIntervalMs=5000,maxHourlyOperations=30,minSendIntervalMs=60000,maxDailySends=10}={}){
  this.directory=directory;this.file=join(directory,'activity-control.json');this.lock=join(directory,'operation.lock');this.now=now;
  Object.assign(this,{minIntervalMs,maxHourlyOperations,minSendIntervalMs,maxDailySends});
 }
 read(){try{return JSON.parse(readFileSync(this.file,'utf8'));}catch(e){if(e.code==='ENOENT')return {paused:false,operations:[],sends:[]};throw new ActivityPausedError('Activity state is unreadable; browser access stopped. Inspect it manually.',{paused:true,reason:'state_unreadable'});}}
 write(state){mkdirSync(this.directory,{recursive:true,mode:0o700});const temp=this.file+'.'+process.pid+'.tmp';writeFileSync(temp,JSON.stringify(state,null,2),{mode:0o600});renameSync(temp,this.file);}
 status(){const s=this.read();return {paused:!!s.paused,reason:s.reason??null,notBefore:s.notBefore??null,requiresManualResume:!!s.paused,retryAutomatically:false,policy:{minIntervalMs:this.minIntervalMs,maxHourlyOperations:this.maxHourlyOperations,minSendIntervalMs:this.minSendIntervalMs,maxDailySends:this.maxDailySends,guaranteedSafeForVK:false}};}
 assertAllowed(){const s=this.read();if(s.paused)throw new ActivityPausedError('VK activity is paused: '+s.reason+'. Resolve the check manually, then explicitly resume. Do not retry automatically.',this.status());}
 pause(reason,{notBefore=null}={}){const s=this.read();const old=s.notBefore&&Date.parse(s.notBefore),next=notBefore&&Date.parse(notBefore);s.paused=true;s.reason=reason;s.notBefore=old&&next?new Date(Math.max(old,next)).toISOString():s.notBefore??notBefore;s.pausedAt=new Date(this.now()).toISOString();this.write(s);return this.status();}
 acquire(){mkdirSync(this.directory,{recursive:true,mode:0o700});try{mkdirSync(this.lock,{mode:0o700});}catch(e){
  if(e.code!=='EEXIST')throw e;
  let pid;try{pid=Number(readFileSync(join(this.lock,'pid'),'utf8'));}catch{}
  let dead=false;if(Number.isInteger(pid)&&pid>0){try{process.kill(pid,0);}catch(err){dead=err.code==='ESRCH';}}
  if(!dead)throw new ActivityPausedError('Another plugin process is using the VK browser. No concurrent session was started.',{reason:'operation_in_progress'});
  rmSync(this.lock,{recursive:true});mkdirSync(this.lock,{mode:0o700});
 }
 writeFileSync(join(this.lock,'pid'),String(process.pid),{mode:0o600});return ()=>rmSync(this.lock,{recursive:true,force:true});}
 resume(confirmResolved){if(confirmResolved!==true)throw Error('Explicit confirmResolved=true is required after the user resolves VK’s security check');const release=this.acquire();try{const s=this.read();if(s.notBefore&&this.now()<Date.parse(s.notBefore))throw new ActivityPausedError('VK’s stated unlock time has not arrived. No browser request was made.',this.status());s.paused=false;s.reason=null;s.notBefore=null;s.resumedAt=new Date(this.now()).toISOString();this.write(s);return {...this.status(),browserRequests:0};}finally{release();}}
 async run(name,args,operation){const release=this.acquire();try{
  this.assertAllowed();
  if(name==='vk_send_messages'&&args.execute)throw Error('Bulk sending is disabled. Use one explicitly authorized message at a time.');
  if(name==='vk_react'&&args.execute)throw Error('Automated swiping is disabled in conservative mode.');
  if(name==='vk_get_conversations'&&args.userIds?.length>1)throw Error('Read one conversation at a time; bulk browsing is disabled.');
  const s=this.read(),now=this.now();s.operations=(s.operations??[]).filter(t=>now-t<3600000);s.sends=(s.sends??[]).filter(t=>now-t<86400000);
  if(s.operations.length&&now-s.operations.at(-1)<this.minIntervalMs)throw new ActivityPausedError('Requests are too close together. Use cached context; no browser request was made.',{reason:'rate_limited',retryAutomatically:false});
  if(s.operations.length>=this.maxHourlyOperations)throw new ActivityPausedError('The local hourly browser-operation budget has been reached. No browser request was made.',{reason:'hourly_budget',retryAutomatically:false});
  if(name==='vk_send_message'&&args.execute){if(s.sends.length>=this.maxDailySends||s.sends.length&&now-s.sends.at(-1)<this.minSendIntervalMs)throw new ActivityPausedError('The local send budget has been reached. No message was sent.',{reason:'send_budget'});s.sends.push(now);}
  s.operations.push(now);this.write(s);return await operation();
 }finally{release();}}
}
export async function detectSecurityPage(page){
 const url=page.url();let host,path;try{const u=new URL(url);host=u.hostname;path=u.pathname;}catch{return null;}
 if(!/(^|\.)vk\.(ru|com)$/.test(host))return null;
 if(/\/(blocked|captcha|challenge)(\/|$)/i.test(path))return {reason:'vk_security_check'};
 for(const frame of page.frames()){
  try{if(!/(^|\.)vk\.(ru|com)$/.test(new URL(frame.url()).hostname))continue;}catch{continue;}
  const text=(await frame.locator('body').innerText({timeout:1500}).catch(()=>'')).replace(/\s+/g,' ');
  if(/Did you sign in from this device|You can unblock your account after|Unblocked after tomorrow|Похоже, ваша страница была взломана|страниц[ауы].{0,35}заблокирован|подтвердите.{0,25}(человек|робот)|verify.{0,20}human|captcha/i.test(text))return {reason:'vk_security_check'};
 }
 return null;
}
ActivityGuard.prototype.cacheInbox=function(result){mkdirSync(this.directory,{recursive:true,mode:0o700});const file=join(this.directory,'inbox-cache.json'),temp=file+'.'+process.pid+'.tmp';writeFileSync(temp,JSON.stringify({savedAt:this.now(),result}),{mode:0o600});renameSync(temp,file);};
ActivityGuard.prototype.cachedInbox=function(){try{return JSON.parse(readFileSync(join(this.directory,'inbox-cache.json'),'utf8'));}catch{return null;}};
