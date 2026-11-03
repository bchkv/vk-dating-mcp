import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectTools,callPublicTool} from '../public-tools.mjs';
import {toolDefinitions} from '../mcp-tools.mjs';
const options={legacy:toolDefinitions,mode:'core'};
test('core exposes nine task tools including read-only statistics and rejects hidden operations before dispatch',async()=>{
 assert.deepEqual(selectTools(toolDefinitions,'core').map(x=>x.name),['vk_unmatch','vk_security','vk_login','vk_tracking_stats','vk_profile','vk_inbox','vk_context','vk_history','vk_send']);
 let calls=0;const dispatch=async()=>{calls++;};
 await assert.rejects(callPublicTool(null,'vk_capture',{},dispatch,options),/Unknown tool/);
 await assert.rejects(callPublicTool(null,'vk_history',{userId:'42',messageLimit:0},dispatch,options));
 await assert.rejects(callPublicTool(null,'vk_send',{userId:'42',expectedName:'Test',text:'Hi'},dispatch,options),/requestId/);
 assert.equal(calls,0);
 assert.equal(selectTools(toolDefinitions,'advanced').length,new Set([...toolDefinitions,...selectTools(toolDefinitions,"core")].map(t=>t.name)).size);
 assert.equal(selectTools(toolDefinitions,'advanced').filter(tool=>tool.name==='vk_tracking_stats').length,1);
});
test('inbox disables per-row context and returns bounded compact rows',async()=>{
 const dispatch=async(_s,name,args)=>{
  assert.equal(name,'vk_sync_overview');assert.equal(args.includeCachedContext,false);
  return {conversations:[{userId:'42',name:'Test',previewText:'Hi',cachedContext:{messages:['not returned']}},{userId:'43'}],scope:'loaded_overview_rows_only'};
 };
 const result=await callPublicTool(null,'vk_inbox',{limit:1},dispatch,{...options,store:()=>({get:()=>({state:{stage:'chatting'}})})});
 assert.equal(result.conversations.length,1);assert.equal(result.nextOffset,1);
 assert.equal(result.conversations[0].cachedContext,undefined);assert.equal(result.openedChats,0);
});
test('history and send route to single-person guarded operations',async()=>{
 const calls=[];const dispatch=async(_s,name,args)=>{calls.push({name,args});return name==='vk_get_conversations'?{conversations:[{userId:'42'}]}:{dryRun:true};};
 assert.equal((await callPublicTool(null,'vk_history',{userId:'42',beforeMessageId:'a'},dispatch,options)).userId,'42');
 assert.deepEqual(calls[0].args,{userIds:['42'],beforeMessageId:'a'});
 const result=await callPublicTool(null,'vk_send',{userId:'42',expectedName:'Test',text:'Hi',requestId:'one'},dispatch,options);
 assert.equal(result.dryRun,true);assert.equal(calls[1].args.execute,undefined);
});

test('default statistics use local tracking without starting or reading a browser',async()=>{
 const {callTool}=await import('../mcp-tools.mjs');
 const session={start(){throw Error('must not open browser');},frame(){throw Error('must not read chats');}};
 const result=await callPublicTool(session,'vk_tracking_stats',{},callTool,options);
 assert.equal(result.source,'local_tracking');assert.equal(result.openedChats,0);
 assert.equal(typeof result.conversations,'number');
 assert.ok('history_coverage' in result);assert.ok('missing_sent_at' in result);
 const tool=selectTools(toolDefinitions,'core').find(tool=>tool.name==='vk_tracking_stats');
 assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.annotations.openWorldHint,false);
 await assert.rejects(callPublicTool(session,'vk_clear_tracking',{},callTool,options),/Unknown tool/);
});
