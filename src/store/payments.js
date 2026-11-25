// Invoices, payments, Telegram Stars, star gifts, boosts and Premium state.
// Kept in its own node:sqlite database at <dataDir>/payments.sqlite (Node >=
// 22.5, zero npm dependencies) with a JSON-file fallback. Every method is
// synchronous so a TL handler can call it directly.
//
// int64 values (amounts, balances, deltas, gift ids) are always stored as
// decimal TEXT, never as a potentially lossy JS number column.

import fs from 'node:fs';
import path from 'node:path';

const TABLE_FIELDS = {
  invoices: ['id', 'userId', 'title', 'description', 'amount', 'currency', 'date'],
  requested_info: ['userId', 'data', 'date'],
  payments: ['id', 'invoiceId', 'userId', 'provider', 'info', 'chargeId', 'status', 'date'],
  stars: ['userId', 'balance'],
  stars_transactions: ['id', 'userId', 'delta', 'description', 'date'],
  star_gifts: ['id', 'data', 'date'],
  gift_purchases: ['id', 'userId', 'giftId', 'date'],
  boosts: ['id', 'userId', 'peerKey', 'date'],
  premium: ['userId', 'active', 'until'],
};

const CREATE_SQL = {
  invoices: `id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '0', title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '', amount TEXT NOT NULL DEFAULT '0',
    currency TEXT NOT NULL DEFAULT '', date INTEGER NOT NULL DEFAULT 0`,
  requested_info: `user_id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}', date INTEGER NOT NULL DEFAULT 0`,
  payments: `id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL DEFAULT '0', user_id TEXT NOT NULL DEFAULT '0',
    provider TEXT NOT NULL DEFAULT '', info TEXT NOT NULL DEFAULT '{}', charge_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', date INTEGER NOT NULL DEFAULT 0`,
  stars: `user_id TEXT PRIMARY KEY, balance TEXT NOT NULL DEFAULT '0'`,
  stars_transactions: `id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '0', delta TEXT NOT NULL DEFAULT '0',
    description TEXT NOT NULL DEFAULT '', date INTEGER NOT NULL DEFAULT 0`,
  star_gifts: `id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}', date INTEGER NOT NULL DEFAULT 0`,
  gift_purchases: `id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '0', gift_id TEXT NOT NULL DEFAULT '0',
    date INTEGER NOT NULL DEFAULT 0`,
  boosts: `id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '0', peer_key TEXT NOT NULL DEFAULT '',
    date INTEGER NOT NULL DEFAULT 0`,
  premium: `user_id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 0, until INTEGER NOT NULL DEFAULT 0`,
};

const now = () => Math.floor(Date.now() / 1000);
const columnOf = (field) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Stable decimal text key for an int64 id (bigint, number or string). */
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
    fs.writeFileSync(this.file, stringify(this.data));
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

export class PaymentStore {
  constructor(dataDir = './data', options = {}) {
    const resolved = optionsOf(dataDir, options);
    this.dataDir = resolved.dataDir;
    this.driverKind = resolved.options.dbDriver || resolved.options.driver || process.env.DB_DRIVER || 'sqlite';
    const jsonFile = path.join(this.dataDir, 'payments.json');
    if (this.driverKind === 'json') {
      this.driver = new JSONDriver(jsonFile);
    } else {
      try {
        const sqlite = process.getBuiltinModule?.('node:sqlite') || globalThis.__nodeSqlite;
        if (!sqlite) throw new Error('node:sqlite unavailable');
        this.driver = new SQLiteDriver(path.join(this.dataDir, 'payments.sqlite'), sqlite.DatabaseSync);
      } catch {
        this.driverKind = 'json';
        this.driver = new JSONDriver(jsonFile);
      }
    }
  }

