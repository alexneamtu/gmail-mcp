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
