import {navigate,openChat} from './adapter.mjs';
import {getStore,personId} from './store.mjs';

const TTL=7*24*60*60*1000,RETRY_DELAY=60*60*1000;
export function cachedProfile(userId,store=getStore(),now=Date.now()) {
 personId(userId);
 const row=store.db.prepare("SELECT data_json,observed_at FROM events WHERE person_id=? AND event_type='profile.recorded' ORDER BY rowid DESC LIMIT 1").get(userId);
 if(!row)return null;
 return {...JSON.parse(row.data_json),observed_at:row.observed_at,stale:now-Date.parse(row.observed_at)>TTL};
}

// Runs only inside the exact profile dialog seen in the supplied DOM capture.
export function snapshotProfile(dialog) {
 const text=selector=>dialog.querySelector(selector)?.innerText?.trim()??null;
 const name=text('.h1aLTqhe .MWrUXww6');
 const ageText=text('.h1aLTqhe .ozp3w7rI');
 const ageMatch=ageText?.match(/^,?\s*(\d{1,3})\s*$/);
 const bioNode=dialog.querySelector('.Ax9AsHXa .QLecl7_H');
 const bio=bioNode?.innerText?.trim()??null;
 const sections=[...dialog.querySelectorAll('.BhMlvjdk section')].map(section=>({
  heading:section.querySelector('.vkuiHeader__contentIn')?.innerText?.trim()??null,
  text:section.innerText.trim().slice(0,10000)
 })).filter(section=>section.text).slice(0,20);
 const loading=[...dialog.querySelectorAll('[role="progressbar"],.vkuiSpinner__host,[aria-busy="true"]')].some(el=>el.getClientRects().length);
 return {name,age:ageMatch?Number(ageMatch[1]):null,bio,bioStatus:bioNode?(bio?'present':'empty'):'not_displayed',
  bioMayBeTruncated:!!bioNode&&(bioNode.scrollHeight>bioNode.clientHeight+2||bioNode.scrollWidth>bioNode.clientWidth+2),
  sections,ready:!!name&&dialog.querySelectorAll('.h1aLTqhe .MWrUXww6').length===1&&!!dialog.querySelector('.BhMlvjdk')&&!loading};
}

export function persistProfile(userId,profile,store=getStore()) {
 personId(userId);
 if(!profile.ready||!profile.name||!(profile.bio===null||typeof profile.bio==='string')||(profile.bio?.length??0)>10000)throw Error('Invalid or incomplete profile snapshot');
 const {ready,...fields}=profile;
 return store.transaction(()=>{
  store.ensure(userId,profile.name);
  const previous=cachedProfile(userId,store);
  const data={...fields,source:'observed_profile',identityVerifiedBy:'exact_chat_row_and_matching_chat_and_profile_names',mayMarkRead:true};
  const eventId=store.event('profile.recorded',userId,data);
  return {eventId,changed:!previous||JSON.stringify({...previous,observed_at:undefined,stale:undefined})!==JSON.stringify(data),...cachedProfile(userId,store)};
 });
}