  // ---- helpers ----------------------------------------------------------
  _nextId(table) {
    return this.driver.all(table).reduce((max, row) => {
      const n = toNumber(row.id, 0);
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 0) + 1;
  }

  _invoice(row) {
    if (!row) return null;
    return {
      id: num(row.id),
      userId: num(row.user_id ?? row.userId),
      title: row.title ?? '',
      description: row.description ?? '',
      amount: num(row.amount, 0),
      currency: row.currency ?? '',
      date: toNumber(row.date, 0),
    };
  }

  _payment(row) {
    if (!row) return null;
    return {
      id: num(row.id),
      invoiceId: num(row.invoice_id ?? row.invoiceId),
      userId: num(row.user_id ?? row.userId),
      provider: row.provider ?? '',
      info: parseJSON(row.info, {}),
      chargeId: row.charge_id ?? row.chargeId ?? '',
      status: row.status ?? 'pending',
      date: toNumber(row.date, 0),
    };
  }

  _transaction(row) {
    if (!row) return null;
    return {
      id: num(row.id),
      userId: num(row.user_id ?? row.userId),
      delta: num(row.delta, 0),
      description: row.description ?? '',
      date: toNumber(row.date, 0),
    };
  }

  _gift(row) {
    if (!row) return null;
    const data = parseJSON(row.data, {}) || {};
    return { ...data, id: num(row.id ?? data.id), date: toNumber(row.date, 0) };
  }

  _boost(row) {
    if (!row) return null;
    return {
      id: num(row.id),
      userId: num(row.user_id ?? row.userId),
      peerKey: row.peer_key ?? row.peerKey ?? '',
      date: toNumber(row.date, 0),
    };
  }

  _balanceBig(userId) {
    const row = this.driver.get('stars', { userId: keyOf(userId) });
    return BigInt(keyOf(row?.balance ?? 0n));
  }

  _setBalance(userId, balance) {
    this.driver.upsert('stars', { userId: keyOf(userId) }, {
      userId: keyOf(userId), balance: String(balance),
    });
  }

  // ---- invoices ---------------------------------------------------------
  createInvoice({ id, title = '', description = '', amount = 0, currency = '', userId = 0 } = {}) {
    const key = id === undefined || id === null ? String(this._nextId('invoices')) : keyOf(id);
    this.driver.upsert('invoices', { id: key }, {
      id: key,
      userId: keyOf(userId),
      title: String(title),
      description: String(description),
      amount: keyOf(amount),
      currency: String(currency),
      date: now(),
    });
    return this.getInvoice(key);
  }

  getInvoice(id) {
    return this._invoice(this.driver.get('invoices', { id: keyOf(id) }));
  }

  // ---- requested info ---------------------------------------------------
  saveRequestedInfo(userId, info) {
    const key = keyOf(userId);
    this.driver.upsert('requested_info', { userId: key }, {
      userId: key, data: stringify(info || {}), date: now(),
    });
    return this.getRequestedInfo(userId);
  }

  getRequestedInfo(userId) {
    const row = this.driver.get('requested_info', { userId: keyOf(userId) });
    return row ? parseJSON(row.data, {}) : null;
  }

  // ---- payments ---------------------------------------------------------
  createPayment(invoiceId, userId, provider = '', info = {}) {
    const id = String(this._nextId('payments'));
    this.driver.insert('payments', {
      id,
      invoiceId: keyOf(invoiceId),
      userId: keyOf(userId),
      provider: String(provider || ''),
      info: stringify(info || {}),
      chargeId: '',
      status: 'pending',
      date: now(),
    });
    return this.getPayment(id);
  }

  getPayment(id) {
    return this._payment(this.driver.get('payments', { id: keyOf(id) }));
  }

  completePayment(paymentId, chargeId = '') {
    const changed = this.driver.update('payments', { id: keyOf(paymentId) }, {
      status: 'completed', chargeId: String(chargeId || ''),
    });
    return changed ? this.getPayment(paymentId) : null;
  }

  getPaymentReceipt(paymentId) {
    const payment = this.getPayment(paymentId);
    if (!payment) return null;
    const invoice = this.getInvoice(payment.invoiceId);
    return {
      ...payment,
      invoice,
      title: invoice?.title ?? '',
      description: invoice?.description ?? '',
      amount: invoice?.amount ?? 0,
      currency: invoice?.currency ?? '',
      transactionId: payment.chargeId,
    };
  }

  listPayments(userId) {
    return this.driver.all('payments', { userId: keyOf(userId) }, { orderBy: '-id' })
      .map((row) => this._payment(row));
  }

  // ---- stars ------------------------------------------------------------
  getStarsBalance(userId) {
    const row = this.driver.get('stars', { userId: keyOf(userId) });
    return num(row?.balance, 0);
  }

  addTransaction(userId, delta = 0, description = '') {
    const id = String(this._nextId('stars_transactions'));
    const row = {
      id,
      userId: keyOf(userId),
      delta: keyOf(delta),
      description: String(description || ''),
      date: now(),
    };
    this.driver.insert('stars_transactions', row);
    this._setBalance(userId, this._balanceBig(userId) + BigInt(keyOf(delta)));
    return this._transaction(row);
  }

  addStars(userId, amount) {
    this.addTransaction(userId, amount, 'add stars');
    return this.getStarsBalance(userId);
  }

  spendStars(userId, amount) {
    const value = BigInt(keyOf(amount));
    if (value <= 0n || this._balanceBig(userId) < value) return null;
    this.addTransaction(userId, -value, 'spend stars');
    return this.getStarsBalance(userId);
  }

  listStarsTransactions(userId) {
    return this.driver.all('stars_transactions', { userId: keyOf(userId) }, { orderBy: '-id' })
      .map((row) => this._transaction(row));
  }

  // ---- star gifts -------------------------------------------------------
  createStarGift(gift = {}) {
    const spec = gift && typeof gift === 'object' ? gift : { title: String(gift) };
    const id = spec.id === undefined || spec.id === null
      ? String(this._nextId('star_gifts'))
      : keyOf(spec.id);
    const data = { ...spec, id: num(id) };
    this.driver.upsert('star_gifts', { id }, {
      id, data: stringify(data), date: toNumber(spec.date, 0) || now(),
    });
    return this.getStarGift(id);
  }

  getStarGift(id) {
    return this._gift(this.driver.get('star_gifts', { id: keyOf(id) }));
  }

  listStarGifts() {
    return this.driver.all('star_gifts', {}, { orderBy: '-date' }).map((row) => this._gift(row));
  }

  purchaseGift(userId, giftId) {
    const gift = this.getStarGift(giftId);
    if (!gift) return null;
    const price = BigInt(keyOf(gift.stars ?? 0));
    if (this._balanceBig(userId) < price) return null;
    this.spendStars(userId, price);
    const id = String(this._nextId('gift_purchases'));
    const row = { id, userId: keyOf(userId), giftId: keyOf(giftId), date: now() };
    this.driver.insert('gift_purchases', row);
    return {
      id: num(id), userId: num(keyOf(userId)), giftId: num(keyOf(giftId)), date: row.date,
    };
  }

  listGiftPurchases(userId) {
    return this.driver.all('gift_purchases', { userId: keyOf(userId) }, { orderBy: '-id' }).map((row) => ({
      id: num(row.id),
      userId: num(row.user_id ?? row.userId),
      giftId: num(row.gift_id ?? row.giftId),
      date: toNumber(row.date, 0),
    }));
  }

  // ---- boosts / premium -------------------------------------------------
  getBoosts(userId) {
    return this.driver.all('boosts', { userId: keyOf(userId) }, { orderBy: '-id' })
      .map((row) => this._boost(row));
  }

  applyBoost(userId, peerKey) {
    const id = String(this._nextId('boosts'));
    const row = { id, userId: keyOf(userId), peerKey: String(peerKey || ''), date: now() };
    this.driver.insert('boosts', row);
    return this._boost(row);
  }

  getPremiumStatus(userId) {
    const row = this.driver.get('premium', { userId: keyOf(userId) });
    return {
      userId: num(userId),
      active: Boolean(row?.active),
      until: toNumber(row?.until, 0),
    };
  }

  setPremium(userId, active = false, until = 0) {
    const key = keyOf(userId);
    this.driver.upsert('premium', { userId: key }, {
      userId: key, active: active ? 1 : 0, until: toNumber(until, 0),
    });
    return this.getPremiumStatus(userId);
  }

  close() {
    this.driver.close();
  }
}

export default PaymentStore;
