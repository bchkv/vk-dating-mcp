import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConversationStore} from '../store.mjs';
import {buildContextPack, recordProfile} from '../context-pack.mjs';

test('context pack exposes omissions, prior invitations and uncertain sends without opening a chat',()=>{
 const store=new ConversationStore(':memory:');
 try {
  store.observeConversation({userId:'42',name:'Test',messages:[{messageId:'a',text:'Coffee?',outgoing:true},{messageId:'b',text:'Maybe later',outgoing:false}],history:{hasMore:false},ready:true});
  store.record({userId:'42',kind:'invitation',recordId:'one',sourceMessageId:'a',confidence:1,values:{message_id:'a'}});
  store.recordAction({userId:'42',event:'message.send.result',timestamp:'2026-11-02T00:00:00Z',outcome:'unverified'});
  let pack=buildContextPack({userId:'42',messageLimit:1},store);
  assert.equal(pack.coverage.omittedCachedMessages,1);
  assert.equal(pack.coverage.actualHistoryComplete,false);
  assert.equal(pack.priorInvitations.length,1);
  assert.equal(pack.recentSendEvents[0].outcome,'unverified');
  assert.equal(pack.profile,null);
  recordProfile({userId:'42',bio:'Synthetic bio',source:'user_provided'},store);
  pack=buildContextPack({userId:'42'},store);
  assert.equal(pack.profile.bio,'Synthetic bio');
  assert.equal(pack.openedChats,0);
  assert.equal(pack.coverage.actualHistoryComplete,true);
 } finally {store.close();}
});
