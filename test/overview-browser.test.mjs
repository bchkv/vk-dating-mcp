import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readOverview} from '../overview.mjs';
import {ConversationStore} from '../store.mjs';

test('overview waits for its loader and persists previews without opening or counting messages', async () => {
  const browser = await chromium.launch({headless: true});
  const store = new ConversationStore(':memory:');
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button role="tab" data-tab="/chats">Chats</button>
      <div class="vkuiSpinner__host" id="loader">Loading...</div>
      <button data-source="chats_list" data-user-id="42">
        <span class="vkuiSimpleCell__children"><span class="vkuiEllipsisText__content">Test</span></span>
        <span class="KKGvjK5h" aria-label="Incoming">A preview that may be truncated</span>
        <span class="CychuW7q">Yesterday</span><span class="vkuiCounter__host">1</span>
      </button>
      <button data-source="new_chats_list" data-user-id="43"><span class="vkuiSimpleCell__children">New match</span></button>
      <section id="chat"><div class="vkuiSpinner__host">Unrelated conversation loader</div></section>
      <script>
        window.opened = 0;
        document.querySelector('[role=tab]').onclick = event => event.target.setAttribute('aria-selected','true');
        for (const row of document.querySelectorAll('[data-user-id]')) row.onclick = () => window.opened++;
        setTimeout(() => document.querySelector('#loader').hidden = true, 700);
      </script>
    `);
    const result = await readOverview(page, {}, store);
    assert.equal(await page.evaluate(() => window.opened), 0);
    assert.equal(result.openedChats, 0);
    assert.equal(result.complete, false);
    assert.equal(result.conversations[0].unreadCount, 1);
    assert.equal(result.conversations[0].direction, 'incoming');
    assert.equal(result.conversations[0].canUseAsVerifiedMessage, false);
    assert.equal(store.stats().messages, 0);
    assert.equal(store.get('43').match.matched_at, null);
    await page.locator('.KKGvjK5h').evaluate(el => el.textContent = 'A changed preview');
    const second = await readOverview(page, {}, store);
    assert.equal(second.conversations[0].previewChanged, true);
    assert.equal(store.stats().messages, 0);
    assert.equal(await page.evaluate(() => window.opened), 0);
  } finally { store.close(); await browser.close(); }
});
