import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';

test('state survives restart without plaintext tokens in the database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-store-'));
  const key = randomBytes(32);
  const token = 'secret-bearer-value-not-for-disk';
  let db = new Store(dir, key);
  try {
    db.put('RefreshToken', token, { refresh_token: token, grantId: 'grant' }, 60);
    db.close();
    assert.equal(readFileSync(join(dir, 'state.db')).includes(Buffer.from(token)), false);
    assert.equal(statSync(join(dir, 'state.db')).mode & 0o777, 0o600);
    db = new Store(dir, key);
    assert.equal(db.get('RefreshToken', token)?.refresh_token, token);
    db.revokeGrant('grant');
    assert.equal(db.get('RefreshToken', token), undefined);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('consume succeeds exactly once even across two database connections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-store-'));
  const key = randomBytes(32);
  const first = new Store(dir, key);
  const second = new Store(dir, key);
  try {
    first.put('AuthorizationCode', 'code', { grantId: 'g' }, 60);
    assert.equal(first.consume('AuthorizationCode', 'code'), true);
    assert.equal(second.consume('AuthorizationCode', 'code'), false);
    assert.equal(typeof second.get('AuthorizationCode', 'code')?.consumed, 'number');
    first.revokeAll();
    assert.equal(second.get('AuthorizationCode', 'code'), undefined);
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a wrong key fails authentication of stored data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-store-'));
  const db = new Store(dir, randomBytes(32));
  try {
    db.put('Settings', 'owner', { sub: 'subject' });
    db.close();
    assert.throws(() => new Store(dir, randomBytes(32)), /key|decrypt|auth/i);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('rejects non-finite TTL and a missing key sentinel over existing records', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'gmail-store-'));
  const key = randomBytes(32); const store = new Store(dir, key);
  try {
    assert.throws(() => store.put('Code','bad',{},NaN), /TTL/);
    assert.throws(() => store.put('Code','bad',{},Infinity), /TTL/);
    store.put('Mailbox','account',{secret:'synthetic'}); store.close();
    const raw = new DatabaseSync(join(dir,'state.db')); raw.exec('DELETE FROM meta'); raw.close();
    assert.throws(() => new Store(dir,key), /sentinel|authenticate/i);
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('secondary lookup ignores expired matches and refuses duplicate live matches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-store-')); const store = new Store(dir,randomBytes(32));
  try {
    store.put('Session','old',{uid:'shared'},-1); store.put('Session','new',{uid:'shared',value:2},60);
    assert.equal(store.find('Session','uid','shared')?.value,2);
    store.put('Session','duplicate',{uid:'shared'},60);
    assert.throws(() => store.find('Session','uid','shared'), /Ambiguous/);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('revoked grants cannot be resurrected by stale writers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-store-')); const store = new Store(dir,randomBytes(32));
  try {
    store.put('Grant','g',{},60);store.revokeGrant('g');
    assert.throws(() => store.put('Grant','g',{},60), /revoked/);
    assert.throws(() => store.put('AccessToken','token',{grantId:'g'},60), /revoked/);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('data-key rotation preserves state and invalidates the old key',()=>{
 const dir=mkdtempSync(join(tmpdir(),'gmail-store-'));const oldKey=randomBytes(32),newKey=randomBytes(32);let store=new Store(dir,oldKey);
 try{
  store.put('Mailbox','personal',{refreshToken:'synthetic'});store.put('AuthorizationCode','code',{},60);store.consume('AuthorizationCode','code');
  store.rekey(newKey);store.close();assert.throws(()=>new Store(dir,oldKey),/authenticate/);
  store=new Store(dir,newKey);assert.equal(store.get('Mailbox','personal')?.refreshToken,'synthetic');assert.equal(store.consume('AuthorizationCode','code'),false);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('rejects an incompatible schema without retaining database handles',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const {readdirSync,readlinkSync,chmodSync}=await import('node:fs');
 const dir=mkdtempSync(join(tmpdir(),'gmail-store-'));const path=join(dir,'state.db');
 try{
  const raw=new DatabaseSync(path);raw.exec('CREATE TABLE records (model TEXT)');raw.close();chmodSync(path,0o600);
  const count=()=>readdirSync('/proc/self/fd').filter(fd=>{try{return readlinkSync('/proc/self/fd/'+fd)===path;}catch{return false;}}).length;
  const before=count();for(let i=0;i<3;i++)assert.throws(()=>new Store(dir,randomBytes(32)),/schema/i);
  assert.equal(count(),before);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('modified ciphertext and substitution between records fail authentication',async()=>{
 const {DatabaseSync}=await import('node:sqlite');
 const dir=mkdtempSync(join(tmpdir(),'gmail-tamper-'));const store=new Store(dir,randomBytes(32));
 const raw=new DatabaseSync(join(dir,'state.db'));
 try{
  store.put('Mailbox','first',{secret:'one'});store.put('Mailbox','second',{secret:'two'});
  const rows=raw.prepare('SELECT id,payload FROM records WHERE model=?').all('Mailbox') as Array<{id:string,payload:Uint8Array}>;
  const payload=Buffer.from(rows[0]!.payload);payload[payload.length-1]=payload[payload.length-1]!^1;
  raw.prepare('UPDATE records SET payload=? WHERE id=?').run(payload,rows[0]!.id);
  assert.throws(()=>store.all('Mailbox'),/auth|decrypt/i);
  raw.prepare('UPDATE records SET payload=? WHERE id=?').run(rows[1]!.payload,rows[0]!.id);
  assert.throws(()=>store.all('Mailbox'),/auth|decrypt/i);
 }finally{raw.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('separate processes serialize initialization and consumption under an exclusive lock',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const {execFile}=await import('node:child_process');
 const {promisify}=await import('node:util');const {pathToFileURL}=await import('node:url');const {resolve}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'gmail-concurrent-')),key=randomBytes(32);const store=new Store(dir,key);
 const raw=new DatabaseSync(join(dir,'state.db'));
 try{
  store.put('AuthorizationCode','one-time',{},60);raw.exec('BEGIN EXCLUSIVE');
  const program=`import {Store} from ${JSON.stringify(pathToFileURL(resolve('src/store.ts')).href)};
   const store=new Store(process.argv[1],Buffer.from(process.argv[2],'hex'));
   console.log(store.consume('AuthorizationCode','one-time'));store.close();`;
  const child=()=>promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',program,dir,key.toString('hex')],{timeout:10000});
  const first=child(),second=child();await new Promise(r=>setTimeout(r,500));raw.exec('COMMIT');
  const results=await Promise.all([first,second]);assert.deepEqual(results.map(r=>r.stdout.trim()).sort(),['false','true']);
 }finally{raw.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('revocation tombstones expire after outliving the grant lifetime', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-store-'));
  const store = new Store(dir, randomBytes(32));
  try {
    store.put('Grant', 'g', {}, 60); store.revokeGrant('g');
    assert.throws(() => store.put('Grant', 'g', {}, 60), /revoked/);
    const now = Date.now();
    t.mock.method(Date, 'now', () => now + 32 * 86400 * 1000);
    store.prune();
    store.put('Grant', 'g', {}, 60);
    assert.deepEqual(store.get('Grant', 'g'), {});
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed rotation keeps the previous key usable', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-store-'));
  const oldKey = randomBytes(32); let store = new Store(dir, oldKey);
  try {
    store.put('Mailbox', 'personal', { refreshToken: 'synthetic' });
    t.mock.method(store as any, 'write', () => { throw new Error('synthetic crash'); });
    assert.throws(() => store.rekey(randomBytes(32)), /synthetic crash/);
    t.mock.restoreAll();
    assert.equal(store.get('Mailbox', 'personal')?.refreshToken, 'synthetic');
    store.close(); store = new Store(dir, oldKey);
    assert.equal(store.get('Mailbox', 'personal')?.refreshToken, 'synthetic');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
