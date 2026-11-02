import {test} from 'node:test';
import assert from 'node:assert/strict';
import {react, openChat, appFrame} from '../adapter.mjs';
function fake(count) {
  let clicks=0;
  return {frame:{locator:()=>({count:async()=>count,click:async()=>{clicks++;}})},clicks:()=>clicks};
}
test('dry run and ambiguous targets do not click; execute clicks only once',async()=>{
  const target=fake(1);
  assert.equal((await react(target.frame,'like')).dryRun,true);
  assert.equal(target.clicks(),0);
  const result=await react(target.frame,'like',true);
  assert.equal(target.clicks(),1);
  assert.equal(result.serverAccepted,'unverified');
  for(const count of [0,2]) {
    const ambiguous=fake(count);
    await assert.rejects(react(ambiguous.frame,'dislike',true),/No action taken/);
    assert.equal(ambiguous.clicks(),0);
  }
});
test('invalid IDs and unsupported reactions are rejected before touching DOM',async()=>{
  const frame={locator:()=>{throw Error('must not access DOM');}};
  await assert.rejects(openChat(frame,'1"]'),/digits/);
  await assert.rejects(react(frame,'super_like',true),/Only/);
});
test('ambiguous app frames are rejected',async()=>{
  await assert.rejects(appFrame({frames:()=>[fake(1).frame,fake(1).frame]}),/Multiple app frames/);
});
