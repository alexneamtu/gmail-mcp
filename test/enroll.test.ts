import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';
import {Store} from '../src/store.js';
import {parseConfig} from '../src/config.js';
import {enroll} from '../src/enroll.js';

for(const scenario of ['cancel','provider_error','wrong_account','missing_scope','success'] as const){
  test(`enrollment ${scenario} reports a safe outcome and closes its listener`,{timeout:8000},async t=>{
    const dir=mkdtempSync(join(tmpdir(),'gmail-enroll-')),store=new Store(dir,randomBytes(32));
    const config=parseConfig({origin:'https://mcp.example.com',ownerEmail:'owner@example.com',accounts:{personal:'owner@example.com'},access:'full'});
    store.put('Settings','desktop',{client_id:'synthetic-client',client_secret:'SECRET_CLIENT'});
    let state='',nonce='',output='';let ready!:()=>void;
    const listening=new Promise<void>(resolve=>{ready=resolve;});
    t.mock.method(OAuth2Client.prototype,'generateAuthUrl',(options:any)=>{state=options.state;nonce=options.nonce;return 'https://accounts.google.com/synthetic-enrollment';});
    const write=process.stdout.write.bind(process.stdout);
    t.mock.method(process.stdout,'write',(chunk:any,...args:any[])=>{
      if(typeof chunk==='string'&&(chunk.includes('SSH')||chunk.includes('authorization link')||chunk.includes('Enrollment'))){output+=chunk;if(chunk.includes('authorization link'))ready();return true;}
      return (write as any)(chunk,...args);
    });
    t.mock.method(OAuth2Client.prototype,'getToken',async()=>({tokens:{id_token:'SECRET_ID',refresh_token:'SECRET_REFRESH',scope:scenario==='missing_scope'?'openid email':'openid email https://www.googleapis.com/auth/gmail.modify'}}));
    t.mock.method(OAuth2Client.prototype,'verifyIdToken',async()=>({getPayload:()=>({sub:'synthetic-owner',email_verified:true,email:scenario==='wrong_account'?'other@example.com':'owner@example.com',nonce})}));
    const outcome=enroll(config,store,'personal').then(()=>undefined,error=>error);
    try{
      await Promise.race([listening,outcome.then(error=>{throw error??new Error('Enrollment ended before listening');})]);
      const response=await fetch('http://127.0.0.1:18888/callback?'+new URLSearchParams({state,...(scenario==='cancel'?{error:'access_denied'}:scenario==='provider_error'?{error:'server_error'}:{code:'synthetic-code'})}),{headers:{Connection:'close'}});
      const body=await response.text();
      // Older code leaves cancelled sessions pending; complete that synthetic session for cleanup.
      if(scenario==='cancel'&&body.includes('Invalid authorization response'))await fetch('http://127.0.0.1:18888/callback?'+new URLSearchParams({state,code:'synthetic-code'}),{headers:{Connection:'close'}});
      const error=await outcome;
      if(scenario==='success'){
        assert.equal(error,undefined);assert.match(body,/personal/);assert.ok(store.get('Mailbox','personal'));
      }else{
        assert.equal(error?.code,scenario==='cancel'?'enrollment_cancelled':scenario==='provider_error'?'authorization_failed':scenario==='wrong_account'?'wrong_account':'grant_missing');
        assert.equal(store.get('Mailbox','personal'),undefined);
      }
      assert.match(output,/personal/);assert.match(output,/ten minutes/);assert.doesNotMatch(body,/SECRET/);
    }finally{store.close();rmSync(dir,{recursive:true,force:true});}
  });
}
