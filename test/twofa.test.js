// Unit tests for the dedicated TwoFAStore and the 2FA / login-token handlers.
// Constructor ids are written out explicitly (from schema/api.tl, layer 234)
// so the tests catch accidental wire-format changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TLBuffer } from '../src/tl/buffer.js';
import { Store } from '../src/store/store.js';
import { TwoFAStore } from '../src/store/twofa.js';
import * as twofa from '../src/rpc/handlers/twofa.js';

const ID = {
  true: 0x3fedd339,
  boolTrue: 0x997275b5,
  user: 0xb1b8cc83,
  authorization: 0x2ea2c0d4,
  sentCode: 0x5e002502,
  loginToken: 0x629f1980,
  accountPassword: 0x957b50fb,
  passwordSettings: 0x9a5c33e5,
  algoUnknown: 0xd45ab096,
  algoModPow: 0x3a912d4a,
  secureAlgoUnknown: 0x4a8537,
  rpcError: 0x2144ca19,
  vector: 0x1cb5c415,
};

const USER_BOOL_BITS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 23, 24, 25, 26, 27, 28, 29];
const PRIME_HEX = 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1'
  + '29024E088A67CC74020BBEA63B139B22514A08798E3404DD'
  + 'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245'
  + 'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED'
  + 'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D'
  + 'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F'
  + '83655D23DCA3AD961C62F356208552BB9ED529077096966D'
  + '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B'
  + 'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9'
  + 'DE2BCBF6955817183995497CEA956AE515D2261898FA0510'
  + '15728E5A8AACAA68FFFFFFFFFFFFFFFF';

