// Registry of data centers: addresses, per-DC RSA key material, auth-key -> DC
// bindings and authorization tokens. All methods are synchronous so the RPC
// handlers can call them directly. Persistence uses node:sqlite (built into
// Node >= 22.5) with a plain JSON fallback when sqlite is unavailable.
//
// Key material is generated with src/crypto/rsa.js. The fingerprint is the low
// 64 bits of SHA1(TL_string(n) || TL_string(e)), i.e. the value carried in
// resPQ#05162463.server_public_key_fingerprints (schema/mtproto.tl line 17).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateRSA, rsaFingerprint } from '../crypto/rsa.js';

const DEFAULT_DCS = Object.freeze([{ id: 1, host: '127.0.0.1', port: 10443 }]);

function nodeSqlite() {
  try {
    return process.getBuiltinModule?.('node:sqlite') || globalThis.__nodeSqlite || null;
  } catch {
    return null;
  }
}

function keyIdHex(value) {
  if (value === undefined || value === null) return '';
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (typeof value === 'bigint') {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
    return b.toString('hex');
  }
  return String(value);
}

function keyIdBig(value) {
  if (typeof value === 'bigint') return value & 0xffffffffffffffffn;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const b = Buffer.alloc(8);
    Buffer.from(value).copy(b, 0, 0, 8);
    return b.readBigUInt64LE(0);
  }
  const text = String(value).replace(/^0x/i, '');
  if (/^[0-9a-f]+$/i.test(text) && text.length <= 16) {
    const b = Buffer.alloc(8);
    Buffer.from(text.padStart(16, '0'), 'hex').copy(b);
    return b.readBigUInt64LE(0);
  }
  return /^-?\d+$/.test(String(value)) ? BigInt(String(value)) : 0n;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function emptyState() {
  return {
    dcs: [],
    keys: {},
    authKeys: {},
    cdnConfig: null,
    tokens: {},
    counters: { file: 0 },
  };
}

class SqliteBackend {
  constructor(file, DatabaseSync) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.kind = 'sqlite';
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('CREATE TABLE IF NOT EXISTS dc_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this._upsert = this.db.prepare(
      'INSERT INTO dc_kv (key, value) VALUES (?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
  }

  load() {
    const rows = this.db.prepare('SELECT key, value FROM dc_kv').all();
    const data = {};
    for (const row of rows) {
      try {
        data[row.key] = JSON.parse(row.value);
      } catch {
        data[row.key] = row.value;
      }
    }
    return data;
  }

  save(state) {
    for (const [key, value] of Object.entries(state)) this._upsert.run(key, JSON.stringify(value));
  }

  close() {
    this.db.close();
  }
}

