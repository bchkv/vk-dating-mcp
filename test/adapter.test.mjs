import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
let chromium;
try { ({chromium} = await import('playwright')); } catch {}
import {appFrame, inspect, openChat, react, navigate} from '../adapter.mjs';

test('capture-derived chat and profile structures are discoverable through an iframe', {skip: !chromium && 'Playwright dependency unavailable'}, async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    for (const [name, expected] of [['chats', '/chats'], ['profiles', '/']]) {
      const html = await readFile(new URL(`./${name}.html`, import.meta.url), 'utf8');
      await page.setContent('<iframe></iframe>');
      await page.locator('iframe').evaluate((el, html) => el.srcdoc=html, html);
      const frame = await appFrame(page);
      // Archived fixtures omit images and CSS; size empty controls for visibility tests.
      await frame.addStyleTag({content: '[data-reaction] { display: block; width: 40px; height: 40px; } [data-reaction][hidden] { display: none; }'});
      const data = await inspect(frame);
      assert.equal(data.tabs.length, 4);
      assert.equal(data.tabs.find(t=>t.selected).key,expected);
      if (name==='chats') {
        assert.equal(data.chats.length,11);
        assert.equal(data.matches.length,23);
        assert.equal(data.editors.length,0);
        await assert.rejects(openChat(frame,'123"]'), /digits/);
        await assert.rejects(openChat(frame,'999999999'), /absent/);
      } else {
        assert.equal(data.reactionControls.length,6);
        await assert.rejects(react(frame,'like',true), /found 2/);
        await frame.locator('[data-reaction="like"]').last().evaluate(el=>el.hidden=true);
        await frame.evaluate(()=>{window.clicks=0;document.addEventListener('click',()=>window.clicks++);});
        assert.equal((await react(frame,'like')).dryRun,true);
        assert.equal(await frame.evaluate(()=>window.clicks),0);
        assert.equal((await react(frame,'like',true)).serverAccepted,'unverified');
        assert.equal(await frame.evaluate(()=>window.clicks),1);
        await assert.rejects(react(frame,'super_like',true),/Only/);
      }
      await assert.rejects(navigate(frame,'unexpected'),/Unknown/);
    }
  } finally {await browser.close();}
});
