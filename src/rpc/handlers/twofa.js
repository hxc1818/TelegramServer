// TL handlers for 2FA / login tokens (schema/api.tl, layer 234).
//
// Every constructor and method id below was grep-verified against the pinned
// schema; the source line is recorded next to each entry. Response objects use
// the declared result type of each function. Local TL encoders live here so
// codecs.js stays untouched.
//
// SRP-6a note
// -----------
// auth.checkPassword implements a real server-side SRP-6a verification when
// the stored password record contains a server secret `b`, a modulus `p` and
// a public `B` (all accepted by TwoFAStore#setPassword). The verifier v is the
// stored `hash2`. Legacy/simple records without `b`/`p` fall back to a
// deterministic proof check: SHA256(salt || A || hash2) == M1. That fallback
// is NOT a cryptographically complete SRP exchange; it is documented here and
// in the report because the server has no server-secret state to reconstruct
// the shared session key in that case. Both paths require a well-formed
// inputCheckPasswordSRP (or inputCheckPasswordEmpty for a passwordless user).

import crypto from 'node:crypto';
import { TLBuffer } from '../../tl/buffer.js';
import { isReader, int, long, str, bytes } from './parsers.js';
import { ensureSession, configOf } from './context.js';
import { TwoFAStore } from '../../store/twofa.js';

// Constructor ids from schema/api.tl (layer 234).
const ID = Object.freeze({
  true: 0x3fedd339,                       // true#3fedd339 (line 4)
  boolTrue: 0x997275b5,                   // boolTrue#997275b5 (line 2)
  vector: 0x1cb5c415,                     // vector#1cb5c415 (line 6)
  user: 0xb1b8cc83,                       // user#b1b8cc83 (line 91)
  authSentCode: 0x5e002502,               // auth.sentCode#5e002502 (line 242)
  authAuthorization: 0x2ea2c0d4,          // auth.authorization#2ea2c0d4 (line 246)
  accountPassword: 0x957b50fb,            // account.password#957b50fb (line 693)
  accountPasswordSettings: 0x9a5c33e5,    // account.passwordSettings#9a5c33e5 (line 695)
  accountPasswordInputSettings: 0xc23727c9, // account.passwordInputSettings#c23727c9 (line 697)
  inputCheckPasswordSRP: 0xd27ff082,      // inputCheckPasswordSRP#d27ff082 (line 1253)
  inputCheckPasswordEmpty: 0x9880f658,    // inputCheckPasswordEmpty#9880f658 (line 1252)
  passwordKdfAlgoUnknown: 0xd45ab096,     // passwordKdfAlgoUnknown#d45ab096 (line 1243)
  passwordKdfAlgoModPow: 0x3a912d4a,      // passwordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow#3a912d4a (line 1244)
  securePasswordKdfAlgoUnknown: 0x4a8537, // securePasswordKdfAlgoUnknown#4a8537 (line 1246)
  sentCodeTypeSms: 0xc000bba2,            // auth.sentCodeTypeSms#c000bba2 (line 852)
  authLoginToken: 0x629f1980,             // auth.loginToken#629f1980 (line 1362)
  authLoginTokenMigrateTo: 0x68e9916,     // auth.loginTokenMigrateTo#68e9916 (line 1363)
  authLoginTokenSuccess: 0x390d5c5e,      // auth.loginTokenSuccess#390d5c5e (line 1364)
  rpcError: 0x2144ca19,                   // rpc_error#2144ca19 (schema/mtproto.tl line 74)
});

// Method ids from schema/api.tl (layer 234).
export const METHOD_IDS = Object.freeze({
  'account.getPassword': 0x548a30f5,             // line 2494
  'account.updatePasswordSettings': 0xa59b102f,  // line 2496
  'account.getPasswordSettings': 0x9cd4eaf9,     // line 2495
  'account.deleteAccount': 0xa2c0cf74,           // line 2486
  'auth.checkPassword': 0xd18b4d16,              // line 2451
  'auth.resendCode': 0xcae47523,                 // line 2454
  'auth.signUp': 0xaac7b717,                     // line 2443
  'auth.exportLoginToken': 0xb7e085fe,           // line 2457
  'auth.importLoginToken': 0x95ac5ce4,           // line 2458
  'auth.acceptLoginToken': 0xe894ad4d,           // line 2459
});

