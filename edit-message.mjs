import {logEvent,logOutcome} from './event-log.mjs';
import {navigate, openChat} from './adapter.mjs';

export async function editMessage(frame, args, attempts) {
 const {userId,expectedName,messageId,expectedText,text,execute=false,requestId}=args;
 if(!/^\d+$/.test(userId)||!expectedName?.trim()||! /^[\w-]+$/.test(messageId)||!expectedText?.trim()||!text?.trim()||text.length>1000) throw Error('Provide userId, expectedName, messageId, expectedText, and 1–1000 characters of text');
 if(execute&&!requestId?.trim()) throw Error('requestId required for execution');
 if(execute&&attempts.has(requestId)) {await logOutcome('message.edit.duplicate',{userId,messageId,requestId,outcome:'skipped'});return {...attempts.get(requestId),duplicateRequest:true};}
 const drafts=frame.locator('#chat:visible textarea[data-testid="write-bar"]');
 for(let i=0;i<await drafts.count();i++) if(await drafts.nth(i).inputValue()) throw Error('Existing draft; refusing to navigate');
 await navigate(frame,'/');
 await frame.locator('#chat:visible').waitFor({state:'hidden',timeout:5000});
 await navigate(frame,'/chats');
 await frame.locator(`[data-source="chats_list"][data-user-id="${userId}"]`).waitFor({state:'visible',timeout:10000});
 await openChat(frame,userId);
 const panel=frame.locator('#chat:visible');
 const header=panel.locator('.vkuiPanelHeaderContent__childrenText');
 await header.waitFor({timeout:5000});
 const checkName=async()=>{if(await header.count()!==1||(await header.innerText()).trim()!==expectedName.trim()) throw Error('Conversation name mismatch');};
 await checkName();
 const row=panel.locator(`[data-list-item-message-id="${messageId}"]`);
 if(await row.count()!==1) throw Error('Exact message absent or ambiguous');
 // Outgoing bubble classes and text node are grounded in the captured app DOM.
 const bubble=row.locator('[data-message-bubble="true"].UzN_JO3e');
 const body=bubble.locator('span.UUBlt8_A');
 if(await bubble.count()!==1||await body.count()!==1) throw Error('Message is not a supported outgoing text message');
 if(await body.innerText()!==expectedText) throw Error('Original message changed; refusing to edit');
 if(text===expectedText) return {userId,messageId,noChange:true};
 if(!execute) return {dryRun:true,userId,expectedName,messageId,expectedText,text,ready:true,editAvailability:'unchecked'};
 await logEvent('message.edit.opening',{userId,messageId,requestId});
 const actions=row.getByRole('button',{name:'Actions',exact:true});
 if(await actions.count()!==1) throw Error('Message actions absent or ambiguous');
 await actions.click();
 // Require explicitly labelled editing controls; never fall back to sending.
 const edit=frame.getByRole('button',{name:/^(Edit|Edit message|Редактировать|Изменить)$/i}).or(frame.getByRole('menuitem',{name:/^(Edit|Edit message|Редактировать|Изменить)$/i}));
 await edit.first().waitFor({state:'visible',timeout:3000});
 if(await edit.count()!==1) throw Error('Unique Edit action unavailable; no message changed');
 await edit.click();
 const editor=panel.locator('textarea[data-testid="write-bar"]:visible');
 await editor.waitFor({timeout:3000});
 if(await editor.count()!==1||!(await editor.isEditable())||await editor.inputValue()!==expectedText) throw Error('Edit composer does not contain the exact original text');
 const save=panel.getByRole('button',{name:/^(Save|Save changes|Done|Сохранить|Сохранить изменения|Готово)$/i});
 if(await save.count()!==1) throw Error('Explicit Save control unavailable; edit retained, no dispatch');
 await checkName();
 if(await body.innerText()!==expectedText) throw Error('Original message changed during edit');
 await editor.fill(text);
 await checkName();
 if(await editor.inputValue()!==text||!await save.isEnabled()) throw Error('Edit draft changed or Save disabled');
 const diagnostics={httpStatuses:[],requestFailures:[],pageErrorNames:[],applicationErrorCodes:[],responses:[]};
 const page=typeof frame.page==='function'?frame.page():null;
 const onResponse=async r=>{
  try {
   const request=r.request();
   if(!['fetch','xhr'].includes(request.resourceType())||diagnostics.httpStatuses.length>=30)return;
   diagnostics.httpStatuses.push(r.status());
   const path=new URL(r.url()).pathname.split('/').filter(Boolean).pop()||'';
   const summary={method:request.method(),status:r.status(),route:/^[a-z_.]+$/i.test(path)?path:'[redacted]',json:false};
   diagnostics.responses.push(summary);
   // VK can return application errors with HTTP 200 and a non-JSON content-type.
   let raw=await r.text();
   if(raw.length>2000000){summary.bodyTooLarge=true;return;}
   raw=raw.replace(/^\s*for\s*\(;;\)\s*;\s*/, '');
   let data;try{data=JSON.parse(raw);summary.json=true;}catch{return;}
   summary.keys=data&&typeof data==='object'?Object.keys(data).filter(k=>/^[a-z_][a-z_0-9]{0,50}$/i.test(k)).slice(0,20):[];
   const scan=(value,depth=0)=>{
    if(!value||typeof value!=='object'||depth>5)return;
    for(const [key,item] of Object.entries(value).slice(0,50)){
     if(/^(error_code|errorCode)$/.test(key)&&typeof item==='number'&&diagnostics.applicationErrorCodes.length<10)diagnostics.applicationErrorCodes.push(item);
     if(/^(success|ok)$/.test(key)&&typeof item==='boolean')summary[key]=item;
     if(key==='error'&&item)summary.hasError=true;
     if(item&&typeof item==='object')scan(item,depth+1);
    }
   };scan(data);
  }catch{}
 };

 const onFailed=r=>{try{if(['fetch','xhr'].includes(r.resourceType())&&diagnostics.requestFailures.length<10)diagnostics.requestFailures.push(r.failure()?.errorText||'request failed');}catch{}};
 const onError=e=>{if(diagnostics.pageErrorNames.length<10)diagnostics.pageErrorNames.push(e.name||'Error');};
 if(page){page.on('response',onResponse);page.on('requestfailed',onFailed);page.on('pageerror',onError);}
 const result={userId,messageId,requestId,attempted:true,serverAccepted:'unverified',retry:false};
 await logEvent('message.edit.attempted',{userId,messageId,requestId,text,previousText:expectedText,textLength:text.length,execute:true,outcome:'attempted'});
 attempts.set(requestId,result);
 let clicked='unknown',stage='save_click';
 try {
  await save.click({timeout:5000});clicked=true;stage='verify_message';
  await body.filter({hasText:text}).waitFor({timeout:5000});
  const verified=await body.innerText()===text;
  const outcome={...result,clicked:true,verifiedInView:verified,diagnostics};
  if(!await logOutcome('message.edit.result',{userId,messageId,requestId,clicked:outcome.clicked,verifiedInView:outcome.verifiedInView,outcome:outcome.verifiedInView?'success':'unverified'}))outcome.auditLogError=true;
  attempts.set(requestId,outcome);return outcome;
 } catch(error) {
  // Report only state booleans/status codes, never response bodies, URLs or message contents.
  let messageUnchanged=null,editStillOpen=null,draftMatches=null;
  try{messageUnchanged=await body.innerText()===expectedText;}catch{}
  try{editStillOpen=await save.count()===1;draftMatches=await editor.inputValue()===text;}catch{}
  const outcome={...result,clicked,stage,errorType:error.name||'Error',messageUnchanged,editStillOpen,draftMatches,diagnostics,note:'Save not verified. Do not automatically retry. Inspect this message before further action.'};
  if(!await logOutcome('message.edit.result',{userId,messageId,requestId,clicked:outcome.clicked,verifiedInView:outcome.verifiedInView,outcome:outcome.verifiedInView?'success':'unverified'}))outcome.auditLogError=true;
  attempts.set(requestId,outcome);return outcome;
 } finally {
  if(page){page.off('response',onResponse);page.off('requestfailed',onFailed);page.off('pageerror',onError);}
 }
}
