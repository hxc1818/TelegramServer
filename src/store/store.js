// Persistent store for users, auth codes, sessions, dialogs, messages, media and contacts.
// Uses node:sqlite when available (built into Node 22) with a JSON-file fallback.
// All methods are synchronous; the server is single-threaded.
import fs from 'node:fs';
import path from 'node:path';

const TABLES = {
  users: {
    columns: { id: 'INTEGER PRIMARY KEY', phone: 'TEXT UNIQUE', firstName: 'TEXT', lastName: 'TEXT', accessHash: 'INTEGER', createdAt: 'INTEGER' },
    fields: ['id', 'phone', 'firstName', 'lastName', 'accessHash', 'createdAt'],
  },
  authCodes: {
    table: 'auth_codes',
    columns: { phone: 'TEXT PRIMARY KEY', codeHash: 'TEXT', code: 'TEXT', expires: 'INTEGER', used: 'INTEGER' },
    fields: ['phone', 'codeHash', 'code', 'expires', 'used'],
  },
  sessions: {
    columns: { authKeyId: 'TEXT PRIMARY KEY', userId: 'INTEGER', serverSalt: 'TEXT', sessionId: 'TEXT', pts: 'INTEGER', qts: 'INTEGER', seq: 'INTEGER', lastDate: 'INTEGER' },
    fields: ['authKeyId', 'userId', 'serverSalt', 'sessionId', 'pts', 'qts', 'seq', 'lastDate'],
  },
  dialogs: {
    table: 'dialogs',
    columns: { userId: 'INTEGER', peerType: 'TEXT', peerId: 'INTEGER', pinned: 'INTEGER', unreadCount: 'INTEGER', date: 'INTEGER', topMessage: 'INTEGER', readInboxMaxId: 'INTEGER' },
    fields: ['userId', 'peerType', 'peerId', 'pinned', 'unreadCount', 'date', 'topMessage', 'readInboxMaxId'],
    extra: 'PRIMARY KEY (user_id, peer_type, peer_id)',
  },
  messages: {
    columns: { id: 'INTEGER PRIMARY KEY', fromId: 'INTEGER', peerType: 'TEXT', peerId: 'INTEGER', text: 'TEXT', randomId: 'INTEGER', date: 'INTEGER', out: 'INTEGER', read: 'INTEGER' },
    fields: ['id', 'fromId', 'peerType', 'peerId', 'text', 'randomId', 'date', 'out', 'read'],
  },
  media: {
    columns: { id: 'INTEGER PRIMARY KEY', partHash: 'TEXT', size: 'INTEGER', parts: 'BLOB' },
    fields: ['id', 'partHash', 'size', 'parts'],
  },
  contacts: {
    columns: { userId: 'INTEGER', phone: 'TEXT', peerId: 'INTEGER' },
    fields: ['userId', 'phone', 'peerId'],
    extra: 'PRIMARY KEY (user_id, phone, peer_id)',
  },
};

function tableName(name) {
  return TABLES[name].table || name;
}

