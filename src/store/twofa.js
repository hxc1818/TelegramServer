// Two-factor / login-token storage, deliberately kept separate from store.js.
//
// Uses a dedicated node:sqlite DatabaseSync at <dataDir>/twofa.sqlite (Node
// >= 22.5, no npm dependencies). Falls back to <dataDir>/twofa.json when
// node:sqlite is unavailable or when dbDriver:'json' is requested. Every
// method is synchronous so it can be called straight from a TL handler.
//
// Buffers (salt, serverSalt, hash2, g_srp_B, p, b, secureRandom) are stored as
// base64 TEXT columns and returned as Buffer instances on read. This avoids
// the node:sqlite BLOB/Uint8Array difference between the sqlite and JSON
// drivers while keeping binary values exact.

import fs from 'node:fs';
import path from 'node:path';

const TABLE_FIELDS = {
  passwords: ['userId', 'salt', 'serverSalt', 'hash2', 'gSrpB', 'algorithm', 'g', 'p', 'b', 'srpId', 'hint', 'secureRandom', 'updatedAt'],
  loginTokens: ['token', 'userId', 'expires', 'used', 'createdAt'],
  loginCodes: ['token', 'code', 'createdAt'],
  exportTokens: ['token', 'userId', 'createdAt'],
  passportConfig: ['key', 'value'],
};

const CREATE_SQL = {
  // srp_id is TEXT on purpose: int64 values above Number.MAX_SAFE_INTEGER are
  // stored as decimal strings and node:sqlite refuses to convert them to JS
  // numbers when the column has INTEGER affinity.
  passwords: 'user_id INTEGER PRIMARY KEY, salt TEXT, server_salt TEXT, hash2 TEXT, g_srp_b TEXT, algorithm TEXT, g INTEGER, p TEXT, b TEXT, srp_id TEXT, hint TEXT, secure_random TEXT, updated_at INTEGER',
  loginTokens: 'token TEXT PRIMARY KEY, user_id INTEGER, expires INTEGER, used INTEGER, created_at INTEGER',
  loginCodes: 'token TEXT PRIMARY KEY, code TEXT, created_at INTEGER',
  exportTokens: 'token TEXT PRIMARY KEY, user_id INTEGER, created_at INTEGER',
  passportConfig: 'key TEXT PRIMARY KEY, value TEXT',
};

const now = () => Math.floor(Date.now() / 1000);
const columnOf = (field) => String(field).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toNumber = (v, fallback = 0) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function sqliteValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return v.toString(); // keep full precision in TEXT columns
  return v;
}

function toBigInt(v) {
  if (v === undefined || v === null || v === '') return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? BigInt(Math.trunc(v)) : 0n;
  const match = String(v).trim().match(/^-?\d+/);
  if (!match) {
    try { return BigInt(String(v).trim()); } catch { return 0n; }
  }
  return BigInt(match[0]);
}

function toB64(v) {
  if (v === undefined || v === null) return '';
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  if (typeof v === 'bigint') return toB64(fromBig(v));
  return Buffer.from(String(v), 'utf8').toString('base64');
}

function fromB64(v) {
  if (v === undefined || v === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'bigint') return fromBig(v);
  return Buffer.from(String(v), 'base64');
}