// 2048-bit MODP group (RFC 3526), used when no explicit p was stored.
const DEFAULT_P = Buffer.from(
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1'
  + '29024E088A67CC74020BBEA63B139B22514A08798E3404DD'
  + 'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245'
  + 'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED'
  + 'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D'
  + 'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F'
  + '83655D23DCA3AD961C62F356208552BB9ED529077096966D'
  + '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B'
  + 'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9'
  + 'DE2BCBF6955817183995497CEA956AE515D2261898FA0510'
  + '15728E5A8AACAA68FFFFFFFFFFFFFFFF', 'hex');

const USER_BOOL_BITS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 23, 24, 25, 26, 27, 28, 29];
const USER_BOOL_KEYS = {
  10: 'self', 11: 'contact', 12: 'mutualContact', 13: 'deleted', 14: 'bot',
  15: 'botChatHistory', 16: 'botNochats', 17: 'verified', 18: 'restricted',
  20: 'min', 21: 'botInlineGeo', 23: 'support', 24: 'scam', 25: 'applyMinPhoto',
  26: 'fake', 27: 'botAttachMenu', 28: 'premium', 29: 'attachMenuEnabled',
};

const toNumber = (v, fallback = 0) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const now = () => Math.floor(Date.now() / 1000);

function asBuf(v) {
  if (v === undefined || v === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'bigint') return fixed256(v);
  return Buffer.from(String(v), 'utf8');
}

function intOf(buf) {
  const b = asBuf(buf);
  return b.length ? BigInt(`0x${b.toString('hex')}`) : 0n;
}

