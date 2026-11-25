// Account-specific storage, deliberately kept separate from store.js.
//
// Uses a dedicated node:sqlite DatabaseSync at <dataDir>/account.sqlite (Node
// >= 22.5, no npm dependencies). Falls back to <dataDir>/account.json when
// node:sqlite is unavailable, mirroring the main Store / GroupStore pattern.
// Every method is synchronous so it can be called straight from a TL handler.

import fs from 'node:fs';
import path from 'node:path';

const TABLE_FIELDS = {
  profiles: ['userId', 'firstName', 'lastName', 'about', 'username', 'online', 'updatedAt'],
  contacts: ['userId', 'phone', 'peerId', 'firstName', 'lastName'],
  notify: ['peerKey', 'settings'],
  blocked: ['userId', 'peerKey', 'peerType', 'peerId', 'date'],
  privacy: ['key', 'rules'],
  tokens: ['token', 'userId', 'dcId', 'issuedAt'],
};

const CREATE_SQL = {
  profiles: 'user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, about TEXT, username TEXT, online INTEGER, updated_at INTEGER',
  contacts: 'user_id INTEGER, phone TEXT, peer_id INTEGER, first_name TEXT, last_name TEXT, PRIMARY KEY (user_id, phone)',
  notify: 'peer_key TEXT PRIMARY KEY, settings TEXT',
  blocked: 'user_id INTEGER, peer_key TEXT, peer_type TEXT, peer_id INTEGER, date INTEGER, PRIMARY KEY (user_id, peer_key)',
  privacy: 'key TEXT PRIMARY KEY, rules TEXT',
  tokens: 'token TEXT PRIMARY KEY, user_id INTEGER, dc_id INTEGER, issued_at INTEGER',
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
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v.toString();
  }
  return v;
}

function randomHex(bytes) {
  const crypto = process.getBuiltinModule?.('node:crypto');
  if (crypto?.randomBytes) return crypto.randomBytes(bytes).toString('hex');
  const buf = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  return Buffer.from(buf).toString('hex');
}

