import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Store} from '../src/store.js';
import {parseConfig} from '../src/config.js';
import {createApp,initializeProviderSecrets} from '../src/app.js';

test('MCP requires authentication, rejects hostile hosts and exposes OAuth discovery',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'gmail-http-'));const store=new Store(dir,randomBytes(32));
 store.put('Settings','owner',{email:'owner@example.com',sub:'owner-sub'});initializeProviderSecrets(store);
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const config=parseConfig({origin,ownerEmail:'owner@example.com',accounts:{personal:'owner@example.com'}});
 const {app}=createApp(config,store,{async request(){throw new Error('must not call Google');}}, {start(){return 'https://accounts.google.com/';},async finish(){return {email:'owner@example.com',sub:'owner-sub'};}});
 server.on('request',app);
 try{
  const unauth=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(unauth.status,401);assert.match(unauth.headers.get('www-authenticate')??'',/resource_metadata/);
  const hostile=await new Promise<number|undefined>(resolve=>{const req=request(origin+'/mcp',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.end();});
  assert.equal(hostile,400);
  assert.equal((await fetch(origin+'/mcp',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(origin+'/mcp',{method:'POST',headers:{Origin:'null','Content-Type':'application/json'},body:'{}'})).status,403);
  const prm=await(await fetch(origin+'/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(prm.resource,origin+'/mcp');assert.deepEqual(prm.authorization_servers,[origin]);
  const as=await(await fetch(origin+'/.well-known/oauth-authorization-server')).json();
  assert.equal(as.issuer,origin);assert.ok(as.code_challenge_methods_supported.includes('S256'));
  assert.equal(as.registration_endpoint,undefined);
  const expired=await fetch(origin+'/interaction/expired/confirm',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:'csrf=expired&decision=allow'});
  assert.equal(expired.status,400);
  assert.match(await expired.text(),/Start a new connection/);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(dir,{recursive:true,force:true});}
});

test('owner-only browser flow issues audience-bound tokens, serves MCP, and rejects refresh replay',async()=>{
 const {createHash}=await import('node:crypto');
 const dir=mkdtempSync(join(tmpdir(),'gmail-oauth-'));const store=new Store(dir,randomBytes(32));
 store.put('Settings','owner',{email:'owner@example.com',sub:'owner-sub'});initializeProviderSecrets(store);
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const config=parseConfig({origin,ownerEmail:'owner@example.com',accounts:{personal:'owner@example.com'},access:'full'});
 const {app}=createApp(config,store,{async request(_a,method,path){assert.notEqual(path,'/drafts/send');return path==='/drafts'?{id:'synthetic-draft'}:{messages:[]};}}, {
  start(state,nonce,challenge){return 'https://accounts.google.com/fake?'+new URLSearchParams({state,nonce,challenge});},
  async finish(code){return code==='owner'?{email:'owner@example.com',sub:'owner-sub'}:{email:'intruder@example.com',sub:'intruder'};}
 });server.on('request',app);
 const cookies=new Map<string,string>();
 async function browser(path:string,init:RequestInit={}){
  const response=await fetch(new URL(path,origin),{...init,redirect:'manual',headers:{Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...init.headers}});
  for(const value of response.headers.getSetCookie()){const part=value.split(';')[0]!;const n=part.indexOf('=');cookies.set(part.slice(0,n),part.slice(n+1));}
  return response;
 }
 const verifier=randomBytes(32).toString('base64url');
 const authorize=()=>'/authorize?'+new URLSearchParams({client_id:'claude-gmail',redirect_uri:'https://claude.ai/api/mcp/auth_callback',response_type:'code',scope:'mcp offline_access',resource:origin+'/mcp',state:'client-state',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
 async function login(code:string){
  let response=await browser(authorize());assert.equal(response.status,303);
  response=await browser(response.headers.get('location')!);assert.equal(response.status,303);
  const google=new URL(response.headers.get('location')!);
  response=await browser('/login/google/callback?'+new URLSearchParams({code,state:google.searchParams.get('state')!}));
  if(code!=='owner'){assert.equal(response.status,403);return undefined;}
  for(let i=0;i<8;i++){
   const location=response.headers.get('location');
   if(location?.startsWith('https://claude.ai/'))return new URL(location).searchParams.get('code');
   if(location){response=await browser(location);continue;}
   const html=await response.text();assert.equal(response.status,200,html);
   assert.equal(response.headers.get('referrer-policy'),'same-origin','Consent form must preserve its same-origin POST Origin');
   const csrf=html.match(/name="csrf" value="([^"]+)"/)?.[1];const action=html.match(/action="([^"]+)"/)?.[1];
   assert.ok(csrf&&action,html);
   const denied=await browser(action,{method:'POST',headers:{Origin:'null','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,decision:'allow'})});
   assert.equal(denied.status,403);
   const forged=await browser(action,{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:'incorrect',decision:'allow'})});
   assert.equal(forged.status,403);
   response=await browser(action,{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,decision:'allow'})});
  }
  throw new Error('OAuth flow did not complete');
 }
 async function token(fields:Record<string,string>){return fetch(origin+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:'claude-gmail',resource:origin+'/mcp',...fields})});}
 async function mcp(access:string,method:string,params:any={}){return fetch(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});}
 try{
  await login('intruder');cookies.clear();
  const code=await login('owner');assert.ok(code);
  const exchange=await token({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:'https://claude.ai/api/mcp/auth_callback'});
  const tokens=await exchange.json();assert.equal(exchange.status,200,JSON.stringify(tokens));assert.ok(tokens.refresh_token);
  const init=await mcp(tokens.access_token,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}});
  assert.equal(init.status,200,await init.text());
  const listed=await(await mcp(tokens.access_token,'tools/list')).json();assert.ok(listed.result.tools.some((t:any)=>t.name==='create_draft'),JSON.stringify(listed));
  const inspected=await promisify(execFile)(process.execPath,['node_modules/@modelcontextprotocol/inspector/clients/cli/build/index.js',
    origin+'/mcp','--client-config',join(dir,'client.json'),
    '--method','tools/list','--format','json','--quiet','--stored-auth-only','--header','Authorization: Bearer '+tokens.access_token],
    {timeout:30000,env:{...process.env,MCP_STORAGE_DIR:dir,MCP_INSPECTOR_OAUTH_STATE_PATH:join(dir,'oauth.json')}});
  assert.match(inspected.stdout,/create_draft/);
  const draft=await(await mcp(tokens.access_token,'tools/call',{name:'create_draft',arguments:{account:'personal',to:['recipient@example.com'],subject:'Synthetic test',body:'Do not send'}})).json();
  assert.match(JSON.stringify(draft),/synthetic-draft/);
  const rotated=await token({grant_type:'refresh_token',refresh_token:tokens.refresh_token});assert.equal(rotated.status,200);
  const next=await rotated.json();assert.notEqual(next.refresh_token,tokens.refresh_token);
  const replay=await token({grant_type:'refresh_token',refresh_token:tokens.refresh_token});assert.equal(replay.status,400);
  assert.equal((await mcp(next.access_token,'tools/list')).status,401);
  cookies.clear();const concurrentCode=await login('owner');assert.ok(concurrentCode);
  const redeem=()=>token({grant_type:'authorization_code',code:concurrentCode,code_verifier:verifier,redirect_uri:'https://claude.ai/api/mcp/auth_callback'});
  const exchanges=await Promise.all([redeem(),redeem()]);
  assert.equal(exchanges.filter(r=>r.status===200).length<=1,true);
  assert.ok(exchanges.some(r=>r.status===400));
  for(const response of exchanges){if(response.status===200){const issued=await response.json();assert.equal((await mcp(issued.access_token,'tools/list')).status,401);}}
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(dir,{recursive:true,force:true});}
});