function columnOf(name, key) {
  const col = TABLES[name].columns[key];
  if (!col) throw new Error(`Store: unknown field "${key}" on ${name}`);
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function toSqlValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v.toString();
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function normalizeWhere(name, where = {}) {
  const out = {};
  for (const [k, v] of Object.entries(where)) out[columnOf(name, k)] = toSqlValue(v);
  return out;
}

class SQLiteDriver {
  constructor(file) {
    this.kind = 'sqlite';
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // node:sqlite is built into Node >=22.5. Importing it is attempted by the caller.
    this.DatabaseSync = arguments[1];
    this.db = new this.DatabaseSync(file);
    for (const [name, def] of Object.entries(TABLES)) {
      const cols = Object.entries(def.columns).map(([key, type]) => `${columnOf(name, key)} ${type}`);
      if (def.extra) cols.push(def.extra);
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${tableName(name)} (${cols.join(', ')})`);
    }
  }

  _whereSql(name, where) {
    const norm = normalizeWhere(name, where);
    const keys = Object.keys(norm);
    return {
      sql: keys.length ? ` WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}` : '',
      values: keys.map((k) => norm[k]),
    };
  }

  all(name, where = {}, opts = {}) {
    const { sql, values } = this._whereSql(name, where);
    let query = `SELECT * FROM ${tableName(name)}${sql}`;
    if (opts.orderBy) {
      const parts = String(opts.orderBy).trim().split(/\s+/);
      const desc = parts[0].startsWith('-');
      const key = desc ? parts[0].slice(1) : parts[0];
      query += ` ORDER BY ${columnOf(name, key)} ${desc ? 'DESC' : 'ASC'}${parts[1] ? ` ${parts[1]}` : ''}`;
    }
    const params = [...values];
    if (opts.limit) {
      query += ' LIMIT ?';
      params.push(Number(opts.limit));
    }
    return this.db.prepare(query).all(...params);
  }

  get(name, where) {
    return this.all(name, where, { limit: 1 })[0] || null;
  }

  insert(name, row) {
    const def = TABLES[name];
    const keys = def.fields.filter((k) => row[k] !== undefined);
    const cols = keys.map((k) => columnOf(name, k));
    const sql = `INSERT INTO ${tableName(name)} (${cols.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    this.db.prepare(sql).run(...keys.map((k) => toSqlValue(row[k])));
    return row;
  }

  update(name, where, patch) {
    const keys = Object.keys(patch).filter((k) => TABLES[name].fields.includes(k));
    if (!keys.length) return 0;
    const { sql, values } = this._whereSql(name, where);
    const set = keys.map((k) => `${columnOf(name, k)} = ?`).join(', ');
    const stmt = this.db.prepare(`UPDATE ${tableName(name)} SET ${set}${sql}`);
    const info = stmt.run(...keys.map((k) => toSqlValue(patch[k])), ...values);
    return info.changes || 0;
  }

  delete(name, where) {
    const { sql, values } = this._whereSql(name, where);
    return this.db.prepare(`DELETE FROM ${tableName(name)}${sql}`).run(...values).changes || 0;
  }

  upsert(name, where, row) {
    const changed = this.update(name, where, row);
    if (changed === 0 && !this.get(name, where)) this.insert(name, row);
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
    for (const name of Object.keys(TABLES)) this.data[name] = [];
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const name of Object.keys(TABLES)) if (Array.isArray(parsed[name])) this.data[name] = parsed[name];
      } catch {
        // Corrupt cache: start empty rather than crashing the server.
      }
    }
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data));
  }

  _match(row, where) {
    return Object.entries(where).every(([k, v]) => row[k] === v);
  }

  all(name, where = {}, opts = {}) {
    let rows = this.data[name].filter((row) => this._match(row, where));
    if (opts.orderBy) {
      const parts = String(opts.orderBy).trim().split(/\s+/);
      const desc = parts[0].startsWith('-');
      const key = desc ? parts[0].slice(1) : parts[0];
      rows = rows.slice().sort((a, b) => {
        const av = a[key] ?? 0;
        const bv = b[key] ?? 0;
        if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * (desc ? -1 : 1);
        return (av - bv) * (desc ? -1 : 1);
      });
    }
    if (opts.limit) rows = rows.slice(0, Number(opts.limit));
    return rows;
  }

  get(name, where) {
    return this.all(name, where, { limit: 1 })[0] || null;
  }

  insert(name, row) {
    this.data[name].push({ ...row });
    this._save();
    return row;
  }

  update(name, where, patch) {
    let changed = 0;
    for (const row of this.data[name]) {
      if (this._match(row, where)) {
        Object.assign(row, patch);
        changed++;
      }
    }
    if (changed) this._save();
    return changed;
  }

  delete(name, where) {
    const before = this.data[name].length;
    this.data[name] = this.data[name].filter((row) => !this._match(row, where));
    if (before !== this.data[name].length) this._save();
    return before - this.data[name].length;
  }

  upsert(name, where, row) {
    if (this.update(name, where, row) === 0 && !this.get(name, where)) this.insert(name, row);
  }

  close() {
    this._save();
  }
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function randomInt(max = 0x7fffffff) {
  return Math.floor(Math.random() * max) + 1;
}

function keyIdHex(value) {
  if (value === undefined || value === null) return '';
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (typeof value === 'bigint') {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
    return b.toString('hex');
  }
  return String(value);
}

function peerFrom(peer, peerType) {
  if (peer && typeof peer === 'object') {
    const type = peer.type || peer.peerType || peerType || 'user';
    return { peerType: String(type), peerId: Number(peer.id ?? peer.peerId ?? 0) || 0 };
  }
  return { peerType: peerType || 'user', peerId: Number(peer) || 0 };
}

