// Help / langpack storage, deliberately kept separate from store.js.
//
// Uses its own node:sqlite DatabaseSync at <dataDir>/help.sqlite (Node >= 22.5,
// no npm dependencies) with a JSON-file fallback. Every method is synchronous
// so it can be called straight from a TL handler.
//
// Minimal defaults are seeded on first run: one 'en' language, an empty CDN
// config and no app update.

import fs from 'node:fs';
import path from 'node:path';

const TABLE_FIELDS = {
  kv: ['namespace', 'key', 'data'],
  countries: ['iso2', 'data', 'position'],
  languages: ['langCode', 'data', 'position'],
  strings: ['langCode', 'key', 'value'],
};

const CREATE_SQL = {
  kv: `namespace TEXT NOT NULL, key TEXT NOT NULL, data TEXT, PRIMARY KEY (namespace, key)`,
  countries: `iso2 TEXT PRIMARY KEY, data TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0`,
  languages: `lang_code TEXT PRIMARY KEY, data TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0`,
  strings: `lang_code TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (lang_code, key)`,
};

const DEFAULT_INVITE_TEXT = 'Join me on Telegram!';
const DEFAULT_SUPPORT = { phoneNumber: '+10000000000', userId: 0 };
const DEFAULT_TERMS = { expires: 0, popup: false, id: '', text: '', minAgeConfirm: 0 };
const DEFAULT_CDN_CONFIG = { publicKeys: [] };
const DEFAULT_COUNTRY = {
  iso2: 'US',
  defaultName: 'United States',
  name: '',
  hidden: false,
  countryCodes: [{ countryCode: '1', prefixes: [], patterns: [] }],
};
const DEFAULT_LANGUAGE = {
  langCode: 'en',
  name: 'English',
  nativeName: 'English',
  baseLangCode: '',
  pluralCode: 'en',
  official: true,
  rtl: false,
  beta: false,
  stringsCount: 3,
  translatedCount: 3,
  translationsUrl: '',
  version: 1,
};
const DEFAULT_STRINGS = {
  app_name: 'Telegram',
  ok: 'OK',
  cancel: 'Cancel',
};

const columnOf = (field) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function parseJSON(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  if (typeof value === 'object') return value;
  return fallback;
}