// Fixed-width big-endian encoding for SRP big integers (256 bytes / 2048 bits).
function fromBig(v, bytes = 256) {
  const out = Buffer.alloc(bytes);
  let n = BigInt(v);
  for (let i = bytes - 1; i >= 0 && n > 0n; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function randomHex(bytes) {
  const crypto = process.getBuiltinModule?.('node:crypto');
  if (crypto?.randomBytes) return crypto.randomBytes(bytes).toString('hex');
  const buf = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  return Buffer.from(buf).toString('hex');
}

function parseJSON(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

class SQLiteDriver {
  constructor(file, DatabaseSync) {
    this.kind = 'sqlite';
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    for (const [table, sql] of Object.entries(CREATE_SQL)) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${sql})`);
    }
  }

  _where(table, where) {
    const entries = Object.entries(where || {}).map(([k, v]) => [columnOf(k), sqliteValue(v)]);
    return {
      sql: entries.length ? ` WHERE ${entries.map(([k]) => `${k} = ?`).join(' AND ')}` : '',
      values: entries.map(([, v]) => v),
    };
  }

  all(table, where = {}, opts = {}) {
    const { sql, values } = this._where(table, where);
    let query = `SELECT * FROM ${table}${sql}`;
    const params = [...values];
    if (opts.limit) {
      query += ' LIMIT ?';
      params.push(Number(opts.limit));
    }
    return this.db.prepare(query).all(...params);
  }

  get(table, where) {
    return this.all(table, where, { limit: 1 })[0] || null;
  }

  insert(table, row) {
    const keys = (TABLE_FIELDS[table] || []).filter((k) => row[k] !== undefined);
    const sql = `INSERT INTO ${table} (${keys.map(columnOf).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    this.db.prepare(sql).run(...keys.map((k) => sqliteValue(row[k])));
    return row;
  }

  update(table, where, patch) {
    const keys = Object.keys(patch).filter((k) => (TABLE_FIELDS[table] || []).includes(k));
    if (!keys.length) return 0;
    const { sql, values } = this._where(table, where);
    const set = keys.map((k) => `${columnOf(k)} = ?`).join(', ');
    return this.db.prepare(`UPDATE ${table} SET ${set}${sql}`)
      .run(...keys.map((k) => sqliteValue(patch[k])), ...values).changes || 0;
  }

  delete(table, where) {
    const { sql, values } = this._where(table, where);
    return this.db.prepare(`DELETE FROM ${table}${sql}`).run(...values).changes || 0;
  }

  upsert(table, where, row) {
    if (this.update(table, where, row) === 0 && !this.get(table, where)) this.insert(table, row);
  }

  close() {
    this.db.close();
  }
}

class JSONDriver {
  constructor(file) {
    this.kind = 'json';
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = {};
    for (const table of Object.keys(TABLE_FIELDS)) this.data[table] = [];
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const table of Object.keys(TABLE_FIELDS)) {
          if (Array.isArray(parsed[table])) this.data[table] = parsed[table];
        }
      } catch {
        // Corrupt cache: start empty rather than crashing the server.
      }
    }
    this._save();
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data));
  }

  _match(row, where) {
    return Object.entries(where || {}).every(([k, v]) => row[k] === v
      || (row[columnOf(k)] !== undefined && row[columnOf(k)] === v));
  }

  all(table, where = {}, opts = {}) {
    let rows = this.data[table].filter((row) => this._match(row, where));
    if (opts.limit) rows = rows.slice(0, Number(opts.limit));
    return rows;
  }

  get(table, where) {
    return this.all(table, where, { limit: 1 })[0] || null;
  }

  insert(table, row) {
    this.data[table].push({ ...row });
    this._save();
    return row;
  }

  update(table, where, patch) {
    let changed = 0;
    for (const row of this.data[table]) {
      if (this._match(row, where)) {
        Object.assign(row, patch);
        changed++;
      }
    }
    if (changed) this._save();
    return changed;
  }

  delete(table, where) {
    const before = this.data[table].length;
    this.data[table] = this.data[table].filter((row) => !this._match(row, where));
    if (before !== this.data[table].length) this._save();
    return before - this.data[table].length;
  }

  upsert(table, where, row) {
    if (this.update(table, where, row) === 0 && !this.get(table, where)) this.insert(table, row);
  }

  close() {
    this._save();
  }
}

function optionsOf(dataDir, options) {
  if (dataDir && typeof dataDir === 'object' && !Array.isArray(dataDir)) {
    return { dataDir: dataDir.dataDir || dataDir.dir || './data', options: { ...dataDir, ...options } };
  }
  return { dataDir: dataDir || './data', options: options || {} };
}

export class TwoFAStore {
  constructor(dataDir = './data', options = {}) {
    const resolved = optionsOf(dataDir, options);
    this.dataDir = resolved.dataDir;
    this.driverKind = resolved.options.dbDriver || process.env.DB_DRIVER || 'sqlite';
    const jsonFile = path.join(this.dataDir, 'twofa.json');
    if (this.driverKind === 'json') {
      this.driver = new JSONDriver(jsonFile);
    } else {
      try {
        // process.getBuiltinModule avoids a top-level await; node:sqlite is
        // built into Node >= 22.5 but may be absent in older runtimes.
        const sqlite = process.getBuiltinModule?.('node:sqlite');
        if (!sqlite) throw new Error('node:sqlite unavailable');
        this.driver = new SQLiteDriver(path.join(this.dataDir, 'twofa.sqlite'), sqlite.DatabaseSync);
      } catch {
        this.driverKind = 'json';
        this.driver = new JSONDriver(jsonFile);
      }
    }
  }

  // ---- normalizers -----------------------------------------------------
  _password(row) {
    if (!row) return null;
    return {
      userId: toNumber(row.user_id ?? row.userId),
      salt: fromB64(row.salt ?? row.salt_b64),
      serverSalt: fromB64(row.server_salt ?? row.serverSalt),
      hash2: fromB64(row.hash2),
      g_srp_B: fromB64(row.g_srp_b ?? row.gSrpB ?? row.g_srp_B),
      algorithm: String(row.algorithm ?? ''),
      g: toNumber(row.g, 7) || 7,
      p: fromB64(row.p),
      b: fromB64(row.b),
      srpId: toBigInt(row.srp_id ?? row.srpId ?? 0),
      hint: String(row.hint ?? ''),
      secureRandom: fromB64(row.secure_random ?? row.secureRandom),
      updatedAt: toNumber(row.updated_at ?? row.updatedAt),
    };
  }

  _loginToken(row) {
    if (!row) return null;
    return {
      token: String(row.token ?? ''),
      userId: toNumber(row.user_id ?? row.userId),
      expires: toNumber(row.expires),
      used: Boolean(row.used),
      createdAt: toNumber(row.created_at ?? row.createdAt),
    };
  }

