// Secret-chat (end-to-end) crypto for MTProto 2.0, zero npm dependencies.
//
// Specifications used (read before changing any constant or formula):
//   https://core.telegram.org/api/end-to-end
//       - shared key = pow(g_a, b) mod p (or pow(g_b, a) mod p), left-padded
//         with zeroes to exactly 256 bytes, big-endian;
//       - key_fingerprint = 64 LAST bits of SHA1(key) (SHA-1 is used even for
//         MTProto 2.0 secret chats); encoded as a TL `long` that is read
//         little-endian from the last eight digest bytes;
//       - msg_key = substr(SHA256(substr(key, 88+x, 32) + plaintext), 8, 16);
//       - aes_key / aes_iv = the SHA-256 mix from the same page, x = 0 for
//         messages from the chat originator, x = 8 for the other direction;
//       - ciphertext envelope = key_fingerprint (8 bytes, TL long LE) +
//         msg_key (16 bytes) + AES-256-IGE(data), where data is a 4-byte LE
//         length prefix, the TL object, and 12..1024 random padding bytes.
//   https://core.telegram.org/schema/end-to-end  (DecryptedMessage TL scheme)
//   https://core.telegram.org/mtproto/serialize  (TL byte-string padding)
//   https://core.telegram.org/mtproto/auth_key   (the 2048-bit "good" prime)
// Reference implementations cross-checked:
//   Telegram Android SecretChatHelper.java / MessageKeyData.java
//   tdesktop mtproto_auth_key.cpp (prepareAES / partForMsgKey / countKeyId)
//
// `computeKeyFingerprint(gAB, gA)` also exposes the canonical-order
// SHA1(min(gAB,gA) || max(gAB,gA)) fingerprint requested by the caller.
// NOTE: Telegram's *secret chat* key_fingerprint is SHA1 of the shared key
// alone (see above); the ordered-concatenation variant is provided for
// callers that need a symmetric fingerprint of the two DH values. Handlers
// accept either form when verifying a client-supplied fingerprint.

import crypto from 'node:crypto';
import { igeEncrypt, igeDecrypt } from './ige.js';

/** The 2048-bit safe prime published by Telegram (big-endian hex). */
export const DH_PRIME_HEX = (
  'C71CAEB9C6B1C9048E6C522F70F13F73' +
  '980D40238E3E21C14934D037563D930F' +
  '48198A0AA7C14058229493D22530F4DB' +
  'FA336F6E0AC925139543AED44CCE7C37' +
  '20FD51F69458705AC68CD4FE6B6B13AB' +
  'DC9746512969328454F18FAF8C595F64' +
  '2477FE96BB2A941D5BCD1D4AC8CC4988' +
  '0708FA9B378E3C4F3A9060BEE67CF9A4' +
  'A4A695811051907E162753B56B0F6B41' +
  '0DBA74D8A84B2A14B3144E0EF1284754' +
  'FD17ED950D5965B4B9DD46582DB1178D' +
  '169C6BC465B0D6FF9CA3928FEF5B9AE4' +
  'E418FC15E83EBEA0F87FA9FF5EED7005' +
  '0DED2849F47BF959D956850CE929851F' +
  '0D8115F635B105EE2E4E15D04B2454BF' +
  '6F4FADF034B10403119CD8E3B92FCC5B'
).toLowerCase();

export const DH_PRIME = BigInt(`0x${DH_PRIME_HEX}`);
export const DH_GENERATOR = 3n; // quadratic residue for this prime (p mod 3 = 2)

const sha1 = (...parts) => crypto.createHash('sha1').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const sha256 = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const sub = (buf, start, len) => Buffer.from(buf.subarray(start, start + len));

/** Interpret the final eight SHA-1 bytes as a signed TL `long`. */
function low64(buf) {
  if (buf.length < 8) throw new RangeError('low64: digest too short');
  return buf.readBigInt64LE(buf.length - 8);
}

/** Normalize a DH value to a fixed-size big-endian byte buffer. */
export function toFixedBytes(value, size = 256) {
  let buf;
  if (typeof value === 'bigint') {
    if (value < 0n) throw new RangeError('toFixedBytes: negative value');
    let hex = value.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    buf = Buffer.from(hex, 'hex');
  } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    buf = Buffer.from(value);
  } else if (typeof value === 'string') {
    const hex = value.replace(/^0x/i, '');
    if (/^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0) buf = Buffer.from(hex, 'hex');
    else buf = Buffer.from(value, 'utf8');
  } else {
    throw new TypeError('toFixedBytes: expected bigint, Buffer or hex string');
  }
  // BigInteger.toByteArray() adds a leading 0x00 sign byte; drop it.
  if (buf.length > size && buf[0] === 0) buf = buf.subarray(buf.length - size);
  if (buf.length > size) buf = buf.subarray(buf.length - size);
  const out = Buffer.alloc(size);
  buf.copy(out, size - buf.length);
  return out;
}

/** Bytes of a bigint as a minimal big-endian TL byte string. */
export function bigintToBytes(value) {
  let hex = BigInt(value).toString(16);
  if (hex === '0') return Buffer.from([0]);
  if (hex.length % 2) hex = `0${hex}`;
  return Buffer.from(hex, 'hex');
}

/** The shared DH secret, exactly 256 bytes, big-endian (spec padding rule). */
export function deriveE2EKey(gAB) {
  return toFixedBytes(gAB, 256);
}

/**
 * Fingerprint of two DH values. With both arguments present the SHA-1 input
 * is the two big-endian byte strings in ascending order (symmetric
 * fingerprint requested by the caller). With only `gAB` it is the official
 * secret-chat key_fingerprint, i.e. low 64 bits of SHA1(shared key).
 */