function stringify(value) {
  return JSON.stringify(value === undefined ? null : value);
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

function optionsOf(dataDir, options) {
  if (dataDir && typeof dataDir === 'object' && !Array.isArray(dataDir)) {
    return { dataDir: dataDir.dataDir || dataDir.dir || './data', options: { ...dataDir, ...options } };
  }
  return { dataDir: dataDir || './data', options: options || {} };
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
      const key = columnOf(parts[0].replace(/^-/, ''));
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
        // Corrupt cache: start empty rather than crashing the server.
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

function normalizeCountry(row) {
  if (!row) return null;
  return { iso2: row.iso2, ...parseJSON(row.data, {}) };
}

function normalizeLanguage(row) {
  if (!row) return null;
  return { ...parseJSON(row.data, {}), langCode: row.lang_code ?? row.langCode ?? '' };
}

function normalizeString(row) {
  return { key: row.key, value: row.value };
}

export class HelpStore {
  constructor(dataDir = './data', options = {}) {
    const resolved = optionsOf(dataDir, options);
    this.dataDir = resolved.dataDir;
    this.driverKind = resolved.options.dbDriver || resolved.options.driver || process.env.DB_DRIVER || 'sqlite';
    if (this.driverKind === 'json') {
      this.driver = new JSONDriver(path.join(this.dataDir, 'help.json'));
    } else {
      try {
        const sqlite = process.getBuiltinModule?.('node:sqlite') || globalThis.__nodeSqlite;
        if (!sqlite) throw new Error('node:sqlite unavailable');
        this.driver = new SQLiteDriver(path.join(this.dataDir, 'help.sqlite'), sqlite.DatabaseSync);
      } catch {
        this.driverKind = 'json';
        this.driver = new JSONDriver(path.join(this.dataDir, 'help.json'));
      }
    }
    this._seed();
  }

  _seed() {
    const seed = (key, value) => {
      if (!this.driver.get('kv', { namespace: 'help', key })) {
        this.driver.insert('kv', { namespace: 'help', key, data: stringify(value) });
      }
    };
    seed('inviteText', DEFAULT_INVITE_TEXT);
    seed('support', DEFAULT_SUPPORT);
    seed('terms', DEFAULT_TERMS);
    seed('cdnConfig', DEFAULT_CDN_CONFIG);
    seed('appUpdate', null);
    if (!this.driver.get('countries', { iso2: DEFAULT_COUNTRY.iso2 })) this.setCountry(DEFAULT_COUNTRY);
    if (!this.driver.get('languages', { langCode: DEFAULT_LANGUAGE.langCode })) {
      this.setLanguage(DEFAULT_LANGUAGE);
      for (const [key, value] of Object.entries(DEFAULT_STRINGS)) {
        this.setString(DEFAULT_LANGUAGE.langCode, key, value);
      }
    }
  }

  // ---- config overrides ------------------------------------------------
  _kv(namespace, key) {
    const row = this.driver.get('kv', { namespace: String(namespace), key: String(key) });
    return row ? parseJSON(row.data, undefined) : undefined;
  }

  _setKv(namespace, key, value) {
    this.driver.upsert('kv', { namespace: String(namespace), key: String(key) }, {
      namespace: String(namespace), key: String(key), data: stringify(value),
    });
    return value;
  }

  getConfigOverride(key) {
    return this._kv('config', key);
  }

  setConfigOverride(key, value) {
    return this._setKv('config', key, value);
  }

  // ---- help settings ---------------------------------------------------
  getInviteText() {
    const value = this._kv('help', 'inviteText');
    return typeof value === 'string' ? value : DEFAULT_INVITE_TEXT;
  }

  setInviteText(message) {
    return this._setKv('help', 'inviteText', String(message ?? ''));
  }

  getSupport() {
    const value = this._kv('help', 'support');
    return value && typeof value === 'object' ? value : { ...DEFAULT_SUPPORT };
  }

  setSupport(support = {}) {
    const value = {
      phoneNumber: String(support.phoneNumber ?? support.phone_number ?? ''),
      userId: Number(support.userId ?? support.user_id ?? 0) || 0,
    };
    this._setKv('help', 'support', value);
    return value;
  }

  getTerms() {
    const value = this._kv('help', 'terms');
    return value && typeof value === 'object' ? value : { ...DEFAULT_TERMS };
  }

  setTerms(terms = {}) {
    const value = {
      expires: Number(terms.expires || 0) || 0,
      popup: Boolean(terms.popup),
      id: String(terms.id ?? ''),
      text: String(terms.text ?? ''),
      entities: Array.isArray(terms.entities) ? terms.entities : [],
      minAgeConfirm: terms.minAgeConfirm === undefined ? 0 : Number(terms.minAgeConfirm) || 0,
    };
    this._setKv('help', 'terms', value);
    return value;
  }

  getCdnConfig() {
    const value = this._kv('help', 'cdnConfig');
    const keys = Array.isArray(value?.publicKeys) ? value.publicKeys : [];
    return { publicKeys: keys };
  }

  setCdnConfig(config = {}) {
    const value = {
      publicKeys: (Array.isArray(config.publicKeys) ? config.publicKeys : []).map((k) => ({
        dcId: Number(k?.dcId ?? k?.dc_id ?? 0) || 0,
        publicKey: String(k?.publicKey ?? k?.public_key ?? ''),
      })),
    };
    this._setKv('help', 'cdnConfig', value);
    return value;
  }

  getAppUpdate() {
    const value = this._kv('help', 'appUpdate');
    return value && typeof value === 'object' ? value : null;
  }

  setAppUpdate(update) {
    return this._setKv('help', 'appUpdate', update && typeof update === 'object' ? update : null);
  }

  // ---- countries -------------------------------------------------------
  setCountry(country = {}) {
    const iso2 = String(country.iso2 ?? country.code ?? '').toUpperCase();
    if (!iso2) throw new Error('HelpStore.setCountry: iso2 is required');
    const position = Number(country.position ?? 0) || 0;
    const data = {
      defaultName: String(country.defaultName ?? country.default_name ?? iso2),
      name: String(country.name ?? ''),
      hidden: Boolean(country.hidden),
      countryCodes: (Array.isArray(country.countryCodes) ? country.countryCodes : []).map((c) => ({
        countryCode: String(c?.countryCode ?? c?.country_code ?? ''),
        prefixes: (Array.isArray(c?.prefixes) ? c.prefixes : []).map(String),
        patterns: (Array.isArray(c?.patterns) ? c.patterns : []).map(String),
      })),
    };
    this.driver.upsert('countries', { iso2 }, { iso2, data: JSON.stringify(data), position });
    return { iso2, ...data };
  }

  listCountries() {
    return this.driver.all('countries', {}, { orderBy: 'position' }).map(normalizeCountry);
  }

  // ---- languages / strings ---------------------------------------------
  setLanguage(language = {}) {
    const langCode = String(language.langCode ?? language.lang_code ?? '').toLowerCase();
    if (!langCode) throw new Error('HelpStore.setLanguage: langCode is required');
    const position = Number(language.position ?? 0) || 0;
    const data = {
      name: String(language.name ?? langCode),
      nativeName: String(language.nativeName ?? language.native_name ?? language.name ?? langCode),
      baseLangCode: String(language.baseLangCode ?? language.base_lang_code ?? ''),
      pluralCode: String(language.pluralCode ?? language.plural_code ?? langCode),
      official: Boolean(language.official),
      rtl: Boolean(language.rtl),
      beta: Boolean(language.beta),
      stringsCount: Number(language.stringsCount ?? 0) || 0,
      translatedCount: Number(language.translatedCount ?? 0) || 0,
      translationsUrl: String(language.translationsUrl ?? ''),
      version: Number(language.version ?? 0) || 0,
    };
    this.driver.upsert('languages', { langCode }, {
      langCode, data: JSON.stringify(data), position,
    });
    return this.getLanguage(langCode);
  }

  getLanguage(langCode) {
    return normalizeLanguage(this.driver.get('languages', { langCode: String(langCode ?? '').toLowerCase() }));
  }

  getLanguages() {
    return this.driver.all('languages', {}, { orderBy: 'position' }).map(normalizeLanguage);
  }

  setString(langCode, key, value) {
    const lang = String(langCode ?? 'en').toLowerCase();
    const name = String(key ?? '');
    const row = { langCode: lang, key: name, value: String(value ?? '') };
    this.driver.upsert('strings', { langCode: lang, key: name }, row);
    return normalizeString(row);
  }

  deleteString(langCode, key) {
    return this.driver.delete('strings', {
      langCode: String(langCode ?? 'en').toLowerCase(), key: String(key ?? ''),
    }) > 0;
  }

  getStrings(langCode, keys) {
    const lang = String(langCode ?? 'en').toLowerCase();
    const rows = this.driver.all('strings', { langCode: lang }, { orderBy: 'key' });
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    if (Array.isArray(keys)) {
      return keys.map((key) => {
        const name = String(key);
        return byKey.has(name) ? { key: name, value: byKey.get(name) } : { key: name, deleted: true };
      });
    }
    return rows.map(normalizeString);
  }

  getDifference(langCode, fromVersion) {
    const lang = String(langCode ?? 'en').toLowerCase();
    const language = this.getLanguage(lang);
    const version = Number(language?.version ?? 0) || 0;
    const from = Number(fromVersion ?? 0) || 0;
    return {
      langCode: language?.langCode ?? lang,
      fromVersion: from,
      version,
      strings: from < version ? this.getStrings(lang) : [],
    };
  }

  close() {
    this.driver.close();
  }
}

export default HelpStore;
