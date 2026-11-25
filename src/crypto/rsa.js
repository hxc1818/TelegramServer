// Telegram's custom RSA_PAD (OAEP+-like) and RSA key helpers.
// NOT PKCS#1 v1.5: raw modular exponentiation is used on both sides.
// Reference: https://core.telegram.org/mtproto/auth_key
import crypto from 'node:crypto';
import { tlString } from '../tl/buffer.js';
import { igeEncrypt, igeDecrypt, xor } from './ige.js';

const ZERO_IV = Buffer.alloc(32);

function toBig(buf) {
  return BigInt(`0x${buf.toString('hex') || '0'}`);
}

function fromBig(v, size = 256) {
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const raw = Buffer.from(hex, 'hex');
  if (raw.length > size) throw new RangeError('rawRSA result too large');
  return Buffer.concat([Buffer.alloc(size - raw.length), raw]);
}

export function generateRSA() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  return {
    privatePem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    n: Buffer.from(pub.n, 'base64url'),
    e: Buffer.from(pub.e, 'base64url'),
    d: Buffer.from(priv.d, 'base64url'),
  };
}

// Raw RSA: c = m^exp mod mod (no padding of any kind).
export function rawRSA(m, exp, mod) {
  return fromBig(modPow(toBig(m), toBig(exp), toBig(mod)), m.length);
}

function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

// low 64 bits of SHA1(TL_string(n) || TL_string(e))
export function rsaFingerprint(n, e) {
  const hash = crypto.createHash('sha1').update(tlString(n)).update(tlString(e)).digest();
  return hash.readBigUInt64LE(12);
}

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

// Client side (used in tests): TL data (<=144 bytes) -> 256-byte RSA block.
export function rsaPadEncrypt(tlData, keys) {
  if (tlData.length > 144) throw new RangeError('RSA_PAD data must be <= 144 bytes');
  const dataWithPadding = Buffer.concat([tlData, crypto.randomBytes(192 - tlData.length)]);
  const reversed = Buffer.from(dataWithPadding).reverse();
  const n = toBig(keys.n);
  for (;;) {
    const tempKey = crypto.randomBytes(32);
    const dataWithHash = Buffer.concat([reversed, sha256(tempKey, dataWithPadding)]);
    const aesEncrypted = igeEncrypt(tempKey, ZERO_IV, dataWithHash);
    const tempKeyXor = xor(tempKey, sha256(aesEncrypted));
    const block = Buffer.concat([tempKeyXor, aesEncrypted]);
    if (toBig(block) < n) return rawRSA(block, keys.e, keys.n);
  }
}

// Server side: 256-byte RSA block -> original TL data + random padding.
export function rsaPadDecrypt(ciphertext, keys) {
  if (ciphertext.length !== 256) throw new RangeError('RSA block must be 256 bytes');
  const block = rawRSA(ciphertext, keys.d, keys.n);
  const tempKeyXor = block.subarray(0, 32);
  const aesEncrypted = block.subarray(32, 256);
  const tempKey = xor(tempKeyXor, sha256(aesEncrypted));
  const plain = igeDecrypt(tempKey, ZERO_IV, aesEncrypted);
  const dataWithPadding = Buffer.from(plain.subarray(0, 192)).reverse();
  const hash = plain.subarray(192, 224);
  const expected = sha256(tempKey, dataWithPadding);
  if (!crypto.timingSafeEqual(hash, expected)) throw new Error('RSA_PAD hash mismatch');
  return dataWithPadding;
}
