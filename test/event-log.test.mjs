import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,stat,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventLogger,AuditLogError,loggedCall,safeFields} from '../event-log.mjs';
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'vk-log-test-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
async function entries(dir){return (await readFile(join(dir,(await readdir(dir))[0]),'utf8')).trim().split('\n').map(JSON.parse);}

test('non-message whitelist excludes text, names, credentials, URLs, and raw errors',()=>{
 const data=safeFields({text:'private',expectedText:'private',expectedName:'Anna',token:'secret',cookie:'secret',url:'https://example.test?token=secret',errorMessage:'private',requestId:'sensitive',userId:'42',textLength:7});
 assert.deepEqual(Object.keys(data).sort(),['requestKey','textLength','userId']);assert.equal(data.requestKey.length,64);assert.ok(!JSON.stringify(data).includes('sensitive'));
});
test('concurrent appends produce valid versioned JSONL with private permissions',()=>fixture(async root=>{
 const logger=new EventLogger(root);await Promise.all(Array.from({length:30},(_,i)=>logger.log('message.observed',{userId:String(i),messageId:'msg-'+i,outgoing:false,token:'never logged'})));
 const data=await entries(root);assert.equal(data.length,30);assert.ok(data.every(x=>x.schemaVersion===2&&x.timestamp&&x.sessionId));
 assert.equal((await stat(join(root,(await readdir(root))[0]))).mode&0o777,0o600);
 assert.ok(!JSON.stringify(data).includes('never logged'));
}));
test('tool calls receive distinct correlation IDs and preserve order inside each call',()=>fixture(async root=>{
 const logger=new EventLogger(root);
 await Promise.all(['42','43'].map(userId=>loggedCall('vk_open_chat',{userId},async()=>{await logger.log('conversation.open.completed',{userId});return {};},logger)));
 const data=await entries(root),groups=Map.groupBy(data,x=>x.operationId);assert.equal(groups.size,2);
 for(const events of groups.values())assert.deepEqual(events.map(x=>x.event),['tool.started','conversation.open.completed','tool.completed']);
}));
test('write-ahead logging failure prevents operation execution',async()=>{
 let called=false;const audit={log:async()=>{throw new AuditLogError();}};
 await assert.rejects(loggedCall('vk_send_message',{},async()=>{called=true;},audit),AuditLogError);assert.equal(called,false);
});
test('failure after action returns warning rather than hiding completed result',async()=>{
 let calls=0;const audit={log:async()=>{if(++calls>1)throw new AuditLogError();}};
 const r=await loggedCall('vk_send_message',{},async()=>({clicked:true,attempted:true}),audit);
 assert.equal(r.clicked,true);assert.equal(r.auditLogError,true);assert.match(r.note,/do not retry/i);
});
test('error logs exclude original error messages and completion is marked unverified for sends',()=>fixture(async root=>{
 const logger=new EventLogger(root);await assert.rejects(loggedCall('vk_send_message',{},async()=>{throw Error('PRIVATE BODY');},logger));
 await loggedCall('vk_send_message',{},async()=>({clicked:true,attempted:true}),logger);
 const data=await entries(root);assert.ok(!JSON.stringify(data).includes('PRIVATE BODY'));assert.equal(data.at(-1).outcome,'unverified');
}));
test('symlink log destinations are rejected without modifying their target',()=>fixture(async root=>{
 const outside=join(root,'outside');await writeFile(outside,'untouched');
 const dir=join(root,'logs');await import('node:fs/promises').then(fs=>fs.mkdir(dir));
 await symlink(outside,join(dir,new Date().toISOString().slice(0,10)+'.jsonl'));
 await assert.rejects(new EventLogger(dir).log('test.event'),AuditLogError);assert.equal(await readFile(outside,'utf8'),'untouched');
}));

test('message events retain exact Russian text and edit history while excluding infrastructure secrets',()=>fixture(async root=>{
 const logger=new EventLogger(root),text='Привет. Давай в пятницу\nВ 19:00, \"кофе\"';
 await logger.log('message.observed',{userId:'42',messageId:'msg-1',outgoing:false,text,token:'SECRET_TOKEN'});
 await logger.log('message.send.attempted',{userId:'42',text,requestId:'a',cookies:'SECRET_COOKIE'});
 await logger.log('message.edit.attempted',{userId:'42',text,previousText:'Старое приглашение',password:'SECRET_PASSWORD'});
 const data=await entries(root);assert.equal(data.length,3);assert.ok(data.every(x=>x.text===text));assert.equal(data[2].previousText,'Старое приглашение');
 assert.ok(!JSON.stringify(data).includes('SECRET_'));
}));
test('non-message events cannot acquire message bodies or edit history',()=>{
 assert.deepEqual(safeFields({text:'private',previousText:'private'},'tool.completed'),{});
 assert.deepEqual(safeFields({text:'new',previousText:'old'},'message.observed'),{text:'new'});
});