class JsonBackend {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.kind = 'json';
    this.file = file;
  }

  load() {
    if (!fs.existsSync(this.file)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  save(state) {
    fs.writeFileSync(this.file, JSON.stringify(state));
  }

  close() {
    // JSON is flushed on every mutation; nothing to do here.
  }
}

function normalizeDc(input = {}) {
  const id = Number(input.id ?? input.dcId ?? input.dc_id ?? 1) | 0;
  const port = Number(input.port ?? 10443) || 10443;
  return {
    id,
    host: String(input.host ?? input.ip ?? input.ipAddress ?? input.ip_address ?? '127.0.0.1'),
    port,
    secret: input.secret === undefined || input.secret === null ? '' : String(input.secret),
    cdn: Boolean(input.cdn),
    mediaOnly: Boolean(input.mediaOnly ?? input.media_only),
    tcpoOnly: Boolean(input.tcpoOnly ?? input.tcpo_only),
  };
}

function normalizeKey(key = {}) {
  const toBuf = (v) => {
    if (Buffer.isBuffer(v)) return Buffer.from(v);
    if (v instanceof Uint8Array) return Buffer.from(v);
    if (typeof v === 'string') {
      return /^[0-9a-f]+$/i.test(v) && v.length % 2 === 0
        ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
    }
    return Buffer.alloc(0);
  };
  let n = toBuf(key.n);
  let e = toBuf(key.e);
  let d = toBuf(key.d);
  const publicPem = key.publicPem || key.public_key || key.publicKey || '';
  if ((!n.length || !e.length) && publicPem) {
    try {
      const jwk = crypto.createPublicKey(publicPem).export({ format: 'jwk' });
      n = Buffer.from(jwk.n, 'base64url');
      e = Buffer.from(jwk.e, 'base64url');
    } catch {
      // Keep the raw PEM; the fingerprint is only available with n/e.
    }
  }
  return {
    n,
    e,
    d,
    privatePem: String(key.privatePem || ''),
    publicPem: String(publicPem || key.publicPem || ''),
    fingerprint: n.length && e.length ? rsaFingerprint(n, e) : 0n,
  };
}

/** DcOption flags from schema/api.tl line 529. */
const DC_FLAG = Object.freeze({
  ipv6: 1 << 0,
  mediaOnly: 1 << 1,
  tcpoOnly: 1 << 2,
  cdn: 1 << 3,
  static: 1 << 4,
  thisPortOnly: 1 << 5,
  secret: 1 << 10,
});

export class DcRegistry {
  constructor(dataDir = './data', options = {}) {
    if (dataDir && typeof dataDir === 'object') {
      options = { ...dataDir, ...options };
      dataDir = options.dataDir || './data';
    }
    this.dataDir = String(dataDir);
    this.options = options || {};
    this.thisDc = Number(this.options.thisDc ?? this.options.serverId ?? 1) | 0;
    this.webfileDcId = Number(this.options.webfileDcId ?? this.thisDc) | 0;

    const sqlite = nodeSqlite();
    let backend = null;
    if (sqlite && this.options.driver !== 'json' && this.options.dbDriver !== 'json') {
      try {
        backend = new SqliteBackend(path.join(this.dataDir, 'dc.sqlite'), sqlite.DatabaseSync);
      } catch {
        backend = null;
      }
    }
    this.backend = backend || new JsonBackend(path.join(this.dataDir, 'dc.json'));
    this.driverKind = this.backend.kind;

    const stored = this.backend.load();
    this.state = { ...emptyState() };
    for (const key of Object.keys(this.state)) {
      if (stored[key] !== undefined) this.state[key] = stored[key];
    }

    const dcs = Array.isArray(this.options.dcs) ? this.options.dcs : null;
    if (dcs && dcs.length) {
      for (const dc of dcs) this.registerDc(dc, { persist: false });
      this.save();
    } else if (!this.state.dcs.length) {
      for (const dc of DEFAULT_DCS) this.registerDc(dc, { persist: false });
      this.save();
    }
  }

  save() {
    this.backend.save(this.state);
  }

  close() {
    this.backend.close();
  }

  // ---- data centers ----------------------------------------------------
  listDcs() {
    return this.state.dcs.map(normalizeDc).sort((a, b) => a.id - b.id);
  }

  getDc(id) {
    const wanted = Number(id) | 0;
    const raw = this.state.dcs.find((dc) => Number(dc.id) === wanted);
    return raw ? normalizeDc(raw) : null;
  }

  registerDc(input, { persist = true } = {}) {
    const dc = normalizeDc(input);
    const index = this.state.dcs.findIndex((d) => Number(d.id) === dc.id);
    if (index >= 0) this.state.dcs[index] = dc;
    else this.state.dcs.push(dc);
    if (!this.state.keys[String(dc.id)]) this.generateDcKey(dc.id);
    if (persist) this.save();
    return dc;
  }

  removeDc(id) {
    const wanted = Number(id) | 0;
    const before = this.state.dcs.length;
    this.state.dcs = this.state.dcs.filter((dc) => Number(dc.id) !== wanted);
    delete this.state.keys[String(wanted)];
    for (const [authKeyId, record] of Object.entries(this.state.authKeys)) {
      if (Number(record.dcId) === wanted) delete this.state.authKeys[authKeyId];
    }
    this.save();
    return this.state.dcs.length !== before;
  }

  /** Object suitable for the config#cc1a241e writer (flags kept as booleans). */
  getDataCenterConfig(testMode = false) {
    const dcs = this.listDcs();
    const webfile = dcs.find((dc) => dc.cdn) || this.getDc(this.webfileDcId) || dcs[0];
    return {
      date: now(),
      expires: now() + 30 * 86400,
      testMode: Boolean(testMode),
      thisDc: this.thisDc,
      dcOptions: dcs.map((dc) => ({
        id: dc.id,
        ipAddress: dc.host,
        port: dc.port,
        ipv6: false,
        mediaOnly: dc.mediaOnly,
        tcpoOnly: dc.tcpoOnly,
        cdn: dc.cdn,
        secret: dc.secret,
        flags: (dc.mediaOnly ? DC_FLAG.mediaOnly : 0)
          | (dc.tcpoOnly ? DC_FLAG.tcpoOnly : 0)
          | (dc.cdn ? DC_FLAG.cdn : 0)
          | (dc.secret ? DC_FLAG.secret : 0),
      })),
      dcTxtDomainName: '',
      webfileDcId: Number(webfile?.id ?? this.webfileDcId) | 0,
    };
  }

  // ---- RSA / CDN keys --------------------------------------------------
  generateDcKey(dcId) {
    const material = generateRSA();
    return this.addDcKey({ ...material, dcId: Number(dcId) | 0 });
  }

  addDcKey(key = {}) {
    const dcId = Number(key.dcId ?? key.dc_id ?? key.id ?? 0) | 0;
    if (!dcId) return null;
    const material = normalizeKey(key);
    this.state.keys[String(dcId)] = {
      n: material.n.toString('base64'),
      e: material.e.toString('base64'),
      d: material.d.toString('base64'),
      privatePem: material.privatePem,
      publicPem: material.publicPem,
      fingerprint: material.fingerprint.toString(),
    };
    this.save();
    return this.getDcKeys()[dcId];
  }

  getDcKeys() {
    const out = {};
    for (const [dcId, raw] of Object.entries(this.state.keys)) {
      out[Number(dcId)] = {
        dcId: Number(dcId),
        n: Buffer.from(raw.n || '', 'base64'),
        e: Buffer.from(raw.e || '', 'base64'),
        d: Buffer.from(raw.d || '', 'base64'),
        privatePem: String(raw.privatePem || ''),
        publicPem: String(raw.publicPem || ''),
        fingerprint: BigInt(raw.fingerprint || 0),
      };
    }
    return out;
  }

  getCdnConfig() {
    const override = this.state.cdnConfig;
    if (override && Array.isArray(override.publicKeys)) {
      return { publicKeys: override.publicKeys.map((k) => ({ ...k })) };
    }
    const publicKeys = Object.values(this.getDcKeys())
      .sort((a, b) => a.dcId - b.dcId)
      .map((k) => ({
        dcId: k.dcId,
        publicKey: k.publicPem,
        fingerprint: k.fingerprint,
      }));
    return { publicKeys };
  }

  setCdnConfig(cfg = {}) {
    const publicKeys = (Array.isArray(cfg.publicKeys) ? cfg.publicKeys : [])
      .map((k) => ({
        dcId: Number(k?.dcId ?? k?.dc_id ?? 0) | 0,
        publicKey: String(k?.publicKey ?? k?.public_key ?? ''),
      }));
    this.state.cdnConfig = { publicKeys };
    this.save();
    return { publicKeys };
  }

  // ---- auth key bindings ----------------------------------------------
  getAuthKeyForDc(dcId, authKeyId) {
    const record = this.state.authKeys[keyIdHex(authKeyId)];
    if (!record) return null;
    if (dcId !== undefined && dcId !== null && Number(record.dcId) !== (Number(dcId) | 0)) return null;
    return { ...record };
  }

  bindAuthKey(dcId, authKeyId) {
    const id = keyIdHex(authKeyId);
    if (!id) return null;
    const record = { authKeyId: id, dcId: Number(dcId) | 0, boundAt: now() };
    this.state.authKeys[id] = record;
    this.save();
    return { ...record };
  }

  findDcByAuthKey(authKeyId) {
    const record = this.state.authKeys[keyIdHex(authKeyId)];
    return record ? this.getDc(record.dcId) : null;
  }

  // ---- file DC selection ----------------------------------------------
  nextFileDc(mediaOnly = false) {
    let dcs = this.listDcs();
    if (mediaOnly) {
      const mediaDcs = dcs.filter((dc) => dc.mediaOnly);
      if (mediaDcs.length) dcs = mediaDcs;
    }
    if (!dcs.length) {
      this.registerDc(DEFAULT_DCS[0]);
      dcs = this.listDcs();
    }
    const index = Number(this.state.counters.file || 0) % dcs.length;
    this.state.counters.file = index + 1;
    this.save();
    return dcs[index];
  }

  // ---- authorization migration ----------------------------------------
  exportAuthorizationForDc(dcId, authKeyId, userId = 0) {
    const dc = this.getDc(dcId);
    if (!dc) throw new Error(`DcRegistry: unknown DC ${dcId}`);
    const token = `dcauth:${randomHex(16)}`;
    this.state.tokens[token] = {
      token,
      dcId: dc.id,
      authKeyId: keyIdHex(authKeyId),
      userId: Number(userId) | 0,
      issuedAt: now(),
    };
    this.save();
    return { dcId: dc.id, token, bytes: Buffer.from(token, 'utf8'), id: keyIdBig(authKeyId) };
  }

  getToken(token) {
    const record = this.state.tokens[String(token ?? '')];
    return record ? { ...record } : null;
  }

  importAuthorization(dcId, authKeyId) {
    const hex = keyIdHex(authKeyId);
    const found = Object.values(this.state.tokens).find((t) => t.authKeyId === hex);
    const targetDc = found ? Number(found.dcId) : (Number(dcId) | 0);
    if (!this.getDc(targetDc)) return false;
    this.bindAuthKey(targetDc, hex);
    return true;
  }

  /** Helpers used by the RPC handlers to keep flags in sync with schema. */
  dcFlags(dc) {
    const normalized = normalizeDc(dc);
    return (normalized.mediaOnly ? DC_FLAG.mediaOnly : 0)
      | (normalized.tcpoOnly ? DC_FLAG.tcpoOnly : 0)
      | (normalized.cdn ? DC_FLAG.cdn : 0)
      | (normalized.secret ? DC_FLAG.secret : 0);
  }
}

export const DC_OPTION_FLAGS = DC_FLAG;
export default DcRegistry;
