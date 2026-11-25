import test from 'node:test';
import assert from 'node:assert/strict';
import { igeEncrypt, igeDecrypt, xor } from '../src/crypto/ige.js';
import { generateRSA, rsaFingerprint, rsaPadEncrypt, rsaPadDecrypt, rawRSA } from '../src/crypto/rsa.js';
import { TLBuffer } from '../src/tl/buffer.js';

test('IGE OpenSSL test vector 1', () => {
  const key = Buffer.from('000102030405060708090A0B0C0D0E0F', 'hex');
  const iv = Buffer.from('000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F', 'hex');
  const plain = Buffer.alloc(32);
  const want = Buffer.from('1A8519A6557BE652E9DA8E43DA4EF4453CF456B4CA488AA383C79C98B34797CB', 'hex');
  assert.deepEqual(igeEncrypt(key, iv, plain), want);
  assert.deepEqual(igeDecrypt(key, iv, want), plain);
});

test('IGE OpenSSL test vector 2', () => {
  const key = Buffer.from('5468697320697320616E2069 6D706C65'.replace(' ', ''), 'hex');
  const iv = Buffer.from('6D656E746174696F6E206F6620494745206D6F646520666F72204F70656E5353', 'hex');
  const plain = Buffer.from('99706487A1CDE613BC6DE0B6F24B1C7AA448C8B9C3403E3467A8CAD89340F53B', 'hex');
  const want = Buffer.from('4C2E204C6574277320686F70652042656E20676F74206974207269676874210A', 'hex');
  assert.deepEqual(igeEncrypt(key, iv, plain), want);
  assert.deepEqual(igeDecrypt(key, iv, want), plain);
});

test('IGE AES-256 round trip', () => {
  const key = Buffer.alloc(32, 7);
  const iv = Buffer.alloc(32, 3);
  const plain = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  assert.deepEqual(igeDecrypt(key, iv, igeEncrypt(key, iv, plain)), plain);
});

test('xor', () => {
  assert.deepEqual(xor(Buffer.from([0xff, 0x0f]), Buffer.from([0x0f, 0xf0])), Buffer.from([0xf0, 0xff]));
});

test('RSA_PAD round trip and fingerprint', () => {
  const keys = generateRSA();
  assert.equal(keys.n.length, 256);
  const payload = TLBuffer ? Buffer.from('hello mtproto') : Buffer.alloc(0);
  const enc = rsaPadEncrypt(payload, keys);
  assert.equal(enc.length, 256);
  assert.deepEqual(rsaPadDecrypt(enc, keys).subarray(0, payload.length), payload);
  const fp = rsaFingerprint(keys.n, keys.e);
  assert.equal(typeof fp, 'bigint');
  assert.ok(fp >= 0n && fp < (1n << 64n));
});

test('raw RSA round trip', () => {
  const keys = generateRSA();
  const m = Buffer.alloc(256, 5);
  assert.deepEqual(rawRSA(rawRSA(m, keys.e, keys.n), keys.d, keys.n), m);
});
