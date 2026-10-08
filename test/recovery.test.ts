import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {OAuth2Client} from 'google-auth-library';
import {Store} from '../src/store.js';
import {Gmail} from '../src/gmail.js';
import {parseConfig} from '../src/config.js';

const config=parseConfig({origin:'https://mcp.example.com',ownerEmail:'owner@example.com',accounts:{personal:'owner@example.com'},access:'full'});
const grant={email:'owner@example.com',sub:'synthetic-owner',refreshToken:'SECRET_REFRESH',scopes:['https://www.googleapis.com/auth/gmail.modify']};
const run=promisify(execFile);

test('CLI help works before configuration exists and never opens credential files',async()=>{
  const {stdout}=await run(process.execPath,['--import','tsx','src/cli.ts','--help'],{env:{...process.env,GMAIL_MCP_CONFIG:'/nonexistent/gmail-test-config',GMAIL_MCP_KEY:'/nonexistent/gmail-test-key'},timeout:10000});
  assert.match(stdout,/enroll-owner/);assert.match(stdout,/status/);assert.match(stdout,/18888/);
});

test('CLI status distinguishes missing, disabled, mismatched and locally enrolled accounts',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'gmail-status-')),key=randomBytes(32),state=join(dir,'state');
  const store=new Store(state,key);
  writeFileSync(join(dir,'key'),key,{mode:0o600});writeFileSync(join(dir,'config'),JSON.stringify(config),{mode:0o600});
  try{
    for(const [record,expected] of [[undefined,'missing'],[{...grant,disabled:true},'disabled'],[{...grant,email:'different@example.com'},'identity_mismatch'],[{...grant,scopes:[]},'scope_mismatch'],[grant,'enrolled']] as const){
      if(record)store.put('Mailbox','personal',record);else store.delete('Mailbox','personal');
      const {stdout}=await run(process.execPath,['--import','tsx','src/cli.ts','status'],{env:{...process.env,GMAIL_MCP_CONFIG:join(dir,'config'),GMAIL_MCP_KEY:join(dir,'key'),GMAIL_MCP_STATE:state},timeout:10000});
      const account=JSON.parse(stdout).accounts[0];assert.equal(account.state,expected);assert.equal(account.enrolled,expected==='enrolled');assert.equal(account.remoteValidity,'unchecked');assert.ok(account.nextAction);assert.doesNotMatch(stdout,/SECRET_REFRESH/);
    }
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('Gmail failures expose safe categories and uncertain writes are attempted only once',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'gmail-errors-')),store=new Store(dir,randomBytes(32));
  store.put('Mailbox','personal',grant);store.put('Settings','desktop',{client_id:'synthetic',client_secret:'SECRET_CLIENT'});
  const auth=t.mock.method(OAuth2Client.prototype,'getAccessToken',async()=>({token:'SECRET_ACCESS'}));
  const gmail=new Gmail(config,store);let calls=0;
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('SECRET_BODY',{status:429});});
  const expectCode=(code:string)=>(error:any)=>{assert.equal(error.code,code);assert.doesNotMatch(error.message,/SECRET/);return true;};
  try{
    await assert.rejects(()=>gmail.request('personal','GET','/messages'),expectCode('rate_limited'));
    for(const [status,code] of [[401,'reauth_required'],[403,'permission_denied'],[404,'not_found'],[400,'invalid_arguments'],[503,'upstream_unavailable']] as const){
      fetchMock.mock.mockImplementation(async()=>{calls++;return new Response('SECRET_BODY',{status});});
      await assert.rejects(()=>gmail.request('personal','GET','/messages'),expectCode(code));
    }
    for(const reason of ['rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded']){
      fetchMock.mock.mockImplementation(async()=>{calls++;return new Response(JSON.stringify({error:{errors:[{reason,message:'SECRET_BODY'}]} }),{status:403});});
      await assert.rejects(()=>gmail.request('personal','GET','/messages'),expectCode(reason==='dailyLimitExceeded'?'quota_exceeded':'rate_limited'));
    }
    fetchMock.mock.mockImplementation(async()=>{calls++;throw new Error('SECRET network error');});
    const before=calls;await assert.rejects(()=>gmail.request('personal','POST','/drafts',{}),expectCode('write_outcome_unknown'));assert.equal(calls,before+1);
    fetchMock.mock.mockImplementation(async()=>{calls++;return new Response('SECRET invalid JSON',{status:200});});
    await assert.rejects(()=>gmail.request('personal','POST','/drafts',{}),expectCode('write_outcome_unknown'));
    fetchMock.mock.mockImplementation(async()=>{calls++;return new Response('SECRET server error',{status:503});});
    await assert.rejects(()=>gmail.request('personal','POST','/drafts',{}),expectCode('write_outcome_unknown'));
    auth.mock.mockImplementation(async()=>{throw {response:{status:400,data:{error:'invalid_grant',error_description:'SECRET_REFRESH'}}};});
    const prior=calls;await assert.rejects(()=>gmail.request('personal','POST','/drafts',{}),expectCode('reauth_required'));assert.equal(calls,prior);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('CLI identifies overly permissive private files without exposing paths or contents',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'gmail-permissions-'));const file=join(dir,'config');
  writeFileSync(file,'SECRET_INVALID_CONFIGURATION',{mode:0o600});chmodSync(file,0o644);
  try{
    await assert.rejects(()=>run(process.execPath,['--import','tsx','src/cli.ts','status'],{env:{...process.env,GMAIL_MCP_CONFIG:file},timeout:10000}),(error:any)=>{assert.match(error.stderr,/private_files_permissions/);assert.doesNotMatch(error.stderr,/SECRET|gmail-permissions-/);return true;});
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Gmail reuses one OAuth client per account until its credentials change',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'gmail-cache-')),store=new Store(dir,randomBytes(32));
  store.put('Mailbox','personal',grant);store.put('Settings','desktop',{client_id:'synthetic',client_secret:'SECRET_CLIENT'});
  const auth=t.mock.method(OAuth2Client.prototype,'getAccessToken',async()=>({token:'SECRET_ACCESS'}));
  t.mock.method(globalThis,'fetch',async()=>new Response('{}',{status:200}));
  const gmail=new Gmail(config,store);
  try{
    await gmail.request('personal','GET','/profile');await gmail.request('personal','GET','/profile');
    assert.equal(auth.mock.calls[0]!.this,auth.mock.calls[1]!.this);
    store.put('Mailbox','personal',{...grant,refreshToken:'SECRET_REFRESH_2'});
    await gmail.request('personal','GET','/profile');
    assert.notEqual(auth.mock.calls[2]!.this,auth.mock.calls[1]!.this);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
