// Persistent store for secret chats, kept separate from store.js (which is
// owned by another agent). Uses a dedicated node:sqlite DatabaseSync at
// <dataDir>/secret.sqlite (Node >= 22.5, built in, zero npm dependencies) and
// falls back to <dataDir>/secret.json when node:sqlite is unavailable or when
// { dbDriver: 'json' } is requested.
//
// Every method is synchronous so it can be called directly from a TL handler.
// int64 fields (access_hash, key_fingerprint, random_id) are kept as TEXT in
// SQLite to preserve full precision; binary DH values (g_a/g_b) are base64
// TEXT. On read they are returned as Buffer / Number-or-BigInt as described on
// the individual methods.
//
// NOTE: this store deliberately does NOT perform any secret-chat key exchange,
// nor does it encrypt/decrypt message payloads. It only records the RPC/data
// layer state. See src/rpc/handlers/secret.js for the E2E limitation.

import fs from 'node:fs';
import path from 'node:path';

const TABLE_FIELDS = {
  chats: [
    'id', 'userId', 'otherUserId', 'accessHash', 'keyFingerprint', 'state',
    'qts', 'seq', 'date', 'gA', 'gB', 'randomId',
  ],
  messages: ['id', 'chatId', 'randomId', 'text', 'date', 'read'],
};

const CREATE_SQL = {
  chats: [
    'id INTEGER PRIMARY KEY',
    'user_id INTEGER',
    'other_user_id INTEGER',
    'access_hash TEXT',
    'key_fingerprint TEXT',
    'state TEXT',
    'qts INTEGER',
    'seq INTEGER',
    'date INTEGER',
    'g_a TEXT',
    'g_b TEXT',
    'random_id TEXT',
  ].join(', '),
  messages: [
    'id INTEGER PRIMARY KEY',
    'chat_id INTEGER',
    'random_id TEXT',
    'text TEXT',
    'date INTEGER',
    'read INTEGER',
  ].join(', '),
};

const now = () => Math.floor(Date.now() / 1000);
const columnOf = (field) => String(field).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function toNumber(v, fallback = 0) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Exact decimal string for TL long values. */
function toLongString(v) {
  if (v === undefined || v === null || v === '') return '0';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.trunc(v)) : '0';
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    try { return BigInt.asUintN(64, BigInt(`0x${Buffer.from(v).toString('hex')}`)).toString(); }
    catch { return '0'; }
  }
  const s = String(v).trim();
  return /^-?\d+$/.test(s) ? s : '0';
}

/** Number when exactly representable, BigInt otherwise (TL long fidelity). */
function fromLongString(v) {
  const s = toLongString(v);
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : BigInt(s);
}

function toB64(v) {
  if (v === undefined || v === null) return '';
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  if (typeof v === 'bigint') return toB64(Buffer.from(v.toString(), 'utf8'));
  return Buffer.from(String(v), 'utf8').toString('base64');
}

function fromB64(v) {
  if (v === undefined || v === null || v === '') return Buffer.alloc(0);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'bigint') return Buffer.from(v.toString(), 'utf8');
  return Buffer.from(String(v), 'base64');
}

function sqliteValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  return v;
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

  _where(table, where = {}) {
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
    if (opts.orderBy) {
      const parts = String(opts.orderBy).trim().split(/\s+/);
      const desc = parts[0].startsWith('-');
      const key = columnOf(desc ? parts[0].slice(1) : parts[0]);
      query += ` ORDER BY ${key} ${desc ? 'DESC' : 'ASC'}`;
    }
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

  _match(row, where = {}) {
    return Object.entries(where).every(([k, v]) => row[k] === v
      || (row[columnOf(k)] !== undefined && row[columnOf(k)] === v));
  }

  all(table, where = {}, opts = {}) {
    let rows = this.data[table].filter((row) => this._match(row, where));
    if (opts.orderBy) {
      const parts = String(opts.orderBy).trim().split(/\s+/);
      const desc = parts[0].startsWith('-');
      const key = parts[0].replace(/^-/, '');
      rows = rows.slice().sort((a, b) => {
        const av = a[key] ?? a[columnOf(key)] ?? 0;
        const bv = b[key] ?? b[columnOf(key)] ?? 0;
        if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * (desc ? -1 : 1);
        return (av - bv) * (desc ? -1 : 1);
      });
    }
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
    return {
      dataDir: dataDir.dataDir || dataDir.dir || './data',
      options: { ...dataDir, ...options },
    };
  }
  return { dataDir: dataDir || './data', options: options || {} };
}

