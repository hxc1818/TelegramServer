// Sticker / emoji / saved-GIF storage, deliberately kept separate from store.js.
//
// Uses its own node:sqlite DatabaseSync at <dataDir>/stickers.sqlite (Node >=
// 22.5, no npm dependencies) with a JSON-file fallback. Every method is
// synchronous so it can be called straight from a TL handler.
//
// A small default sticker set is seeded on first run so TDesktop's sticker
// panel is never completely empty.

import fs from 'node:fs';
import path from 'node:path';

const TABLE_FIELDS = {
  sticker_sets: ['id', 'accessHash', 'title', 'shortName', 'count', 'hash', 'featured', 'date'],
  stickers: ['setId', 'documentId', 'emoji', 'position', 'data'],
  recent: ['userId', 'documentId', 'position'],
  emoji_packs: ['id', 'name', 'data', 'date'],
  saved_gifs: ['documentId', 'position', 'data'],
};

const CREATE_SQL = {
  sticker_sets: `id TEXT PRIMARY KEY, access_hash TEXT NOT NULL DEFAULT '0', title TEXT NOT NULL DEFAULT '',
    short_name TEXT UNIQUE, count INTEGER NOT NULL DEFAULT 0, hash INTEGER NOT NULL DEFAULT 0,
    featured INTEGER NOT NULL DEFAULT 1, date INTEGER NOT NULL DEFAULT 0`,
  stickers: `set_id TEXT NOT NULL, document_id TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, PRIMARY KEY (set_id, document_id)`,
  recent: `user_id TEXT NOT NULL, document_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, document_id)`,
  emoji_packs: `id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', data TEXT NOT NULL, date INTEGER NOT NULL DEFAULT 0`,
  saved_gifs: `document_id TEXT PRIMARY KEY, position INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL`,
};

const RECENT_LIMIT = 30;

const now = () => Math.floor(Date.now() / 1000);
const columnOf = (field) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Stable decimal text key for int64 ids (bigint, number or string). */
function keyOf(value) {
  if (value === undefined || value === null) return '0';
  return String(value);
}

/** A plain number when exactly representable, otherwise a bigint. */
function num(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'bigint') return value;
  const text = String(value);
  if (/^-?\d+$/.test(text)) {
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : BigInt(text);
  }
  return text;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

