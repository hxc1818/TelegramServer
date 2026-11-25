// Push-device / notification-queue storage, deliberately separate from
// src/store/store.js and src/store/stories.js (this module must not touch them).
//
// Uses a dedicated node:sqlite DatabaseSync at <dataDir>/push.sqlite (Node
// >= 22.5, zero npm dependencies). Falls back to <dataDir>/push.json when
// node:sqlite is unavailable or when dbDriver:'json' is requested. Every
// method is synchronous so it can be called straight from a TL handler or
// from a Webhook dispatch loop.
//
// This store only persists state. Actual delivery lives in src/push/dispatcher.js.

import fs from 'node:fs';
import path from 'node:path';

const TABLE_FIELDS = {
  devices: ['token', 'userId', 'type', 'appId', 'createdAt'],
  pushSettings: ['peerKey', 'value'],
  notifications: ['id', 'userId', 'peerKey', 'text', 'date', 'delivered', 'deliveredAt'],
};

const CREATE_SQL = {
  devices: 'token TEXT PRIMARY KEY, user_id INTEGER, type TEXT, app_id TEXT, created_at INTEGER',
  push_settings: 'peer_key TEXT PRIMARY KEY, value TEXT',
  // id is assigned explicitly (max + 1) so the SQLite and JSON drivers behave
  // identically; delivered rows are kept as a delivery history.
  notifications: 'id INTEGER PRIMARY KEY, user_id INTEGER, peer_key TEXT, text TEXT, '
    + 'date INTEGER, delivered INTEGER DEFAULT 0, delivered_at INTEGER',
};

const SQL_TABLE = { pushSettings: 'push_settings' };

const now = () => Math.floor(Date.now() / 1000);
const columnOf = (field) => String(field).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const tableOf = (table) => SQL_TABLE[table] || table;

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

// type may be a number (legacy token_type) or a string such as 'apns'/'fcm'.
// Encoding it as JSON text keeps the original JS type across both drivers.
function encodeType(value) {
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value); } catch { return JSON.stringify(String(value)); }
}

