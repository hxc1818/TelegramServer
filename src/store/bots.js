// Bot / inline-results / scheduled-messages / game-scores storage, deliberately
// kept separate from store.js.
//
// Uses its own node:sqlite DatabaseSync at <dataDir>/bots.sqlite (Node >= 22.5,
// zero npm dependencies) with a JSON-file fallback. Every method is synchronous
// so it can be called straight from a TL handler.
//
// A single demo bot is seeded on first run so inline bot RPCs have something to
// return on a fresh server.

import fs from 'node:fs';
import path from 'node:path';

const TABLE_FIELDS = {
  bots: ['id', 'accessHash', 'username', 'token', 'date'],
  inline_results: ['query', 'results', 'date'],
  scheduled_messages: ['id', 'userId', 'peerKey', 'text', 'scheduleDate', 'date'],
  game_scores: ['id', 'userId', 'gameId', 'score', 'date'],
};

const CREATE_SQL = {
  bots: `id TEXT PRIMARY KEY, access_hash TEXT NOT NULL DEFAULT '0', username TEXT UNIQUE,
    token TEXT NOT NULL DEFAULT '', date INTEGER NOT NULL DEFAULT 0`,
  inline_results: `query TEXT PRIMARY KEY, results TEXT NOT NULL DEFAULT '[]', date INTEGER NOT NULL DEFAULT 0`,
  scheduled_messages: `id INTEGER PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '0',
    peer_key TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
    schedule_date INTEGER NOT NULL DEFAULT 0, date INTEGER NOT NULL DEFAULT 0`,
  game_scores: `id INTEGER PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '0',
    game_id TEXT NOT NULL DEFAULT '0', score INTEGER NOT NULL DEFAULT 0,
    date INTEGER NOT NULL DEFAULT 0`,
};

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

export class BotStore {
  constructor(dataDir = './data', options = {}) {
    const resolved = optionsOf(dataDir, options);
    this.dataDir = resolved.dataDir;
    this.driverKind = resolved.options.dbDriver || resolved.options.driver || process.env.DB_DRIVER || 'sqlite';
    const jsonFile = path.join(this.dataDir, 'bots.json');
    if (this.driverKind === 'json') {
      this.driver = new JSONDriver(jsonFile);
    } else {
      try {
        const sqlite = process.getBuiltinModule?.('node:sqlite') || globalThis.__nodeSqlite;
        if (!sqlite) throw new Error('node:sqlite unavailable');
        this.driver = new SQLiteDriver(path.join(this.dataDir, 'bots.sqlite'), sqlite.DatabaseSync);
      } catch {
        this.driverKind = 'json';
        this.driver = new JSONDriver(jsonFile);
      }
    }
    this._seedDemoBot();
  }

  // ---- normalizers ------------------------------------------------------
  _bot(row) {
    if (!row) return null;
    return {
      id: num(row.id ?? row.id_),
      accessHash: num(row.access_hash ?? row.accessHash ?? 0),
      username: row.username ?? '',
      token: row.token ?? '',
      date: toNumber(row.date, 0),
    };
  }

  _scheduled(row) {
    if (!row) return null;
    return {
      id: toNumber(row.id),
      userId: num(row.user_id ?? row.userId ?? 0),
      peerKey: row.peer_key ?? row.peerKey ?? '',
      text: row.text ?? '',
      scheduleDate: toNumber(row.schedule_date ?? row.scheduleDate ?? 0),
      date: toNumber(row.date, 0),
    };
  }

  _score(row) {
    if (!row) return null;
    return {
      id: toNumber(row.id),
      userId: num(row.user_id ?? row.userId ?? 0),
      gameId: num(row.game_id ?? row.gameId ?? 0),
      score: toNumber(row.score, 0),
      date: toNumber(row.date, 0),
    };
  }

  _nextId(table) {
    return this.driver.all(table).reduce((max, row) => Math.max(max, toNumber(row.id ?? row.id_, 0)), 0) + 1;
  }

