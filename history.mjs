// Bounded, per-call history collection. No persistent conversation cache.
export const historyProperties = {
  messageLimit: {type: 'number', minimum: 1, maximum: 500, default: 50},
  beforeMessageId: {type: 'string', minLength: 1, maxLength: 100},
  maxScrolls: {type: 'number', minimum: 0, maximum: 100, default: 20},
  timeoutMs: {type: 'number', minimum: 1000, maximum: 60000, default: 15000},
};

export function historyOptions(args = {}) {
  const options = {
    messageLimit: args.messageLimit ?? 50,
    maxScrolls: args.maxScrolls ?? 20,
    timeoutMs: args.timeoutMs ?? 15000,
    beforeMessageId: args.beforeMessageId,
  };
  for (const key of ['messageLimit', 'maxScrolls', 'timeoutMs']) {
    const rule = historyProperties[key];
    if (!Number.isInteger(options[key]) || options[key] < rule.minimum || options[key] > rule.maximum) {
      throw Error(`${key} must be an integer between ${rule.minimum} and ${rule.maximum}`);
    }
  }
  if (options.beforeMessageId !== undefined &&
      (typeof options.beforeMessageId !== 'string' || !options.beforeMessageId.trim() || options.beforeMessageId.length > 100)) {
    throw Error('beforeMessageId must contain 1–100 characters');
  }
  return options;
}

// This function runs in the page. Inspect only the opened conversation.
export function snapshotHistory(panel) {
  const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const outsideMessage = el => !el.closest('[data-list-item-message-id], textarea, [contenteditable="true"], .vkuiPanelHeaderContent__childrenText');
  const uiText = [...panel.querySelectorAll('span, p, div, button')]
    .filter(el => !el.children.length && outsideMessage(el) && visible(el))
    .map(el => el.textContent.trim());
  const loading = panel.getAttribute('aria-busy') === 'true' || [...panel.querySelectorAll('[role="progressbar"], [aria-busy="true"], .vkuiSpinner__host')]
    .some(el => outsideMessage(el) && visible(el)) || uiText.some(text => /^(Loading|Загружается|Загрузка)(\.{3}|…)?$/i.test(text));
  const loadError = uiText.some(text => /^(Try Again|Retry|Повторить|Попробовать снова)$/i.test(text));
  const empty = uiText.some(text => /^(No messages yet\.?|Пока нет сообщений\.?|Сообщений пока нет\.?)$/i.test(text));
  // Only an explicit UI boundary can establish completeness; scroll position alone cannot.
  const beginningReached = empty || uiText.some(text => /^(This is the beginning of your conversation\.?|Начало переписки\.?)$/i.test(text));
  const messages = [...panel.querySelectorAll('[data-list-item-message-id]')].map(row => ({
    messageId: row.getAttribute('data-list-item-message-id'),
    outgoing: !!row.querySelector('[data-message-bubble="true"].UzN_JO3e'),
    text: row.querySelector('[data-message-bubble="true"] span.UUBlt8_A')?.innerText ?? null,
    // Preserve actual times only when the DOM provides an unambiguous ISO timestamp.
    sentAt: (() => {
      const raw = row.querySelector('time[datetime]')?.getAttribute('datetime') ?? row.getAttribute('data-sent-at');
      return raw && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(raw) && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
    })(),
    editedAt: (() => {
      const raw = row.getAttribute('data-edited-at');
      return raw && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(raw) && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
    })(),
    replyToId: row.getAttribute('data-reply-to-id') ?? null,
    direction: row.querySelector('[data-message-bubble="true"].UzN_JO3e') ? 'outgoing' : row.querySelector('[data-message-bubble="true"]') ? 'incoming' : 'unknown',
  }));
  const editors = [...panel.querySelectorAll('textarea[data-testid="write-bar"]')].filter(visible);
  return {messages, loading, loadError, empty, beginningReached, draftPresent: editors.some(el => !!el.value)};
}

export function scrollHistoryOlder(panel) {
  const first = panel.querySelector('[data-list-item-message-id]');
  if (!first) return {scrolled: false, reason: 'no_message_anchor'};
  // Find the message list's scroll ancestor, never a sidebar or the whole page.
  let scroller = first.parentElement;
  while (scroller && scroller !== panel) {
    const style = getComputedStyle(scroller);
    if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
    scroller = scroller.parentElement;
  }
  if (!scroller || scroller === panel) {
    const style = getComputedStyle(panel);
    if (!/(auto|scroll)/.test(style.overflowY) || panel.scrollHeight <= panel.clientHeight) {
      return {scrolled: false, reason: 'no_scroll_container'};
    }
    scroller = panel;
  }
  // Move to the earliest rendered row; don't jump over unobserved virtualized rows.
  const before = scroller.scrollTop;
  const target = Math.max(0, before + first.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 1);
  scroller.scrollTop = target;
  if (Math.abs(scroller.scrollTop - before) < 1 && target > 0) scroller.scrollTop = Math.max(0, before - scroller.clientHeight / 2);
  scroller.dispatchEvent(new Event('scroll', {bubbles: true}));
  return {scrolled: true};
}

