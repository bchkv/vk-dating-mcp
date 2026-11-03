import {createHash} from 'node:crypto';
import {getStore,personId} from './store.mjs';
import {logEvent,logOutcome} from './event-log.mjs';
import {navigate,openChat} from './adapter.mjs';
export const unmatchToolDefinition={name:'vk_unmatch',description:'Preview unmatching locally, or explicitly execute Delete Like for one exact person. Execution can permanently remove the match/conversation and opens the chat (may mark it read). Require user authorization, expectedName, requestId, execute=true and confirmUnmatch=true. Never retry an uncertain result or click Report and Block. Unknown follow-up confirmations are returned for inspection, not clicked.',inputSchema:{type:'object',additionalProperties:false,properties:{userId:{type:'string',pattern:'^[0-9]+$'},expectedName:{type:'string',minLength:1},requestId:{type:'string',minLength:1},execute:{type:'boolean',default:false},confirmUnmatch:{type:'boolean',default:false}},required:['userId','expectedName','requestId']},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}};
function validate(args){
 personId(args.userId);
 if(typeof args.expectedName!=='string'||!args.expectedName.trim()||typeof args.requestId!=='string'||!args.requestId.trim())throw Error('expectedName and requestId are required');
 if(args.execute===true&&args.confirmUnmatch!==true)throw Error('Explicit confirmUnmatch=true is required for execution');
}
export function previewUnmatch(args,store=getStore()){
 validate(args);
 const known=store.get(args.userId,{messageLimit:0});
 if(known?.display_name&&known.display_name!==args.expectedName.trim())throw Error('Cached recipient name mismatch');
 return {dryRun:true,userId:args.userId,expectedName:args.expectedName,openedChats:0,liveRecipientVerified:false,destructive:true,instruction:'Execution requires execute=true and confirmUnmatch=true after user authorization. May permanently remove the match and conversation.'};
}
async function verifyRemoval(frame,userId,panel){
 const deadline=Date.now()+5000;
 do{
  const rows=frame.locator(`[data-source="chats_list"][data-user-id="${userId}"], [data-source="new_chats_list"][data-user-id="${userId}"]`);
  if(await rows.count()===0&&!await panel.isVisible())return true;
  await new Promise(resolve=>setTimeout(resolve,100));
 }while(Date.now()<deadline);
 return false;
}
export async function unmatch(frame,args,store=getStore(),verify=verifyRemoval){
 validate(args);
 if(!args.execute)return previewUnmatch(args,store);
 const {userId,expectedName,requestId}=args;
 const requestKey=createHash('sha256').update(requestId).digest('hex');
 if(store.db.prepare("SELECT 1 FROM events WHERE person_id=? AND event_type='unmatch.attempted' AND json_extract(data_json,'$.requestKey')=?").get(userId,requestKey))return {userId,duplicateRequest:true,attempted:true,retry:false,note:'This request was already attempted. Inspect the match state; do not retry automatically.'};
 const drafts=frame.locator('#chat:visible textarea[data-testid="write-bar"]');
 for(let i=0;i<await drafts.count();i++)if(await drafts.nth(i).inputValue())throw Error('Unfinished draft; refusing to navigate');
 if(await frame.locator('[role="dialog"]:visible').count())throw Error('An existing dialog must be dismissed before selecting a target');
 await navigate(frame,'/');
 await frame.locator('#chat:visible').waitFor({state:'hidden',timeout:5000});
 await navigate(frame,'/chats');
 await openChat(frame,userId);
 const panel=frame.locator('#chat:visible');
 const header=panel.locator('.vkuiPanelHeaderContent__childrenText');
 const checkName=async()=>{if(await header.count()!==1||(await header.innerText()).trim()!==expectedName.trim())throw Error('Conversation name mismatch; no unmatch dispatched');};
 await checkName();
 // Grounded in the supplied capture: header Report opens a choice sheet; it does not submit a report.
 const menu=panel.locator('.vkuiPanelHeader__after').getByRole('button',{name:'Report',exact:true});
 if(await menu.count()!==1)throw Error('Unique chat-header Report menu unavailable');
 await menu.click();
 const dialog=frame.locator('[role="dialog"]:visible').filter({hasText:/Do You Want to\s+Report This User\?/i});
 await dialog.waitFor({state:'visible',timeout:3000});
 if(await dialog.count()!==1)throw Error('Expected unmatch choice dialog unavailable or ambiguous');
 const remove=dialog.getByRole('button',{name:'Delete Like',exact:true});
 if(await remove.count()!==1||!await remove.isEnabled())throw Error('Unique enabled Delete Like action unavailable');
 await checkName();
 await logEvent('unmatch.attempted',{userId,requestId,execute:true,outcome:'attempted'});
 store.event('unmatch.attempted',userId,{requestKey});
 await checkName();
 const result={userId,attempted:true,retry:false,serverAccepted:'unverified'};
 try{
  await remove.click({timeout:5000});result.clicked=true;
  // No guessed second destructive click. A new confirmation must be inspected separately.
  const remainingDialogs=frame.locator('[role="dialog"]:visible');
  result.confirmationVisible=await remainingDialogs.count()>0;
  result.verifiedRemovedInView=result.confirmationVisible?false:await verify(frame,userId,panel);
 }catch(error){result.clicked??='unknown';result.errorType=error.name;result.verifiedRemovedInView=false;}
 store.event('unmatch.result',userId,{requestKey,...result});
 if(result.verifiedRemovedInView)result.availability=store.markUnmatched(userId);
 if(!await logOutcome('unmatch.result',{userId,requestId,clicked:result.clicked,outcome:result.verifiedRemovedInView?'success':'unverified'}))result.auditLogError=true;
 result.note=result.verifiedRemovedInView?'Match row and open conversation disappeared in the current view; server acceptance is not independently confirmed.':'Outcome unverified or a follow-up confirmation remains. Do not automatically retry.';
 return result;
}
