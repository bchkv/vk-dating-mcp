import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {sendMessage} from '../send-message.mjs';
import {validate,toolDefinitions} from '../mcp-tools.mjs';
test('send schema exposed and validated',()=>{
 assert(toolDefinitions.some(t=>t.name==='vk_send_message'));
 assert.throws(()=>validate('vk_send_message',{userId:'1',text:'hi'}),/expectedName/);
 assert.throws(()=>validate('vk_send_message',{userId:'x',expectedName:'Test',text:'hi'}),/Invalid/);
});
test('preview, dispatch, draft protection, recipient checks, and duplicate suppression',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
 const page=await browser.newPage();
 await page.setContent(`<button role="tab" data-tab="/">Profiles</button><button role="tab" data-tab="/chats">Chats</button><button data-source="chats_list" data-user-id="42">Test</button><div id="chat" hidden><div class="vkuiPanelHeaderContent__childrenText">Test</div><form><textarea data-testid="write-bar" maxlength="1000"></textarea><button type="button" id="send"><svg class="vkuiIcon--send_24"></svg>Send</button></form></div><script>
 window.sent=0;document.querySelectorAll('[role=tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[role=tab]').forEach(t=>t.setAttribute('aria-selected',String(t===b)));document.querySelector('#chat').hidden=true;});
 document.querySelector('[data-user-id]').onclick=()=>document.querySelector('#chat').hidden=false;
 document.querySelector('#send').onclick=()=>{window.sent++;document.querySelector('textarea').value='';};
 </script>`);
 const attempts=new Map(),args={userId:'42',expectedName:'Test',text:'Hello 👋\nSecond line'};
 assert.equal((await sendMessage(page,args,attempts)).dryRun,true);
 assert.equal(await page.locator('textarea').inputValue(),'');
 assert.equal(await page.evaluate(()=>window.sent),0);
 await assert.rejects(sendMessage(page,{...args,expectedName:'Other'},attempts),/name/);
 await assert.rejects(sendMessage(page,{...args,execute:true},attempts),/requestId/);
 await page.locator('textarea').fill('my draft');
 await assert.rejects(sendMessage(page,args,attempts),/draft/);
 await page.locator('textarea').fill('');
 assert.equal((await sendMessage(page,{...args,execute:true,requestId:'one'},attempts)).clicked,true);
 assert.equal((await sendMessage(page,{...args,execute:true,requestId:'one'},attempts)).duplicateRequest,true);
 assert.equal(await page.evaluate(()=>window.sent),1);
 await page.locator('#send').evaluate(el=>el.remove());
 await assert.rejects(sendMessage(page,{...args,execute:true,requestId:'two'},attempts),/Send control/);
 assert.equal(await page.evaluate(()=>window.sent),1);
 }finally{await browser.close();}
});
