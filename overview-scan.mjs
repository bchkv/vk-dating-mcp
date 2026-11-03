// Traverse the overview only. No conversation clicks or individual chat reads.
export function scrollOverview(body, reset=false) {
 const rowSelector='[data-source="chats_list"][data-user-id], [data-source="new_chats_list"][data-user-id]';
 const targets=new Set();
 for(const row of body.querySelectorAll(rowSelector)) {
  for(let el=row.parentElement;el;el=el.parentElement) {
   const css=getComputedStyle(el);
   if(el.closest('#chat'))continue;
   if((/auto|scroll/.test(css.overflowY)&&el.scrollHeight>el.clientHeight+2)||(/auto|scroll/.test(css.overflowX)&&el.scrollWidth>el.clientWidth+2))targets.add(el);
  }
 }
 if(document.scrollingElement)targets.add(document.scrollingElement);
 let atEnd=true;
 const geometry=[];
 for(const el of targets) {
  const maxY=Math.max(0,el.scrollHeight-el.clientHeight),maxX=Math.max(0,el.scrollWidth-el.clientWidth);
  if(reset){el.scrollTop=0;el.scrollLeft=0;}
  else {el.scrollTop=Math.min(maxY,el.scrollTop+Math.max(100,el.clientHeight*.8));el.scrollLeft=Math.min(maxX,el.scrollLeft+Math.max(100,el.clientWidth*.8));}
  if(el.scrollTop<maxY-2||el.scrollLeft<maxX-2)atEnd=false;
  geometry.push([Math.round(el.scrollTop),el.scrollHeight,Math.round(el.scrollLeft),el.scrollWidth]);
 }
 const filtered=[...body.querySelectorAll('input')].some(el=>!el.closest('#chat')&&el.getClientRects().length&&el.value.trim()&&
  (el.type==='search'||/search|поиск/i.test([el.placeholder,el.getAttribute('aria-label')].join(' '))));
 return {atEnd,geometry,filtered};
}

export async function scanOverview(frame,snapshotFn,{timeoutMs=15000,maxSteps=100,pause=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
 const body=frame.locator('body'),rows=new Map();
 const deadline=Date.now()+timeoutMs;
 await body.evaluate(scrollOverview,true);
 let signature=null,stable=0,filtered=false,steps=0;
 for(;steps<maxSteps&&Date.now()<deadline;steps++) {
  const snapshot=await body.evaluate(snapshotFn);
  for(const row of snapshot.conversations)rows.set(row.userId,row);
  if(snapshot.retry)return {conversations:[...rows.values()],complete:false,reason:'loading_error',steps};
  const movement=await body.evaluate(scrollOverview,false);filtered ||= movement.filtered;
  const current=JSON.stringify([[...rows.keys()].sort(),movement.geometry]);
  if(!snapshot.loading&&movement.atEnd&&current===signature)stable++;else stable=0;
  signature=current;
  if(stable>=3&&(rows.size||snapshot.empty))return {conversations:[...rows.values()],complete:!filtered,reason:filtered?'filtered_view':'stable_end_of_overview',steps:steps+1,serverVerified:false};
  await pause(400);
 }
 return {conversations:[...rows.values()],complete:false,reason:steps>=maxSteps?'scroll_limit':'timeout',steps,serverVerified:false};
}
