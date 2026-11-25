// Extra, synchronous storage for messaging features that are not covered by the
// core Store: edit history, deleted flags, forwarded metadata, drafts, replies
// and reactions. Uses node:sqlite (built into Node 22) with a JSON fallback.
// No npm dependencies.
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS message_meta (
  msg_id INTEGER PRIMARY KEY,
  text TEXT,
  edit_date INTEGER DEFAULT 0,
  deleted INTEGER DEFAULT 0,
  fwd_from_peer TEXT,
  fwd_from_id INTEGER DEFAULT 0,
  fwd_date INTEGER DEFAULT 0,
  reply_to_id INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS edit_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id INTEGER NOT NULL,
  old_text TEXT,
  new_text TEXT,
  edit_date INTEGER,
  edited_by INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS drafts (
  peer_key TEXT PRIMARY KEY,
  text TEXT,
  entities TEXT,
  date INTEGER
);
CREATE TABLE IF NOT EXISTS reactions (
  msg_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  date INTEGER,
  PRIMARY KEY (msg_id, emoji)
);
CREATE TABLE IF NOT EXISTS replies (
  msg_id INTEGER PRIMARY KEY,
  reply_to_id INTEGER NOT NULL,
  reply_to_peer TEXT
);
`;

// Logical (camelCase) field -> SQL column for every table.
const TABLES = {
  meta: {
    table: 'message_meta',
    cols: {
      msgId: 'msg_id', text: 'text', editDate: 'edit_date', deleted: 'deleted',
      fwdFromPeer: 'fwd_from_peer', fwdFromId: 'fwd_from_id',
      fwdDate: 'fwd_date', replyToId: 'reply_to_id',
    },
  },
  edits: {
    table: 'edit_history',
    cols: {
      id: 'id', msgId: 'msg_id', oldText: 'old_text', newText: 'new_text',
      editDate: 'edit_date', editedBy: 'edited_by',
    },
  },
  drafts: {
    table: 'drafts',
    cols: { peerKey: 'peer_key', text: 'text', entities: 'entities', date: 'date' },
  },
  reactions: {
    table: 'reactions',
    cols: { msgId: 'msg_id', emoji: 'emoji', date: 'date' },
  },
  replies: {
    table: 'replies',
    cols: { msgId: 'msg_id', replyToId: 'reply_to_id', replyToPeer: 'reply_to_peer' },
  },
};

function now() {
  return Math.floor(Date.now() / 1000);
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

function matches(row, where) {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

/** Normalize a Peer/InputPeer-like value into a stable string key. */
export function peerKeyOf(peer) {
  if (peer && typeof peer === 'object') {
    const type = peer.type || peer.peerType || 'user';
    const id = peer.id ?? peer.peerId ?? 0;
    return `${type}:${Number(id) || 0}`;
  }
  return String(peer ?? '');
}

/** Normalize a Peer/InputPeer-like value into { type, id }. */
export function peerParts(peer) {
  const key = peerKeyOf(peer);
  const split = key.indexOf(':');
  if (split < 0) return { type: 'user', id: 0 };
  return { type: key.slice(0, split), id: Number(key.slice(split + 1)) || 0 };
}

// A tiny uniform driver so all public methods stay driver-agnostic.
class DB {
  constructor(file) {
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (sqlite?.DatabaseSync) {
      this.kind = 'sqlite';
      this.file = file;
      this.db = new sqlite.DatabaseSync(file);
      this.db.exec(SCHEMA_SQL);
    } else {
      this.kind = 'json';
      this.file = file.replace(/\.sqlite$/, '.json');
      this.data = {};
      for (const [name, def] of Object.entries(TABLES)) this.data[name] = [];
      if (fs.existsSync(this.file)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
          for (const name of Object.keys(TABLES)) {
            if (Array.isArray(parsed[name])) this.data[name] = parsed[name];
          }
        } catch {
          // Corrupt cache: start empty.
        }
      }
    }
  }

  _row(name, row) {
    if (!row) return null;
    const out = {};
    for (const [key, col] of Object.entries(TABLES[name].cols)) {
      const value = row[col] ?? row[key];
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  all(name, where = {}) {
    if (this.kind === 'json') {
      return this.data[name].filter((row) => matches(row, where)).map((row) => ({ ...row }));
    }
    const def = TABLES[name];
    const keys = Object.keys(where);
    const sql = `SELECT * FROM ${def.table}${keys.length ? ` WHERE ${keys.map((k) => `${def.cols[k]} = ?`).join(' AND ')}` : ''}`;
    return this.db.prepare(sql).all(...keys.map((k) => toSqlValue(where[k])))
      .map((row) => this._row(name, row));
  }

  get(name, where) {
    return this.all(name, where)[0] || null;
  }

  insert(name, row) {
    if (this.kind === 'json') {
      this.data[name].push({ ...row });
      this._save();
      return row;
    }
    const def = TABLES[name];
    const keys = Object.keys(row).filter((k) => Object.hasOwn(def.cols, k));
    const sql = `INSERT INTO ${def.table} (${keys.map((k) => def.cols[k]).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    this.db.prepare(sql).run(...keys.map((k) => toSqlValue(row[k])));
    return row;
  }

  update(name, where, patch) {
    const keys = Object.keys(patch).filter((k) => Object.hasOwn(TABLES[name].cols, k));
    if (!keys.length) return 0;
    if (this.kind === 'json') {
      let changed = 0;
      for (const row of this.data[name]) {
        if (matches(row, where)) {
          Object.assign(row, patch);
          changed++;
        }
      }
      if (changed) this._save();
      return changed;
    }
    const def = TABLES[name];
    const whereKeys = Object.keys(where);
    const sql = `UPDATE ${def.table} SET ${keys.map((k) => `${def.cols[k]} = ?`).join(', ')}${whereKeys.length ? ` WHERE ${whereKeys.map((k) => `${def.cols[k]} = ?`).join(' AND ')}` : ''}`;
    return this.db.prepare(sql).run(
      ...keys.map((k) => toSqlValue(patch[k])),
      ...whereKeys.map((k) => toSqlValue(where[k])),
    ).changes || 0;
  }

  delete(name, where) {
    if (this.kind === 'json') {
      const before = this.data[name].length;
      this.data[name] = this.data[name].filter((row) => !matches(row, where));
      if (this.data[name].length !== before) this._save();
      return before - this.data[name].length;
    }
    const def = TABLES[name];
    const keys = Object.keys(where);
    const sql = `DELETE FROM ${def.table}${keys.length ? ` WHERE ${keys.map((k) => `${def.cols[k]} = ?`).join(' AND ')}` : ''}`;
    return this.db.prepare(sql).run(...keys.map((k) => toSqlValue(where[k]))).changes || 0;
  }

  upsert(name, where, row) {
    const existing = this.get(name, where);
    if (existing) {
      this.update(name, where, row);
      return this.get(name, where);
    }
    this.insert(name, row);
    return this.get(name, row);
  }

  _save() {
    if (this.kind === 'json') fs.writeFileSync(this.file, JSON.stringify(this.data));
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    if (this.kind === 'sqlite') this.db.close();
    else this._save();
  }
}

export class MessagingExtraStore {
  constructor(dataDir = './data') {
    this.dataDir = String(dataDir);
    this.db = new DB(path.join(this.dataDir, 'messaging-extra.sqlite'));
  }

  _meta(row) {
    if (!row) return null;
    return {
      msgId: Number(row.msgId) || 0,
      text: String(row.text ?? ''),
      editDate: Number(row.editDate) || 0,
      deleted: Number(row.deleted || 0) === 1,
      fwdFromPeer: String(row.fwdFromPeer ?? ''),
      fwdFromId: Number(row.fwdFromId) || 0,
      fwdDate: Number(row.fwdDate) || 0,
      replyToId: Number(row.replyToId) || 0,
    };
  }

  _rowFor(msgId, patch = {}) {
    const prev = this._meta(this.db.get('meta', { msgId }));
    return {
      msgId,
      text: prev?.text ?? '',
      editDate: prev?.editDate ?? 0,
      deleted: prev?.deleted ? 1 : 0,
      fwdFromPeer: prev?.fwdFromPeer ?? '',
      fwdFromId: prev?.fwdFromId ?? 0,
      fwdDate: prev?.fwdDate ?? 0,
      replyToId: prev?.replyToId ?? 0,
      ...patch,
    };
  }

  getMeta(id) {
    return this._meta(this.db.get('meta', { msgId: Number(id) || 0 }));
  }

  isDeleted(id) {
    return Boolean(this.getMeta(id)?.deleted);
  }

  // ---- edit history ----------------------------------------------------
  editMessage(id, newText, editDate = now()) {
    const msgId = Number(id) || 0;
    const text = String(newText ?? '');
    const date = Number(editDate) || now();
    const prev = this._meta(this.db.get('meta', { msgId }));
    this.db.insert('edits', {
      msgId,
      oldText: prev?.text ?? '',
      newText: text,
      editDate: date,
      editedBy: 0,
    });
    this.db.upsert('meta', { msgId }, this._rowFor(msgId, { text, editDate: date }));
    const meta = this._meta(this.db.get('meta', { msgId }));
    return { ...meta, editCount: this.db.all('edits', { msgId }).length };
  }

  getEditHistory(id) {
    const msgId = Number(id) || 0;
    return this.db.all('edits', { msgId })
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((row) => ({
        id: Number(row.id),
        msgId: Number(row.msgId),
        oldText: String(row.oldText ?? ''),
        newText: String(row.newText ?? ''),
        editDate: Number(row.editDate) || 0,
      }));
  }

  // ---- deleted flags ---------------------------------------------------
  markDeleted(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    let changed = 0;
    for (const raw of list) {
      const msgId = Number(raw) || 0;
      if (!msgId) continue;
      this.db.upsert('meta', { msgId }, this._rowFor(msgId, { deleted: 1 }));
      changed++;
    }
    return changed;
  }

  // ---- forwarded metadata ---------------------------------------------
  addForward(id, fromPeer, fromId) {
    const msgId = Number(id) || 0;
    const row = this._rowFor(msgId, {
      fwdFromPeer: peerKeyOf(fromPeer),
      fwdFromId: Number(fromId) || 0,
      fwdDate: now(),
    });
    this.db.upsert('meta', { msgId }, row);
    return this._meta(this.db.get('meta', { msgId }));
  }

  // ---- replies ---------------------------------------------------------
  setReply(msgId, replyToId, replyToPeer = '') {
    const id = Number(msgId) || 0;
    this.db.upsert('replies', { msgId: id }, {
      msgId: id,
      replyToId: Number(replyToId) || 0,
      replyToPeer: peerKeyOf(replyToPeer),
    });
    this.db.upsert('meta', { msgId: id }, this._rowFor(id, { replyToId: Number(replyToId) || 0 }));
    return this.getReply(id);
  }

  getReply(msgId) {
    const row = this.db.get('replies', { msgId: Number(msgId) || 0 });
    if (!row) return null;
    return {
      msgId: Number(row.msgId),
      replyToId: Number(row.replyToId) || 0,
      replyToPeer: String(row.replyToPeer ?? ''),
    };
  }

  // ---- drafts ----------------------------------------------------------
  setDraft(peer, text = '', entities = []) {
    const peerKey = typeof peer === 'string' ? peer : peerKeyOf(peer);
    const list = Array.isArray(entities) ? entities : [];
    const row = {
      peerKey,
      text: String(text ?? ''),
      entities: JSON.stringify(list),
      date: now(),
    };
    this.db.upsert('drafts', { peerKey }, row);
    return this.getDraft(peerKey);
  }

  _draft(row) {
    if (!row) return null;
    let entities = [];
    try {
      const parsed = JSON.parse(row.entities ?? '[]');
      if (Array.isArray(parsed)) entities = parsed;
    } catch {
      entities = [];
    }
    return {
      peerKey: String(row.peerKey),
      text: String(row.text ?? ''),
      entities,
      date: Number(row.date) || 0,
    };
  }

  getDraft(peer) {
    const peerKey = typeof peer === 'string' ? peer : peerKeyOf(peer);
    return this._draft(this.db.get('drafts', { peerKey }));
  }

  listDrafts() {
    return this.db.all('drafts').map((row) => this._draft(row));
  }

  clearDraft(peer) {
    const peerKey = typeof peer === 'string' ? peer : peerKeyOf(peer);
    return this.db.delete('drafts', { peerKey }) > 0;
  }

  // ---- reactions -------------------------------------------------------
  addReaction(msgId, emoji) {
    const id = Number(msgId) || 0;
    const value = String(emoji ?? '');
    if (!id || !value) return false;
    if (!this.db.get('reactions', { msgId: id, emoji: value })) {
      this.db.insert('reactions', { msgId: id, emoji: value, date: now() });
    }
    return true;
  }

  removeReaction(msgId, emoji) {
    const id = Number(msgId) || 0;
    const value = String(emoji ?? '');
    return this.db.delete('reactions', { msgId: id, emoji: value }) > 0;
  }

  getReactions(msgId) {
    const id = Number(msgId) || 0;
    return this.db.all('reactions', { msgId: id }).map((row) => String(row.emoji));
  }

  close() {
    this.db.close();
  }
}

export default MessagingExtraStore;
