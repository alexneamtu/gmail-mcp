import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';
import {Store} from '../src/store.js';
import {GoogleIdentity} from '../src/identity.js';
import {parseConfig} from '../src/config.js';

test('owner login accepts only the verified owner with the expected nonce',async t=>{
  const config=parseConfig({origin:'https://mcp.example.com',ownerEmail:'owner@example.com',accounts:{personal:'owner@example.com'}});
  const dir=mkdtempSync(join(tmpdir(),'gmail-identity-')),store=new Store(dir,randomBytes(32));
  store.put('Settings','web',{client_id:'synthetic-web',client_secret:'SECRET_CLIENT'});
  const valid={sub:'synthetic-owner',email:'owner@example.com',email_verified:true,nonce:'n'};
  let payload:any=valid,tokens:any={id_token:'SECRET_ID'};
  t.mock.method(OAuth2Client.prototype,'getToken',async()=>({tokens}));
  const verify=t.mock.method(OAuth2Client.prototype,'verifyIdToken',async()=>({getPayload:()=>payload}));
  try{
    const identity=new GoogleIdentity(config,store);
    assert.deepEqual(await identity.finish('code','verifier','n'),{email:'owner@example.com',sub:'synthetic-owner'});
    assert.equal((verify.mock.calls[0]!.arguments[0] as any).audience,'synthetic-web');
    for(const bad of [{nonce:'other'},{email_verified:false},{email_verified:'true'},{email:'other@example.com'},{sub:''}]){
      payload={...valid,...bad};
      await assert.rejects(()=>identity.finish('code','verifier','n'),/Owner identity required/);
    }
    payload=undefined;await assert.rejects(()=>identity.finish('code','verifier','n'),/Owner identity required/);
    tokens={};await assert.rejects(()=>identity.finish('code','verifier','n'),/Missing identity/);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