function normalizeUsername(value) {
  return String(value ?? '').trim().replace(/^@+/, '').toLowerCase();
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

export class AccountStore {
  constructor(dataDir = './data', options = {}) {
    const resolved = optionsOf(dataDir, options);
    this.dataDir = resolved.dataDir;
    this.driverKind = resolved.options.dbDriver || process.env.DB_DRIVER || 'sqlite';
    const jsonFile = path.join(this.dataDir, 'account.json');
    if (this.driverKind === 'json') {
      this.driver = new JSONDriver(jsonFile);
    } else {
      try {
        // process.getBuiltinModule avoids a top-level await; node:sqlite is
        // built into Node >= 22.5 but may be absent in older runtimes.
        const sqlite = process.getBuiltinModule?.('node:sqlite');
        if (!sqlite) throw new Error('node:sqlite unavailable');
        this.driver = new SQLiteDriver(path.join(this.dataDir, 'account.sqlite'), sqlite.DatabaseSync);
      } catch {
        this.driverKind = 'json';
        this.driver = new JSONDriver(jsonFile);
      }
    }
  }

  // ---- normalizers -----------------------------------------------------
  _profile(row) {
    if (!row) return { userId: 0, firstName: '', lastName: '', about: '', username: '', online: false };
    return {
      userId: toNumber(row.user_id ?? row.userId),
      firstName: String(row.first_name ?? row.firstName ?? ''),
      lastName: String(row.last_name ?? row.lastName ?? ''),
      about: String(row.about ?? ''),
      username: String(row.username ?? ''),
      online: Boolean(row.online),
    };
  }

  _contact(row) {
    return {
      userId: toNumber(row.user_id ?? row.userId),
      phone: String(row.phone ?? ''),
      peerId: toNumber(row.peer_id ?? row.peerId),
      firstName: String(row.first_name ?? row.firstName ?? ''),
      lastName: String(row.last_name ?? row.lastName ?? ''),
    };
  }

  _blocked(row) {
    return {
      userId: toNumber(row.user_id ?? row.userId),
      peerKey: String(row.peer_key ?? row.peerKey ?? ''),
      peerType: String(row.peer_type ?? row.peerType ?? 'user'),
      peerId: toNumber(row.peer_id ?? row.peerId),
      date: toNumber(row.date),
    };
  }

  peerInfoOf(peer) {
    if (peer && typeof peer === 'object') {
      const type = String(peer.type || peer.peerType || 'user');
      const id = toNumber(peer.id ?? peer.peerId ?? peer.user_id ?? peer.userId);
      return { type, id, key: `${type}:${id}` };
    }
    const value = String(peer ?? '');
    if (value.includes(':')) {
      const [type, id] = value.split(':', 2);
      return { type: type || 'user', id: toNumber(id), key: value };
    }
    const id = toNumber(value);
    return { type: 'user', id, key: `user:${id}` };
  }

  // ---- profile ---------------------------------------------------------
  setProfile(userId, patch = {}) {
    const id = toNumber(userId);
    if (!id) return this._profile(null);
    const o = patch && typeof patch === 'object' ? patch : {};
    const row = this.driver.get('profiles', { userId: id }) || {
      userId: id, firstName: '', lastName: '', about: '', username: '', online: 0, updatedAt: now(),
    };
    for (const key of ['firstName', 'lastName', 'about', 'username']) {
      const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      const value = o[key] !== undefined ? o[key] : o[snake];
      if (value !== undefined) row[key] = String(value ?? '');
    }
    if (row.username) {
      row.username = normalizeUsername(row.username);
      // Telegram usernames are unique: release the name from any other account.
      const owners = this.driver.all('profiles', { username: row.username });
      for (const owner of owners) {
        if (toNumber(owner.user_id ?? owner.userId) !== id) {
          this.driver.update('profiles', { userId: toNumber(owner.user_id ?? owner.userId) }, { username: '' });
        }
      }
    }
    row.updatedAt = now();
    this.driver.upsert('profiles', { userId: id }, row);
    return this._profile(this.driver.get('profiles', { userId: id }));
  }

  getProfile(userId) {
    return this._profile(this.driver.get('profiles', { userId: toNumber(userId) }));
  }

  setUsername(userId, username) {
    return this.setProfile(userId, { username: normalizeUsername(username) });
  }

  resolveUsername(username) {
    const name = normalizeUsername(username);
    if (!name) return null;
    const row = this.driver.get('profiles', { username: name })
      || this.driver.all('profiles').find((r) => normalizeUsername(r.username ?? r.user_name) === name);
    return row ? this._profile(row) : null;
  }

  setStatus(userId, online) {
    const id = toNumber(userId);
    if (!id) return this._profile(null);
    const row = this.driver.get('profiles', { userId: id }) || this._profile(null);
    this.driver.upsert('profiles', { userId: id }, { ...row, userId: id, online: Boolean(online), updatedAt: now() });
    return this._profile(this.driver.get('profiles', { userId: id }));
  }

  // ---- contacts --------------------------------------------------------
  addContact(userId, input, legacyPeerId) {
    const o = input && typeof input === 'object' && !Array.isArray(input) ? input : { phone: String(input ?? '') };
    const phone = String(o.phone ?? o.phone_number ?? o.phoneNumber ?? '');
    const peerId = toNumber(o.peerId ?? o.peer_id ?? o.userId ?? o.user_id ?? legacyPeerId);
    const row = {
      userId: toNumber(userId),
      phone,
      peerId,
      firstName: String(o.firstName ?? o.first_name ?? ''),
      lastName: String(o.lastName ?? o.last_name ?? ''),
    };
    this.driver.upsert('contacts', { userId: row.userId, phone }, row);
    return this._contact(this.driver.get('contacts', { userId: row.userId, phone }) || row);
  }

  removeContact(userId, phone) {
    return this.driver.delete('contacts', { userId: toNumber(userId), phone: String(phone) }) > 0;
  }

  listContacts(userId) {
    return this.driver.all('contacts', { userId: toNumber(userId) }).map((r) => this._contact(r));
  }

  // ---- notify settings -------------------------------------------------
  setNotifySettings(peerKey, settings = {}) {
    const key = String(peerKey);
    this.driver.upsert('notify', { peerKey: key }, { peerKey: key, settings: JSON.stringify(settings || {}) });
    return this.getNotifySettings(key);
  }

  getNotifySettings(peerKey) {
    const row = this.driver.get('notify', { peerKey: String(peerKey) });
    return row ? parseJSON(row.settings ?? row.settings_json, {}) : null;
  }

  // ---- blocked peers ---------------------------------------------------
  block(userId, peer) {
    const info = this.peerInfoOf(peer);
    if (!info.key) return false;
    this.driver.upsert('blocked', { userId: toNumber(userId), peerKey: info.key }, {
      userId: toNumber(userId), peerKey: info.key, peerType: info.type, peerId: info.id, date: now(),
    });
    return true;
  }

  unblock(userId, peer) {
    const info = this.peerInfoOf(peer);
    return this.driver.delete('blocked', { userId: toNumber(userId), peerKey: info.key }) > 0;
  }

  listBlocked(userId) {
    return this.driver.all('blocked', { userId: toNumber(userId) }).map((r) => this._blocked(r));
  }

  // ---- privacy ---------------------------------------------------------
  setPrivacy(key, rules) {
    const name = String(key);
    const list = Array.isArray(rules) ? rules : [];
    this.driver.upsert('privacy', { key: name }, { key: name, rules: JSON.stringify(list) });
    return this.getPrivacy(name);
  }

  getPrivacy(key) {
    const row = this.driver.get('privacy', { key: String(key) });
    return row ? parseJSON(row.rules, []) : null;
  }

  // ---- authorization tokens (simple token -> user map) ----------------
  exportAuthorization(userId, dcId = 1) {
    const id = toNumber(userId);
    if (!id) return '';
    const existing = this.driver.get('tokens', { userId: id });
    if (existing?.token) return String(existing.token);
    const token = `auth:${randomHex(16)}`;
    this.driver.upsert('tokens', { userId: id }, { token, userId: id, dcId: toNumber(dcId), issuedAt: now() });
    return token;
  }

  importAuthorization(token) {
    const row = this.driver.get('tokens', { token: String(token ?? '') });
    return row ? toNumber(row.user_id ?? row.userId) : null;
  }

  close() {
    this.driver.close();
  }
}

export default AccountStore;
