import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {validate,callTool} from '../mcp-tools.mjs';
import {profileDir,projectDir} from '../session.mjs';
import {resolve} from 'node:path';
test('profile defaults to project directory, independent of working directory',()=>{
 if(!process.env.VK_DATING_PROFILE_DIR) assert.equal(profileDir,resolve(projectDir,'.browser-profile'));
});
test('MCP rejects malformed arguments before opening browser',async()=>{
 for(const args of [{reaction:'like',execute:'true'},{reaction:'super_like'},{reaction:'like',other:1}]) {
  assert.throws(()=>validate('vk_react',args));
 }
 let touched=false;
 await assert.rejects(callTool({frame:async()=>{touched=true;}},'vk_open_chat',{userId:'1"]'}));
 assert.equal(touched,false);
});
test('stdio initializes, lists tools, returns useful errors and closes without launching Chrome',async()=>{
 const child=spawn(process.execPath,[new URL('../mcp.mjs',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});
 let output='',err='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>err+=d);
 const messages=[
  {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}},
  {jsonrpc:'2.0',method:'notifications/initialized'},
  {jsonrpc:'2.0',id:2,method:'tools/list'},
  {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'vk_status'}},
  {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'vk_react',arguments:{reaction:'like',execute:'true'}}},
  {jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'unknown_tool'}},
 ];
 child.stdin.end(messages.map(m=>JSON.stringify(m)).join('\n')+'\n');
 const exit=await new Promise((r,j)=>{child.on('error',j);child.on('close',r);});
 assert.equal(exit,0,err);
 const replies=output.trim().split('\n').map(JSON.parse);
 assert.equal(replies.length,5);
 assert.equal(replies[0].result.protocolVersion,'2024-11-05');
 assert.equal(replies[1].result.tools.length,14);
 assert.equal(JSON.parse(replies[2].result.content[0].text).running,false);
 assert.equal(replies[3].result.isError,true);
 assert.match(replies[4].result.content[0].text,/Unknown tool/);
});