  // ---- 2FA password ----------------------------------------------------
  /** Store (or partially update) the SRP password record for a user. */
  setPassword(userId, patch = {}) {
    const id = toNumber(userId);
    if (!id) return null;
    const o = patch && typeof patch === 'object' ? patch : {};
    const current = this.driver.get('passwords', { userId: id });
    const row = current ? { ...current } : {
      userId: id, salt: '', serverSalt: '', hash2: '', gSrpB: '',
      algorithm: '', g: 7, p: '', b: '', srpId: 0, hint: '', secureRandom: '',
      updatedAt: now(),
    };
    const aliases = {
      salt: ['salt', 'salt1'],
      serverSalt: ['serverSalt', 'server_salt', 'salt2'],
      hash2: ['hash2', 'newPasswordHash', 'new_password_hash'],
      gSrpB: ['g_srp_B', 'gSrpB', 'g_srp_b', 'B', 'b_public'],
      algorithm: ['algorithm', 'algo'],
      g: ['g'],
      p: ['p'],
      b: ['b', 'serverSecret', 'server_secret'],
      srpId: ['srpId', 'srp_id'],
      hint: ['hint'],
      secureRandom: ['secureRandom', 'secure_random'],
    };
    for (const [target, names] of Object.entries(aliases)) {
      const found = names.find((name) => o[name] !== undefined);
      if (found === undefined) continue;
      const v = o[found];
      if (target === 'salt' || target === 'serverSalt' || target === 'hash2'
        || target === 'gSrpB' || target === 'p' || target === 'b' || target === 'secureRandom') {
        row[target] = toB64(v);
      } else if (target === 'g') {
        row.g = toNumber(v, 7) || 7;
      } else if (target === 'srpId') {
        row.srpId = toBigInt(v);
      } else {
        row[target] = String(v ?? '');
      }
    }
    row.userId = id;
    row.updatedAt = now();
    this.driver.upsert('passwords', { userId: id }, row);
    return this._password(this.driver.get('passwords', { userId: id }));
  }

  getPassword(userId) {
    return this._password(this.driver.get('passwords', { userId: toNumber(userId) }));
  }

  clearPassword(userId) {
    return this.driver.delete('passwords', { userId: toNumber(userId) }) > 0;
  }

  // ---- login tokens / codes -------------------------------------------
  createLoginToken(token, userId, expires) {
    const value = String(token || `token:${randomHex(16)}`);
    const seconds = toNumber(expires, 0) || (now() + 300);
    const row = {
      token: value,
      userId: toNumber(userId),
      expires: seconds,
      used: 0,
      createdAt: now(),
    };
    this.driver.upsert('loginTokens', { token: value }, row);
    return this._loginToken(this.driver.get('loginTokens', { token: value }));
  }

  getLoginToken(token) {
    return this._loginToken(this.driver.get('loginTokens', { token: String(token ?? '') }));
  }

  /** Consume a login token once. Returns its userId, or null if invalid. */
  consumeLoginToken(token) {
    const row = this.getLoginToken(token);
    if (!row || row.used || row.expires <= now()) return null;
    this.driver.update('loginTokens', { token: row.token }, { used: 1 });
    return row.userId;
  }

  createLoginCode(token, code) {
    const row = { token: String(token ?? ''), code: String(code ?? ''), createdAt: now() };
    this.driver.upsert('loginCodes', { token: row.token }, row);
    return { ...row };
  }

  /** Codes are intentionally re-checkable (idempotent). */
  checkLoginCode(token, code) {
    const row = this.driver.get('loginCodes', { token: String(token ?? '') });
    return Boolean(row && String(row.code) === String(code ?? ''));
  }

  // ---- authorization export / import ----------------------------------
  exportToken(userId) {
    const id = toNumber(userId);
    if (!id) return '';
    const existing = this.driver.get('exportTokens', { userId: id });
    if (existing?.token) return String(existing.token);
    const token = `login:${randomHex(16)}`;
    this.driver.upsert('exportTokens', { userId: id }, { token, userId: id, createdAt: now() });
    return token;
  }

  /**
   * Bind an imported token to a local user. An existing token keeps its user;
   * passing userId registers a new mapping.
   */
  importToken(token, userId) {
    const value = String(token ?? '');
    if (!value) return null;
    const existing = this.driver.get('exportTokens', { token: value });
    if (existing) return toNumber(existing.user_id ?? existing.userId);
    const id = toNumber(userId);
    if (!id) return null;
    this.driver.upsert('exportTokens', { token: value }, { token: value, userId: id, createdAt: now() });
    return id;
  }

  // ---- passport config -------------------------------------------------
  setPassportConfig(config = {}) {
    const value = config && typeof config === 'object' ? config : {};
    this.driver.upsert('passportConfig', { key: 'default' }, {
      key: 'default', value: JSON.stringify(value),
    });
    return this.getPassportConfig();
  }

  getPassportConfig() {
    const row = this.driver.get('passportConfig', { key: 'default' });
    return row ? parseJSON(row.value, {}) : {};
  }

  close() {
    this.driver.close();
  }
}

export default TwoFAStore;
