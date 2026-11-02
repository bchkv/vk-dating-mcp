import {navigate,openChat} from './adapter.mjs';

// This state belongs to the MCP process, not to the user's regular Chrome profile.
const states=new WeakMap();
export async function withBrowser(session,name,args,operation) {
 let state=states.get(session);
 if(!state){state={tab:'/',chatId:null};states.set(session,state);}
 if(name==='vk_close') return session.close();
 if(name==='vk_status') return session.status();
 session.cancelIdleClose();
 let result;
 try {
  const wasRunning=!!session.page&&!session.page.isClosed();
  await session.start();
  if(!wasRunning&&!['vk_start','vk_status','vk_navigate','vk_list_chats','vk_send_message','vk_edit_message','vk_get_conversations','vk_send_messages'].includes(name)) {
   const frame=await session.frame();
   await navigate(frame,state.tab);
   if(state.chatId&&name!=='vk_open_chat') {
    await frame.locator(`[data-source="chats_list"][data-user-id="${state.chatId}"], [data-source="new_chats_list"][data-user-id="${state.chatId}"]`).waitFor({state:'visible',timeout:10000});
    await openChat(frame,state.chatId);
   }
  }
  if(name==='vk_open_chat') {
   const frame=await session.frame();await navigate(frame,'/chats');
   await frame.locator(`[data-source="chats_list"][data-user-id="${args.userId}"], [data-source="new_chats_list"][data-user-id="${args.userId}"]`).waitFor({state:'visible',timeout:10000});
  }
  if(['vk_open_chat','vk_send_message','vk_edit_message','vk_get_conversations','vk_send_messages'].includes(name)){state.tab='/chats';state.chatId=args.userId;}
  if(name==='vk_list_chats'){state.tab='/chats';state.chatId=null;}
  if(name==='vk_navigate'){state.tab={profiles:'/',chats:'/chats',likes:'reactions',profile:'/tab_profile'}[args.tab];state.chatId=null;}
  result=await operation();
  if(name==='vk_get_conversations'&&result.conversations?.length){state.tab='/chats';state.chatId=result.conversations.at(-1).userId;}
  if(name==='vk_send_messages'&&result.results?.length){state.tab='/chats';state.chatId=result.results.at(-1).userId;}
  return result;
 } finally {
  session.armIdleClose();
  if(result&&typeof result==='object')result.browserLifecycle={closed:false,idleTimeoutSeconds:session.idleTimeoutMs/1000,dedicatedHeadlessShell:true};
 }
}
