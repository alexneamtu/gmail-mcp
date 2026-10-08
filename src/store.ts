import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {OperationError} from './errors.js';

export type Payload = Record<string, any>;
type RecordValue = { id: string; data: Payload; expires: number | null };
// Revocation markers only block stale in-flight writers; grants live at most 30 days.
const REVOKED_TTL = 31 * 86400;

export function readPrivateFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new OperationError('private_files_permissions');
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
      const file = fstatSync(fd);
      if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error('Database must be a private regular file');
    } finally { closeSync(fd); }
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
      // DELETE is SQLite's default. Changing journal mode during every open takes unnecessary locks.
      this.transaction(() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value BLOB NOT NULL);
          CREATE TABLE IF NOT EXISTS records (model TEXT NOT NULL, id TEXT NOT NULL, payload BLOB NOT NULL,
          PRIMARY KEY(model,id));`);
        const columns = this.db.prepare('PRAGMA table_info(records)').all();
        if (columns.map(c => c.name).join(',') !== 'model,id,payload' || columns[0]?.pk !== 1 || columns[1]?.pk !== 2) {
          throw new Error('Unsupported state schema; explicit migration required');
        }
        const check = this.db.prepare('SELECT value FROM meta WHERE name=?').get('key-check');
        if (check) {
          let value: Payload;
          try { value = this.decrypt(Buffer.from(check.value as Uint8Array), 'key-check'); }
          catch { throw new Error('Cannot authenticate state with this key'); }
          if (value.version !== 2) throw new Error('Unsupported state schema; explicit migration required');
        } else {
          if (this.db.prepare('SELECT 1 FROM records LIMIT 1').get()) throw new Error('Missing key sentinel in existing state');
          this.db.prepare('INSERT INTO meta VALUES (?,?)').run('key-check', this.encrypt({ version: 2 }, 'key-check'));
        }
      });
    } catch (error) { this.db.close(); this.closed = true; throw error; }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private hash(model: string, id: string): string {
    return createHmac('sha256', this.lookup).update(JSON.stringify([model, id])).digest('hex');
  }
  private encrypt(data: Payload, aad: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryption, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }
  private decrypt(data: Buffer, aad: string): Payload {
    if (data.length < 29) throw new Error('Invalid encrypted record');
    const decipher = createDecipheriv('aes-256-gcm', this.encryption, data.subarray(0, 12), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
  }
  private decode(row: any): RecordValue | undefined {
    if (!row) return undefined;
    return this.decrypt(Buffer.from(row.payload), `${row.model}:${row.id}`) as RecordValue;
  }
  private raw(model: string, id: string): RecordValue | undefined {
    return this.decode(this.db.prepare('SELECT * FROM records WHERE model=? AND id=?').get(model, this.hash(model, id)));
  }
  private write(model: string, record: RecordValue): void {
    const hash = this.hash(model, record.id);
    this.db.prepare(`INSERT INTO records(model,id,payload) VALUES (?,?,?)
      ON CONFLICT(model,id) DO UPDATE SET payload=excluded.payload`).run(model, hash, this.encrypt(record, `${model}:${hash}`));
  }
  put(model: string, id: string, data: Payload, ttl?: number): void {
    if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isFinite(ttl) || !Number.isSafeInteger(Math.floor(Date.now()/1000) + ttl))) throw new Error('TTL must produce a finite integer expiration');
    this.transaction(() => {
      const grant = model === 'Grant' ? id : data.grantId;
      if (grant && this.raw('Revoked', grant)) throw new Error('Grant is revoked');
      const previous = this.raw(model, id);
      this.write(model, { id, data: previous?.data.consumed ? { ...data, consumed: previous.data.consumed } : data,
        expires: ttl === undefined ? null : Math.floor(Date.now()/1000) + ttl });
    });
  }
  private live(model: string, record: RecordValue | undefined): Payload | undefined {
    if (!record || (record.expires !== null && record.expires <= Date.now()/1000)) return undefined;
    const grant = model === 'Grant' ? record.id : record.data.grantId;
    if (grant && this.raw('Revoked', grant)) return undefined;
    return record.data;
  }
  get(model: string, id: string): Payload | undefined {
    return this.live(model, this.raw(model, id));
  }
  all(model: string): Array<{ id: string; data: Payload }> {
    return this.db.prepare('SELECT * FROM records WHERE model=?').all(model).flatMap(row => {
      const record = this.decode(row)!; const data = this.live(model, record);
      return data ? [{ id: record.id, data }] : [];
    });
  }
  find(model: string, field: 'uid' | 'user_code', value: string): Payload | undefined {
    const matches = this.all(model).filter(({data}) => data[field === 'uid' ? 'uid' : 'userCode'] === value);
    if (matches.length > 1) throw new Error('Ambiguous secondary lookup');
    return matches[0]?.data;
  }
  consume(model: string, id: string): boolean {
    return this.transaction(() => {
      const data = this.get(model, id); if (!data || data.consumed !== undefined) return false;
      const record = this.raw(model, id)!;
      this.write(model, { ...record, data: { ...data, consumed: Math.floor(Date.now()/1000) } });
      return true;
    });
  }
  delete(model: string, id: string): void {
    this.db.prepare('DELETE FROM records WHERE model=? AND id=?').run(model, this.hash(model, id));
  }
  revokeGrant(grant: string): void {
    this.transaction(() => {
      this.write('Revoked', {id: grant, data: {}, expires: Math.floor(Date.now()/1000) + REVOKED_TTL});
      for (const row of this.db.prepare('SELECT * FROM records').all()) {
        const record = this.decode(row)!;
        if ((row.model === 'Grant' && record.id === grant) || record.data.grantId === grant) this.delete(String(row.model), record.id);
      }
    });
  }
  revokeAll(): void {
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT * FROM records').all()) {
        const record = this.decode(row)!;
        const grant = row.model === 'Grant' ? record.id : record.data.grantId;
        if (grant) this.write('Revoked', {id: grant, data: {}, expires: Math.floor(Date.now()/1000) + REVOKED_TTL});
      }
      this.db.exec("DELETE FROM records WHERE model NOT IN ('Settings','Mailbox','Revoked')");
    });
  }
  prune(): void {
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT * FROM records').all()) {
        const record = this.decode(row)!;
        if (record.expires !== null && record.expires <= Date.now()/1000) this.delete(String(row.model), record.id);
      }
    });
  }
  rekey(key: Buffer): void {
    if (key.length !== 32) throw new Error('Encryption key must contain exactly 32 bytes');
    const previousEncryption = this.encryption, previousLookup = this.lookup;
    try {
      this.transaction(() => {
        const records = this.db.prepare('SELECT * FROM records').all().map(row => ({model: String(row.model), value: this.decode(row)!}));
        this.encryption = Buffer.from(hkdfSync('sha256', key, 'gmail-mcp', 'encryption', 32));
        this.lookup = Buffer.from(hkdfSync('sha256', key, 'gmail-mcp', 'lookup', 32));
        this.db.exec('DELETE FROM records');
        for (const record of records) this.write(record.model, record.value);
        this.db.prepare('UPDATE meta SET value=? WHERE name=?').run(this.encrypt({version: 2}, 'key-check'), 'key-check');
      });
    } catch (error) { this.encryption = previousEncryption; this.lookup = previousLookup; throw error; }
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
