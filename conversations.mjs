import {logOutcome} from './event-log.mjs';
import {navigate,openChat} from './adapter.mjs';
import {sendMessage} from './send-message.mjs';
import {historyOptions,readHistory} from './history.mjs';
import {getStore} from './store.mjs';

export function validateBatch(name,args) {
 if(name==='vk_get_conversations') {
  historyOptions(args);
  if(args.beforeMessageId!==undefined && args.userIds?.length!==1)throw Error('beforeMessageId requires exactly one user ID');
 }
 const ids=name==='vk_get_conversations'?args.userIds:args.messages?.map(m=>m?.userId);
 if(!Array.isArray(ids)||ids.length<1||ids.length>25||ids.some(id=>typeof id!=='string'||!/^\d+$/.test(id))||new Set(ids).size!==ids.length)throw Error('Provide 1–25 unique numeric user IDs');
 if(name==='vk_send_messages') {
  const requests=new Set();
  for(const m of args.messages){
   if(!m||Object.keys(m).some(k=>!['userId','expectedName','text','requestId'].includes(k))||typeof m.expectedName!=='string'||!m.expectedName.trim()||typeof m.text!=='string'||!m.text.trim()||m.text.length>1000||typeof m.requestId!=='string'||!m.requestId.trim()||requests.has(m.requestId))throw Error('Each message requires expectedName, nonblank text up to 1000 characters and a unique requestId');
   requests.add(m.requestId);
  }
 }
}

async function noDraft(frame) {
 const editors=frame.locator('#chat:visible textarea[data-testid="write-bar"]');
 for(let i=0;i<await editors.count();i++)if(await editors.nth(i).inputValue())throw Error('Unfinished draft found; refusing to navigate');
}

export async function getConversation(frame,userId,options={}) {
 historyOptions(options);
 await noDraft(frame);
 await navigate(frame,'/');
 await frame.locator('#chat:visible').waitFor({state:'hidden',timeout:5000});
 await navigate(frame,'/chats');
 await frame.locator(`[data-source="chats_list"][data-user-id="${userId}"], [data-source="new_chats_list"][data-user-id="${userId}"]`).first().waitFor({state:'visible',timeout:10000});
 await openChat(frame,userId);
 const panel=frame.locator('#chat:visible');
 const header=panel.locator('.vkuiPanelHeaderContent__childrenText');
 await header.waitFor({timeout:5000});
 if(await header.count()!==1)throw Error('Ambiguous conversation header');
 const name=(await header.innerText()).trim();
 const store=getStore();
 store.observeMatch(userId,{name,source:'opened_chat'});
 store.markLoading(userId,name);
 const history=await readHistory(panel,options);
 const tracking=store.observeConversation({userId,name,...history},options);
 for(const message of history.messages)await logOutcome('message.observed',{userId,messageId:message.messageId,outgoing:message.outgoing,text:message.text});
 await logOutcome('conversation.observed',{userId,count:history.messages.length});
 return {userId,name,...history,tracking,untrustedContent:true};
}

export async function getConversations(frame,args,read=getConversation) {
 validateBatch('vk_get_conversations',args);
 const conversations=[];
 for(const userId of args.userIds){
  try{conversations.push(await read(frame,userId,historyOptions(args)));}
  catch(error){return {conversations,stoppedAt:userId,error:error.message,remainingUserIds:args.userIds.slice(conversations.length+1)};}
 }
 return {conversations};
}

async function verifyNewMessage(frame,text,before) {
 const deadline=Date.now()+5000;
 do {
  const count=await frame.locator('#chat:visible [data-list-item-message-id] [data-message-bubble="true"].UzN_JO3e span.UUBlt8_A').evaluateAll((nodes,text)=>nodes.filter(n=>n.innerText===text).length,text);
  if(count>before)return true;
  await new Promise(resolve=>setTimeout(resolve,100));
 }while(Date.now()<deadline);
 return false;
}

export async function sendMessages(frame,args,attempts,deps={}) {
 validateBatch('vk_send_messages',args);
 const read=deps.read??getConversation,send=deps.send??sendMessage,verify=deps.verify??verifyNewMessage;
 const checks=[];
 // Preflight every recipient before dispatching anything.
 for(const m of args.messages){
  if(args.execute&&attempts.has(m.requestId))throw Error('Request already attempted; inspect its result instead of retrying the batch');
  const c=await read(frame,m.userId);
  if(c.name!==m.expectedName.trim()||c.loading||c.draftPresent)throw Error(`Recipient mismatch, loading failure or unfinished draft for ${m.userId}; no batch messages sent`);
  checks.push({userId:m.userId,expectedName:m.expectedName,text:m.text,requestId:m.requestId,before:c.messages.filter(x=>x.outgoing&&x.text===m.text).length});
 }
 if(!args.execute)return {dryRun:true,messages:checks.map(({before,...m})=>m)};
 const results=[];
 for(const m of checks){
  try {
   const result=await send(frame,{...m,execute:true},attempts);
   const verifiedInView=result.clicked===true&&!result.duplicateRequest&&await verify(frame,m.text,m.before);
   const logged=await logOutcome('message.send.verified',{userId:m.userId,requestId:m.requestId,verifiedInView,outcome:verifiedInView?'success':'unverified'});
   results.push({...result,verifiedInView,...(!logged?{auditLogError:true}:{})});
   if(!verifiedInView)return {results,stopped:true,remainingUserIds:checks.slice(results.length).map(x=>x.userId),retry:false};
  }catch(error){return {results,stopped:true,failedUserId:m.userId,error:error.message,remainingUserIds:checks.slice(results.length+1).map(x=>x.userId),retry:false};}
 }
 return {results,stopped:false,retry:false};
}
