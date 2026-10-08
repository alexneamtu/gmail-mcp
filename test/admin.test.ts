import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {Store} from '../src/store.js';
import {Gmail} from '../src/gmail.js';
import {parseConfig} from '../src/config.js';

test('failed removal blocks mailbox access while retaining credentials for a revocation retry',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'gmail-admin-')),key=randomBytes(32);
  const config=parseConfig({origin:'https://mcp.example.com',ownerEmail:'owner@example.com',accounts:{personal:'owner@example.com'}});
  const state=join(dir,'state'),store=new Store(state,key);
  writeFileSync(join(dir,'key'),key,{mode:0o600});
  writeFileSync(join(dir,'config'),JSON.stringify(config),{mode:0o600});
  store.put('Mailbox','personal',{email:'owner@example.com',refreshToken:'synthetic-refresh'});
  const shim=join(dir,'google.mjs');
  const prefix=`import {OAuth2Client} from ${JSON.stringify(pathToFileURL(resolve('node_modules/google-auth-library/build/src/index.js')).href)};`;
  const run=()=>promisify(execFile)(process.execPath,['--import','tsx','--import',shim,'src/cli.ts','remove','personal'],{
    env:{...process.env,GMAIL_MCP_CONFIG:join(dir,'config'),GMAIL_MCP_KEY:join(dir,'key'),GMAIL_MCP_STATE:state},timeout:10000});
  try{
    writeFileSync(shim,prefix+"OAuth2Client.prototype.revokeToken=async()=>{throw Error('synthetic network failure')};");
    await assert.rejects(run);
    assert.equal(store.get('Mailbox','personal')?.refreshToken,'synthetic-refresh');
    assert.equal(store.get('Mailbox','personal')?.disabled,true);
    await assert.rejects(()=>new Gmail(config,store).request('personal','GET','/profile'),(error:any)=>error.code==='account_disabled');
    writeFileSync(shim,prefix+'OAuth2Client.prototype.revokeToken=async()=>({});');
    await run();assert.equal(store.get('Mailbox','personal'),undefined);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
