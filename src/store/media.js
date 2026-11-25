// Media storage with its own node:sqlite database (zero npm dependencies).
// Kept separate from Store so the existing store/router code is untouched.
// All methods are synchronous.
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS parts (
  file_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  total_parts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (file_id, part)
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  access_hash TEXT NOT NULL DEFAULT '0',
  file_name TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '0',
  data BLOB NOT NULL,
  mtime INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  access_hash TEXT NOT NULL DEFAULT '0',
  data BLOB NOT NULL,
  mtime INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0
);
`;

function nodeSqlite() {
  try {
    return process.getBuiltinModule?.('node:sqlite') || globalThis.__nodeSqlite || null;
  } catch {
    return null;
  }
}

/** Stable text key for long ids (bigint, number or string). */
function keyOf(value) {
  if (value === undefined || value === null) return '0';
  if (typeof value === 'bigint') return value.toString(10);
  return String(value);
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.alloc(0);
}

/** Return a plain number when exactly representable, otherwise a bigint. */
function num(value) {
  if (value === undefined || value === null) return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : BigInt(String(value));
}

function now() {
  return Math.floor(Date.now() / 1000);
}

export class MediaStore {
  constructor(dataDir = './data', options = {}) {
    this.dataDir = String(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    const sqlite = nodeSqlite();
    if (sqlite && options.driver !== 'json') {
      this.driverKind = 'sqlite';
      this.file = path.join(this.dataDir, 'media.sqlite');
      this.db = new sqlite.DatabaseSync(this.file);
      this.db.exec(SCHEMA);
    } else {
      this.driverKind = 'json';
      this.file = path.join(this.dataDir, 'media.json');
      this.data = { parts: {}, documents: {}, photos: {} };
      if (fs.existsSync(this.file)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
          for (const table of Object.keys(this.data)) {
            if (parsed[table] && typeof parsed[table] === 'object') this.data[table] = parsed[table];
          }
        } catch {
          // Corrupt cache: start empty rather than crash the server.
        }
      }
    }
  }

  // ---- uploaded file parts --------------------------------------------
  saveFilePart(fileId, part, bytes) {
    const id = keyOf(fileId);
    const n = Number(part) || 0;
    const buf = toBuffer(bytes);
    if (this.driverKind === 'sqlite') {
      this.db.prepare(`INSERT INTO parts (file_id, part, bytes, total_parts) VALUES (?, ?, ?, 0)
        ON CONFLICT(file_id, part) DO UPDATE SET bytes = excluded.bytes`).run(id, n, buf);
    } else {
      (this.data.parts[id] ||= {})[String(n)] = buf.toString('base64');
      this._save();
    }
    return true;
  }

  saveBigFilePart(fileId, filePart, fileTotalParts, bytes) {
    const id = keyOf(fileId);
    const part = Number(filePart) || 0;
    const total = Number(fileTotalParts) || 0;
    const buf = toBuffer(bytes);
    if (this.driverKind === 'sqlite') {
      this.db.prepare(`INSERT INTO parts (file_id, part, bytes, total_parts) VALUES (?, ?, ?, ?)
        ON CONFLICT(file_id, part) DO UPDATE SET bytes = excluded.bytes, total_parts = excluded.total_parts`)
        .run(id, part, buf, total);
    } else {
      (this.data.parts[id] ||= {})[String(part)] = buf.toString('base64');
      this._save();
    }
    return true;
  }

  /** All parts for a file, concatenated in ascending part order. */
  getFileParts(fileId) {
    const id = keyOf(fileId);
    if (this.driverKind === 'sqlite') {
      const rows = this.db.prepare('SELECT bytes FROM parts WHERE file_id = ? ORDER BY part ASC').all(id);
      return Buffer.concat(rows.map((row) => toBuffer(row.bytes)));
    }
    const parts = this.data.parts[id] || {};
    return Buffer.concat(
      Object.keys(parts).sort((a, b) => Number(a) - Number(b)).map((k) => Buffer.from(parts[k], 'base64')),
    );
  }

  /** Convenience alias used by upload.getFile-style handlers. */
  getFile(fileId) {
    return this.getFileParts(fileId);
  }

  // ---- documents -------------------------------------------------------
  putDocument({ id, accessHash = 0, fileName = '', mimeType = '', size, data, mtime } = {}) {
    if (id === undefined || id === null) throw new Error('MediaStore.putDocument: id is required');
    const buf = toBuffer(data);
    const row = {
      id: keyOf(id),
      accessHash: keyOf(accessHash),
      fileName: String(fileName || ''),
      mimeType: String(mimeType || ''),
      size: String(size === undefined || size === null ? buf.length : size),
      data: buf,
      mtime: Number(mtime || now()),
    };
    if (this.driverKind === 'sqlite') {
      this.db.prepare(`INSERT INTO documents (id, access_hash, file_name, mime_type, size, data, mtime)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET access_hash = excluded.access_hash, file_name = excluded.file_name,
          mime_type = excluded.mime_type, size = excluded.size, data = excluded.data, mtime = excluded.mtime`)
        .run(row.id, row.accessHash, row.fileName, row.mimeType, row.size, row.data, row.mtime);
    } else {
      this.data.documents[row.id] = { ...row, data: buf.toString('base64') };
      this._save();
    }
    return this.getDocument(id);
  }

  getDocument(id) {
    const key = keyOf(id);
    let row;
    if (this.driverKind === 'sqlite') {
      row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(key);
    } else {
      row = this.data.documents[key];
    }
    if (!row) return null;
    return {
      id: num(row.id),
      accessHash: num(row.access_hash ?? row.accessHash),
      fileName: row.file_name ?? row.fileName ?? '',
      mimeType: row.mime_type ?? row.mimeType ?? '',
      size: num(row.size),
      data: toBuffer(row.data),
      mtime: Number(row.mtime || 0),
    };
  }

  // ---- photos ----------------------------------------------------------
  putPhoto({ id, accessHash = 0, data, width = 0, height = 0, mtime } = {}) {
    if (id === undefined || id === null) throw new Error('MediaStore.putPhoto: id is required');
    const buf = toBuffer(data);
    const row = {
      id: keyOf(id),
      accessHash: keyOf(accessHash),
      data: buf,
      mtime: Number(mtime || now()),
      width: Number(width) || 0,
      height: Number(height) || 0,
    };
    if (this.driverKind === 'sqlite') {
      this.db.prepare(`INSERT INTO photos (id, access_hash, data, mtime, width, height)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET access_hash = excluded.access_hash, data = excluded.data,
          mtime = excluded.mtime, width = excluded.width, height = excluded.height`)
        .run(row.id, row.accessHash, row.data, row.mtime, row.width, row.height);
    } else {
      this.data.photos[row.id] = { ...row, data: buf.toString('base64') };
      this._save();
    }
    return this.getPhoto(id);
  }

  getPhoto(id) {
    const key = keyOf(id);
    let row;
    if (this.driverKind === 'sqlite') {
      row = this.db.prepare('SELECT * FROM photos WHERE id = ?').get(key);
    } else {
      row = this.data.photos[key];
    }
    if (!row) return null;
    return {
      id: num(row.id),
      accessHash: num(row.access_hash ?? row.accessHash),
      data: toBuffer(row.data),
      mtime: Number(row.mtime || 0),
      width: Number(row.width || 0),
      height: Number(row.height || 0),
    };
  }

  close() {
    if (this.db) this.db.close();
    else this._save();
  }

  _save() {
    if (this.driverKind === 'json') fs.writeFileSync(this.file, JSON.stringify(this.data));
  }
}

export default MediaStore;