/** JSON.stringify that keeps int64 values as decimal strings. */
function stringify(value) {
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function parseJSON(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  if (typeof value === 'object') return value;
  return fallback;
}

/** FNV-1a 32-bit, used for stable content hashes (the TL hash field is long). */
function hashOf(parts) {
  let h = 0x811c9dc5;
  const text = parts.map((p) => String(p)).join('\u0000');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hashOfStickers(stickers) {
  return hashOf(stickers.map((s) => `${keyOf(s.id)}:${s.emoji || ''}`));
}

function emojiOf(document) {
  if (!document || typeof document !== 'object') return '';
  if (document.emoji !== undefined && document.emoji !== null) return String(document.emoji);
  const attributes = Array.isArray(document.attributes) ? document.attributes : [];
  const sticker = attributes.find((a) => a && (a.type === 'sticker' || a.alt !== undefined));
  return sticker ? String(sticker.alt || sticker.emoji || '') : '';
}

/** Flatten a sticker document (plain object) into the shape we persist. */
function normalizeSticker(document = {}) {
  const src = document && typeof document === 'object' ? document : { id: document };
  return {
    ...src,
    id: num(src.id ?? src.documentId ?? 0),
    accessHash: num(src.accessHash ?? src.access_hash ?? 0),
    emoji: emojiOf(src),
    mimeType: String(src.mimeType ?? src.mime_type ?? 'image/webp'),
    size: toNumber(src.size ?? 0, 0),
  };
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
    if (!keys.length) return row;
    const sql = `INSERT INTO ${table} (${keys.map(columnOf).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    this.db.prepare(sql).run(...keys.map((k) => sqliteValue(row[k])));
    return row;
  }

  update(table, where, patch) {
    const keys = Object.keys(patch || {}).filter((k) => (TABLE_FIELDS[table] || []).includes(k));
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
        // Corrupt cache: start empty rather than crash the server.
      }
    }
    this._save();
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data));
  }

  _match(row, where) {
    return Object.entries(where || {}).every(([k, v]) => (
      row[k] === v || (row[columnOf(k)] !== undefined && row[columnOf(k)] === v)
    ));
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

function optionsOf(dataDir, options) {
  if (dataDir && typeof dataDir === 'object' && !Array.isArray(dataDir)) {
    return { dataDir: dataDir.dataDir || dataDir.dir || './data', options: { ...dataDir, ...options } };
  }
  return { dataDir: dataDir || './data', options: options || {} };
}

export class StickerStore {
  constructor(dataDir = './data', options = {}) {
    const resolved = optionsOf(dataDir, options);
    this.dataDir = resolved.dataDir;
    this.driverKind = resolved.options.dbDriver || resolved.options.driver || process.env.DB_DRIVER || 'sqlite';
    const jsonFile = path.join(this.dataDir, 'stickers.json');
    if (this.driverKind === 'json') {
      this.driver = new JSONDriver(jsonFile);
    } else {
      try {
        const sqlite = process.getBuiltinModule?.('node:sqlite') || globalThis.__nodeSqlite;
        if (!sqlite) throw new Error('node:sqlite unavailable');
        this.driver = new SQLiteDriver(path.join(this.dataDir, 'stickers.sqlite'), sqlite.DatabaseSync);
      } catch {
        this.driverKind = 'json';
        this.driver = new JSONDriver(jsonFile);
      }
    }
    this._seedDefaultSet();
  }

  // ---- normalizers ------------------------------------------------------
  _sticker(row) {
    if (!row) return null;
    const data = parseJSON(row.data ?? row.data_json, {}) || {};
    return normalizeSticker({
      ...data,
      id: num(row.document_id ?? row.documentId ?? data.id),
      accessHash: num(data.accessHash ?? data.access_hash ?? 0),
      emoji: row.emoji ?? data.emoji ?? '',
      setId: num(row.set_id ?? row.setId ?? 0),
    });
  }

  _stickersOf(setId) {
    return this.driver.all('stickers', { setId: keyOf(setId) }, { orderBy: 'position' })
      .map((row) => this._sticker(row));
  }

  _set(row) {
    if (!row) return null;
    const stickers = this._stickersOf(row.id ?? row.id_);
    return {
      id: num(row.id ?? row.id_),
      accessHash: num(row.access_hash ?? row.accessHash ?? 0),
      title: row.title ?? '',
      shortName: row.short_name ?? row.shortName ?? '',
      count: stickers.length || toNumber(row.count, 0),
      hash: toNumber(row.hash, hashOfStickers(stickers)),
      featured: row.featured === undefined ? true : Boolean(row.featured),
      date: toNumber(row.date, 0),
      stickers,
    };
  }

  _refreshSet(setId) {
    const stickers = this._stickersOf(setId);
    this.driver.update('sticker_sets', { id: keyOf(setId) }, {
      count: stickers.length,
      hash: hashOfStickers(stickers),
    });
  }

  _findSet(input) {
    if (input === undefined || input === null) return null;
    if (typeof input === 'object') {
      const id = input.id ?? input.setId ?? input.stickerset?.id;
      const shortName = input.shortName ?? input.short_name ?? input.stickerset?.shortName;
      if (id !== undefined) {
        const byId = this.driver.get('sticker_sets', { id: keyOf(id) });
        if (byId) return byId;
      }
      if (shortName) {
        const byName = this.driver.get('sticker_sets', { shortName: String(shortName) });
        if (byName) return byName;
      }
      return null;
    }
    return this.driver.get('sticker_sets', { id: keyOf(input) })
      || this.driver.get('sticker_sets', { shortName: String(input) });
  }

  // ---- sticker sets -----------------------------------------------------
  createStickerSet({
    id, accessHash = 0, title = '', shortName = '', stickers = [], featured = true,
  } = {}) {
    const name = String(shortName || '');
    const setId = id === undefined || id === null
      ? BigInt(0x54000000000000) + BigInt(hashOf(['stickerSet', name]) >>> 0)
      : id;
    const existing = this._findSet(setId) || (name ? this._findSet(name) : null);
    const key = existing ? keyOf(existing.id ?? existing.id_) : keyOf(setId);
    const row = {
      id: key,
      accessHash: keyOf(accessHash || 0),
      title: String(title || ''),
      shortName: name,
      count: (Array.isArray(stickers) ? stickers.length : 0),
      hash: hashOfStickers(Array.isArray(stickers) ? stickers.map(normalizeSticker) : []),
      featured: featured === false ? 0 : 1,
      date: now(),
    };
    this.driver.upsert('sticker_sets', { id: key }, row);

    this.driver.delete('stickers', { setId: key });
    let position = 0;
    for (const raw of Array.isArray(stickers) ? stickers : []) {
      const document = normalizeSticker(raw);
      this.driver.insert('stickers', {
        setId: key,
        documentId: keyOf(document.id),
        emoji: document.emoji || '',
        position: ++position,
        data: stringify(document),
      });
    }
    return this._set(this.driver.get('sticker_sets', { id: key }));
  }

  getStickerSet(idOrShortName) {
    return this._set(this._findSet(idOrShortName));
  }

  /** Every known set, used by TDesktop's featured/sticker panels. */
  listStickerSets() {
    return this.driver.all('sticker_sets', {}, { orderBy: '-date' }).map((row) => this._set(row));
  }

  getFeaturedStickers() {
    return this.listStickerSets().filter((set) => set.featured);
  }

  addSticker(setId, document) {
    const set = this._findSet(setId);
    if (!set) return null;
    const key = keyOf(set.id ?? set.id_);
    const sticker = normalizeSticker(document);
    const docKey = keyOf(sticker.id);
    const where = { setId: key, documentId: docKey };
    const existing = this.driver.get('stickers', where);
    const position = existing
      ? toNumber(existing.position, 0)
      : this.driver.all('stickers', { setId: key }, { orderBy: '-position' })
        .reduce((max, row) => Math.max(max, toNumber(row.position, 0)), 0) + 1;
    this.driver.upsert('stickers', where, {
      ...where,
      emoji: sticker.emoji || '',
      position,
      data: stringify(sticker),
    });
    this._refreshSet(key);
    return this.getStickerSet(key);
  }

  /** Remove a document from the set that contains it. Returns the updated set. */
  removeSticker(setId, document) {
    let target = setId;
    let sticker = document;
    if (sticker === undefined && target && typeof target === 'object') {
      sticker = target.document ?? target.sticker ?? target.documentId;
      target = target.setId ?? target.stickerset ?? target.id;
    }
    if (target === undefined && sticker !== undefined) {
      const found = this.findSetByDocument(sticker);
      if (!found) return null;
      target = found.id;
    }
    const set = this._findSet(target);
    if (!set) return null;
    const key = keyOf(set.id ?? set.id_);
    const docKey = keyOf(sticker && typeof sticker === 'object'
      ? (sticker.id ?? sticker.documentId)
      : sticker);
    this.driver.delete('stickers', { setId: key, documentId: docKey });
    this._refreshSet(key);
    return this.getStickerSet(key);
  }

  findSetByDocument(documentId) {
    const key = keyOf(documentId && typeof documentId === 'object'
      ? (documentId.id ?? documentId.documentId)
      : documentId);
    const row = this.driver.get('stickers', { documentId: key });
    return row ? this._set(this._findSet(row.set_id ?? row.setId)) : null;
  }

  /** All sticker documents, optionally filtered by their emoji/alt text. */
  listStickers({ emoticon, setId } = {}) {
    let rows = this.driver.all('stickers', setId === undefined ? {} : { setId: keyOf(setId) }, { orderBy: 'position' });
    if (emoticon) {
      const needle = String(emoticon).toLowerCase();
      rows = rows.filter((row) => String(row.emoji || '').toLowerCase().includes(needle));
    }
    return rows.map((row) => this._sticker(row));
  }

  // ---- recent stickers --------------------------------------------------
  saveRecent(userId, document) {
    const userKey = keyOf(userId);
    const sticker = normalizeSticker(document);
    const docKey = keyOf(sticker.id);
    const rows = this.driver.all('recent', { userId: userKey }, { orderBy: '-position' });
    const position = rows.reduce((max, row) => Math.max(max, toNumber(row.position, 0)), 0) + 1;
    this.driver.upsert('recent', { userId: userKey, documentId: docKey }, {
      userId: userKey, documentId: docKey, position,
    });
    const trimmed = this.driver.all('recent', { userId: userKey }, { orderBy: '-position' }).slice(RECENT_LIMIT);
    for (const row of trimmed) {
      this.driver.delete('recent', { userId: userKey, documentId: keyOf(row.document_id ?? row.documentId) });
    }
    return true;
  }

  listRecent(userId) {
    const userKey = keyOf(userId);
    return this.driver.all('recent', { userId: userKey }, { orderBy: '-position' }).map((row) => {
      const docKey = keyOf(row.document_id ?? row.documentId);
      const sticker = this.driver.get('stickers', { documentId: docKey });
      return sticker ? this._sticker(sticker) : normalizeSticker({ id: num(docKey) });
    });
  }

  // ---- emoji packs ------------------------------------------------------
  createEmojiPack(input = {}, documentIds) {
    const spec = typeof input === 'string' || typeof input === 'bigint' || typeof input === 'number'
      ? { name: String(input), documentIds }
      : (input || {});
    const name = String(spec.name ?? spec.shortName ?? 'popular');
    const id = spec.id === undefined || spec.id === null ? name : spec.id;
    const ids = (spec.documentIds ?? spec.documents ?? spec.ids ?? documentIds ?? [])
      .map((value) => keyOf(value && typeof value === 'object' ? (value.id ?? value.documentId) : value));
    const pack = {
      id: num(id),
      name,
      documentIds: ids.map((value) => num(value)),
      hash: hashOf(ids),
    };
    this.driver.upsert('emoji_packs', { id: keyOf(id) }, {
      id: keyOf(id), name, data: stringify(pack), date: now(),
    });
    return this.getEmojiPack(id);
  }

  getEmojiPack(idOrName) {
    const row = this.driver.get('emoji_packs', { id: keyOf(idOrName) })
      || this.driver.get('emoji_packs', { name: String(idOrName) });
    if (!row) return null;
    const pack = parseJSON(row.data, null);
    if (!pack) return null;
    return { ...pack, id: num(row.id), name: row.name ?? pack.name ?? '', date: toNumber(row.date, 0) };
  }

  // ---- saved GIFs -------------------------------------------------------
  listSavedGifs() {
    return this.driver.all('saved_gifs', {}, { orderBy: 'position' }).map((row) => this._sticker(row));
  }

  saveGif(document, unsave = false) {
    const gif = normalizeSticker(document);
    const key = keyOf(gif.id);
    if (unsave) {
      this.driver.delete('saved_gifs', { documentId: key });
      return true;
    }
    const rows = this.driver.all('saved_gifs', {}, { orderBy: '-position' });
    const existing = this.driver.get('saved_gifs', { documentId: key });
    const position = existing
      ? toNumber(existing.position, 0)
      : rows.reduce((max, row) => Math.max(max, toNumber(row.position, 0)), 0) + 1;
    this.driver.upsert('saved_gifs', { documentId: key }, {
      documentId: key, position, data: stringify(gif),
    });
    return true;
  }

  // ---- defaults ---------------------------------------------------------
  _seedDefaultSet() {
    if (this.driver.all('sticker_sets').length) return;
    const emojis = ['\u{1F44B}', '\u2764\uFE0F', '\u{1F44D}'];
    const stickers = emojis.map((emoji, index) => ({
      id: BigInt(900000000000001) + BigInt(index),
      accessHash: BigInt(987654321) + BigInt(index),
      emoji,
      mimeType: 'image/webp',
      size: 1024,
      fileName: `welcome_${index + 1}.webp`,
      attributes: [
        { type: 'imageSize', w: 512, h: 512 },
        { type: 'filename', fileName: `welcome_${index + 1}.webp` },
        { type: 'sticker', alt: emoji },
      ],
    }));
    this.createStickerSet({
      id: BigInt(900000000000001),
      accessHash: BigInt(123456789),
      title: 'Welcome',
      shortName: 'telegramserver_welcome',
      stickers,
      featured: true,
    });
  }

  close() {
    this.driver.close();
  }
}

export default StickerStore;