export async function fetchProfile(frame,{userId,expectedName,refresh=false,inCurrentChat=false}={},store=getStore()) {
 personId(userId);
 const cached=cachedProfile(userId,store);
 if(cached&&!cached.stale&&!refresh)return {userId,cached:true,openedChats:0,profile:cached};
 const name=expectedName??store.get(userId,{messageLimit:0})?.display_name;
 if(typeof name!=='string'||!name.trim())throw Error('Refresh the inbox first to establish this person’s name');
 const editors=frame.locator('textarea[data-testid="write-bar"]');
 for(let i=0;i<await editors.count();i++)if(await editors.nth(i).inputValue())throw Error('Unfinished draft; profile navigation deferred');
 if(await frame.locator('[role="dialog"]:visible').count())throw Error('Existing dialog; profile navigation deferred');
 if(!inCurrentChat){
  await navigate(frame,'/');await frame.locator('#chat:visible').waitFor({state:'hidden',timeout:5000});await navigate(frame,'/chats');
  await frame.locator(`[data-source="chats_list"][data-user-id="${userId}"], [data-source="new_chats_list"][data-user-id="${userId}"]`).first().waitFor({state:'visible',timeout:5000});
  await openChat(frame,userId);
 }
 const panel=frame.locator('#chat:visible');
 const header=panel.locator('.vkuiPanelHeaderContent__childrenText');
 const verify=async()=>{if(await header.count()!==1||(await header.innerText()).trim()!==name.trim())throw Error('Profile recipient name mismatch');};
 await verify();
 const opener=panel.locator('.vkuiPanelHeaderContent__host');
 if(await opener.count()!==1)throw Error('Unique profile header unavailable');
 const dialog=frame.locator('#chat_user_card:visible');
 let opened=false;
 try{
  opened=true;await opener.click();await dialog.waitFor({state:'visible',timeout:5000});
  if(await dialog.count()!==1)throw Error('Ambiguous profile dialog');
  const deadline=Date.now()+5000;let snapshot;
  do {snapshot=await dialog.evaluate(snapshotProfile);if(snapshot.ready)break;await new Promise(r=>setTimeout(r,150));}while(Date.now()<deadline);
  if(!snapshot?.ready)throw Error('Profile did not finish loading');
  await verify();
  if(snapshot.name!==name.trim())throw Error('Profile dialog name mismatch');
  const profile=persistProfile(userId,snapshot,store);
  return {userId,cached:false,openedChats:inCurrentChat?0:1,mayMarkRead:true,profile};
 }finally{
  if(opened&&await dialog.count()){
   const close=dialog.locator('.vkuiModalOutsideButton__host');
   try{
    if(await close.count()!==1)throw Error('Close control missing or ambiguous');
    await close.click({timeout:1500});await dialog.waitFor({state:'hidden',timeout:1500});
   }catch{
    try{await dialog.press('Escape',{timeout:1500});await dialog.waitFor({state:'hidden',timeout:1500});}
    catch{const error=new Error('Profile panel is stuck; activity stopped for manual inspection.');error.name='ProfileUIBlockedError';throw error;}
   }
  }
 }
}

export async function enrichProfiles(frame,rows,{limit=1,timeoutMs=25000,read=fetchProfile,now=Date.now}={},store=getStore()) {
 const results=[],deadline=now()+timeoutMs;let attempts=0;
 for(const row of rows){
  const cached=cachedProfile(row.userId,store,now());
  if(cached&&!cached.stale){results.push({userId:row.userId,status:'cached'});continue;}
  const failed=store.db.prepare("SELECT observed_at FROM events WHERE person_id=? AND event_type='profile.fetch_failed' ORDER BY rowid DESC LIMIT 1").get(row.userId);
  if(failed&&now()-Date.parse(failed.observed_at)<RETRY_DELAY){results.push({userId:row.userId,status:cached?'stale':'retry_deferred'});continue;}
  if(attempts>=limit||now()>=deadline){results.push({userId:row.userId,status:cached?'stale':'pending'});continue;}
  attempts++;
  try{const result=await read(frame,{userId:row.userId,expectedName:row.name},store);results.push({userId:row.userId,status:result.cached?'cached':'fetched',openedChats:result.openedChats??0});}
  catch(error){
   store.event('profile.fetch_failed',row.userId,{errorType:error.name,reason:'profile_read_failed',retryAfterMs:RETRY_DELAY});
   results.push({userId:row.userId,status:cached?'stale':'failed',error:'Profile unavailable; cached data was retained'});
   // An unexpected open dialog or draft must be left for inspection, not bypassed.
   if(await frame.locator('[role="dialog"]:visible').count())break;
   const editors=frame.locator('textarea[data-testid="write-bar"]');let draft=false;
   for(let i=0;i<await editors.count();i++)if(await editors.nth(i).inputValue())draft=true;
   if(draft)break;
  }
 }
 return {results,attempts,openedChats:results.some(r=>r.status==='failed')?null:results.reduce((n,r)=>n+(r.openedChats??0),0),pending:rows.filter(r=>!cachedProfile(r.userId,store,now())).length,mayMarkRead:attempts>0};
}
