import {logEvent,logOutcome} from './event-log.mjs';
// Capture-derived VK composer selectors. Never infer a send control by position.
import {navigate, openChat} from './adapter.mjs';
export async function sendMessage(frame, {userId, expectedName, text, execute=false, requestId}, attempts) {
 if (!/^\d+$/.test(userId) || !expectedName?.trim() || !text?.trim() || text.length>1000) throw Error('Provide numeric userId, expectedName, and 1–1000 characters of nonblank text');
 if (execute && !requestId?.trim()) throw Error('requestId is required when execute=true');
 if (execute && attempts.has(requestId)) {await logOutcome('message.send.duplicate',{userId,requestId,outcome:'skipped'});return {...attempts.get(requestId),duplicateRequest:true};}
 const currentDrafts=frame.locator('#chat:visible textarea[data-testid="write-bar"]');
 for(let i=0;i<await currentDrafts.count();i++) if(await currentDrafts.nth(i).inputValue()) throw Error('Existing draft found; refusing to navigate away');
 // Destroy any previously displayed conversation before selecting the exact ID.
 await navigate(frame,'/');
 await frame.locator('#chat:visible').waitFor({state:'hidden',timeout:5000});
 await navigate(frame,'/chats');
 await openChat(frame,userId);
 const panel=frame.locator('#chat:visible');
 const header=panel.locator('.vkuiPanelHeaderContent__childrenText');
 await header.waitFor({timeout:5000});
 if ((await header.count())!==1 || (await header.innerText()).trim()!==expectedName.trim()) throw Error('Conversation name does not match expectedName; no message sent');
 const editor=panel.locator('textarea[data-testid="write-bar"]:visible');
 if(await editor.count()!==1 || !(await editor.isEditable())) throw Error('Message composer absent or ambiguous');
 if(await editor.inputValue()) throw Error('Existing draft found; refusing to overwrite it');
 const limit=await editor.getAttribute('maxlength');
 if(limit && text.length>Number(limit)) throw Error('Message exceeds composer limit');
 if(!execute) return {dryRun:true,userId,expectedName,text,ready:true};
 await editor.fill(text);
 if((await header.innerText()).trim()!==expectedName.trim() || await editor.inputValue()!==text) throw Error('Conversation or draft changed; no message sent');
 const send=panel.locator('form button:visible').filter({has:frame.locator('svg.vkuiIcon--send_24, svg.vkuiIcon--send_outline_24')});
 if(await send.count()!==1 || !(await send.isEnabled())) throw Error('Unique enabled Send control not found; draft retained, no message sent');
 const result={dryRun:false,userId,expectedName,requestId,attempted:true,serverAccepted:'unverified',retry:false};
 // Record before dispatch: a timeout can occur after delivery. Never resend automatically.
 await logEvent('message.send.attempted',{userId,requestId,text,textLength:text.length,execute:true,outcome:'attempted'});
 attempts.set(requestId,result);
 let outcome;
 try {await send.click({timeout:5000});outcome={...result,clicked:true};}
 catch {outcome={...result,clicked:'unknown',note:'Dispatch outcome uncertain; inspect the conversation before any further action.'};}
 const logged=await logOutcome('message.send.result',{userId,requestId,clicked:outcome.clicked,outcome:'unverified'});
 if(!logged)outcome.auditLogError=true;
 attempts.set(requestId,outcome);return outcome;
}