function mergeMessages(messages, incoming) {
  // DOM order is chronological; IDs are opaque, not numerically sortable.
  for (let i = 0; i < incoming.length; i++) {
    const message = incoming[i];
    const existing = messages.findIndex(row => row.messageId === message.messageId);
    if (existing >= 0) { messages[existing] = message; continue; }
    const next = incoming.slice(i + 1).find(row => messages.some(old => old.messageId === row.messageId));
    if (next) messages.splice(messages.findIndex(row => row.messageId === next.messageId), 0, message);
    else {
      const previous = incoming.slice(0, i).reverse().find(row => messages.some(old => old.messageId === row.messageId));
      if (previous) messages.splice(messages.findIndex(row => row.messageId === previous.messageId) + 1, 0, message);
      else messages.unshift(message);
    }
  }
}

export async function collectHistory(port, args = {}) {
  const {messageLimit, beforeMessageId, maxScrolls, timeoutMs} = historyOptions(args);
  const now = port.now ?? Date.now;
  const sleep = port.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let last, scrolls = 0, stopReason = 'message_limit';
  let boundary = false;
  const messages = [];

  async function waitForSettled(previousSignature, minimumWait = 600) {
    const started = now();
    let signature, stableSince = started;
    while (now() < deadline) {
      const state = await port.snapshot();
      if (state.loadError) throw Error('Conversation loading failed; retry control is visible');
      last = state;
      const current = JSON.stringify([state.messages, state.empty, state.beginningReached, state.draftPresent]);
      if (state.loading || current !== signature) { signature = current; stableSince = now(); }
      const populated = state.messages.length > 0 || state.empty;
      const changed = previousSignature === undefined || current !== previousSignature;
      // Allow a delayed scroll-triggered loader to appear before declaring no progress.
      if (populated && !state.loading && now() - stableSince >= 500 &&
          now() - started >= (changed ? minimumWait : 1500)) {
        return {state, signature: current};
      }
      await sleep(Math.min(100, Math.max(0, deadline - now())));
    }
    return null;
  }

  let settled = await waitForSettled();
  if (!settled) throw Error('Conversation messages did not finish loading before timeout; history is not ready');
  let lastSignature = settled.signature;
  for (;;) {
    mergeMessages(messages, settled.state.messages);
    boundary ||= settled.state.beginningReached;
    const cursor = beforeMessageId === undefined ? messages.length : messages.findIndex(row => row.messageId === beforeMessageId);
    if (cursor >= 0 && (cursor > messageLimit || boundary)) break;
    if (boundary) { stopReason = 'beginning_reached'; break; }
    if (scrolls >= maxScrolls) { stopReason = 'scroll_limit'; break; }
    if (messages.length >= 5000) { stopReason = 'observation_limit'; break; }
    if (now() >= deadline) { stopReason = 'timeout'; break; }
    const outcome = await port.scrollOlder();
    if (!outcome.scrolled) { stopReason = outcome.reason ?? 'no_scroll_container'; break; }
    scrolls++;
    settled = await waitForSettled(lastSignature);
    if (!settled) { stopReason = 'timeout'; break; }
    if (settled.signature === lastSignature) { stopReason = 'no_progress'; break; }
    lastSignature = settled.signature;
  }

  const cursor = beforeMessageId === undefined ? messages.length : messages.findIndex(row => row.messageId === beforeMessageId);
  if (cursor < 0) {
    throw Error(`History cursor was not found within the read budget (${stopReason}); increase maxScrolls/timeoutMs or refresh recent history`);
  }
  const start = Math.max(0, cursor - messageLimit);
  const page = messages.slice(start, cursor);
  const hasMore = start > 0 ? true : boundary ? false : null;
  const oldestMessageId = page[0]?.messageId ?? null;
  return {
    messages: page,
    loading: !!last?.loading,
    draftPresent: !!last?.draftPresent,
    ready: !last?.loading,
    history: {
      hasMore,
      status: hasMore === true ? 'more_available' : hasMore === false ? 'beginning_reached' : 'unknown',
      complete: hasMore === false,
      oldestMessageId,
      newestMessageId: page.at(-1)?.messageId ?? null,
      nextBeforeMessageId: hasMore === false ? null : oldestMessageId,
      stopReason: hasMore === false ? 'beginning_reached' : stopReason,
      scrolls,
    },
    scope: 'bounded_conversation_history',
  };
}

export function readHistory(panel, options) {
  return collectHistory({
    snapshot: () => panel.evaluate(snapshotHistory),
    scrollOlder: () => panel.evaluate(scrollHistoryOlder),
  }, options);
}
