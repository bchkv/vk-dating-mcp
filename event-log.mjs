import {getStore} from './store.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const context=new AsyncLocalStorage();
export class AuditLogError extends Error {constructor(){super('Event log unavailable; action was not started');this.name='AuditLogError';}}
export function safeFields(fields={},event='') {
 const out={};
 // Message content is permitted only on explicit message-content events.
 if(['message.observed','message.send.attempted','message.edit.attempted'].includes(event)){
  if(typeof fields.text==='string')out.text=fields.text;
  if(event==='message.edit.attempted'&&typeof fields.previousText==='string')out.previousText=fields.previousText;
 }
 for(const key of ['execute','attempted','verifiedInView','stopped','closed','reused','draftPresent','auditLogError','outgoing'])if(typeof fields[key]==='boolean')out[key]=fields[key];
 for(const key of ['textLength','count','durationMs','idleTimeoutSeconds'])if(Number.isFinite(fields[key])&&fields[key]>=0)out[key]=fields[key];
 if(typeof fields.userId==='string'&&/^\d+$/.test(fields.userId))out.userId=fields.userId;
 if(typeof fields.messageId==='string'&&/^[\w-]{1,100}$/.test(fields.messageId))out.messageId=fields.messageId;
 if(typeof fields.requestId==='string')out.requestKey=createHash('sha256').update(fields.requestId).digest('hex');
 if(['like','dislike'].includes(fields.reaction))out.reaction=fields.reaction;
 if(fields.clicked===true||fields.clicked==='unknown')out.clicked=fields.clicked;
 if(['success','failure','unverified','preview','skipped','attempted'].includes(fields.outcome))out.outcome=fields.outcome;
 if(['/','/chats','reactions','/tab_profile'].includes(fields.tab))out.tab=fields.tab;
 if(typeof fields.errorType==='string'&&/^[A-Za-z]{1,50}$/.test(fields.errorType))out.errorType=fields.errorType;
 return out;
}
export class EventLogger {
 constructor(directory,{sink}={}){this.sink=sink;this.directory=directory;this.sessionId=randomUUID();this.queue=Promise.resolve();}
 log(event,fields={}) {
  if(!/^[a-z][a-z0-9_.]{0,80}$/.test(event))throw new AuditLogError();
  const scope=context.getStore()??{};
  const entry={schemaVersion:2,timestamp:new Date().toISOString(),sessionId:this.sessionId,...(scope.operationId?{operationId:scope.operationId}:{}),...(scope.tool&&/^vk_[a-z_]+$/.test(scope.tool)?{tool:scope.tool}:{}),event,...safeFields(fields,event)};
  const write=async()=>{
   let handle;
   try {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const info=await lstat(this.directory);if(!info.isDirectory()||info.isSymbolicLink())throw Error('unsafe log directory');
    handle=await open(join(this.directory,entry.timestamp.slice(0,10)+'.jsonl'),constants.O_CREAT|constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
    await handle.chmod(0o600);await handle.writeFile(JSON.stringify(entry)+'\n');await handle.sync();await this.sink?.(entry);
   }catch{throw new AuditLogError();}finally{await handle?.close();}
  };
  const task=this.queue.catch(()=>{}).then(write);this.queue=task;return task;
 }
}
const logger=new EventLogger(process.env.VK_DATING_LOG_DIR||fileURLToPath(new URL('./logs/',import.meta.url)),{sink:entry=>getStore().recordAction(entry)});
export const logEvent=(event,fields)=>logger.log(event,fields);
export async function logOutcome(event,fields) {
 try{await logEvent(event,fields);return true;}catch{return false;}
}
export function loggedCall(tool,args,operation,audit=logger) {
 return context.run({operationId:randomUUID(),tool},async()=>{
  const started=Date.now();
  await audit.log('tool.started',{userId:args.userId,messageId:args.messageId,requestId:args.requestId,execute:args.execute,textLength:typeof args.text==='string'?args.text.length:undefined,count:args.userIds?.length??args.messages?.length});
  let result;
  try{result=await operation();}
  catch(error){try{await audit.log('tool.failed',{errorType:error.name,durationMs:Date.now()-started,outcome:'failure'});}catch{}throw error;}
  let ok=true;try{await audit.log('tool.completed',{durationMs:Date.now()-started,outcome:result?.dryRun?'preview':result?.stopped||(result?.attempted&&!result?.verifiedInView)?'unverified':'success',attempted:result?.attempted,verifiedInView:result?.verifiedInView,stopped:result?.stopped,count:result?.results?.length??result?.conversations?.length});}catch{ok=false;}
  if(!ok&&result&&typeof result==='object')return {...result,auditLogError:true,note:'Action may have completed, but outcome logging failed. Inspect state; do not retry automatically.'};
  return result;
 });
}
