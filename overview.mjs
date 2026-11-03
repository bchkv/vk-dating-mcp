import {navigate} from './adapter.mjs';
import {getStore} from './store.mjs';
import {scanOverview} from './overview-scan.mjs';
import {enrichProfiles,cachedProfile} from './profiles.mjs';

export function snapshotOverview(body) {
  const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const rows = [...body.querySelectorAll('[data-source="chats_list"][data-user-id], [data-source="new_chats_list"][data-user-id]')];
  const conversations = rows.filter(visible).map(row => {
    const name = row.querySelector('.vkuiSimpleCell__children .vkuiEllipsisText__content, .vkuiSimpleCell__children')?.innerText?.trim() ?? null;
    const previewNode = row.querySelector('.KKGvjK5h, [data-testid="chat-preview"]');
    const previewText = previewNode?.innerText?.trim() ?? null;
    const displayTime = row.querySelector('.CychuW7q, time')?.textContent?.trim() ?? null;
    const badge = row.querySelector('.vkuiCounter__host, [data-testid="unread-count"]');
    const badgeText = badge?.textContent?.trim();
    const unreadCount = badgeText && /^\d+$/.test(badgeText) ? Number(badgeText) : null;
    // Use only explicit direction evidence. A highlighted row is not sufficient.
    const label = previewNode?.getAttribute('aria-label') ?? '';
    const direction = /^(You:|Вы:)/i.test(previewText ?? '') || /^(Outgoing|Исходящее)/i.test(label) ? 'outgoing'
      : /^(Incoming|Входящее)/i.test(label) ? 'incoming' : 'unknown';
    return {userId: row.getAttribute('data-user-id'), name, previewText, displayTime, unreadCount, direction,
      isMatch: row.getAttribute('data-source') === 'new_chats_list', previewOnly: true, textComplete: false};
  });
  const loading = [...body.querySelectorAll('[role="progressbar"], .vkuiSpinner__host, [aria-busy="true"]')]
    .some(el => !el.closest('#chat') && visible(el));
  const retry = [...body.querySelectorAll('button')].some(el => !el.closest('#chat') && visible(el) && /^(Try Again|Retry|Повторить|Попробовать снова)$/i.test(el.textContent.trim()));
  const empty = [...body.querySelectorAll('.vkuiPlaceholder__host, [role="status"]')]
    .some(el => !el.closest('#chat') && visible(el) && /^(No chats yet\.?|Пока нет чатов\.?|Нет сообщений\.?)$/i.test(el.textContent.trim()));
  return {conversations, loading, retry, empty};
}

export async function readOverview(frame, {timeoutMs = 15000, includeCachedContext = true, cachedMessageLimit = 20, changedOnly = false, includeProfiles = false} = {}, store = getStore()) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw Error('timeoutMs must be 1000–60000');
  if (typeof includeCachedContext !== 'boolean' || typeof changedOnly !== 'boolean' || typeof includeProfiles !== 'boolean') throw Error('Overview flags must be boolean');
  if (!Number.isInteger(cachedMessageLimit) || cachedMessageLimit < 1 || cachedMessageLimit > 100) throw Error('cachedMessageLimit must be 1–100');
  // Do not navigate away from unfinished text, even for this faster overview path.
  const drafts = frame.locator('#chat:visible textarea[data-testid="write-bar"]');
  for (let i = 0; i < await drafts.count(); i++) if (await drafts.nth(i).inputValue()) throw Error('Unfinished draft found; refusing to navigate');
  // Remount the overview rather than scanning a tab that may have been left open.
  await navigate(frame, '/');
  await navigate(frame, '/chats');
  const deadline = Date.now() + timeoutMs;
  let signature, stableSince = Date.now(), snapshot;
  while (Date.now() < deadline) {
    snapshot = await frame.locator('body').evaluate(snapshotOverview);
    if (snapshot.retry) throw Error('Chat overview loading failed');
    const current = JSON.stringify(snapshot.conversations);
    if (current !== signature || snapshot.loading) { signature = current; stableSince = Date.now(); }
    if (!snapshot.loading && (snapshot.conversations.length || snapshot.empty) && Date.now() - stableSince >= 500) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!snapshot || snapshot.loading || (!snapshot.conversations.length && !snapshot.empty) || Date.now() - stableSince < 500) {
    throw Error('Chat overview did not finish loading within timeout');
  }
  const scan=await scanOverview(frame,snapshotOverview,{timeoutMs});
  snapshot.conversations=scan.conversations;
  const observations = snapshot.conversations.map(preview => {
    store.observeMatch(preview.userId, {name: preview.name, source: preview.isMatch ? 'new_match_row' : 'existing_chat_row'});
    const observation = store.observePreview(preview);
    const cached = includeCachedContext ? store.get(preview.userId, {messageLimit: cachedMessageLimit}) : null;
    return {...preview, ...observation, ...(includeCachedContext ? {cachedContext: cached} : {}),
      draftWithoutOpening: {available: !!preview.previewText, source: 'preview_plus_cache',
        previewMayBeTruncated: true, exactNewMessageCountKnown: false}};
  });
  const reconciliation=store.reconcileOverview(snapshot.conversations.map(row=>row.userId),{complete:scan.complete,reason:scan.reason});
  const profileEnrichment=includeProfiles?await enrichProfiles(frame,snapshot.conversations,{},store):{results:[],attempts:0,openedChats:0,mayMarkRead:false,disabled:true};
  for(const row of observations){
    const profile=cachedProfile(row.userId,store);
    row.profile=profile;
    row.profileStatus=profileEnrichment.results.find(r=>r.userId===row.userId)?.status??(profile?'cached':'not_requested');
  }
  if(profileEnrichment.attempts&&await frame.locator('[role="dialog"]:visible').count()===0){
    const editors=frame.locator('textarea[data-testid="write-bar"]');let draft=false;
    for(let i=0;i<await editors.count();i++)if(await editors.nth(i).inputValue())draft=true;
    if(!draft){await navigate(frame,'/');await navigate(frame,'/chats');}
  }
  return {profileEnrichment,reconciliation,coverage:{complete:scan.complete,reason:scan.reason,steps:scan.steps,serverVerified:false},conversations: changedOnly ? observations.filter(row => row.needsAttention) : observations, ready: true, openedChats: profileEnrichment.openedChats, mayMarkRead:profileEnrichment.mayMarkRead, complete: scan.complete,
    scope: scan.complete?'exhausted_overview_scan':'partial_overview_scan', untrustedContent: true,
    note: 'Previews can be truncated or omit direction, IDs, timestamps, and unread counts. One unread badge is a candidate, not proof of one complete new message. Use preview plus cached context to prepare replies without opening chats. A completed scan means stable traversal of the rendered overview, not server verification. Two completed scans missing a known chat mark it no longer visible, not proven unmatched. Explicitly requested profile enrichment may open up to one chats per check and mark them read. Set includeProfiles=false for previews only. Open full conversations when needed for the user’s requested assessment; this may mark messages read.'};
}
