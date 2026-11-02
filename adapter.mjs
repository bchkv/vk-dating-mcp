import {logEvent,logOutcome} from './event-log.mjs';
export const selectors = {
  tabs: '[role="tab"][data-tab]',
  chats: '[data-source="chats_list"][data-user-id]',
  matches: '[data-source="new_chats_list"][data-user-id]',
  reactions: '[data-reaction]',
};
export async function appFrame(page, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frames = [];
    for (const frame of page.frames()) {
      if (await frame.locator(selectors.tabs).count().catch(() => 0)) frames.push(frame);
    }
    if (frames.length === 1) return frames[0];
    if (frames.length > 1) throw new Error('Multiple app frames found; refusing to guess.');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('App frame not found. Finish sign-in or open VK Dating in this window.');
}
export async function inspect(frame) {
  return frame.evaluate(s => {
    const rows = selector => [...document.querySelectorAll(selector)].map(el => ({userId: el.getAttribute('data-user-id'), text: el.innerText.trim()}));
    return {
      tabs: [...document.querySelectorAll(s.tabs)].map(el => ({key: el.getAttribute('data-tab'), text: el.innerText.trim(), selected: el.getAttribute('aria-selected') === 'true'})),
      chats: rows(s.chats), matches: rows(s.matches),
      reactionControls: [...document.querySelectorAll(s.reactions)].map(el => ({reaction: el.getAttribute('data-reaction'), label: el.getAttribute('aria-label')})),
      editors: [...document.querySelectorAll('textarea, [contenteditable="true"], input:not([type="hidden"])')].map(el => ({tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), label: el.getAttribute('aria-label'), placeholder: el.getAttribute('placeholder')})),
    };
  }, selectors);
}
export async function navigate(frame, key) {
  if (!['/', '/chats', 'reactions', '/tab_profile'].includes(key)) throw new Error('Unknown tab');
  const tab = frame.locator(`[role="tab"][data-tab="${key}"]`);
  if (await tab.count() !== 1) throw new Error('Tab is ambiguous or absent');
  await logEvent('navigation.attempted',{tab:key});
  await tab.click();
  await tab.and(frame.locator('[aria-selected="true"]')).waitFor();
  await logOutcome('navigation.completed',{tab:key,outcome:'success'});
}
export async function openChat(frame, userId) {
  if (!/^\d+$/.test(userId)) throw new Error('User ID must contain digits only');
  // Prefer an existing conversation; otherwise open the exact matched profile.
  let row = frame.locator(`[data-source="chats_list"][data-user-id="${userId}"]`);
  if(await row.count()===0) row=frame.locator(`[data-source="new_chats_list"][data-user-id="${userId}"]`);
  if (await row.count() !== 1) throw new Error('Chat absent or ambiguous; inspect Chats first');
  await logEvent('conversation.open.attempted',{userId});
  await row.click();
  await frame.locator('#chat:visible .vkuiPanelHeaderContent__childrenText').waitFor({state:'visible',timeout:10000});
  await logOutcome('conversation.open.completed',{userId,outcome:'success'});
  return {clicked:true,conversationReady:true};
}
export async function react(frame, reaction, execute = false) {
  if (!['like', 'dislike'].includes(reaction)) throw new Error('Only like and dislike supported');
  const controls = frame.locator(`[data-reaction="${reaction}"]:visible`);
  const count = await controls.count();
  if (count !== 1) throw new Error(`Expected one visible ${reaction} control; found ${count}. No action taken.`);
  if (!execute) return {dryRun: true, reaction, matchingVisibleControls: count};
  await logEvent('reaction.attempted',{reaction,execute:true,outcome:'attempted'});
  await controls.click();
  await logOutcome('reaction.result',{reaction,clicked:true,outcome:'unverified'});
  // A click does not establish server acceptance. Never retry automatically.
  return {dryRun: false, reaction, clicked: true, serverAccepted: 'unverified', retry: false};
}
