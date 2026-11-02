import {getStore} from './store.mjs';
const id = {type:'string',pattern:'^[0-9]+$'};
const make=(name,description,properties,required,annotations)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations});
const read={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
export const coreToolDefinitions=[
 make('vk_inbox','Read a compact inbox from overview previews without opening individual chats. Start here. Returns IDs, names, previews and attention/state flags, not full conversations. Scope is loaded rows only.',
  {changedOnly:{type:'boolean',default:false},limit:{type:'number',minimum:1,maximum:100,default:50},offset:{type:'number',minimum:0,default:0}},[],{...read,openWorldHint:true}),
 make('vk_context','Get one person’s reply context from local storage: messages, latest preview, profile if available, state, invitations and uncertain send events. Does not open chats. Check coverage and freshness; never assume missing history means something was not discussed.',
  {userId:id,messageLimit:{type:'number',minimum:1,maximum:500,default:200}},['userId'],read),
 make('vk_history','Explicitly open one chat and fetch messages; may mark it read. Use only when full history is wanted and that side effect is acceptable. beforeMessageId fetches an older exclusive page. hasMore can be unknown. Reads also update the local context.',
  {userId:id,messageLimit:{type:'number',minimum:1,maximum:500,default:50},beforeMessageId:{type:'string',minLength:1,maxLength:100},maxScrolls:{type:'number',minimum:0,maximum:100,default:20},timeoutMs:{type:'number',minimum:1000,maximum:60000,default:15000}},['userId'],{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}),
 make('vk_send','Prepare a local message preview by default. Only execute=true opens the chat, verifies expectedName and attempts one send. Requires a unique requestId. Never automatically retry an uncertain result. Check context for prior invitations and pending attempts before sending.',
  {userId:id,expectedName:{type:'string',minLength:1},text:{type:'string',minLength:1,maxLength:1000},requestId:{type:'string',minLength:1},execute:{type:'boolean',default:false}},['userId','expectedName','text','requestId'],{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}),
];
export function selectTools(legacy,mode=process.env.VK_DATING_TOOLSET??'core') {
 if(!['core','advanced'].includes(mode))throw Error('VK_DATING_TOOLSET must be core or advanced');
 return mode==='advanced'?[...coreToolDefinitions,...legacy]:coreToolDefinitions;
}
export async function callPublicTool(session,name,args,callInternal,{legacy,mode=process.env.VK_DATING_TOOLSET??'core',store=getStore}={}) {
 const tool=selectTools(legacy,mode).find(item=>item.name===name);
 if(!tool)throw Error('Unknown tool');
 if(!args||typeof args!=='object'||Array.isArray(args))throw Error('Arguments must be an object');
 for(const key of Object.keys(args))if(!(key in tool.inputSchema.properties))throw Error(`Unknown argument: ${key}`);
 for(const key of tool.inputSchema.required)if(!(key in args))throw Error(`Missing argument: ${key}`);
 for(const [key,value]of Object.entries(args)){
  const rule=tool.inputSchema.properties[key];
  if(rule.type==='array'?!Array.isArray(value):typeof value!==rule.type)throw Error(`Invalid type for ${key}`);
  if(rule.type==='number'&&(!Number.isInteger(value)||value<(rule.minimum??-Infinity)||value>(rule.maximum??Infinity)))throw Error(`Invalid value for ${key}`);
  if(rule.type==='string'&&((rule.pattern&&!new RegExp(rule.pattern).test(value))||value.length<(rule.minLength??0)||value.length>(rule.maxLength??Infinity)))throw Error(`Invalid value for ${key}`);
 }
 if(name==='vk_inbox'){
  const result=await callInternal(session,'vk_sync_overview',{changedOnly:args.changedOnly??false,includeCachedContext:false});
  const offset=args.offset??0,limit=args.limit??50;
  const rows=result.conversations.slice(offset,offset+limit).map(row=>{
   const cached=store().get(row.userId,{messageLimit:0});
   return {userId:row.userId,name:row.name,preview:row.previewText,unreadCount:row.unreadCount,changed:row.previewChanged,
    previewEventId:row.previewEventId,needsAttention:row.needsAttention,stage:cached?.state.stage??null,waitingOn:cached?.state.waiting_on??null};
  });
  return {conversations:rows,nextOffset:offset+limit<result.conversations.length?offset+limit:null,scope:result.scope,complete:false,openedChats:0,untrustedContent:true};
 }
 if(name==='vk_context'){
  const pack=await callInternal(session,'vk_get_reply_context',args);
  if(!pack.found)return pack;
  const c=pack.conversation;
  return {userId:pack.userId,name:c.display_name,profile:pack.profile,preview:c.preview,messages:c.messages,
   state:c.state,fieldEvidence:c.field_evidence,records:c.records,sendEvents:pack.recentSendEvents,coverage:pack.coverage,
   lastOverviewOrChatCheck:c.last_checked_at,lastMessagesCheck:c.last_messages_checked_at,openedChats:0,untrustedContent:true};
 }
 if(name==='vk_history'){
  const {userId,...options}=args;
  const result=await callInternal(session,'vk_get_conversations',{userIds:[userId],...options});
  if(result.error)throw Error(result.error);
  return result.conversations[0];
 }
 if(name==='vk_send')return callInternal(session,'vk_send_message',args);
 return callInternal(session,name,args);
}
