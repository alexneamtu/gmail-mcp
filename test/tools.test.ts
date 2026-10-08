import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseConfig} from '../src/config.js';
import {MailTools,Attachment,attachmentContent} from '../src/tools.js';

const config = {origin:'https://mcp.example.com', ownerEmail:'owner@example.com', accounts:{personal:'owner@example.com',work:'owner@example.org'},access:'full'};
test('configuration rejects unsafe origins and ambiguous account aliases',()=>{
  assert.throws(()=>parseConfig({...config,origin:'https://mcp.example.com/path'}));
  assert.throws(()=>parseConfig({...config,origin:'http://mcp.example.com'}));
  assert.throws(()=>parseConfig({...config,accounts:{'../work':'owner@example.org'}}));
});
test('tools require a known account and reject injected fields before any API operation',async()=>{
  let calls=0;const api={async request(){calls++;return {};}};
  const tools=new MailTools(parseConfig(config),api);
  await assert.rejects(()=>tools.execute('search_messages',{query:'is:unread'}));
  await assert.rejects(()=>tools.execute('search_messages',{account:'unknown',query:'x'}));
  await assert.rejects(()=>tools.execute('create_draft',{account:'personal',to:['person@example.com'],subject:'test',body:'test',attachments:['/etc/passwd']}));
  await assert.rejects(()=>tools.execute('create_draft',{account:'personal',to:['person@example.com'],subject:'test\r\nBcc: victim@example.com',body:'test'}));
  assert.equal(calls,0);
  assert.equal((await tools.execute('list_accounts',{account:'personal'}) as any[]).length,2);
});
test('draft mode removes sending and labeling tools; write failures are not retried',async()=>{
  let calls=0;
  const api={async request(){calls++;throw new Error('secret upstream response');}};
  const tools=new MailTools(parseConfig({...config,access:'drafts'}),api);
  assert.equal(tools.definitions.some(t=>t.name==='send_draft'),false);
  await assert.rejects(()=>tools.execute('send_draft',{account:'personal',draftId:'d1'}));
  assert.equal(calls,0);
  await assert.rejects(()=>tools.execute('create_draft',{account:'personal',to:['person@example.com'],subject:'Synthetic test',body:'Do not send'}),/Gmail operation failed/);
  assert.equal(calls,1);
});
test('draft MIME uses the selected account and routes exactly once',async()=>{
  const requests:any[]=[];
  const tools=new MailTools(parseConfig(config),{async request(...args:any[]){requests.push(args);return {id:'draft1'};}});
  await tools.execute('create_draft',{account:'work',to:['person@example.com'],subject:'Synthetic test',body:'Do not send'});
  assert.equal(requests.length,1);assert.equal(requests[0][0],'work');assert.equal(requests[0][2],'/drafts');
  const mime=Buffer.from(requests[0][3].message.raw,'base64url').toString();
  assert.match(mime,/From: owner@example.org/);assert.match(mime,/Do not send/);
});
test('HTML-only and attachment-backed message bodies are readable with explicit limits',async()=>{
  let message:any={id:'m1',payload:{mimeType:'text/html',body:{data:Buffer.from('<p>Readable HTML</p>').toString('base64url')}}};
  const tools=new MailTools(parseConfig(config),{async request(_account,_method,path){
    if(path==='/messages/m1/attachments/a1')return {data:Buffer.from('Attachment-backed body').toString('base64url')};
    return message;
  }});
  const html:any=await tools.execute('get_message',{account:'personal',messageId:'m1'});
  assert.equal(html.body,'<p>Readable HTML</p>');assert.equal(html.bodyMimeType,'text/html');
  message={id:'m1',payload:{mimeType:'text/plain',body:{attachmentId:'a1'}}};
  assert.equal((await tools.execute('get_message',{account:'personal',messageId:'m1'}) as any).body,'Attachment-backed body');
  message={id:'m1',payload:{mimeType:'text/plain',body:{data:Buffer.from('x'.repeat(60001)).toString('base64url')}}};
  const large:any=await tools.execute('get_message',{account:'personal',messageId:'m1'});
  assert.equal(large.body.length,60000);assert.equal(large.bodyTruncated,true);
});
test('messages list attachments by stable part ID and downloads resolve the current attachment ID',async()=>{
  const longId='A'.repeat(600);const requests:string[]=[];
  const pdf={partId:'1',filename:'invoice.pdf',mimeType:'application/pdf',body:{attachmentId:longId,size:3}};
  const tools=new MailTools(parseConfig(config),{async request(_account,_method,path){
    requests.push(path);
    if(path===`/messages/m1/attachments/${longId}`)return {data:Buffer.from('PDF').toString('base64url')};
    return {id:'m1',payload:{mimeType:'multipart/mixed',parts:[{partId:'0',mimeType:'text/plain',body:{data:Buffer.from('Body').toString('base64url')}},pdf,
      {partId:'2',filename:'huge.zip',mimeType:'application/zip',body:{attachmentId:'z',size:5_000_001}}]}};
  }});
  const message:any=await tools.execute('get_message',{account:'personal',messageId:'m1'});
  assert.equal(message.body,'Body');
  assert.deepEqual(message.attachments.map((a:any)=>a.partId),['1','2']);
  const file=await tools.execute('get_attachment',{account:'personal',messageId:'m1',partId:'1'}) as Attachment;
  assert.ok(file instanceof Attachment);assert.equal(file.mimeType,'application/pdf');assert.equal(Buffer.from(file.data,'base64').toString(),'PDF');
  requests.length=0;
  await assert.rejects(()=>tools.execute('get_attachment',{account:'personal',messageId:'m1',partId:'2'}),/safety limit/);
  assert.deepEqual(requests,['/messages/m1']);
  await assert.rejects(()=>tools.execute('get_attachment',{account:'personal',messageId:'m1',partId:'0'}),/not found/);
  await assert.rejects(()=>tools.execute('get_attachment',{account:'personal',messageId:'m1',partId:'../1'}),/partId/);
});
test('attachments map to image, text and binary MCP content',()=>{
  const data=Buffer.from('x').toString('base64');
  assert.equal(attachmentContent(new Attachment('u','a.png','image/png',1,data))[1]!.type,'image');
  assert.equal((attachmentContent(new Attachment('u','a.txt','text/plain',1,data))[1] as any).resource.text,'x');
  assert.equal((attachmentContent(new Attachment('u','a.pdf','application/pdf',1,data))[1] as any).resource.blob,data);
});
test('threads read every message within a shared body budget',async()=>{
  const big=Buffer.from('x'.repeat(60000)).toString('base64url');
  const messages=[1,2,3,4].map(n=>({id:'m'+n,threadId:'t1',payload:{mimeType:'text/plain',body:{data:big}}}));
  const tools=new MailTools(parseConfig(config),{async request(_account,_method,path){assert.equal(path,'/threads/t1');return {id:'t1',messages};}});
  const thread:any=await tools.execute('get_thread',{account:'personal',threadId:'t1'});
  assert.deepEqual(thread.messages.map((m:any)=>m.body.length),[60000,60000,60000,20000]);
  assert.equal(thread.messages[3].bodyTruncated,true);assert.equal(thread.messagesTruncated,false);
});
