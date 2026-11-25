// Peer-to-peer call *signaling* state, deliberately kept separate from
// store.js so the existing store/router code is untouched.
//
// Uses a dedicated node:sqlite DatabaseSync at <dataDir>/calls.sqlite (Node
// >= 22.5, zero npm dependencies). Falls back to <dataDir>/calls.json when
// node:sqlite is unavailable or when { dbDriver: 'json' } is requested.
// Every method is synchronous so it can be called straight from a TL handler.
//
// This store records signaling state only. It never carries RTP/media, and it
// does not implement a relay, ICE negotiation or encryption of media.

import fs from 'node:fs';
import path from 'node:path';

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  access_hash TEXT NOT NULL DEFAULT '0',
  caller_id TEXT NOT NULL DEFAULT '0',
  callee_id TEXT NOT NULL DEFAULT '0',
  video INTEGER NOT NULL DEFAULT 0,
  date INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'requested',
  g_a_hash TEXT NOT NULL DEFAULT '',
  g_b TEXT NOT NULL DEFAULT '',
  g_a TEXT NOT NULL DEFAULT '',
  key_fingerprint TEXT NOT NULL DEFAULT '0',
  protocol TEXT NOT NULL DEFAULT '{}',
  rating INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  duration INTEGER NOT NULL DEFAULT 0,
  end_date INTEGER NOT NULL DEFAULT 0,
  accepted_date INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS candidates (
  call_id TEXT NOT NULL,
  candidate_id INTEGER NOT NULL,
  sdp TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (call_id, candidate_id)
);
`;

// camelCase public field -> SQL column. int64 values are stored as TEXT so
// values above Number.MAX_SAFE_INTEGER keep their full precision.
const FIELDS = Object.freeze({
  id: 'id',
  accessHash: 'access_hash',
  callerId: 'caller_id',
  calleeId: 'callee_id',
  video: 'video',
  date: 'date',
  status: 'status',
  gAHash: 'g_a_hash',
  gB: 'g_b',
  gA: 'g_a',
  keyFingerprint: 'key_fingerprint',
  protocol: 'protocol',
  rating: 'rating',
  reason: 'reason',
  duration: 'duration',
  endDate: 'end_date',
  acceptedDate: 'accepted_date',
  updatedAt: 'updated_at',
});

const now = () => Math.floor(Date.now() / 1000);

function keyOf(value) {
  if (value === undefined || value === null) return '0';
  if (typeof value === 'bigint') return value.toString(10);
  return String(value);
}

/** int64 values are exposed as bigint, matching TL long semantics. */
function toLong(value, fallback = 0n) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? BigInt(Math.trunc(value)) : fallback;
  const text = String(value).trim();
  // node:sqlite renders JS numbers bound to TEXT columns as "33.0".
  const match = text.match(/^(-?\d+)(?:\.0+)?$/);
  return match ? BigInt(match[1]) : fallback;
}

function intOf(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function sqliteValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return v.toString(10);
  // Bind numbers as plain decimal text: node:sqlite would otherwise turn a
  // number bound to a TEXT column into "33.0".
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v;
  if (v && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

function parseJSON(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function optionsOf(dataDir, options) {
  if (dataDir && typeof dataDir === 'object' && !Array.isArray(dataDir)) {
    return { dataDir: dataDir.dataDir || dataDir.dir || './data', options: { ...dataDir, ...options } };
  }
  return { dataDir: dataDir || './data', options: options || {} };
}

export class CallStore {
  constructor(dataDir = './data', options = {}) {
    const resolved = optionsOf(dataDir, options);
    this.dataDir = resolved.dataDir;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.driverKind = resolved.options.dbDriver || process.env.DB_DRIVER || 'sqlite';
    const jsonFile = path.join(this.dataDir, 'calls.json');
    if (this.driverKind === 'json') {
      this.file = jsonFile;
      this.data = { calls: {}, candidates: {} };
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
    } else {
      try {
        const sqlite = process.getBuiltinModule?.('node:sqlite') || globalThis.__nodeSqlite;
        if (!sqlite?.DatabaseSync) throw new Error('node:sqlite unavailable');
        this.file = path.join(this.dataDir, 'calls.sqlite');
        this.db = new sqlite.DatabaseSync(this.file);
        this.db.exec(CREATE_SQL);
      } catch {
        this.driverKind = 'json';
        this.file = jsonFile;
        this.data = { calls: {}, candidates: {} };
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
    if (this.driverKind === 'json') this._save();
  }

  // ---- normalizers -----------------------------------------------------
  _call(row) {
    if (!row) return null;
    const rating = row.rating ?? row.rating_value;
    return {
      id: toLong(row.id),
      accessHash: toLong(row.access_hash ?? row.accessHash),
      callerId: toLong(row.caller_id ?? row.callerId),
      calleeId: toLong(row.callee_id ?? row.calleeId),
      video: Boolean(row.video),
      date: intOf(row.date),
      status: String(row.status || 'requested'),
      gAHash: String(row.g_a_hash ?? row.gAHash ?? ''),
      gB: String(row.g_b ?? row.gB ?? ''),
      gA: String(row.g_a ?? row.gA ?? ''),
      keyFingerprint: toLong(row.key_fingerprint ?? row.keyFingerprint),
      protocol: parseJSON(row.protocol, {}),
      rating: rating === undefined || rating === null || rating === '' ? null : intOf(rating),
      reason: String(row.reason || ''),
      duration: intOf(row.duration),
      endDate: intOf(row.end_date ?? row.endDate),
      acceptedDate: intOf(row.accepted_date ?? row.acceptedDate),
      updatedAt: intOf(row.updated_at ?? row.updatedAt),
    };
  }

  _rows(sql, params = []) {
    if (this.driverKind === 'sqlite') return this.db.prepare(sql).all(...params);
    return [];
  }

  // ---- calls -----------------------------------------------------------
  /** Create a new signaling record. Initial status is "requested" (ringing). */
  createCall({ id, accessHash = 0, callerId = 0, calleeId = 0, video = false, date } = {}) {
    if (id === undefined || id === null) throw new Error('CallStore.createCall: id is required');
    const key = keyOf(id);
    const row = {
      id: key,
      accessHash: sqliteValue(accessHash),
      callerId: sqliteValue(callerId),
      calleeId: sqliteValue(calleeId),
      video: video ? 1 : 0,
      date: intOf(date, now()),
      status: 'requested',
      gAHash: '',
      gB: '',
      gA: '',
      keyFingerprint: '0',
      protocol: '{}',
      rating: null,
      reason: '',
      duration: 0,
      endDate: 0,
      acceptedDate: 0,
      updatedAt: now(),
    };
    if (this.driverKind === 'sqlite') {
      this.db.prepare(`INSERT INTO calls (${Object.values(FIELDS).join(', ')})
        VALUES (${Object.values(FIELDS).map(() => '?').join(', ')})
        ON CONFLICT(id) DO UPDATE SET
          access_hash = excluded.access_hash, caller_id = excluded.caller_id,
          callee_id = excluded.callee_id, video = excluded.video, date = excluded.date,
          status = excluded.status, updated_at = excluded.updated_at`)
        .run(...Object.keys(FIELDS).map((field) => sqliteValue(row[field])));
    } else {
      this.data.calls[key] = row;
      this._save();
    }
    return this.getCall(key);
  }

  getCall(id) {
    const key = keyOf(id);
    if (this.driverKind === 'sqlite') {
      return this._call(this.db.prepare('SELECT * FROM calls WHERE id = ?').get(key));
    }
    return this._call(this.data.calls[key]);
  }

  /** Merge a whitelisted set of fields into an existing call. */
  updateCall(id, patch = {}) {
    const key = keyOf(id);
    const entries = Object.entries(patch || {}).filter(([k]) => FIELDS[k] && k !== 'id' && k !== 'updatedAt');
    const updatedAt = patch?.updatedAt !== undefined ? intOf(patch.updatedAt) : now();
    if (this.driverKind === 'sqlite') {
      const existing = this.db.prepare('SELECT * FROM calls WHERE id = ?').get(key);
      if (!existing) return null;
      const sets = entries.map(([k]) => `${FIELDS[k]} = ?`);
      sets.push('updated_at = ?');
      this.db.prepare(`UPDATE calls SET ${sets.join(', ')} WHERE id = ?`)
        .run(...entries.map(([, v]) => sqliteValue(v)), updatedAt, key);
    } else {
      const existing = this.data.calls[key];
      if (!existing) return null;
      const merged = { ...existing };
      for (const [k, v] of entries) merged[FIELDS[k]] = v === undefined || v === null ? null : sqliteValue(v);
      merged.updated_at = updatedAt;
      this.data.calls[key] = merged;
      this._save();
    }
    return this.getCall(key);
  }

  acceptCall(id) {
    return this.updateCall(id, { status: 'accepted', acceptedDate: now() });
  }

  declineCall(id) {
    return this.updateCall(id, { status: 'declined', endDate: now() });
  }

  discardCall(id, patch = {}) {
    return this.updateCall(id, { status: 'discarded', endDate: now(), ...patch });
  }

  listCalls(userId) {
    const key = keyOf(userId);
    if (this.driverKind === 'sqlite') {
      return this._rows('SELECT * FROM calls WHERE caller_id = ? OR callee_id = ? ORDER BY date DESC, rowid DESC', [key, key])
        .map((row) => this._call(row));
    }
    return Object.values(this.data.calls)
      .filter((row) => keyOf(row.caller_id ?? row.callerId) === key || keyOf(row.callee_id ?? row.calleeId) === key)
      .sort((a, b) => intOf(b.date) - intOf(a.date))
      .map((row) => this._call(row));
  }

  setRating(id, rating) {
    return this.updateCall(id, { rating: intOf(rating) });
  }

  // ---- ICE candidates (signaling only, never media) -------------------
  putCandidate(callId, { id: candidateId, sdp = '' } = {}) {
    const key = keyOf(callId);
    const cid = intOf(candidateId);
    const value = String(sdp ?? '');
    if (this.driverKind === 'sqlite') {
      this.db.prepare(`INSERT INTO candidates (call_id, candidate_id, sdp) VALUES (?, ?, ?)
        ON CONFLICT(call_id, candidate_id) DO UPDATE SET sdp = excluded.sdp`)
        .run(key, cid, value);
    } else {
      (this.data.candidates[key] ||= {})[String(cid)] = sdp;
      this._save();
    }
    return { id: cid, sdp: value };
  }

  listCandidates(callId) {
    const key = keyOf(callId);
    if (this.driverKind === 'sqlite') {
      return this._rows('SELECT candidate_id, sdp FROM candidates WHERE call_id = ? ORDER BY candidate_id ASC', [key])
        .map((row) => ({ id: intOf(row.candidate_id), sdp: String(row.sdp ?? '') }));
    }
    const bucket = this.data.candidates[key] || {};
    return Object.keys(bucket)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => ({ id: intOf(k), sdp: String(bucket[k] ?? '') }));
  }

  close() {
    if (this.db) this.db.close();
    else this._save();
  }

  _save() {
    if (this.driverKind === 'json') fs.writeFileSync(this.file, JSON.stringify(this.data));
  }
}

export default CallStore;