export class SecretStore {
  constructor(dataDir = './data', options = {}) {
    const resolved = optionsOf(dataDir, options);
    this.dataDir = resolved.dataDir;
    this.driverKind = resolved.options.dbDriver || process.env.DB_DRIVER || 'sqlite';
    const jsonFile = path.join(this.dataDir, 'secret.json');
    if (this.driverKind === 'json') {
      this.driver = new JSONDriver(jsonFile);
    } else {
      try {
        // process.getBuiltinModule avoids a top-level await; node:sqlite is
        // built into Node >= 22.5 but may be absent in older runtimes.
        const sqlite = process.getBuiltinModule?.('node:sqlite');
        if (!sqlite) throw new Error('node:sqlite unavailable');
        this.driver = new SQLiteDriver(path.join(this.dataDir, 'secret.sqlite'), sqlite.DatabaseSync);
      } catch {
        this.driverKind = 'json';
        this.driver = new JSONDriver(jsonFile);
      }
    }
  }

  // ---- normalizers -----------------------------------------------------
  _chat(row) {
    if (!row) return null;
    return {
      id: toNumber(row.id ?? row.chatId),
      userId: toNumber(row.user_id ?? row.userId),
      otherUserId: toNumber(row.other_user_id ?? row.otherUserId),
      accessHash: fromLongString(row.access_hash ?? row.accessHash ?? 0),
      keyFingerprint: fromLongString(row.key_fingerprint ?? row.keyFingerprint ?? 0),
      state: String(row.state ?? 'requested'),
      qts: toNumber(row.qts),
      seq: toNumber(row.seq),
      date: toNumber(row.date),
      gA: fromB64(row.g_a ?? row.gA),
      gB: fromB64(row.g_b ?? row.gB),
      randomId: fromLongString(row.random_id ?? row.randomId ?? 0),
    };
  }

  _message(row) {
    if (!row) return null;
    return {
      id: toNumber(row.id),
      chatId: toNumber(row.chat_id ?? row.chatId),
      randomId: fromLongString(row.random_id ?? row.randomId ?? 0),
      text: String(row.text ?? ''),
      date: toNumber(row.date),
      read: Number(row.read || 0) ? 1 : 0,
    };
  }

  // ---- chats -----------------------------------------------------------
  /**
   * Create a secret chat. `id` may be supplied explicitly (e.g. when mirroring
   * a client-provided chat_id); otherwise the next local sequential id is used.
   */
  createChat({
    id, userId, otherUserId, accessHash = 0, keyFingerprint = 0,
    state = 'requested', qts = 0, seq = 0, date, gA, gB, randomId = 0,
  } = {}) {
    const nextId = id !== undefined && id !== null
      ? toNumber(id)
      : this.driver.all('chats').reduce((max, r) => Math.max(max, toNumber(r.id ?? r.chat_id ?? r.chatId)), 0) + 1;
    const row = {
      id: nextId,
      userId: toNumber(userId),
      otherUserId: toNumber(otherUserId),
      accessHash: toLongString(accessHash),
      keyFingerprint: toLongString(keyFingerprint),
      state: String(state || 'requested'),
      qts: toNumber(qts),
      seq: toNumber(seq),
      date: toNumber(date) || now(),
      gA: toB64(gA),
      gB: toB64(gB),
      randomId: toLongString(randomId),
    };
    this.driver.insert('chats', row);
    return this._chat(row);
  }

  getChat(chatId) {
    return this._chat(this.driver.get('chats', { id: toNumber(chatId) }));
  }

  /** Chats where the user is either the initiator or the participant. */
  listChats(userId) {
    const uid = toNumber(userId);
    return this.driver.all('chats', {}, { orderBy: 'id' })
      .map((row) => this._chat(row))
      .filter((chat) => chat.userId === uid || chat.otherUserId === uid);
  }