export class Store {
  constructor(dataDir = './data', options = {}) {
    if (dataDir && typeof dataDir === 'object') {
      options = dataDir;
      dataDir = options.dataDir || './data';
    }
    this.dataDir = dataDir;
    this.driverKind = options.dbDriver || process.env.DB_DRIVER || 'sqlite';
    const file = path.join(dataDir, this.driverKind === 'json' ? 'store.json' : 'store.sqlite');
    if (this.driverKind === 'json') {
      this.driver = new JSONDriver(file);
    } else {
      try {
        const sqlite = globalThis.__nodeSqlite || (awaitImportNodeSqlite());
        this.driver = new SQLiteDriver(file, sqlite.DatabaseSync);
      } catch {
        this.driver = new JSONDriver(path.join(dataDir, 'store.json'));
      }
    }
    this._pts = new Map();
  }

  // ---- users -----------------------------------------------------------
  _user(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      phone: row.phone,
      firstName: row.first_name ?? row.firstName ?? '',
      lastName: row.last_name ?? row.lastName ?? '',
      accessHash: Number(row.access_hash ?? row.accessHash ?? 0),
      createdAt: Number(row.created_at ?? row.createdAt ?? 0),
    };
  }

  createUser({ phone, firstName = '', lastName = '', accessHash } = {}) {
    const rows = this.driver.all('users');
    const id = rows.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1;
    const row = {
      id,
      phone: String(phone),
      firstName: String(firstName || ''),
      lastName: String(lastName || ''),
      accessHash: accessHash === undefined ? randomInt() : Number(accessHash),
      createdAt: now(),
    };
    this.driver.insert('users', row);
    return this._user(row);
  }

  getUser(id) {
    return this._user(this.driver.get('users', { id: Number(id) }));
  }

  getUserByPhone(phone) {
    return this._user(this.driver.get('users', { phone: String(phone) }));
  }

  // ---- auth codes ------------------------------------------------------
  createCode(phone, code, hash) {
    const codeHash = String(hash || cryptoRandomHex(16));
    this.driver.upsert('authCodes', { phone: String(phone) }, {
      phone: String(phone),
      codeHash,
      code: String(code),
      expires: now() + 300,
      used: 0,
    });
    return codeHash;
  }

  checkCode(phone, hash, code) {
    const row = this.driver.get('authCodes', { phone: String(phone) });
    if (!row) return false;
    const rh = row.code_hash ?? row.codeHash;
    const valid = String(rh) === String(hash)
      && String(row.code) === String(code)
      && Number(row.used || 0) === 0
      && Number(row.expires || 0) > now();
    if (valid) this.driver.update('authCodes', { phone: String(phone) }, { used: 1 });
    return valid;
  }

  // ---- sessions --------------------------------------------------------
  _session(row) {
    if (!row) return null;
    const saltHex = row.server_salt ?? row.serverSalt ?? '';
    const sessionHex = row.session_id ?? row.sessionId ?? '';
    return {
      authKeyId: row.auth_key_id ?? row.authKeyId ?? '',
      userId: Number(row.user_id ?? row.userId ?? 0),
      serverSalt: Buffer.from(saltHex, 'hex'),
      sessionId: Buffer.from(sessionHex, 'hex'),
      server_salt: saltHex,
      session_id: sessionHex,
      pts: Number(row.pts || 0),
      qts: Number(row.qts || 0),
      seq: Number(row.seq || 0),
      lastDate: Number(row.last_date ?? row.lastDate ?? 0),
    };
  }

  createSession(userId, authKeyId) {
    const id = keyIdHex(authKeyId);
    const row = {
      authKeyId: id,
      userId: Number(userId),
      serverSalt: cryptoRandomHex(8),
      sessionId: cryptoRandomHex(8),
      pts: 0,
      qts: 0,
      seq: 0,
      lastDate: now(),
    };
    this.driver.upsert('sessions', { authKeyId: id }, row);
    return this._session(this.driver.get('sessions', { authKeyId: id }));
  }

  getSession(authKeyId) {
    return this._session(this.driver.get('sessions', { authKeyId: keyIdHex(authKeyId) }));
  }

  updateSession(authKeyId, patch) {
    const normalized = {};
    for (const [k, v] of Object.entries(patch)) {
      if (['serverSalt', 'sessionId', 'pts', 'qts', 'seq', 'lastDate', 'userId'].includes(k)) normalized[k] = v;
    }
    this.driver.update('sessions', { authKeyId: keyIdHex(authKeyId) }, normalized);
    return this.getSession(authKeyId);
  }

  listSessions(userId) {
    return this.driver.all('sessions', { userId: Number(userId) }).map((r) => this._session(r));
  }

  // ---- dialogs ---------------------------------------------------------
  _dialog(row) {
    if (!row) return null;
    return {
      userId: Number(row.user_id ?? row.userId ?? 0),
      peerType: row.peer_type ?? row.peerType ?? 'user',
      peerId: Number(row.peer_id ?? row.peerId ?? 0),
      pinned: Number(row.pinned || 0),
      unreadCount: Number(row.unread_count ?? row.unreadCount ?? 0),
      date: Number(row.date || 0),
      topMessage: Number(row.top_message ?? row.topMessage ?? 0),
      readInboxMaxId: Number(row.read_inbox_max_id ?? row.readInboxMaxId ?? 0),
    };
  }

  _dialogWhere(userId, peerType, peerId) {
    return { userId: Number(userId), peerType: String(peerType), peerId: Number(peerId) };
  }

  createDialog(userId, peer, peerType) {
    const { peerType: type, peerId } = peerFrom(peer, peerType);
    const where = this._dialogWhere(userId, type, peerId);
    const existing = this.driver.get('dialogs', where);
    const row = existing || { ...where, pinned: 0, unreadCount: 0, date: now(), topMessage: 0, readInboxMaxId: 0 };
    this.driver.upsert('dialogs', where, row);
    return this._dialog(this.driver.get('dialogs', where));
  }

  listDialogs(userId) {
    return this.driver.all('dialogs', { userId: Number(userId) }, { orderBy: '-date' }).map((r) => this._dialog(r));
  }

  // ---- messages --------------------------------------------------------
  _message(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      fromId: Number(row.from_id ?? row.fromId ?? 0),
      peerType: row.peer_type ?? row.peerType ?? 'user',
      peerId: Number(row.peer_id ?? row.peerId ?? 0),
      text: row.text ?? '',
      randomId: Number(row.random_id ?? row.randomId ?? 0),
      date: Number(row.date || 0),
      out: Number(row.out || 0),
      read: Number(row.read || 0),
    };
  }

  putMessage({ fromId = 0, peerType = 'user', peerId = 0, text = '', randomId = 0, out = 0 } = {}) {
    const rows = this.driver.all('messages');
    const id = rows.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1;
    const row = {
      id,
      fromId: Number(fromId),
      peerType: String(peerType),
      peerId: Number(peerId),
      text: String(text),
      randomId: Number(randomId),
      date: now(),
      out: out ? 1 : 0,
      read: 0,
    };
    this.driver.insert('messages', row);

    // Keep the corresponding dialog up to date.
    const where = this._dialogWhere(fromId || 1, row.peerType, row.peerId);
    const dialog = this.driver.get('dialogs', where) || { ...where, pinned: 0, unreadCount: 0, date: 0, topMessage: 0, readInboxMaxId: 0 };
    this.driver.upsert('dialogs', where, {
      ...dialog,
      date: row.date,
      topMessage: id,
      unreadCount: out ? Number(dialog.unread_count ?? dialog.unreadCount ?? 0) : Number(dialog.unread_count ?? dialog.unreadCount ?? 0) + 1,
    });
    return this._message(row);
  }

  listMessages(peerType, peerId, limit = 20) {
    return this.driver.all('messages', { peerType: String(peerType), peerId: Number(peerId) }, { orderBy: '-id', limit: Number(limit) || 20 })
      .map((r) => this._message(r));
  }

  getMessage(id) {
    return this._message(this.driver.get('messages', { id: Number(id) }));
  }

  markRead(peerType, peerId, maxId = 0) {
    let changed = 0;
    for (const row of this.driver.all('messages', { peerType: String(peerType), peerId: Number(peerId) })) {
      if (Number(row.id) <= Number(maxId) && Number(row.read || 0) === 0) {
        this.driver.update('messages', { id: Number(row.id) }, { read: 1 });
        changed++;
      }
    }
    const dialogs = this.driver.all('dialogs', { peerType: String(peerType), peerId: Number(peerId) });
    for (const d of dialogs) {
      this.driver.update('dialogs', { userId: d.user_id ?? d.userId, peerType: String(peerType), peerId: Number(peerId) }, {
        unreadCount: 0,
        readInboxMaxId: Number(maxId),
      });
    }
    return changed;
  }

  // ---- pts / state -----------------------------------------------------
  nextPts(userId, authKeyId) {
    const current = this._pts.has(Number(userId)) ? this._pts.get(Number(userId)) : this.getState(userId).pts;
    const pts = Number(current) + 1;
    this._pts.set(Number(userId), pts);
    const where = authKeyId ? { authKeyId: keyIdHex(authKeyId) } : { userId: Number(userId) };
    for (const s of this.driver.all('sessions', where)) {
      this.driver.update('sessions', { authKeyId: s.auth_key_id ?? s.authKeyId }, { pts, lastDate: now() });
    }
    return pts;
  }

  getState(userId) {
    const session = this.driver.get('sessions', { userId: Number(userId) });
    let unread = 0;
    for (const d of this.driver.all('dialogs', { userId: Number(userId) })) unread += Number(d.unread_count ?? d.unreadCount ?? 0);
    return {
      pts: this._pts.has(Number(userId)) ? this._pts.get(Number(userId)) : Number(session?.pts || 0),
      qts: Number(session?.qts || 0),
      date: Number(session?.last_date ?? session?.lastDate ?? now()),
      seq: Number(session?.seq || 0),
      unread_count: unread,
      unreadCount: unread,
    };
  }

  // ---- media (upload.saveFilePart / upload.getFile) --------------------
  _mediaRow(fileId) {
    return this.driver.get('media', { id: Number(fileId) || 0 });
  }

  _decodeParts(row) {
    if (!row) return {};
    const raw = row.parts;
    // node:sqlite returns BLOB columns as Uint8Array, not Buffer.
    if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
      try { return JSON.parse(Buffer.from(raw).toString('utf8')); } catch { return {}; }
    }
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return {}; }
    }
    return raw && typeof raw === 'object' ? raw : {};
  }

  saveMediaPart(fileId, part, bytes) {
    const id = Number(fileId) || 0;
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
    const row = this._mediaRow(id) || { id, partHash: keyIdHex(fileId).slice(0, 32), size: 0, parts: Buffer.from('{}') };
    const parts = this._decodeParts(row);
    parts[String(part)] = buf.toString('base64');
    const size = Object.values(parts).reduce((sum, b64) => sum + Buffer.from(b64, 'base64').length, 0);
    this.driver.upsert('media', { id }, { ...row, parts: Buffer.from(JSON.stringify(parts)), size });
    return true;
  }

  getMedia(fileId) {
    const row = this._mediaRow(fileId);
    if (!row) return null;
    const parts = this._decodeParts(row);
    const buf = Object.keys(parts).sort((a, b) => Number(a) - Number(b))
      .map((k) => Buffer.from(parts[k], 'base64'));
    return {
      id: Number(row.id),
      partHash: row.part_hash ?? row.partHash ?? '',
      size: Number(row.size || 0),
      data: Buffer.concat(buf),
      parts: Object.keys(parts).map(Number),
    };
  }

  getMediaPart(fileId, part) {
    const row = this._mediaRow(fileId);
    if (!row) return null;
    const value = this._decodeParts(row)[String(part)];
    return value === undefined ? null : Buffer.from(value, 'base64');
  }

  listMedia(fileId) {
    const row = this._mediaRow(fileId);
    return row ? this._decodeParts(row) : null;
  }

  // ---- contacts --------------------------------------------------------
  addContact(userId, phone, peerId) {
    const row = { userId: Number(userId), phone: String(phone), peerId: Number(peerId) };
    this.driver.upsert('contacts', row, row);
    return row;
  }

  listContacts(userId) {
    return this.driver.all('contacts', { userId: Number(userId) }).map((r) => ({
      userId: Number(r.user_id ?? r.userId),
      phone: r.phone,
      peerId: Number(r.peer_id ?? r.peerId),
    }));
  }

  close() {
    this.driver.close();
  }
}

// A tiny sync import shim: node:sqlite is a built-in module but only available
// on Node >=22.5. Keeping it here avoids a top-level await in the module.
function awaitImportNodeSqlite() {
  // eslint-disable-next-line no-undef
  const mod = process.getBuiltinModule?.('node:sqlite');
  if (mod) return mod;
  throw new Error('node:sqlite is unavailable');
}

function cryptoRandomHex(bytes) {
  // Avoid importing node:crypto twice; generate deterministic-quality random ids.
  const buf = new Uint8Array(bytes);
  // Math.random is sufficient for salts/session ids in this local server.
  for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  return Buffer.from(buf).toString('hex');
}

export default Store;