function decodeType(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

function encodeValue(value) {
  if (value === undefined) return null;
  try { return JSON.stringify(value); } catch { return JSON.stringify(String(value)); }
}

function decodeValue(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

class SQLiteDriver {
  constructor(file, DatabaseSync) {
    this.kind = 'sqlite';
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    for (const [table, sql] of Object.entries(CREATE_SQL)) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${tableOf(table)} (${sql})`);
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
    let query = `SELECT * FROM ${tableOf(table)}${sql}`;
    const params = [...values];
    if (opts.orderBy) {
      const parts = String(opts.orderBy).trim().split(/\s+/);
      const desc = parts[0].startsWith('-');
      const key = desc ? parts[0].slice(1) : parts[0];
      query += ` ORDER BY ${columnOf(key)} ${desc ? 'DESC' : 'ASC'}${parts[1] ? ` ${parts[1]}` : ''}`;
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
    const sql = `INSERT INTO ${tableOf(table)} (${keys.map(columnOf).join(', ')}) `
      + `VALUES (${keys.map(() => '?').join(', ')})`;
    this.db.prepare(sql).run(...keys.map((k) => sqliteValue(row[k])));
    return row;
  }

  update(table, where, patch) {
    const keys = Object.keys(patch).filter((k) => (TABLE_FIELDS[table] || []).includes(k));
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
    if (opts.orderBy) {
      const parts = String(opts.orderBy).trim().split(/\s+/);
      const desc = parts[0].startsWith('-');
      const key = desc ? parts[0].slice(1) : parts[0];
      rows = rows.slice().sort((a, b) => {
        const av = a[key] ?? 0;
        const bv = b[key] ?? 0;
        const cmp = typeof av === 'string' || typeof bv === 'string'
          ? String(av).localeCompare(String(bv))
          : Number(av) - Number(bv);
        return desc ? -cmp : cmp;
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
    return { dataDir: dataDir.dataDir || dataDir.dir || './data', options: { ...dataDir, ...options } };
  }
  return { dataDir: dataDir || './data', options: options || {} };
}

export class PushStore {
  constructor(dataDir = './data', options = {}) {
    const resolved = optionsOf(dataDir, options);
    this.dataDir = resolved.dataDir;
    this.driverKind = resolved.options.dbDriver || process.env.DB_DRIVER || 'sqlite';
    const jsonFile = path.join(this.dataDir, 'push.json');
    if (this.driverKind === 'json') {
      this.driver = new JSONDriver(jsonFile);
    } else {
      try {
        // process.getBuiltinModule avoids a top-level await; node:sqlite is
        // built into Node >= 22.5 but may be absent in older runtimes.
        const sqlite = process.getBuiltinModule?.('node:sqlite');
        if (!sqlite) throw new Error('node:sqlite unavailable');
        this.driver = new SQLiteDriver(path.join(this.dataDir, 'push.sqlite'), sqlite.DatabaseSync);
      } catch {
        this.driverKind = 'json';
        this.driver = new JSONDriver(jsonFile);
      }
    }
  }

  // ---- normalizers -----------------------------------------------------
  _device(row) {
    if (!row) return null;
    return {
      token: String(row.token ?? ''),
      userId: toNumber(row.user_id ?? row.userId),
      type: decodeType(row.type),
      appId: String(row.app_id ?? row.appId ?? ''),
      createdAt: toNumber(row.created_at ?? row.createdAt),
    };
  }

  _settings(row) {
    if (!row) return null;
    const value = decodeValue(row.value, {}) || {};
    return {
      ...value,
      silent: value.silent === true,
      includeText: value.includeText !== false,
      showPreviews: value.showPreviews !== false,
    };
  }

  _notification(row) {
    if (!row) return null;
    return {
      id: toNumber(row.id),
      userId: toNumber(row.user_id ?? row.userId),
      peerKey: String(row.peer_key ?? row.peerKey ?? ''),
      text: String(row.text ?? ''),
      date: toNumber(row.date),
      delivered: Boolean(Number(row.delivered || 0)),
      deliveredAt: toNumber(row.delivered_at ?? row.deliveredAt),
    };
  }

  // ---- devices ---------------------------------------------------------
  /** Register (or update) a device token for a user. */
  registerDevice({ userId = 0, token, type = '', appId = '' } = {}) {
    const key = String(token ?? '');
    const existing = this.driver.get('devices', { token: key });
    const row = {
      token: key,
      userId: toNumber(userId),
      type: encodeType(type),
      appId: String(appId ?? ''),
      createdAt: toNumber(existing?.created_at ?? existing?.createdAt) || now(),
    };
    this.driver.upsert('devices', { token: key }, row);
    return this._device(this.driver.get('devices', { token: key }));
  }

  /** Remove a device token. Returns true when a token was removed. */
  unregisterDevice(token) {
    return this.driver.delete('devices', { token: String(token ?? '') }) > 0;
  }

  listDevices(userId) {
    return this.driver.all('devices', { userId: toNumber(userId) }, { orderBy: 'token' })
      .map((row) => this._device(row));
  }

  /** Devices for several users at once (used when a message has recipients). */
  getDevicesForUsers(userIds) {
    let ids;
    if (Array.isArray(userIds)) ids = userIds.map((v) => toNumber(v));
    else if (userIds && typeof userIds === 'object') ids = [toNumber(userIds.userId ?? userIds.id)];
    else ids = [toNumber(userIds)];
    const wanted = new Set(ids.filter(Boolean));
    if (!wanted.size) return [];
    return this.driver.all('devices', {}, { orderBy: 'token' })
      .filter((row) => wanted.has(toNumber(row.user_id ?? row.userId)))
      .map((row) => this._device(row));
  }

  /** All distinct user ids that have at least one registered device. */
  listDeviceUserIds() {
    const ids = new Set();
    for (const row of this.driver.all('devices')) ids.add(toNumber(row.user_id ?? row.userId));
    return [...ids].filter(Boolean).sort((a, b) => a - b);
  }

  // ---- per-peer notification preferences -------------------------------
  setPushSettings(peerKey, settings = {}) {
    const key = String(peerKey ?? '');
    const patch = settings && typeof settings === 'object' ? settings : {};
    const current = decodeValue(this.driver.get('pushSettings', { peerKey: key })?.value, {}) || {};
    const value = { ...current };
    for (const name of ['silent', 'includeText', 'showPreviews', 'include_text', 'show_previews']) {
      if (patch[name] !== undefined) value[name] = Boolean(patch[name]);
    }
    // Preserve unrelated flags (muteUntil, storiesMuted, ...) used by the
    // account.getNotifySettings handler.
    for (const [k, v] of Object.entries(patch)) {
      if (['silent', 'includeText', 'showPreviews', 'include_text', 'show_previews'].includes(k)) continue;
      value[k] = v;
    }
    if (value.include_text !== undefined) {
      value.includeText = Boolean(value.include_text);
      delete value.include_text;
    }
    if (value.show_previews !== undefined) {
      value.showPreviews = Boolean(value.show_previews);
      delete value.show_previews;
    }
    this.driver.upsert('pushSettings', { peerKey: key }, { peerKey: key, value: encodeValue(value) });
    return this._settings(this.driver.get('pushSettings', { peerKey: key }));
  }

  getPushSettings(peerKey) {
    return this._settings(this.driver.get('pushSettings', { peerKey: String(peerKey ?? '') }));
  }

  // ---- notification queue ----------------------------------------------
  enqueueNotification({ userId = 0, peerKey = '', text = '', date } = {}) {
    const rows = this.driver.all('notifications');
    const id = rows.reduce((max, r) => Math.max(max, toNumber(r.id)), 0) + 1;
    const row = {
      id,
      userId: toNumber(userId),
      peerKey: String(peerKey ?? ''),
      text: String(text ?? ''),
      date: date === undefined ? now() : toNumber(date),
      delivered: 0,
      deliveredAt: 0,
    };
    this.driver.insert('notifications', row);
    return this._notification(row);
  }

  /** Undelivered notifications for one user, oldest first. */
  listPending(userId, { includeDelivered = false } = {}) {
    const rows = this.driver.all('notifications', { userId: toNumber(userId) }, { orderBy: 'id' });
    return rows.filter((r) => includeDelivered || !Number(r.delivered || 0))
      .map((row) => this._notification(row));
  }

  markDelivered(id) {
    const key = toNumber(id);
    return this.driver.update('notifications', { id: key }, { delivered: 1, deliveredAt: now() }) > 0;
  }

  /** Undelivered notifications across all users, oldest first. */
  listUndelivered(limit = 100) {
    const rows = this.driver.all('notifications', {}, { orderBy: 'id' });
    return rows.filter((r) => !Number(r.delivered || 0))
      .slice(0, Math.max(0, Number(limit) || 0))
      .map((row) => this._notification(row));
  }

  close() {
    this.driver.close();
  }
}

export default PushStore;
