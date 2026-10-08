import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Payload = Record<string, any>;

export function readPrivateFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Credential file must be private');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export class Store {
  private db: DatabaseSync;
  private encryption: Buffer;
  private lookup: Buffer;
  private closed = false;

  constructor(dir: string, key: Buffer) {
    if (key.length !== 32) throw new Error('Encryption key must contain exactly 32 bytes');
    this.encryption = Buffer.from(hkdfSync('sha256', key, 'gmail-mcp', 'encryption', 32));
    this.lookup = Buffer.from(hkdfSync('sha256', key, 'gmail-mcp', 'lookup', 32));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('State directory must be private');
    const path = join(dir, 'state.db');
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      if ((fstatSync(fd).mode & 0o077) !== 0) throw new Error('Database must have mode 0600');
    } finally { closeSync(fd); }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS records (
        model TEXT NOT NULL, id TEXT NOT NULL, payload BLOB NOT NULL, expires INTEGER,
        consumed INTEGER, grant_id TEXT, uid TEXT, user_code TEXT,
        PRIMARY KEY(model,id));
      CREATE INDEX IF NOT EXISTS grants ON records(grant_id);
      CREATE INDEX IF NOT EXISTS uids ON records(model,uid);`);
    try {
      const check = this.db.prepare('SELECT value FROM meta WHERE name=?').get('key-check');
      if (check) this.decrypt(Buffer.from(check.value as Uint8Array), 'key-check');
      else this.db.prepare('INSERT INTO meta VALUES (?,?)').run('key-check', this.encrypt({ valid: true }, 'key-check'));
    } catch { this.db.close(); throw new Error('Cannot authenticate state with this key'); }
  }

  private hash(domain: string, value: string): string {
    return createHmac('sha256', this.lookup).update(JSON.stringify([domain, value])).digest('hex');
  }
  private encrypt(data: Payload, aad: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryption, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }
  private decrypt(data: Buffer, aad: string): Payload {
    const decipher = createDecipheriv('aes-256-gcm', this.encryption, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
  }
  put(model: string, id: string, data: Payload, ttl?: number): void {
    const hash = this.hash(model, id);
    this.db.prepare(`INSERT INTO records VALUES (?,?,?,?,NULL,?,?,?)
      ON CONFLICT(model,id) DO UPDATE SET payload=excluded.payload, expires=excluded.expires,
      grant_id=excluded.grant_id, uid=excluded.uid, user_code=excluded.user_code`).run(
      model, hash, this.encrypt({ id, data }, `${model}:${hash}`),
      ttl === undefined ? null : Math.floor(Date.now() / 1000) + ttl,
      data.grantId ? this.hash('Grant', data.grantId) : null,
      data.uid ? this.hash('uid', data.uid) : null,
      data.userCode ? this.hash('userCode', data.userCode) : null,
    );
  }
  private decode(row: any): Payload | undefined {
    if (!row || (row.expires !== null && row.expires <= Date.now() / 1000)) return undefined;
    const { data } = this.decrypt(Buffer.from(row.payload), `${row.model}:${row.id}`);
    return row.consumed === null ? data : { ...data, consumed: row.consumed };
  }
  get(model: string, id: string): Payload | undefined {
    return this.decode(this.db.prepare('SELECT * FROM records WHERE model=? AND id=?').get(model, this.hash(model, id)));
  }
  find(model: string, field: 'uid' | 'user_code', value: string): Payload | undefined {
    return this.decode(this.db.prepare(`SELECT * FROM records WHERE model=? AND ${field}=?`).get(model, this.hash(field === 'uid' ? 'uid' : 'userCode', value)));
  }
  consume(model: string, id: string): boolean {
    return this.db.prepare(`UPDATE records SET consumed=? WHERE model=? AND id=? AND consumed IS NULL
      AND (expires IS NULL OR expires>?)`).run(Math.floor(Date.now() / 1000), model, this.hash(model, id), Date.now() / 1000).changes === 1;
  }
  delete(model: string, id: string): void {
    this.db.prepare('DELETE FROM records WHERE model=? AND id=?').run(model, this.hash(model, id));
  }
  revokeGrant(grant: string): void {
    const hash = this.hash('Grant', grant);
    this.db.prepare('DELETE FROM records WHERE grant_id=? OR (model=? AND id=?)').run(hash, 'Grant', hash);
  }
  revokeAll(): void {
    this.db.exec("DELETE FROM records WHERE model NOT IN ('Settings','Mailbox')");
  }
  prune(): void { this.db.prepare('DELETE FROM records WHERE expires IS NOT NULL AND expires<=?').run(Date.now() / 1000); }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
