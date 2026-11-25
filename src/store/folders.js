// Folder (chat-list) storage, deliberately kept separate from store.js.
//
// Uses a dedicated node:sqlite DatabaseSync at <dataDir>/folders.sqlite (Node
// >= 22.5, no npm dependencies). Falls back to a JSON file when node:sqlite is
// unavailable, mirroring the other stores. Every method is synchronous so it
// can be called straight from a TL handler.
//
// Peers are keyed by the canonical string "type:id" (e.g. "user:123",
// "chat:-1000001", "channel:-1000000000001"), which keeps every Peer kind in a
// single, portable table.

import fs from 'node:fs';
import path from 'node:path';

const TABLES = {
  folders: {
    table: 'folders',
    columns: { id: 'INTEGER PRIMARY KEY', userId: 'INTEGER', title: 'TEXT', color: 'INTEGER', emoticon: 'TEXT' },
    fields: ['id', 'userId', 'title', 'color', 'emoticon'],
  },
  folderPeers: {
    table: 'folder_peers',
    columns: {
      folderId: 'INTEGER',
      peerKey: 'TEXT',
      extra: 'PRIMARY KEY (folder_id, peer_key)',
    },
    fields: ['folderId', 'peerKey'],
  },
  dialogs: {
    table: 'dialogs',
    columns: {
      userId: 'INTEGER',
      peerKey: 'TEXT',
      folderId: 'INTEGER',
      pinned: 'INTEGER',
      pinOrder: 'INTEGER',
      extra: 'PRIMARY KEY (user_id, peer_key)',
    },
    fields: ['userId', 'peerKey', 'folderId', 'pinned', 'pinOrder'],
  },
};

