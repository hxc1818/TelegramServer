// Story / story-view / device / push-settings storage, deliberately separate
// from src/store/store.js (which this module must not touch).
//
// Uses a dedicated node:sqlite DatabaseSync at <dataDir>/stories.sqlite (Node
// >= 22.5, zero npm dependencies). Falls back to <dataDir>/stories.json when
// node:sqlite is unavailable or when dbDriver:'json' is requested. Every
// method is synchronous so it can be called directly from a TL handler.
//
// NOTE: device tokens and notification preferences are only persisted here.
// This server does NOT deliver real APNs/FCM pushes.

import fs from 'node:fs';
import path from 'node:path';

const TABLES = {
  stories: {
    columns: { id: 'INTEGER PRIMARY KEY', ownerId: 'INTEGER', media: 'TEXT', text: 'TEXT', date: 'INTEGER', expires: 'INTEGER' },
    fields: ['id', 'ownerId', 'media', 'text', 'date', 'expires'],
  },
  views: {
    columns: { storyId: 'INTEGER', userId: 'INTEGER', date: 'INTEGER' },
    fields: ['storyId', 'userId', 'date'],
  },
  devices: {
    columns: { token: 'TEXT PRIMARY KEY', userId: 'INTEGER', type: 'TEXT' },
    fields: ['token', 'userId', 'type'],
  },
  pushSettings: {
    table: 'push_settings',
    columns: { peerKey: 'TEXT PRIMARY KEY', value: 'TEXT' },
    fields: ['peerKey', 'value'],
  },
};

const CREATE_SQL = {
  stories: 'id INTEGER PRIMARY KEY, owner_id INTEGER, media TEXT, text TEXT, date INTEGER, expires INTEGER',
  views: 'story_id INTEGER, user_id INTEGER, date INTEGER, PRIMARY KEY (story_id, user_id)',
  devices: 'token TEXT PRIMARY KEY, user_id INTEGER, type TEXT',
  push_settings: 'peer_key TEXT PRIMARY KEY, value TEXT',
};

const now = () => Math.floor(Date.now() / 1000);
const columnOf = (field) => String(field).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const tableOf = (table) => TABLES[table]?.table || table;

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

// media/settings may be Buffers, plain objects or scalars. Store them as JSON
// text so the sqlite and JSON drivers return exactly the same shapes.
function encodeValue(value) {
  if (value === undefined) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return JSON.stringify({ __type: 'Buffer', data: Buffer.from(value).toString('base64') });
  }
  try { return JSON.stringify(value); } catch { return JSON.stringify(String(value)); }
}

function decodeValue(raw, fallback = null) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.__type === 'Buffer' && typeof parsed.data === 'string') {
      return Buffer.from(parsed.data, 'base64');
    }
    return parsed;
  } catch {
    return fallback;
  }
}

function normalizeType(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return value;
  const str = String(value);
  return /^-?\d+$/.test(str) ? Number(str) : str;
}