  /** Patch arbitrary chat fields (used by the acceptEncryption handler). */
  updateChat(chatId, patch = {}) {
    const normalized = {};
    const p = patch && typeof patch === 'object' ? patch : {};
    if (p.userId !== undefined) normalized.userId = toNumber(p.userId);
    if (p.otherUserId !== undefined) normalized.otherUserId = toNumber(p.otherUserId);
    if (p.accessHash !== undefined) normalized.accessHash = toLongString(p.accessHash);
    if (p.keyFingerprint !== undefined) normalized.keyFingerprint = toLongString(p.keyFingerprint);
    if (p.state !== undefined) normalized.state = String(p.state);
    if (p.qts !== undefined) normalized.qts = toNumber(p.qts);
    if (p.seq !== undefined) normalized.seq = toNumber(p.seq);
    if (p.date !== undefined) normalized.date = toNumber(p.date);
    if (p.randomId !== undefined) normalized.randomId = toLongString(p.randomId);
    if (p.gA !== undefined) normalized.gA = toB64(p.gA);
    if (p.gB !== undefined) normalized.gB = toB64(p.gB);
    this.driver.update('chats', { id: toNumber(chatId) }, normalized);
    return this.getChat(chatId);
  }

  acceptChat(chatId) {
    this.driver.update('chats', { id: toNumber(chatId) }, { state: 'accepted' });
    return this.getChat(chatId);
  }

  discardChat(chatId) {
    this.driver.update('chats', { id: toNumber(chatId) }, { state: 'discarded' });
    return this.getChat(chatId);
  }

  // ---- messages --------------------------------------------------------
  putMessage({ chatId, randomId = 0, text = '', date } = {}) {
    const nextId = this.driver.all('messages')
      .reduce((max, r) => Math.max(max, toNumber(r.id)), 0) + 1;
    const row = {
      id: nextId,
      chatId: toNumber(chatId),
      randomId: toLongString(randomId),
      text: String(text ?? ''),
      date: toNumber(date) || now(),
      read: 0,
    };
    this.driver.insert('messages', row);
    return this._message(row);
  }

  listMessages(chatId) {
    return this.driver.all('messages', { chatId: toNumber(chatId) }, { orderBy: 'id' })
      .map((row) => this._message(row));
  }

  markRead(chatId, maxId = 0) {
    let changed = 0;
    for (const row of this.driver.all('messages', { chatId: toNumber(chatId) })) {
      if (toNumber(row.id) <= toNumber(maxId) && !Number(row.read || 0)) {
        this.driver.update('messages', { id: toNumber(row.id) }, { read: 1 });
        changed++;
      }
    }
    return changed;
  }

  clearMessages(chatId) {
    return this.driver.delete('messages', { chatId: toNumber(chatId) });
  }

  // ---- state -----------------------------------------------------------
  /**
   * Update the per-chat state. `state` may be a string ('requested',
   * 'accepted', 'discarded', ...) or an object with state/qts/seq/date keys.
   * qts and seq can also be passed positionally.
   */
  updateState(chatId, state, qts, seq) {
    const patch = {};
    if (state !== undefined && state !== null) {
      if (typeof state === 'object') {
        if (state.state !== undefined) patch.state = String(state.state);
        if (state.qts !== undefined) patch.qts = toNumber(state.qts);
        if (state.seq !== undefined) patch.seq = toNumber(state.seq);
        if (state.date !== undefined) patch.date = toNumber(state.date);
      } else {
        patch.state = String(state);
      }
    }
    if (qts !== undefined && qts !== null) patch.qts = toNumber(qts);
    if (seq !== undefined && seq !== null) patch.seq = toNumber(seq);
    this.driver.update('chats', { id: toNumber(chatId) }, patch);
    return this.getState(chatId);
  }

  getState(chatId) {
    const chat = this.getChat(chatId);
    if (!chat) return null;
    const messages = this.listMessages(chatId);
    const unread = messages.filter((m) => !m.read).length;
    return {
      chatId: chat.id,
      state: chat.state,
      qts: chat.qts,
      seq: chat.seq,
      date: chat.date,
      unreadCount: unread,
      unread_count: unread,
      maxId: messages.length ? messages[messages.length - 1].id : 0,
    };
  }

  close() {
    this.driver.close();
  }
}

export default SecretStore;