  // ---- bots -------------------------------------------------------------
  registerBot({ id, accessHash = 0, username = '', token = '' } = {}) {
    const name = String(username || '').replace(/^@/, '');
    const existing = this.driver.get('bots', { id: keyOf(id) })
      || (name ? this.driver.get('bots', { username: name }) : null);
    const key = existing ? keyOf(existing.id ?? existing.id_) : keyOf(id);
    this.driver.upsert('bots', { id: key }, {
      id: key,
      accessHash: keyOf(accessHash || 0),
      username: name,
      token: String(token || ''),
      date: now(),
    });
    return this._bot(this.driver.get('bots', { id: key }));
  }

  getBot(idOrUsername) {
    if (idOrUsername === undefined || idOrUsername === null) return null;
    const byId = this.driver.get('bots', { id: keyOf(idOrUsername) });
    if (byId) return this._bot(byId);
    if (typeof idOrUsername === 'string' || typeof idOrUsername === 'bigint') {
      const name = String(idOrUsername).replace(/^@/, '');
      return this._bot(this.driver.get('bots', { username: name }));
    }
    return null;
  }

  listBots() {
    return this.driver.all('bots', {}, { orderBy: '-date' }).map((row) => this._bot(row));
  }

  // ---- inline results ---------------------------------------------------
  setInlineResults(query, results) {
    const key = String(query ?? '');
    const list = Array.isArray(results) ? results : (results === undefined ? [] : [results]);
    this.driver.upsert('inline_results', { query: key }, {
      query: key,
      results: stringify(list),
      date: now(),
    });
    return parseJSON(this.driver.get('inline_results', { query: key })?.results, []);
  }

  getInlineResults(query) {
    const row = this.driver.get('inline_results', { query: String(query ?? '') });
    const value = parseJSON(row?.results ?? row?.results_json, []);
    return Array.isArray(value) ? value : [];
  }

  // ---- scheduled messages ----------------------------------------------
  saveScheduledMessage({ userId = 0, peerKey = '', text = '', scheduleDate = 0 } = {}) {
    const id = this._nextId('scheduled_messages');
    const row = {
      id,
      userId: keyOf(userId),
      peerKey: String(peerKey ?? ''),
      text: String(text ?? ''),
      scheduleDate: toNumber(scheduleDate, 0),
      date: now(),
    };
    this.driver.insert('scheduled_messages', row);
    return this._scheduled(this.driver.get('scheduled_messages', { id }));
  }

  listScheduled(userId) {
    return this.driver.all('scheduled_messages', { userId: keyOf(userId) }, { orderBy: 'scheduleDate' })
      .map((row) => this._scheduled(row));
  }

  deleteScheduled(id) {
    return this.driver.delete('scheduled_messages', { id: toNumber(id) }) > 0;
  }

  // ---- game scores ------------------------------------------------------
  saveGameScore(userId, gameId, score) {
    const id = this._nextId('game_scores');
    const row = {
      id,
      userId: keyOf(userId),
      gameId: keyOf(gameId),
      score: toNumber(score, 0),
      date: now(),
    };
    this.driver.insert('game_scores', row);
    return this._score(this.driver.get('game_scores', { id }));
  }

  getGameScores(gameId) {
    return this.driver.all('game_scores', { gameId: keyOf(gameId) }, { orderBy: '-score' })
      .map((row) => this._score(row));
  }

  // ---- defaults ---------------------------------------------------------
  _seedDemoBot() {
    if (this.driver.all('bots').length) return;
    this.registerBot({
      id: 1000001,
      accessHash: 0x5f3a21c9,
      username: 'demo_bot',
      token: '123456:DEMO',
    });
    this.setInlineResults('demo', [{
      id: 'demo:1',
      type: 'article',
      title: 'Demo inline result',
      description: 'A result from the seeded demo bot',
      message: 'Hello from demo_bot',
    }]);
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this.driver.close();
  }
}

export default BotStore;
