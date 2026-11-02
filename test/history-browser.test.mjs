import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshotHistory, readHistory} from '../history.mjs';
import {getConversations} from '../conversations.mjs';

// Synthetic UI only: no account, cookies, VK connection, or captured messages.
test('browser adapter waits for loading, scrolls the message list, and serves an exclusive older page', async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>#messages {height: 120px; overflow-y: auto;} [data-list-item-message-id] {height: 70px;}</style>
      <button role="tab" data-tab="/">Profiles</button>
      <button role="tab" data-tab="/chats">Chats</button>
      <button data-source="chats_list" data-user-id="42">Test</button>
      <div class="vkuiSpinner__host" id="unrelated">Unrelated loader</div>
      <section id="chat" hidden>
        <div class="vkuiPanelHeaderContent__childrenText">Test</div>
        <div id="messages"></div>
        <textarea data-testid="write-bar"></textarea>
      </section>
      <script>
        const panel = document.querySelector('#chat');
        const list = document.querySelector('#messages');
        const row = id => '<div data-list-item-message-id="' + id + '"><div data-message-bubble="true"><span class="UUBlt8_A">Message ' + id + '</span></div></div>';
        window.olderLoads = 0;
        let loading = false, beginning = false;
        for (const tab of document.querySelectorAll('[role=tab]')) tab.onclick = () => {
          document.querySelectorAll('[role=tab]').forEach(el => el.setAttribute('aria-selected', String(el === tab)));
          panel.hidden = true;
        };
        document.querySelector('[data-user-id]').onclick = () => {
          panel.hidden = false; beginning = false; loading = true;
          list.innerHTML = '<div class="vkuiSpinner__host">Loading...</div>';
          setTimeout(() => {
            list.innerHTML = ['d', 'e', 'f'].map(row).join('');
            list.scrollTop = list.scrollHeight;
            loading = false;
          }, 900);
        };
        list.addEventListener('scroll', () => {
          if (list.scrollTop > 1 || loading || beginning) return;
          loading = true; window.olderLoads++;
          list.insertAdjacentHTML('afterbegin', '<div class="vkuiSpinner__host">Loading...</div>');
          setTimeout(() => {
            list.innerHTML = '<p>This is the beginning of your conversation.</p>' + ['a', 'b', 'c', 'd', 'e', 'f'].map(row).join('');
            beginning = true; loading = false;
          }, 500);
        });
      </script>
    `);
    const first = await getConversations(page, {userIds: ['42'], messageLimit: 3});
    assert.equal(first.error, undefined);
    assert.deepEqual(first.conversations[0].messages.map(m => m.messageId), ['d', 'e', 'f']);
    assert.equal(first.conversations[0].ready, true);
    assert.equal(first.conversations[0].history.hasMore, true);
    assert.equal(await page.evaluate(() => window.olderLoads), 1);
    const older = await readHistory(page.locator('#chat'), {messageLimit: 3, beforeMessageId: 'd'});
    assert.deepEqual(older.messages.map(m => m.messageId), ['a', 'b', 'c']);
    assert.equal(older.history.hasMore, false);

    // Hidden loaders, message contents, and recipient names cannot fake UI history markers.
    await page.locator('#chat').evaluate(panel => {
      panel.innerHTML = '<div class="vkuiPanelHeaderContent__childrenText">No messages yet</div>' +
        '<div class="vkuiSpinner__host" hidden>Loading...</div>' +
        '<div data-list-item-message-id="x"><div data-message-bubble="true"><span class="UUBlt8_A">This is the beginning of your conversation.</span></div></div>' +
        '<div data-list-item-message-id="attachment"><div data-message-bubble="true"></div></div>';
    });
    const snapshot = await page.locator('#chat').evaluate(snapshotHistory);
    assert.equal(snapshot.loading, false);
    assert.equal(snapshot.beginningReached, false);
    assert.equal(snapshot.empty, false);
    assert.equal(snapshot.messages[1].text, null);
  } finally {
    await browser.close();
  }
});