function orderRows(rows, table, orderBy) {
  if (!orderBy) return rows;
  const parts = String(orderBy).trim().split(/\s+/);
  const descending = parts[0].startsWith('-');
  const key = descending ? parts[0].slice(1) : parts[0];
  return rows.slice().sort((a, b) => {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    const cmp = typeof av === 'string' || typeof bv === 'string'
      ? String(av).localeCompare(String(bv))
      : Number(av) - Number(bv);
    return descending ? -cmp : cmp;
  });
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
    const params = [...values];
    let query = `SELECT * FROM ${tableOf(table)}${sql}`;
    if (opts.orderBy) {
      const parts = String(opts.orderBy).trim().split(/\s+/);
      const descending = parts[0].startsWith('-');
      const key = columnOf(parts[0].startsWith('-') ? parts[0].slice(1) : parts[0]);
      query += ` ORDER BY ${key} ${descending ? 'DESC' : 'ASC'}`;
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
    const keys = (TABLES[table].fields || []).filter((k) => row[k] !== undefined);
    const sql = `INSERT INTO ${tableOf(table)} (${keys.map(columnOf).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    this.db.prepare(sql).run(...keys.map((k) => sqliteValue(row[k])));
    return row;
  }

  update(table, where, patch) {
    const keys = Object.keys(patch).filter((k) => (TABLES[table].fields || []).includes(k));
    if (!keys.length) return 0;
    const { sql, values } = this._where(table, where);
    const set = keys.map((k) => `${columnOf(k)} = ?`).join(', ');
    return this.db.prepare(`UPDATE ${tableOf(table)} SET ${set}${sql}`)
      .run(...keys.map((k) => sqliteValue(patch[k])), ...values).changes || 0;
  }

  delete(table, where) {
    const { sql, values } = this._where(table, where);
    return this.db.prepare(`DELETE FROM ${tableOf(table)}${sql}`).run(...values).changes || 0;
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
    const names = Object.keys(TABLES).map(tableOf);
    this.data = {};
    for (const name of names) this.data[name] = [];
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const name of names) if (Array.isArray(parsed[name])) this.data[name] = parsed[name];
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
    return Object.entries(where).every(([k, v]) => {
      const col = columnOf(k);
      return row[k] === v || (row[col] !== undefined && row[col] === v);
    });
  }

  all(table, where = {}, opts = {}) {
    const name = tableOf(table);
    let rows = (this.data[name] || []).filter((row) => this._match(row, where));
    rows = orderRows(rows, table, opts.orderBy);
    if (opts.limit) rows = rows.slice(0, Number(opts.limit));
    return rows;
  }

  get(table, where) {
    return this.all(table, where, { limit: 1 })[0] || null;
  }

  insert(table, row) {
    const name = tableOf(table);
    const stored = {};
    for (const k of TABLES[table].fields || []) if (row[k] !== undefined) stored[columnOf(k)] = row[k];
    (this.data[name] ||= []).push(stored);
    this._save();
    return stored;
  }

  update(table, where, patch) {
    const name = tableOf(table);
    let changed = 0;
    for (const row of this.data[name] || []) {
      if (this._match(row, where)) {
        for (const k of TABLES[table].fields || []) {
          if (patch[k] !== undefined) row[columnOf(k)] = patch[k];
        }
        changed++;
      }
    }
    if (changed) this._save();
    return changed;
  }

  delete(table, where) {
    const name = tableOf(table);
    const before = (this.data[name] || []).length;
    this.data[name] = (this.data[name] || []).filter((row) => !this._match(row, where));
    if (before !== this.data[name].length) this._save();
    return before - this.data[name].length;
  }

  upsert(table, where, row) {
    if (this.update(table, where, row) === 0 && !this.get(table, where)) this.insert(table, row);
  }

  close() {
    this._save();
  }
}

export class StoryStore {
  constructor(dataDir = './data', options = {}) {
    if (dataDir && typeof dataDir === 'object') {
      options = dataDir;
      dataDir = options.dataDir || './data';
    }
    this.dataDir = dataDir;
    this.driverKind = options.dbDriver || process.env.DB_DRIVER || 'sqlite';
    const file = path.join(dataDir, this.driverKind === 'json' ? 'stories.json' : 'stories.sqlite');
    if (this.driverKind === 'json') {
      this.driver = new JSONDriver(file);
    } else {
      try {
        const sqlite = process.getBuiltinModule?.('node:sqlite');
        if (!sqlite?.DatabaseSync) throw new Error('node:sqlite is unavailable');
        this.driver = new SQLiteDriver(file, sqlite.DatabaseSync);
      } catch {
        this.driver = new JSONDriver(path.join(dataDir, 'stories.json'));
      }
    }
  }

  // ---- stories ---------------------------------------------------------
  _story(row) {
    if (!row) return null;
    return {
      id: toNumber(row.id ?? row.story_id),
      ownerId: toNumber(row.owner_id ?? row.ownerId),
      media: decodeValue(row.media, null),
      text: row.text ?? '',
      date: toNumber(row.date),
      expires: toNumber(row.expires),
      // Alias used by the TL storyItem codec.
      expireDate: toNumber(row.expires),
    };
  }

  createStory({ id, ownerId = 0, media = null, text = '', date, expires = 0 } = {}) {
    const rows = this.driver.all('stories');
    const maxId = rows.reduce((max, row) => Math.max(max, toNumber(row.id)), 0);
    const storyId = id === undefined || id === null ? maxId + 1 : (Number(BigInt(id)) & 0x7fffffff) || maxId + 1;
    const row = {
      id: storyId,
      ownerId: toNumber(ownerId),
      media: encodeValue(media),
      text: String(text ?? ''),
      date: date === undefined ? now() : toNumber(date),
      expires: toNumber(expires),
    };
    this.driver.upsert('stories', { id: storyId }, row);
    return this._story(this.driver.get('stories', { id: storyId }));
  }

  getStory(id) {
    return this._story(this.driver.get('stories', { id: toNumber(id) }));
  }

  listStories(ownerId) {
    return this.driver.all('stories', { ownerId: toNumber(ownerId) }, { orderBy: '-date' })
      .map((row) => this._story(row));
  }

  /** Active stories ordered newest-first. Own stories are included (as in the
   *  Telegram "Your story" feed); pass includeOwn:false to exclude them. */
  listFeed(userId = 0, { limit = 0, includeOwn = true, includeExpired = false } = {}) {
    const stamp = now();
    let rows = this.driver.all('stories', {}, { orderBy: '-date' });
    if (!includeExpired) {
      rows = rows.filter((row) => toNumber(row.expires) === 0 || toNumber(row.expires) > stamp);
    }
    if (!includeOwn) rows = rows.filter((row) => toNumber(row.owner_id ?? row.ownerId) !== toNumber(userId));
    const stories = rows.map((row) => this._story(row));
    return limit ? stories.slice(0, Number(limit)) : stories;
  }

  deleteStory(id) {
    const removed = this.driver.delete('stories', { id: toNumber(id) }) > 0;
    this.driver.delete('views', { storyId: toNumber(id) });
    return removed;
  }

  // ---- views -----------------------------------------------------------
  _view(row) {
    if (!row) return null;
    return {
      storyId: toNumber(row.story_id ?? row.storyId),
      userId: toNumber(row.user_id ?? row.userId),
      date: toNumber(row.date),
    };
  }

  viewStory(id, userId) {
    const storyId = toNumber(id);
    if (!this.driver.get('stories', { id: storyId })) return null;
    const viewer = toNumber(userId);
    const where = { storyId, userId: viewer };
    const existing = this.driver.get('views', where);
    if (existing) return this._view(existing);
    const row = { storyId, userId: viewer, date: now() };
    this.driver.insert('views', row);
    return this._view(row);
  }

  listViews(id) {
    return this.driver.all('views', { storyId: toNumber(id) }, { orderBy: '-date' })
      .map((row) => this._view(row));
  }

  // ---- devices / push settings -----------------------------------------
  addDevice({ userId = 0, token, type = 0 } = {}) {
    const key = String(token ?? '');
    const row = { token: key, userId: toNumber(userId), type: String(normalizeType(type)) };
    this.driver.upsert('devices', { token: key }, row);
    const saved = this.driver.get('devices', { token: key });
    return { token: key, userId: toNumber(saved.user_id ?? saved.userId), type: normalizeType(saved.type) };
  }

  removeDevice(token) {
    return this.driver.delete('devices', { token: String(token ?? '') }) > 0;
  }

  listDevices(userId) {
    return this.driver.all('devices', { userId: toNumber(userId) }).map((row) => ({
      token: row.token,
      userId: toNumber(row.user_id ?? row.userId),
      type: normalizeType(row.type),
    }));
  }

  setPushSettings(peerKey, settings = {}) {
    const key = String(peerKey);
    this.driver.upsert('pushSettings', { peerKey: key }, { peerKey: key, value: encodeValue(settings ?? {}) });
    return this.getPushSettings(key);
  }

  getPushSettings(peerKey) {
    const row = this.driver.get('pushSettings', { peerKey: String(peerKey) });
    return row ? decodeValue(row.value, {}) : null;
  }

  close() {
    this.driver.close();
  }
}

export default StoryStore;