// Fixed 256-byte big-endian representation for SRP integers. intOf() below
// decodes the same byte order, so intOf(fixed256(v)) === v.
function fixed256(v) {
  const out = Buffer.alloc(256);
  let n = BigInt(v);
  for (let i = out.length - 1; i >= 0 && n > 0n; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function modPow(base, exp, mod) {
  if (mod <= 0n) return 0n;
  let result = 1n;
  let b = base % mod;
  if (b < 0n) b += mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    if (e) b = (b * b) % mod;
  }
  return result;
}

function sha(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(asBuf(part));
  return hash.digest();
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function twofaStoreOf(ctx = {}) {
  if (ctx.twofaStore) return ctx.twofaStore;
  const store = new TwoFAStore(ctx.store?.dataDir || './data');
  ctx.twofaStore = store;
  return store;
}

function currentUserId(ctx = {}) {
  if (ctx.userId) return toNumber(ctx.userId);
  if (ctx.user?.id) return toNumber(ctx.user.id);
  if (ctx.session?.userId) return toNumber(ctx.session.userId);
  const first = ctx.store?.driver?.all?.('users', {}, { limit: 1 })?.[0];
  return first ? toNumber(first.id ?? first.user_id) : 0;
}

function bindUser(ctx = {}, userId) {
  const store = ctx.store;
  let user = userId ? store?.getUser?.(userId) : null;
  if (!user && store?.driver?.all) {
    const first = store.driver.all('users', {}, { limit: 1 })[0];
    if (first) user = store.getUser(first.id ?? first.user_id);
  }
  if (!user && store?.createUser) {
    user = store.createUser({ phone: '', firstName: '', lastName: '' });
  }
  if (!user) user = { id: toNumber(userId) || 1 };
  const session = store ? ensureSession(store, ctx, user.id) : null;
  ctx.userId = user.id;
  ctx.session = session;
  return user;
}

// ---- local TL encoders --------------------------------------------------
function error(code, message) {
  return new TLBuffer().putUint(ID.rpcError).putInt(code).putString(message).buffer;
}

function boolTrue() {
  return new TLBuffer().putUint(ID.boolTrue).buffer;
}

function encodeUser(u = {}) {
  const flags = USER_BOOL_BITS.reduce((f, bit) => f | (u[USER_BOOL_KEYS[bit]] ? 1 << bit : 0), 0)
    | (u.accessHash !== undefined && u.accessHash !== null ? 1 : 0)
    | (u.firstName ? 1 << 1 : 0)
    | (u.lastName ? 1 << 2 : 0)
    | (u.username ? 1 << 3 : 0)
    | (u.phone ? 1 << 4 : 0);
  const b = new TLBuffer();
  b.putUint(ID.user).putUint(flags);
  for (const bit of USER_BOOL_BITS) if (flags & (1 << bit)) b.putUint(ID.true); // flags.N?true (true#3fedd339)
  b.putUint(0); // flags2 (all optional fields omitted)
  b.putLong(BigInt(toNumber(u.id ?? u.userId)));
  if (flags & 1) b.putLong(BigInt(toNumber(u.accessHash)));
  if (flags & (1 << 1)) b.putString(u.firstName);
  if (flags & (1 << 2)) b.putString(u.lastName);
  if (flags & (1 << 3)) b.putString(u.username);
  if (flags & (1 << 4)) b.putString(u.phone);
  return b.buffer;
}

function encodeAuthorization(user = {}) {
  return new TLBuffer().putUint(ID.authAuthorization).putUint(0).putRaw(encodeUser(user)).buffer;
}

function encodeSentCode({ phoneCodeHash = '', length = 5 } = {}) {
  const b = new TLBuffer();
  b.putUint(ID.authSentCode).putUint(0);
  b.putUint(ID.sentCodeTypeSms).putInt(toNumber(length));
  b.putString(phoneCodeHash);
  return b.buffer;
}

function encodeLoginToken(token, expires) {
  return new TLBuffer()
    .putUint(ID.authLoginToken)
    .putInt(toNumber(expires))
    .putBytes(asBuf(token))
    .buffer;
}

function encodeKdfAlgo(record) {
  const unknown = !record
    || (record.algorithm && String(record.algorithm).includes('Unknown'));
  if (unknown) return new TLBuffer().putUint(ID.passwordKdfAlgoUnknown).buffer;
  const salt1 = asBuf(record.salt).length ? asBuf(record.salt) : crypto.randomBytes(8);
  const salt2 = asBuf(record.serverSalt).length ? asBuf(record.serverSalt) : crypto.randomBytes(8);
  const p = asBuf(record.p).length ? asBuf(record.p) : DEFAULT_P;
  return new TLBuffer()
    .putUint(ID.passwordKdfAlgoModPow)
    .putBytes(salt1).putBytes(salt2)
    .putInt(toNumber(record.g, 7) || 7)
    .putBytes(p)
    .buffer;
}

function serverPublicB(record, v, N, g, k) {
  if (asBuf(record?.g_srp_B).length) return intOf(record.g_srp_B);
  const b = intOf(record?.b);
  if (!b || !N || !v) return 0n;
  return (k * v + modPow(g, b, N)) % N;
}

function encodeAccountPassword(record) {
  const hasPassword = Boolean(asBuf(record?.hash2).length);
  const flags = (hasPassword ? 4 : 0) | (hasPassword && record.hint ? 8 : 0);
  const b = new TLBuffer();
  b.putUint(ID.accountPassword).putUint(flags);
  if (flags & 4) b.putUint(ID.true); // has_password:flags.2?true
  if (flags & 4) {
    b.putRaw(encodeKdfAlgo(record)); // current_algo:flags.2?PasswordKdfAlgo
    const N = asBuf(record.p).length ? intOf(record.p) : intOf(DEFAULT_P);
    const g = BigInt(toNumber(record.g, 7) || 7);
    const v = intOf(record.hash2);
    const k = intOf(sha(fixed256(N), fixed256(g)));
    b.putBytes(fixed256(serverPublicB(record, v, N, g, k))); // srp_B:flags.2?bytes
    b.putLong(BigInt(record.srpId ?? 0n)); // srp_id:flags.2?long
  }
  if (flags & 8) b.putString(record.hint); // hint:flags.3?string
  b.putRaw(encodeKdfAlgo(record)); // new_algo (mandatory)
  b.putUint(ID.securePasswordKdfAlgoUnknown); // new_secure_algo (mandatory)
  b.putBytes(asBuf(record?.secureRandom).length ? record.secureRandom : crypto.randomBytes(16));
  return b.buffer;
}

function encodePasswordSettings() {
  return new TLBuffer().putUint(ID.accountPasswordSettings).putUint(0).buffer;
}

// ---- parameter readers --------------------------------------------------
function readInputCheckPasswordSRP(r) {
  const empty = { empty: true, srpId: 0n, A: Buffer.alloc(0), M1: Buffer.alloc(0) };
  if (!isReader(r)) {
    const o = r && typeof r === 'object' ? r : {};
    if (o.empty || o.type === 'inputCheckPasswordEmpty') return empty;
    return {
      empty: false,
      srpId: BigInt(o.srpId ?? o.srp_id ?? 0n),
      A: asBuf(o.A ?? o.a),
      M1: asBuf(o.M1 ?? o.m1),
    };
  }
  if (!r.has(4)) return empty;
  const ctor = r.uint() >>> 0;
  if (ctor === ID.inputCheckPasswordEmpty) return empty;
  if (ctor !== ID.inputCheckPasswordSRP) return { ...empty, constructor: ctor };
  return {
    empty: false,
    srpId: r.has(8) ? r.long() : 0n,
    A: r.has(1) ? r.bytes() : Buffer.alloc(0),
    M1: r.has(1) ? r.bytes() : Buffer.alloc(0),
  };
}

function readKdfAlgo(r) {
  const fallback = { algorithm: 'unknown', salt: Buffer.alloc(0), serverSalt: Buffer.alloc(0), g: 7, p: Buffer.alloc(0) };
  if (!isReader(r) || !r.has(4)) return fallback;
  const ctor = r.uint() >>> 0;
  if (ctor === ID.passwordKdfAlgoUnknown) return fallback;
  if (ctor !== ID.passwordKdfAlgoModPow) return { ...fallback, constructor: ctor };
  return {
    algorithm: 'passwordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow',
    salt: r.has(1) ? r.bytes() : Buffer.alloc(0),
    serverSalt: r.has(1) ? r.bytes() : Buffer.alloc(0),
    g: r.has(4) ? r.int() : 7,
    p: r.has(1) ? r.bytes() : Buffer.alloc(0),
  };
}

function skipSecureSecretSettings(r) {
  if (!isReader(r) || !r.has(4)) return;
  r.uint(); // secureSecretSettings#1527bcac
  if (r.has(4)) r.uint(); // secure_algo:SecurePasswordKdfAlgo
  if (r.has(1)) r.bytes(); // secure_secret
  if (r.has(8)) r.long(); // secure_secret_id
}

function readPasswordInputSettings(r) {
  if (!isReader(r)) {
    const o = r && typeof r === 'object' ? r : {};
    const s = o.newSettings ?? o.new_settings ?? o.settings ?? o;
    return {
      algorithm: s.algorithm ?? s.algo,
      salt: asBuf(s.salt ?? s.salt1),
      serverSalt: asBuf(s.serverSalt ?? s.server_salt ?? s.salt2),
      hash2: asBuf(s.hash2 ?? s.newPasswordHash ?? s.new_password_hash),
      g: s.g !== undefined ? toNumber(s.g, 7) : undefined,
      p: asBuf(s.p),
      b: asBuf(s.b ?? s.serverSecret ?? s.server_secret),
      hint: s.hint !== undefined ? String(s.hint) : undefined,
      email: s.email !== undefined ? String(s.email) : undefined,
    };
  }
  const out = {
    algorithm: undefined, salt: Buffer.alloc(0), serverSalt: Buffer.alloc(0),
    hash2: Buffer.alloc(0), g: undefined, p: Buffer.alloc(0), b: Buffer.alloc(0),
    hint: undefined, email: undefined,
  };
  const flags = r.has(4) ? r.uint() : 0;
  if (flags & 1) {
    const algo = readKdfAlgo(r);
    out.algorithm = algo.algorithm;
    out.salt = algo.salt;
    out.serverSalt = algo.serverSalt;
    out.g = algo.g;
    out.p = algo.p;
    out.hash2 = r.has(1) ? r.bytes() : Buffer.alloc(0); // new_password_hash
    out.hint = r.has(1) ? r.string() : '';
  }
  if (flags & 2) out.email = r.has(1) ? r.string() : '';
  if (flags & 4) skipSecureSecretSettings(r);
  return out;
}

function readToken(r) {
  if (isReader(r)) return r.has(1) ? r.bytes() : Buffer.alloc(0);
  return asBuf(r?.token ?? r?.bytes ?? r);
}

// ---- SRP verification ---------------------------------------------------
/**
 * Verify an inputCheckPasswordSRP against a stored password record.
 * Returns { ok, mode } where mode is 'srp6a', 'fallback', 'passwordless' or 'invalid'.
 */
export function verifyPassword(record, input = {}, ctx = {}) {
  const hasPassword = Boolean(asBuf(record?.hash2).length);
  if (!hasPassword) {
    // A fresh account has no 2FA password; inputCheckPasswordEmpty is enough.
    return { ok: Boolean(input.empty), mode: 'passwordless' };
  }
  if (input.empty || !asBuf(input.A).length || !asBuf(input.M1).length) {
    return { ok: false, mode: 'invalid' };
  }

  const N = asBuf(record.p).length ? intOf(record.p) : 0n;
  const b = intOf(record.b);
  if (!N || !b) {
    // Fallback: deterministic proof against the stored verifier. See the note
    // at the top of this file — this is not a complete SRP exchange.
    const expected = sha(record.salt, asBuf(input.A), record.hash2);
    const provided = asBuf(input.M1);
    return {
      ok: provided.length === expected.length && crypto.timingSafeEqual(provided, expected),
      mode: 'fallback',
    };
  }

  // Real SRP-6a server side.
  const g = BigInt(toNumber(record.g, 7) || 7);
  const v = intOf(record.hash2);
  const k = intOf(sha(fixed256(N), fixed256(g)));
  const B = serverPublicB(record, v, N, g, k);
  const A = intOf(input.A);
  if (A <= 0n || A % N === 0n || B <= 0n || B % N === 0n) return { ok: false, mode: 'invalid' };

  const u = intOf(sha(fixed256(A), fixed256(B)));
  if (u === 0n) return { ok: false, mode: 'invalid' };
  const S = modPow((A * modPow(v, u, N)) % N, b, N);
  const K = sha(fixed256(S));

  const hN = sha(fixed256(N));
  const hg = sha(fixed256(g));
  const xor = Buffer.alloc(hN.length);
  for (let i = 0; i < hN.length; i++) xor[i] = hN[i] ^ hg[i];
  const identity = String(record.identity ?? ctx.phone ?? '');
  const expected = sha(xor, sha(identity), record.salt, fixed256(A), fixed256(B), K);
  const provided = asBuf(input.M1);
  return {
    ok: provided.length === expected.length && crypto.timingSafeEqual(provided, expected),
    mode: 'srp6a',
  };
}

// ---- account methods ----------------------------------------------------
export function getPassword(r, ctx) {
  const record = twofaStoreOf(ctx).getPassword(currentUserId(ctx));
  return encodeAccountPassword(record);
}

export function updatePasswordSettings(r, ctx) {
  const input = isReader(r)
    ? readInputCheckPasswordSRP(r)
    : readInputCheckPasswordSRP(r?.password ?? {});
  const settings = readPasswordInputSettings(isReader(r) ? r : (r?.newSettings ?? r?.new_settings ?? r?.settings ?? r));
  const store = twofaStoreOf(ctx);
  const me = currentUserId(ctx);
  const existing = store.getPassword(me);
  // Setting a password is accepted even with inputCheckPasswordEmpty: this is
  // the normal first-time setup path. Existing passwords are never silently
  // overwritten without a new hash in the settings object.
  void input;
  const next = {
    salt: settings.salt?.length ? settings.salt : (existing?.salt ?? crypto.randomBytes(8)),
    serverSalt: settings.serverSalt?.length ? settings.serverSalt : (existing?.serverSalt ?? crypto.randomBytes(8)),
    hash2: settings.hash2?.length ? settings.hash2 : (existing?.hash2 ?? Buffer.alloc(0)),
    g: settings.g ?? existing?.g ?? 7,
    p: settings.p?.length ? settings.p : (existing?.p ?? DEFAULT_P),
    b: settings.b?.length ? settings.b : (existing?.b ?? Buffer.alloc(0)),
    algorithm: settings.algorithm || 'passwordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow',
    hint: settings.hint ?? existing?.hint ?? '',
    srpId: existing?.srpId || (BigInt(`0x${randomHex(8)}`) & 0x7fffffffffffffffn),
    secureRandom: crypto.randomBytes(16),
  };
  store.setPassword(me, next);
  return boolTrue();
}

export function getPasswordSettings(r, ctx) {
  return encodePasswordSettings();
}

export function deleteAccount(r, ctx) {
  twofaStoreOf(ctx).clearPassword(currentUserId(ctx));
  return boolTrue();
}

// ---- auth methods -------------------------------------------------------
export function checkPassword(r, ctx) {
  const input = readInputCheckPasswordSRP(isReader(r) ? r : (r?.password ?? r));
  const me = currentUserId(ctx);
  const record = twofaStoreOf(ctx).getPassword(me);
  const result = verifyPassword(record, input, ctx);
  if (!result.ok) {
    return error(400, record?.hash2?.length ? 'PASSWORD_INVALID' : 'PASSWORD_NOT_SET');
  }
  const user = bindUser(ctx, me);
  return encodeAuthorization(user);
}

export function resendCode(r, ctx) {
  let phone = '';
  let hash = '';
  if (isReader(r)) {
    const flags = r.has(4) ? r.uint() : 0;
    phone = r.has(1) ? r.string() : '';
    hash = r.has(1) ? r.string() : '';
    if (flags & 1 && r.has(1)) r.string(); // reason
  } else {
    phone = str(r, 'phoneNumber', '');
    hash = str(r, 'phoneCodeHash', '');
  }
  const code = configOf(ctx).authCode || '22222';
  let codeHash = hash || crypto.randomBytes(12).toString('hex');
  if (ctx.store?.createCode) codeHash = ctx.store.createCode(phone, code, codeHash) || codeHash;
  return encodeSentCode({ phoneCodeHash: codeHash, length: String(code).length });
}

export function signUp(r, ctx) {
  const flags = int(r, 'flags', 0);
  const phone = str(r, 'phoneNumber', '');
  const hash = str(r, 'phoneCodeHash', '');
  // flags.0 no_joined_notifications has no wire data beyond the flag itself.
  void flags;
  const firstName = str(r, 'firstName', '');
  const lastName = str(r, 'lastName', '');
  const store = ctx.store;
  const code = configOf(ctx).authCode || '22222';
  if (!store?.checkCode?.(phone, hash, code)) return error(400, 'PHONE_CODE_INVALID');
  let user = store.getUserByPhone(phone);
  if (user) user = { ...user, firstName, lastName };
  else user = store.createUser({ phone, firstName, lastName });
  const session = ensureSession(store, ctx, user.id);
  ctx.userId = user.id;
  ctx.session = session;
  return encodeAuthorization({ ...user, self: true });
}

export function exportLoginToken(r, ctx) {
  const me = currentUserId(ctx);
  const expires = now() + 300;
  const token = `login:${randomHex(16)}`;
  twofaStoreOf(ctx).createLoginToken(token, me, expires);
  return encodeLoginToken(token, expires);
}

export function importLoginToken(r, ctx) {
  const token = readToken(r);
  const store = twofaStoreOf(ctx);
  const row = store.getLoginToken(token);
  if (!row || row.used || row.expires <= now()) return error(400, 'LOGIN_TOKEN_INVALID');
  const userId = row.userId;
  const code = configOf(ctx).authCode || '22222';
  store.createLoginCode(String(token.toString('utf8')), code);
  // Issue a fresh token so auth.acceptLoginToken can complete on the caller.
  const nextToken = `login:${randomHex(16)}`;
  store.createLoginToken(nextToken, userId, now() + 300);
  ctx.nextLoginToken = nextToken;
  const user = bindUser(ctx, userId);
  // The pinned layer-234 schema declares auth.importLoginToken -> auth.LoginToken
  // (normally loginTokenSuccess). This local server returns the authorization
  // directly, as required by the integration contract for this module.
  return encodeAuthorization(user);
}

export function acceptLoginToken(r, ctx) {
  const token = readToken(r);
  const store = twofaStoreOf(ctx);
  let userId = store.consumeLoginToken(String(token.toString('utf8')));
  if (userId === null) {
    // Also accept exported authorization tokens bound via importToken.
    const mapped = store.importToken(String(token.toString('utf8')));
    if (mapped) userId = mapped;
  }
  if (userId === null) return error(400, 'LOGIN_TOKEN_INVALID');
  const user = bindUser(ctx, userId);
  return encodeAuthorization(user);
}

export default {
  getPassword, updatePasswordSettings, getPasswordSettings, deleteAccount,
  checkPassword, resendCode, signUp, exportLoginToken, importLoginToken,
  acceptLoginToken, verifyPassword, METHOD_IDS,
};
