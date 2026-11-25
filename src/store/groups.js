// Group/channel storage, deliberately kept separate from store.js.
//
// Uses a dedicated node:sqlite DatabaseSync at <dataDir>/groups.sqlite (Node >=
// 22.5, no npm dependencies). Falls back to a JSON file when node:sqlite is not
// available, mirroring the main Store's fallback behaviour. Every method is
// synchronous so it can be called straight from a TL handler.

import fs from 'node:fs';
import path from 'node:path';

const TABLE_FIELDS = {
  chats: ['id', 'title', 'creatorId', 'date', 'members', 'megagroup', 'about', 'version'],
  channels: ['id', 'title', 'creatorId', 'date', 'broadcast', 'megagroup', 'about', 'accessHash', 'version'],
  chat_members: ['chatId', 'userId'],
  messages: ['id', 'peerType', 'peerId', 'fromId', 'text', 'randomId', 'date', 'out'],
  state: ['key', 'value'],
};

const CREATE_SQL = {
  chats: 'id INTEGER PRIMARY KEY, title TEXT, creator_id INTEGER, date INTEGER, members TEXT, megagroup INTEGER, about TEXT, version INTEGER',
  channels: 'id INTEGER PRIMARY KEY, title TEXT, creator_id INTEGER, date INTEGER, broadcast INTEGER, megagroup INTEGER, about TEXT, access_hash INTEGER, version INTEGER',
  chat_members: 'chat_id INTEGER, user_id INTEGER, PRIMARY KEY (chat_id, user_id)',
  messages: 'id INTEGER PRIMARY KEY, peer_type TEXT, peer_id INTEGER, from_id INTEGER, text TEXT, random_id INTEGER, date INTEGER, out INTEGER',
  state: 'key TEXT PRIMARY KEY, value INTEGER',
};

// ids: int64 (well within JS safe-integer range) with a stable negative range.
const CHAT_ID_BASE = -1000001;
const CHANNEL_ID_BASE = -1000000000001;

const now = () => Math.floor(Date.now() / 1000);
const columnOf = (field) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toNumber = (v, fallback = 0) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function optionsOf(dataDir, options) {
  if (dataDir && typeof dataDir === 'object' && !Array.isArray(dataDir)) {
    return { dataDir: dataDir.dataDir || dataDir.dir || './data', options: { ...dataDir, ...options } };
  }
  return { dataDir: dataDir || './data', options: options || {} };
}

function parseMembers(value) {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch {
    return [];
  }
}

function sqliteValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v.toString();
  }
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
    if (opts.orderBy) {
      const parts = String(opts.orderBy).trim().split(/\s+/);
      const desc = parts[0].startsWith('-');
      const key = columnOf(desc ? parts[0].slice(1) : parts[0]);
      query += ` ORDER BY ${key}${desc ? ' DESC' : ' ASC'}`;
    }
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
        this._save();
      }
    } else {
      // Create the fallback file up front so it always exists on disk.
      this._save();
    }
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data));
  }

  _match(row, where) {
    return Object.entries(where || {}).every(([k, v]) => row[k] === v || (row[columnOf(k)] !== undefined && row[columnOf(k)] === v));
  }

  all(table, where = {}, opts = {}) {
    let rows = this.data[table].filter((row) => this._match(row, where));
    if (opts.orderBy) {
      const parts = String(opts.orderBy).trim().split(/\s+/);
      const desc = parts[0].startsWith('-');
      const key = desc ? parts[0].slice(1) : parts[0];
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

export class GroupStore {
  constructor(dataDir = './data', options = {}) {
    const resolved = optionsOf(dataDir, options);
    this.dataDir = resolved.dataDir;
    this.driverKind = resolved.options.dbDriver || process.env.DB_DRIVER || 'sqlite';
    const jsonFile = path.join(this.dataDir, 'groups.json');
    if (this.driverKind === 'json') {
      this.driver = new JSONDriver(jsonFile);
    } else {
      try {
        // process.getBuiltinModule avoids a top-level await; node:sqlite is
        // built into Node >= 22.5 but may be absent in older runtimes.
        const sqlite = process.getBuiltinModule?.('node:sqlite');
        if (!sqlite) throw new Error('node:sqlite unavailable');
        this.driver = new SQLiteDriver(path.join(this.dataDir, 'groups.sqlite'), sqlite.DatabaseSync);
      } catch {
        this.driverKind = 'json';
        this.driver = new JSONDriver(jsonFile);
      }
    }
  }

  // ---- object normalizers ---------------------------------------------
  _chat(row) {
    if (!row) return null;
    const members = this._membersOf(row.id);
    const stored = parseMembers(row.members ?? row.members_json ?? row.membersJson);
    return {
      type: 'chat',
      id: toNumber(row.id),
      title: row.title ?? '',
      creatorId: toNumber(row.creator_id ?? row.creatorId),
      date: toNumber(row.date),
      members: members.length ? members : stored,
      megagroup: Boolean(row.megagroup),
      about: row.about ?? '',
      version: toNumber(row.version, 1),
      participantsCount: (members.length ? members : stored).length,
    };
  }

  _channel(row) {
    if (!row) return null;
    const members = this._membersOf(row.id);
    const stored = parseMembers(row.members ?? row.members_json ?? row.membersJson);
    return {
      type: 'channel',
      id: toNumber(row.id),
      title: row.title ?? '',
      creatorId: toNumber(row.creator_id ?? row.creatorId),
      date: toNumber(row.date),
      members: members.length ? members : stored,
      broadcast: Boolean(row.broadcast),
      megagroup: Boolean(row.megagroup),
      about: row.about ?? '',
      accessHash: toNumber(row.access_hash ?? row.accessHash),
      version: toNumber(row.version, 1),
      participantsCount: (members.length ? members : stored).length,
    };
  }

  _message(row) {
    if (!row) return null;
    return {
      id: toNumber(row.id),
      peerType: row.peer_type ?? row.peerType ?? 'chat',
      peerId: toNumber(row.peer_id ?? row.peerId),
      fromId: toNumber(row.from_id ?? row.fromId),
      text: row.text ?? '',
      randomId: toNumber(row.random_id ?? row.randomId),
      date: toNumber(row.date),
      out: Boolean(row.out),
    };
  }

  _membersOf(peerId) {
    return this.driver.all('chat_members', { chatId: toNumber(peerId) }, { orderBy: 'user_id' })
      .map((r) => toNumber(r.user_id ?? r.userId)).filter(Boolean);
  }

  _nextId(table, base) {
    const rows = this.driver.all(table);
    const min = rows.reduce((m, r) => Math.min(m, toNumber(r.id)), 0);
    return Math.min(base, min - 1);
  }

  _kindOf(id) {
    if (this.driver.get('chats', { id: toNumber(id) })) return 'chats';
    if (this.driver.get('channels', { id: toNumber(id) })) return 'channels';
    return null;
  }

  _syncMembers(table, id, members) {
    this.driver.update(table, { id: toNumber(id) }, { members: JSON.stringify([...new Set(members)]) });
  }

  // ---- chats / channels ------------------------------------------------
  createChat(input = {}) {
    const o = (input && typeof input === 'object' && !Array.isArray(input)) ? input : { title: String(input ?? '') };
    const creatorId = toNumber(o.creatorId ?? o.creator_id ?? o.creator ?? 0);
    const requested = Array.isArray(o.members) ? o.members : [];
    const members = [...new Set([creatorId, ...requested].map(Number).filter(Boolean))];
    const row = {
      id: toNumber(o.id) || this._nextId('chats', CHAT_ID_BASE),
      title: String(o.title ?? 'Untitled'),
      creatorId,
      date: toNumber(o.date) || now(),
      members: JSON.stringify(members),
      megagroup: Boolean(o.megagroup),
      about: String(o.about ?? ''),
      version: toNumber(o.version, 1),
    };
    this.driver.insert('chats', row);
    for (const userId of members) {
      this.driver.upsert('chat_members', { chatId: row.id, userId }, { chatId: row.id, userId });
    }
    return this._chat(row);
  }

  createChannel(input = {}) {
    const o = (input && typeof input === 'object' && !Array.isArray(input)) ? input : { title: String(input ?? '') };
    const creatorId = toNumber(o.creatorId ?? o.creator_id ?? o.creator ?? 0);
    const requested = Array.isArray(o.members) ? o.members : [];
    const members = [...new Set([creatorId, ...requested].map(Number).filter(Boolean))];
    const row = {
      id: toNumber(o.id) || this._nextId('channels', CHANNEL_ID_BASE),
      title: String(o.title ?? 'Untitled'),
      creatorId,
      date: toNumber(o.date) || now(),
      broadcast: Boolean(o.broadcast),
      megagroup: Boolean(o.megagroup),
      about: String(o.about ?? ''),
      accessHash: toNumber(o.accessHash ?? o.access_hash),
      version: toNumber(o.version, 1),
      members: JSON.stringify(members),
    };
    this.driver.insert('channels', row);
    for (const userId of members) {
      this.driver.upsert('chat_members', { chatId: row.id, userId }, { chatId: row.id, userId });
    }
    return this._channel(row);
  }

  getChat(id) {
    return this._chat(this.driver.get('chats', { id: toNumber(id) }));
  }

  getChannel(id) {
    return this._channel(this.driver.get('channels', { id: toNumber(id) }));
  }

  updateChat(id, patch = {}) {
    const allowed = {};
    for (const key of ['title', 'about', 'megagroup', 'version', 'creatorId', 'date']) {
      if (patch[key] !== undefined) allowed[key] = patch[key];
    }
    this.driver.update('chats', { id: toNumber(id) }, allowed);
    return this.getChat(id);
  }

  updateChannel(id, patch = {}) {
    const allowed = {};
    for (const key of ['title', 'about', 'broadcast', 'megagroup', 'version', 'creatorId', 'date']) {
      if (patch[key] !== undefined) allowed[key] = patch[key];
    }
    this.driver.update('channels', { id: toNumber(id) }, allowed);
    return this.getChannel(id);
  }

  // Accepts either addMember(chatId, userId) or addMember({ chatId, userId }).
  _memberArgs(chatId, userId) {
    if (chatId && typeof chatId === 'object' && !Array.isArray(chatId)) {
      return {
        id: toNumber(chatId.chatId ?? chatId.chat_id ?? chatId.peerId ?? chatId.id),
        uid: toNumber(userId ?? chatId.userId ?? chatId.user_id),
      };
    }
    return { id: toNumber(chatId), uid: toNumber(userId) };
  }

  addMember(chatId, userId) {
    const { id, uid } = this._memberArgs(chatId, userId);
    const table = this._kindOf(id);
    if (!id || !uid || !table) return false;
    this.driver.upsert('chat_members', { chatId: id, userId: uid }, { chatId: id, userId: uid });
    this._syncMembers(table, id, this._membersOf(id));
    return true;
  }

  removeMember(chatId, userId) {
    const { id, uid } = this._memberArgs(chatId, userId);
    const table = this._kindOf(id);
    if (!id || !uid || !table) return false;
    this.driver.delete('chat_members', { chatId: id, userId: uid });
    this._syncMembers(table, id, this._membersOf(id));
    return true;
  }

  listChatsForUser(userId) {
    const uid = toNumber(userId);
    if (!uid) return [];
    const rows = this.driver.all('chat_members', { userId: uid });
    const out = [];
    for (const row of rows) {
      const id = toNumber(row.chat_id ?? row.chatId);
      const chat = this.getChat(id);
      if (chat) out.push(chat);
      else {
        const channel = this.getChannel(id);
        if (channel) out.push(channel);
      }
    }
    return out.sort((a, b) => (b.date || 0) - (a.date || 0));
  }

  // ---- messages --------------------------------------------------------
  putMessage(input = {}) {
    const o = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
    const rows = this.driver.all('messages');
    const id = toNumber(o.id) || rows.reduce((max, r) => Math.max(max, toNumber(r.id)), 0) + 1;
    const row = {
      id,
      peerType: String(o.peerType ?? o.peer_type ?? 'chat'),
      peerId: toNumber(o.peerId ?? o.peer_id ?? o.chatId ?? o.channelId),
      fromId: toNumber(o.fromId ?? o.from_id),
      text: String(o.text ?? ''),
      randomId: toNumber(o.randomId ?? o.random_id),
      date: toNumber(o.date) || now(),
      out: o.out ? 1 : 0,
    };
    this.driver.insert('messages', row);
    return this._message(row);
  }

  // Newest first, matching Store.listMessages; handlers reverse for TL output.
  listMessages(peerType, peerId, limit = 20) {
    return this.driver.all('messages', {
      peerType: String(peerType ?? 'chat'),
      peerId: toNumber(peerId),
    }, { orderBy: '-id', limit: Number(limit) || 20 }).map((r) => this._message(r));
  }

  // ---- pts / state -----------------------------------------------------
  _stateValue(key, fallback = 0) {
    const row = this.driver.get('state', { key: String(key) });
    return row ? toNumber(row.value) : fallback;
  }

  _setState(key, value) {
    this.driver.upsert('state', { key: String(key) }, { key: String(key), value: toNumber(value) });
  }

  nextPts() {
    const pts = this._stateValue('pts') + 1;
    this._setState('pts', pts);
    this._setState('date', now());
    return pts;
  }

  getState() {
    const unread = this._stateValue('unread_count');
    return {
      pts: this._stateValue('pts'),
      qts: this._stateValue('qts'),
      date: this._stateValue('date', now()),
      seq: this._stateValue('seq'),
      unread_count: unread,
      unreadCount: unread,
    };
  }

  close() {
    this.driver.close();
  }
}

export default GroupStore;