const columnOf = (name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
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

/** Normalize a Peer / InputPeer / dialog row / peer-key string into "type:id". */
export function peerKeyOf(value, defaultType = 'user') {
  if (typeof value === 'string') {
    const match = /^(user|chat|channel):(-?\d+)$/.exec(value);
    if (match) return `${match[1]}:${Number(match[2])}`;
    if (/^-?\d+$/.test(value)) return `${defaultType}:${Number(value)}`;
    // Unknown string keys are kept verbatim (forward compatibility).
    return value;
  }
  if (value && typeof value === 'object') {
    const type = String(value.type ?? value.peerType ?? (
      value.channelId ? 'channel' : value.chatId ? 'chat' : defaultType
    ));
    const raw = value.id ?? value.peerId ?? value.userId ?? value.chatId ?? value.channelId ?? 0;
    return `${type}:${Number(raw) || 0}`;
  }
  return `${defaultType}:${Number(value) || 0}`;
}

/** Reverse of peerKeyOf, for TL encoders that need a Peer. */
export function peerFromKey(key) {
  const text = String(key ?? '');
  const split = text.indexOf(':');
  if (split < 0) return { type: 'user', id: toNumber(text) };
  return { type: text.slice(0, split) || 'user', id: toNumber(text.slice(split + 1)) };
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
    for (const def of Object.values(TABLES)) {
      const cols = Object.entries(def.columns)
        .map(([key, type]) => (key === 'extra' ? type : `${columnOf(key)} ${type}`));
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${def.table} (${cols.join(', ')})`);
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
    let query = `SELECT * FROM ${TABLES[table].table}${sql}`;
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
    const keys = TABLES[table].fields.filter((k) => row[k] !== undefined);
    const sql = `INSERT INTO ${TABLES[table].table} (${keys.map(columnOf).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    this.db.prepare(sql).run(...keys.map((k) => sqliteValue(row[k])));
    return row;
  }

  update(table, where, patch) {
    const keys = Object.keys(patch).filter((k) => TABLES[table].fields.includes(k));
    if (!keys.length) return 0;
    const { sql, values } = this._where(table, where);
    const set = keys.map((k) => `${columnOf(k)} = ?`).join(', ');
    return this.db.prepare(`UPDATE ${TABLES[table].table} SET ${set}${sql}`)
      .run(...keys.map((k) => sqliteValue(patch[k])), ...values).changes || 0;
  }

  delete(table, where) {
    const { sql, values } = this._where(table, where);
    return this.db.prepare(`DELETE FROM ${TABLES[table].table}${sql}`).run(...values).changes || 0;
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
    for (const table of Object.keys(TABLES)) this.data[table] = [];
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const table of Object.keys(TABLES)) {
          if (Array.isArray(parsed[table])) this.data[table] = parsed[table];
        }
      } catch {
        this._save();
      }
    } else {
      this._save();
    }
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data));
  }

  _match(row, where) {
    return Object.entries(where || {}).every(([k, v]) => {
      const col = columnOf(k);
      return row[k] === v || (row[col] !== undefined && row[col] === v);
    });
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
        if (typeof av === 'string' || typeof bv === 'string') {
          return String(av).localeCompare(String(bv)) * (desc ? -1 : 1);
        }
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

export class FolderStore {
  constructor(dataDir = './data', options = {}) {
    const resolved = optionsOf(dataDir, options);
    this.dataDir = resolved.dataDir;
    this.driverKind = resolved.options.dbDriver || process.env.DB_DRIVER || 'sqlite';
    const jsonFile = path.join(this.dataDir, 'folders.json');
    if (this.driverKind === 'json') {
      this.driver = new JSONDriver(jsonFile);
    } else {
      try {
        // process.getBuiltinModule avoids a top-level await: node:sqlite is
        // built into Node >= 22.5 but may be absent in older runtimes.
        const sqlite = process.getBuiltinModule?.('node:sqlite');
        if (!sqlite) throw new Error('node:sqlite unavailable');
        this.driver = new SQLiteDriver(path.join(this.dataDir, 'folders.sqlite'), sqlite.DatabaseSync);
      } catch {
        this.driverKind = 'json';
        this.driver = new JSONDriver(jsonFile);
      }
    }
  }

  // ---- normalizers ------------------------------------------------------
  _folder(row) {
    if (!row) return null;
    return {
      id: toNumber(row.id),
      userId: toNumber(row.user_id ?? row.userId),
      title: String(row.title ?? ''),
      color: toNumber(row.color),
      emoticon: String(row.emoticon ?? ''),
    };
  }

  _dialog(row) {
    if (!row) return null;
    return {
      userId: toNumber(row.user_id ?? row.userId),
      peerKey: String(row.peer_key ?? row.peerKey ?? ''),
      folderId: toNumber(row.folder_id ?? row.folderId),
      pinned: Boolean(row.pinned),
      pinOrder: toNumber(row.pin_order ?? row.pinOrder),
    };
  }

  _nextFolderId(userId) {
    const rows = this.driver.all('folders', userId ? { userId: toNumber(userId) } : {});
    return rows.reduce((max, r) => Math.max(max, toNumber(r.id)), 0) + 1;
  }

  _dialogWhere(userId, peerKey) {
    return { userId: toNumber(userId), peerKey: peerKeyOf(peerKey) };
  }

  // ---- folders -----------------------------------------------------------
  createFolder(userId, input = {}) {
    const o = (input && typeof input === 'object' && !Array.isArray(input)) ? input : { title: String(input ?? '') };
    const uid = toNumber(o.userId ?? o.user_id ?? userId);
    const row = {
      id: toNumber(o.id) || this._nextFolderId(uid),
      userId: uid,
      title: String(o.title ?? ''),
      color: toNumber(o.color),
      emoticon: String(o.emoticon ?? ''),
    };
    this.driver.insert('folders', row);
    return this._folder(this.driver.get('folders', { id: row.id }));
  }

  getFolder(folderId) {
    return this._folder(this.driver.get('folders', { id: toNumber(folderId) }));
  }

  updateFolder(folderId, patch = {}) {
    const allowed = {};
    for (const key of ['title', 'color', 'emoticon', 'userId']) {
      if (patch?.[key] !== undefined) allowed[key] = patch[key];
    }
    this.driver.update('folders', { id: toNumber(folderId) }, allowed);
    return this.getFolder(folderId);
  }

  deleteFolder(folderId) {
    const id = toNumber(folderId);
    const removed = this.driver.delete('folders', { id }) > 0;
    for (const row of this.driver.all('folderPeers', { folderId: id })) {
      this.driver.delete('folderPeers', { folderId: id, peerKey: row.peer_key ?? row.peerKey });
    }
    this.driver.update('dialogs', { folderId: id }, { folderId: 0 });
    return removed;
  }

  listFolders(userId) {
    return this.driver.all('folders', { userId: toNumber(userId) }, { orderBy: 'id' })
      .map((row) => this._folder(row));
  }

  // ---- folder membership -------------------------------------------------
  addPeerToFolder(folderId, peerKey) {
    const id = toNumber(folderId);
    const key = peerKeyOf(peerKey);
    if (!id || !key || !this.getFolder(id)) return false;
    this.driver.upsert('folderPeers', { folderId: id, peerKey: key }, { folderId: id, peerKey: key });
    return true;
  }

  removePeerFromFolder(folderId, peerKey) {
    const id = toNumber(folderId);
    const key = peerKeyOf(peerKey);
    if (!id || !key) return false;
    return this.driver.delete('folderPeers', { folderId: id, peerKey: key }) > 0;
  }

  listFolderPeers(folderId) {
    return this.driver.all('folderPeers', { folderId: toNumber(folderId) }, { orderBy: 'peerKey' })
      .map((row) => String(row.peer_key ?? row.peerKey ?? ''));
  }

  // ---- dialog pinning / folder assignment -------------------------------
  getDialog(userId, peerKey) {
    return this._dialog(this.driver.get('dialogs', this._dialogWhere(userId, peerKey)));
  }

  _ensureDialog(userId, peerKey) {
    const where = this._dialogWhere(userId, peerKey);
    const existing = this.driver.get('dialogs', where);
    if (!existing) {
      this.driver.insert('dialogs', {
        userId: where.userId, peerKey: where.peerKey, folderId: 0, pinned: 0, pinOrder: 0,
      });
    }
    return this.driver.get('dialogs', where);
  }

  pinDialog(userId, peerKey, pinned) {
    const where = this._dialogWhere(userId, peerKey);
    if (!where.userId || !where.peerKey) return null;
    const existing = this._ensureDialog(where.userId, where.peerKey);
    let order = toNumber(existing?.pin_order ?? existing?.pinOrder);
    if (pinned) {
      const rows = this.driver.all('dialogs', { userId: where.userId });
      order = rows.reduce((max, r) => Math.max(max, toNumber(r.pin_order ?? r.pinOrder)), 0) + 1;
    } else {
      order = 0;
    }
    this.driver.update('dialogs', where, { pinned: pinned ? 1 : 0, pinOrder: order });
    return this.getDialog(where.userId, where.peerKey);
  }

  unpinAll(userId) {
    let changed = 0;
    for (const row of this.driver.all('dialogs', { userId: toNumber(userId) })) {
      if (!row.pinned) continue;
      this.driver.update('dialogs', {
        userId: toNumber(userId), peerKey: row.peer_key ?? row.peerKey,
      }, { pinned: 0, pinOrder: 0 });
      changed++;
    }
    return changed;
  }

  listPinned(userId) {
    return this.driver.all('dialogs', { userId: toNumber(userId) }, { orderBy: 'pinOrder' })
      .filter((row) => Boolean(row.pinned))
      .map((row) => String(row.peer_key ?? row.peerKey ?? ''));
  }

  markDialogFolder(userId, peerKey, folderId) {
    const where = this._dialogWhere(userId, peerKey);
    if (!where.userId || !where.peerKey) return null;
    this._ensureDialog(where.userId, where.peerKey);
    this.driver.update('dialogs', where, { folderId: toNumber(folderId) });
    return this.getDialog(where.userId, where.peerKey);
  }

  getDialogFolder(userId, peerKey) {
    const row = this.driver.get('dialogs', this._dialogWhere(userId, peerKey));
    return row ? toNumber(row.folder_id ?? row.folderId) : 0;
  }

  close() {
    this.driver.close();
  }
}

export default FolderStore;