export function computeKeyFingerprint(gAB, gA) {
  if (gA === undefined || gA === null) return computeSharedKeyFingerprint(gAB);
  const raw = (v) => {
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v);
    if (typeof v === 'bigint') return bigintToBytes(v);
    const hex = String(v).replace(/^0x/i, '');
    if (/^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0) return Buffer.from(hex, 'hex');
    return Buffer.from(String(v), 'utf8');
  };
  const first = raw(gAB);
  const second = raw(gA);
  const cmp = Buffer.compare(first, second);
  const ordered = cmp <= 0 ? [first, second] : [second, first];
  return low64(sha1(...ordered));
}

/** Official secret-chat key_fingerprint: last 64 bits of SHA1(256-byte key). */
export function computeSharedKeyFingerprint(gAB) {
  return low64(sha1(deriveE2EKey(gAB)));
}

/** 8-byte TL `long` encoding of a fingerprint (little-endian). */
export function fingerprintBytes(fingerprint) {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(fingerprint), 0);
  return out;
}

/**
 * Secret-chat msg_key. `plaintext` is the complete padded data block:
 * 4-byte little-endian TL length + TL object + 12..1024 padding bytes.
 * x = 0 for the chat originator, x = 8 for the peer.
 */
export function computeSecretMsgKey(key, plaintext, x = 0) {
  const k = deriveE2EKey(key);
  return sub(sha256(sub(k, 88 + x, 32), Buffer.from(plaintext)), 8, 16);
}

/** aes_key / aes_iv for a given msg_key and direction (MTProto 2.0). */
export function deriveAesIge(key, msgKey, x = 0) {
  const k = deriveE2EKey(key);
  const sha256A = sha256(Buffer.from(msgKey), sub(k, x, 36));
  const sha256B = sha256(sub(k, 40 + x, 36), Buffer.from(msgKey));
  const aesKey = Buffer.concat([sub(sha256A, 0, 8), sub(sha256B, 8, 16), sub(sha256A, 24, 8)]);
  const aesIv = Buffer.concat([sub(sha256B, 0, 8), sub(sha256A, 8, 16), sub(sha256B, 24, 8)]);
  return { aesKey, aesIv };
}

/** Length prefix + TL bytes + 12..1024 random bytes, total length % 16 == 0. */
export function serializeSecretPlaintext(tlData, padding = null) {
  const tl = Buffer.from(tlData);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(tl.length, 0);
  const body = 4 + tl.length;
  let pad = padding === null ? (16 - (body % 16)) % 16 : Number(padding);
  if (padding === null && pad < 12) pad += 16; // padding must be >= 12
  if (pad < 12 || pad > 1024) throw new RangeError('secret padding must be 12..1024 bytes');
  return Buffer.concat([prefix, tl, crypto.randomBytes(pad)]);
}

/**
 * Encrypt a TL object as a secret-chat encryptedMessage.data envelope:
 * fingerprint(8, LE long) + msg_key(16) + AES-256-IGE ciphertext.
 */
export function encryptSecretMessage(key, tlData, opts = {}) {
  const k = deriveE2EKey(key);
  const x = Number(opts.x ?? 0);
  const plain = opts.plaintext ? Buffer.from(opts.plaintext) : serializeSecretPlaintext(tlData, opts.padding);
  const msgKey = computeSecretMsgKey(k, plain, x);
  const { aesKey, aesIv } = deriveAesIge(k, msgKey, x);
  const fingerprint = opts.fingerprint === undefined
    ? computeSharedKeyFingerprint(k)
    : BigInt(opts.fingerprint);
  return Buffer.concat([fingerprintBytes(fingerprint), msgKey, igeEncrypt(aesKey, aesIv, plain)]);
}

/**
 * Decrypt an encryptedMessage.data envelope. Verifies msg_key (the mandatory
 * integrity check from the spec), the length prefix, and the padding range.
 * Returns the padded plaintext plus the unwrapped TL object bytes.
 */
export function decryptSecretMessage(key, ciphertext, opts = {}) {
  const k = deriveE2EKey(key);
  const data = Buffer.from(ciphertext);
  if (data.length < 24 + 16) throw new Error('secret message too short');
  const fingerprint = data.readBigInt64LE(0);
  const msgKey = sub(data, 8, 16);
  const body = Buffer.from(data.subarray(24));
  if (body.length % 16 !== 0) throw new Error('secret ciphertext is not block aligned');
  const x = Number(opts.x ?? 0);
  const { aesKey, aesIv } = deriveAesIge(k, msgKey, x);
  const plain = igeDecrypt(aesKey, aesIv, body);
  const expected = computeSecretMsgKey(k, plain, x);
  if (!crypto.timingSafeEqual(msgKey, expected)) throw new Error('secret msg_key mismatch');
  if (opts.fingerprint !== undefined && BigInt(opts.fingerprint) !== fingerprint) {
    throw new Error('secret key fingerprint mismatch');
  }
  if (plain.length < 16) throw new Error('secret plaintext too short');
  const length = plain.readUInt32LE(0);
  const padding = plain.length - 4 - length;
  if (length <= 0 || length > plain.length - 4) throw new Error('secret TL length out of range');
  if (padding < 12 || padding > 1024) throw new Error('secret padding out of range');
  return {
    plaintext: plain,
    tlData: sub(plain, 4, length),
    msgKey,
    fingerprint,
    length,
    padding,
  };
}

export default {
  DH_PRIME_HEX,
  DH_PRIME,
  DH_GENERATOR,
  toFixedBytes,
  bigintToBytes,
  deriveE2EKey,
  computeKeyFingerprint,
  computeSharedKeyFingerprint,
  fingerprintBytes,
  computeSecretMsgKey,
  deriveAesIge,
  serializeSecretPlaintext,
  encryptSecretMessage,
  decryptSecretMessage,
};