function tempDir() {
  const dir = path.join(os.tmpdir(), `telegramserver-twofa-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function afterId(hex) {
  const b = new TLBuffer();
  b.putUint(hex);
  return { b, reader: () => new TLBuffer(b.buffer.subarray(4)) };
}

function readUser(r) {
  assert.equal(r.uint(), ID.user);
  const flags = r.uint();
  for (const bit of USER_BOOL_BITS) if (flags & (1 << bit)) assert.equal(r.uint(), ID.true);
  r.uint(); // flags2
  const id = Number(r.long());
  if (flags & 1) r.long();
  const firstName = flags & 2 ? r.string() : '';
  const lastName = flags & 4 ? r.string() : '';
  return { id, firstName, lastName };
}

function fixed256(v) {
  const out = Buffer.alloc(256);
  let n = BigInt(v);
  for (let i = out.length - 1; i >= 0 && n > 0n; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function intOf(buf) {
  return buf.length ? BigInt(`0x${buf.toString('hex')}`) : 0n;
}

function modPow(base, exp, mod) {
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
  const h = crypto.createHash('sha256');
  for (const part of parts) h.update(part);
  return h.digest();
}

function makeContext(dir) {
  const store = new Store(dir);
  const twofaStore = new TwoFAStore(dir);
  const user = store.createUser({ phone: '+15551110000', firstName: 'Me', lastName: 'User' });
  return {
    ctx: { store, twofaStore, userId: user.id, config: { authCode: '22222' } },
    user, store, twofaStore,
  };
}

// ---- store ---------------------------------------------------------------
test('TwoFAStore (sqlite) password CRUD, tokens, codes and passport config', () => {
  const dir = tempDir();
  const store = new TwoFAStore(dir);
  try {
    assert.equal(store.driverKind, 'sqlite');
    assert.ok(fs.existsSync(path.join(dir, 'twofa.sqlite')));
    assert.equal(store.getPassword(1), null);

    const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const serverSalt = Buffer.from('fedcba9876543210', 'hex');
    const hash2 = crypto.randomBytes(32);
    const B = crypto.randomBytes(256);
    const saved = store.setPassword(1, {
      salt, serverSalt, hash2, g_srp_B: B, algorithm: 'kdf', g: 7,
      p: Buffer.from(PRIME_HEX, 'hex'), srpId: 123n, hint: 'pet name',
    });
    assert.equal(saved.userId, 1);
    const loaded = store.getPassword(1);
    assert.deepEqual(loaded.salt, salt);
    assert.deepEqual(loaded.serverSalt, serverSalt);
    assert.deepEqual(loaded.hash2, hash2);
    assert.deepEqual(loaded.g_srp_B, B);
    assert.equal(loaded.algorithm, 'kdf');
    assert.equal(loaded.g, 7);
    assert.equal(loaded.srpId, 123n);
    assert.equal(loaded.hint, 'pet name');

    const partial = store.setPassword(1, { hint: 'new hint' });
    assert.equal(partial.hint, 'new hint');
    assert.deepEqual(partial.hash2, hash2); // partial update keeps other fields

    assert.equal(store.clearPassword(1), true);
    assert.equal(store.clearPassword(1), false);
    assert.equal(store.getPassword(1), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TwoFAStore login token / code / export round trip and JSON fallback', () => {
  const dir = tempDir();
  const store = new TwoFAStore(dir);
  try {
    const expires = Math.floor(Date.now() / 1000) + 300;
    store.createLoginToken('tok-1', 42, expires);
    const row = store.getLoginToken('tok-1');
    assert.equal(row.userId, 42);
    assert.equal(row.expires, expires);
    assert.equal(row.used, false);

    store.createLoginCode('tok-1', '22222');
    assert.equal(store.checkLoginCode('tok-1', '22222'), true);
    assert.equal(store.checkLoginCode('tok-1', '00000'), false);

    assert.equal(store.consumeLoginToken('tok-1'), 42);
    assert.equal(store.consumeLoginToken('tok-1'), null); // one-shot
    store.createLoginToken('tok-old', 42, Math.floor(Date.now() / 1000) - 1);
    assert.equal(store.consumeLoginToken('tok-old'), null); // expired

    const token = store.exportToken(42);
    assert.ok(token.startsWith('login:'));
    assert.equal(store.exportToken(42), token);
    assert.equal(store.importToken(token), 42);
    assert.equal(store.importToken('login:foreign', 99), 99);
    assert.equal(store.importToken('login:foreign'), 99);
    assert.equal(store.importToken(''), null);

    store.setPassportConfig({ essential: true, google: { value: 'x' } });
    assert.deepEqual(store.getPassportConfig(), { essential: true, google: { value: 'x' } });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const jsonDir = tempDir();
  const json = new TwoFAStore(jsonDir, { dbDriver: 'json' });
  try {
    assert.equal(json.driverKind, 'json');
    assert.ok(fs.existsSync(path.join(jsonDir, 'twofa.json')));
    json.setPassword(7, { salt: Buffer.from('aa', 'hex'), hash2: Buffer.from('bb', 'hex') });
    assert.deepEqual(json.getPassword(7).hash2, Buffer.from('bb', 'hex'));
    json.createLoginToken('json-token', 7, Math.floor(Date.now() / 1000) + 60);
    assert.equal(json.consumeLoginToken('json-token'), 7);
    assert.deepEqual(json.getPassportConfig(), {});
  } finally {
    json.close();
    fs.rmSync(jsonDir, { recursive: true, force: true });
  }
});

// ---- handlers ------------------------------------------------------------
test('account.getPassword returns account.password#957b50fb with parsed fields', () => {
  const dir = tempDir();
  const { ctx } = makeContext(dir);
  try {
    const empty = new TLBuffer(twofa.getPassword({}, ctx));
    assert.equal(empty.uint(), ID.accountPassword);
    assert.equal(empty.uint(), 0); // flags: no password yet
    assert.equal(empty.uint(), ID.algoUnknown); // new_algo
    assert.equal(empty.uint(), ID.secureAlgoUnknown); // new_secure_algo
    assert.ok(empty.bytes().length > 0); // secure_random

    ctx.twofaStore.setPassword(ctx.userId, {
      salt: Buffer.from('0102030405060708', 'hex'),
      serverSalt: Buffer.from('1112131415161718', 'hex'),
      hash2: crypto.randomBytes(32),
      g_srp_B: crypto.randomBytes(256),
      srpId: 987654321n,
      hint: 'my pet',
    });
    const r = new TLBuffer(twofa.getPassword({}, ctx));
    assert.equal(r.uint(), ID.accountPassword);
    const flags = r.uint();
    assert.equal(flags, 4 | 8); // has_password + hint
    assert.equal(r.uint(), ID.true); // has_password:flags.2?true
    assert.equal(r.uint(), ID.algoModPow); // current_algo
    assert.deepEqual(r.bytes(), Buffer.from('0102030405060708', 'hex')); // salt1
    assert.deepEqual(r.bytes(), Buffer.from('1112131415161718', 'hex')); // salt2
    assert.equal(r.int(), 7); // g
    assert.equal(r.bytes().length, 256); // p
    assert.equal(r.bytes().length, 256); // srp_B
    assert.equal(r.long(), 987654321n); // srp_id
    assert.equal(r.string(), 'my pet'); // hint
    assert.equal(r.uint(), ID.algoModPow); // new_algo
    assert.equal(r.bytes().length, 8); // new_algo.salt1
    assert.equal(r.bytes().length, 8); // new_algo.salt2
    assert.equal(r.int(), 7); // new_algo.g
    assert.equal(r.bytes().length, 256); // new_algo.p
    assert.equal(r.uint(), ID.secureAlgoUnknown);
    assert.ok(r.bytes().length > 0);
    assert.equal(r.offset, r.length);
  } finally {
    ctx.twofaStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('account.updatePasswordSettings persists a password; getPasswordSettings / deleteAccount', () => {
  const dir = tempDir();
  const { ctx } = makeContext(dir);
  try {
    const salt = Buffer.from('aabbccddeeff0011', 'hex');
    const serverSalt = Buffer.from('1122334455667788', 'hex');
    const hash2 = crypto.randomBytes(32);
    const params = {
      password: { empty: true },
      newSettings: {
        algorithm: 'passwordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow',
        salt, serverSalt, hash2, g: 7, hint: 'secret hint',
      },
    };
    const updated = twofa.updatePasswordSettings(params, ctx);
    assert.equal(updated.readUInt32LE(0), ID.boolTrue);

    const record = ctx.twofaStore.getPassword(ctx.userId);
    assert.deepEqual(record.salt, salt);
    assert.deepEqual(record.serverSalt, serverSalt);
    assert.deepEqual(record.hash2, hash2);
    assert.equal(record.hint, 'secret hint');
    const hasPassword = new TLBuffer(twofa.getPassword({}, ctx));
    assert.equal(hasPassword.uint(), ID.accountPassword);
    assert.equal(hasPassword.uint() & 4, 4);

    const settings = new TLBuffer(twofa.getPasswordSettings({}, ctx));
    assert.equal(settings.uint(), ID.passwordSettings);
    assert.equal(settings.uint(), 0);

    assert.equal(twofa.deleteAccount({}, ctx).readUInt32LE(0), ID.boolTrue);
    assert.equal(ctx.twofaStore.getPassword(ctx.userId), null);
  } finally {
    ctx.twofaStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auth.checkPassword verifies a deterministic fallback proof and binds the session', () => {
  const dir = tempDir();
  const { ctx, user } = makeContext(dir);
  try {
    const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const hash2 = Buffer.from('deadbeef'.repeat(8), 'hex');
    const A = Buffer.from('feedface'.repeat(8), 'hex');
    const M1 = sha(salt, A, hash2);
    ctx.twofaStore.setPassword(user.id, { salt, hash2 });

    const result = twofa.checkPassword({
      password: { srpId: 1n, A, M1 },
    }, ctx);
    const r = new TLBuffer(result);
    assert.equal(r.uint(), ID.authorization);
    assert.equal(r.uint(), 0); // flags
    assert.equal(readUser(r).id, user.id);
    assert.equal(ctx.userId, user.id);
    assert.ok(ctx.session?.userId === user.id);

    const bad = twofa.checkPassword({ password: { srpId: 1n, A, M1: Buffer.alloc(32) } }, ctx);
    const err = new TLBuffer(bad);
    assert.equal(err.uint(), ID.rpcError);
    assert.equal(err.int(), 400);
    assert.equal(err.string(), 'PASSWORD_INVALID');
  } finally {
    ctx.twofaStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auth.checkPassword performs a real SRP-6a server-side verification', () => {
  const dir = tempDir();
  const { ctx, user } = makeContext(dir);
  try {
    const N = intOf(Buffer.from(PRIME_HEX, 'hex'));
    const g = 7n;
    const x = 123456789n;
    const a = 987654321n;
    const b = 0xabcdef1234567890n;
    const salt = Buffer.from('cafebabe'.repeat(4), 'hex');
    const v = modPow(g, x, N);
    const k = intOf(sha(fixed256(N), fixed256(g)));
    const B = (k * v + modPow(g, b, N)) % N;
    const A = modPow(g, a, N);
    const u = intOf(sha(fixed256(A), fixed256(B)));
    const S = modPow((B - ((k * v) % N) + N) % N, a + u * x, N);
    const K = sha(fixed256(S));
    const hN = sha(fixed256(N));
    const hg = sha(fixed256(g));
    const xor = Buffer.from(hN.map((byte, i) => byte ^ hg[i]));
    const M1 = sha(xor, sha(''), salt, fixed256(A), fixed256(B), K);

    ctx.twofaStore.setPassword(user.id, {
      salt,
      serverSalt: Buffer.alloc(8),
      hash2: fixed256(v),
      g_srp_B: fixed256(B),
      b: fixed256(b),
      p: Buffer.from(PRIME_HEX, 'hex'),
      g: 7,
      srpId: 777n,
    });
    const input = { password: { srpId: 777n, A: fixed256(A), M1 } };

    assert.deepEqual(twofa.verifyPassword(ctx.twofaStore.getPassword(user.id), input.password, ctx), {
      ok: true, mode: 'srp6a',
    });
    const result = new TLBuffer(twofa.checkPassword(input, ctx));
    assert.equal(result.uint(), ID.authorization);
    assert.equal(result.uint(), 0); // flags
    assert.equal(readUser(result).id, user.id);

    const badM1 = Buffer.from(M1);
    badM1[0] ^= 1;
    assert.equal(twofa.verifyPassword(ctx.twofaStore.getPassword(user.id), {
      srpId: 777n, A: fixed256(A), M1: badM1,
    }, ctx).ok, false);
  } finally {
    ctx.twofaStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auth.resendCode returns auth.sentCode#5e002502 and auth.signUp registers a user', () => {
  const dir = tempDir();
  const { ctx } = makeContext(dir);
  try {
    const { reader } = afterId(0xcae47523);
    // params are encoded by hand to exercise reader-after-id parsing.
    const b = new TLBuffer();
    b.putUint(0).putString('+15559990000').putString('old-hash');
    const codeBuf = twofa.resendCode(new TLBuffer(b.buffer), ctx);
    const sent = new TLBuffer(codeBuf);
    assert.equal(sent.uint(), ID.sentCode);
    assert.equal(sent.uint(), 0); // flags
    assert.equal(sent.uint(), 0xc000bba2); // sentCodeTypeSms
    assert.equal(sent.int(), 5); // length of '22222'
    const hash = sent.string();
    assert.ok(hash.length > 0);
    void reader;

    const signup = twofa.signUp({
      phoneNumber: '+15559990000', phoneCodeHash: hash,
      firstName: 'New', lastName: 'User',
    }, ctx);
    const r = new TLBuffer(signup);
    assert.equal(r.uint(), ID.authorization);
    assert.equal(r.uint(), 0);
    const created = readUser(r);
    assert.equal(created.firstName, 'New');
    assert.equal(created.lastName, 'User');
    assert.equal(ctx.store.getUser(created.id).phone, '+15559990000');

    const invalid = twofa.signUp({ phoneNumber: '+1', phoneCodeHash: 'nope', firstName: 'A', lastName: 'B' }, ctx);
    assert.equal(new TLBuffer(invalid).uint(), ID.rpcError);
  } finally {
    ctx.twofaStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auth.exportLoginToken / importLoginToken / acceptLoginToken round trip', () => {
  const dir = tempDir();
  const { ctx, user } = makeContext(dir);
  try {
    const exported = new TLBuffer(twofa.exportLoginToken({}, ctx));
    assert.equal(exported.uint(), ID.loginToken);
    const expires = exported.int();
    const token = exported.string();
    assert.ok(expires > Math.floor(Date.now() / 1000));
    assert.ok(token.startsWith('login:'));
    assert.equal(exported.offset, exported.length);

    const imported = new TLBuffer(twofa.importLoginToken({ token }, ctx));
    assert.equal(imported.uint(), ID.authorization);
    assert.equal(imported.uint(), 0); // flags
    assert.equal(readUser(imported).id, user.id);
    assert.equal(ctx.twofaStore.checkLoginCode(token, '22222'), true);

    const accepted = new TLBuffer(twofa.acceptLoginToken({ token: ctx.nextLoginToken }, ctx));
    assert.equal(accepted.uint(), ID.authorization);
    assert.equal(accepted.uint(), 0); // flags
    assert.equal(readUser(accepted).id, user.id);
    assert.equal(ctx.twofaStore.consumeLoginToken(ctx.nextLoginToken), null); // consumed

    const again = twofa.acceptLoginToken({ token: ctx.nextLoginToken }, ctx);
    assert.equal(new TLBuffer(again).uint(), ID.rpcError);
  } finally {
    ctx.twofaStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handlers also accept TLBuffer readers positioned after the method id', () => {
  const dir = tempDir();
  const { ctx, user } = makeContext(dir);
  try {
    const salt = Buffer.from('1122334455667788', 'hex');
    const hash2 = crypto.randomBytes(32);
    const A = crypto.randomBytes(16);
    const M1 = sha(salt, A, hash2);
    ctx.twofaStore.setPassword(user.id, { salt, hash2 });

    const srp = new TLBuffer();
    srp.putUint(0xd27ff082).putLong(5n).putBytes(A).putBytes(M1); // inputCheckPasswordSRP
    const checked = new TLBuffer(twofa.checkPassword(new TLBuffer(srp.buffer), ctx));
    assert.equal(checked.uint(), ID.authorization);
    assert.equal(checked.uint(), 0);
    assert.equal(readUser(checked).id, user.id);

    const token = ctx.twofaStore.exportToken(user.id);
    ctx.twofaStore.createLoginToken(token, user.id, Math.floor(Date.now() / 1000) + 300);
    const tokenBuf = new TLBuffer();
    tokenBuf.putUint(0x95ac5ce4).putBytes(Buffer.from(token, 'utf8'));
    const reader = new TLBuffer(tokenBuf.buffer);
    assert.equal(reader.uint(), 0x95ac5ce4); // method id consumed by the router
    const imported = new TLBuffer(twofa.importLoginToken(reader, ctx));
    assert.equal(imported.uint(), ID.authorization);
  } finally {
    ctx.twofaStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handler method ids match the layer-234 schema', () => {
  assert.equal(twofa.METHOD_IDS['account.getPassword'], 0x548a30f5);
  assert.equal(twofa.METHOD_IDS['account.updatePasswordSettings'], 0xa59b102f);
  assert.equal(twofa.METHOD_IDS['account.getPasswordSettings'], 0x9cd4eaf9);
  assert.equal(twofa.METHOD_IDS['account.deleteAccount'], 0xa2c0cf74);
  assert.equal(twofa.METHOD_IDS['auth.checkPassword'], 0xd18b4d16);
  assert.equal(twofa.METHOD_IDS['auth.resendCode'], 0xcae47523);
  assert.equal(twofa.METHOD_IDS['auth.signUp'], 0xaac7b717);
  assert.equal(twofa.METHOD_IDS['auth.exportLoginToken'], 0xb7e085fe);
  assert.equal(twofa.METHOD_IDS['auth.importLoginToken'], 0x95ac5ce4);
  assert.equal(twofa.METHOD_IDS['auth.acceptLoginToken'], 0xe894ad4d);
});
