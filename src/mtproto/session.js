// MTProto 2.0 encrypted session: IGE message encryption and the inner
// plaintext (salt | session_id | msg_id | seq_no | length | body | padding).
// No third-party dependencies.
import crypto from 'node:crypto';
import { igeEncrypt, igeDecrypt } from '../crypto/ige.js';

const AUTH_KEY_SIZE = 256;
const INNER_HEADER_SIZE = 8 + 8 + 8 + 4 + 4; // 32 bytes
const MIN_PADDING = 12;
const MAX_PADDING = 1024;

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function authKeyIdOf(authKey) {
  return sha1Low64(authKey);
}

function sha1Low64(buf) {
  const h = crypto.createHash('sha1').update(buf).digest();
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(h.readBigUInt64LE(12), 0);
  return out;
}

let lastServerMsgId = 0n;

/** Server msg_id: odd, mod 4 == 1, approximately unixtime << 32. */
export function newServerMsgId() {
  const t = BigInt(Math.floor(Date.now() / 1000));
  let id = (t << 32n) | 1n;
  if (id <= lastServerMsgId) id = lastServerMsgId + 4n;
  lastServerMsgId = id;
  return id;
}

let lastClientMsgId = 0n;

/** Client msg_id: even, divisible by 4, approximately unixtime << 32. */
export function newClientMsgId() {
  const t = BigInt(Math.floor(Date.now() / 1000));
  const fraction = BigInt(crypto.randomInt(1, 1 << 30) & ~3);
  let id = (t << 32n) | fraction;
  if (id <= lastClientMsgId) id = lastClientMsgId + 4n;
  lastClientMsgId = id;
  return id;
}

/** Build the encrypted inner plaintext. Padding is chosen so len % 16 === 0. */
export function packMessage({ salt, sessionId, msgId, seqNo, body, padding } = {}) {
  if (!Buffer.isBuffer(salt) || salt.length !== 8) throw new RangeError('salt must be 8 bytes');
  if (!Buffer.isBuffer(sessionId) || sessionId.length !== 8) throw new RangeError('sessionId must be 8 bytes');
  const src = Buffer.isBuffer(body) ? body : Buffer.from(body || Buffer.alloc(0));
  const header = Buffer.alloc(INNER_HEADER_SIZE);
  salt.copy(header, 0);
  sessionId.copy(header, 8);
  header.writeBigInt64LE(BigInt.asIntN(64, BigInt(msgId)), 16);
  header.writeInt32LE(seqNo | 0, 24);
  header.writeUInt32LE(src.length, 28);

  let pad = padding;
  if (pad === undefined) {
    const residue = (16 - (src.length % 16)) % 16;
    const padLen = residue >= MIN_PADDING ? residue : residue + 16;
    if (padLen > MAX_PADDING) throw new RangeError('body too large for MTProto padding');
    pad = crypto.randomBytes(padLen);
  } else {
    pad = Buffer.isBuffer(pad) ? pad : Buffer.from(pad);
    if (pad.length < MIN_PADDING || pad.length > MAX_PADDING) throw new RangeError('padding must be 12..1024 bytes');
  }
  const msg = Buffer.concat([header, src, pad]);
  if (msg.length % 16 !== 0) throw new RangeError('inner plaintext must be a multiple of 16');
  return msg;
}

/** Parse the encrypted inner plaintext. */
export function unpackMessage(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < INNER_HEADER_SIZE + MIN_PADDING) throw new RangeError('inner plaintext is too short');
  const salt = Buffer.from(b.subarray(0, 8));
  const sessionId = Buffer.from(b.subarray(8, 16));
  const msgId = b.readBigInt64LE(16);
  const seqNo = b.readInt32LE(24);
  const length = b.readUInt32LE(28);
  if (length > b.length - INNER_HEADER_SIZE) throw new RangeError('inner plaintext length is invalid');
  const body = Buffer.from(b.subarray(INNER_HEADER_SIZE, INNER_HEADER_SIZE + length));
  const padding = Buffer.from(b.subarray(INNER_HEADER_SIZE + length));
  return { salt, sessionId, msgId, seqNo, length, body, padding };
}

/** Compute the 128-bit message key. x = 0 (client->server) / 8 (server->client). */
export function computeMsgKey(authKey, plaintext, x) {
  return sha256(authKey.subarray(88 + x, 120 + x), plaintext).subarray(8, 24);
}

/** Derive the AES-256-IGE key/IV from auth_key, msg_key and direction x. */
export function deriveAesKeys(authKey, msgKey, x) {
  const a = sha256(msgKey, authKey.subarray(x, x + 36));
  const b = sha256(authKey.subarray(40 + x, 76 + x), msgKey);
  const aesKey = Buffer.concat([a.subarray(0, 8), b.subarray(8, 24), a.subarray(24, 32)]);
  const aesIv = Buffer.concat([b.subarray(0, 8), a.subarray(8, 24), b.subarray(24, 32)]);
  return { aesKey, aesIv };
}

/** Plain envelope used during the DH handshake: auth_key_id=0 | msg_id | length | body. */
export function packPlainEnvelope(body, msgId = newServerMsgId()) {
  const src = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const header = Buffer.alloc(8 + 8 + 4);
  header.writeBigUInt64LE(0n, 0);
  header.writeBigInt64LE(BigInt.asIntN(64, BigInt(msgId)), 8);
  header.writeUInt32LE(src.length, 16);
  return Buffer.concat([header, src]);
}

export function unpackPlainEnvelope(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 20) throw new RangeError('plain envelope is too short');
  const authKeyId = b.readBigUInt64LE(0);
  const msgId = b.readBigInt64LE(8);
  const length = b.readUInt32LE(16);
  if (length > b.length - 20) throw new RangeError('plain envelope length is invalid');
  return { authKeyId, msgId, length, body: Buffer.from(b.subarray(20, 20 + length)) };
}

function nextSeqNo(state, contentRelated) {
  const seq = contentRelated ? state.seqNo * 2 + 1 : state.seqNo * 2;
  if (contentRelated) state.seqNo += 1;
  return seq;
}

export class SessionContext {
  /**
   * @param {Buffer} authKey 256-byte shared key
   * @param {Buffer} serverSalt 8-byte salt
   * @param {object} [opts] { sessionId, role: 'server'|'client' }
   *   For 'server' (default): incoming messages use x=0, outgoing x=8.
   *   For 'client': incoming x=8, outgoing x=0.
   */
  constructor(authKey, serverSalt, { sessionId, role = 'server' } = {}) {
    if (!Buffer.isBuffer(authKey) || authKey.length !== AUTH_KEY_SIZE) {
      throw new RangeError('auth_key must be 256 bytes');
    }
    if (role !== 'server' && role !== 'client') throw new RangeError('role must be server or client');
    this.authKey = Buffer.from(authKey);
    this.serverSalt = Buffer.isBuffer(serverSalt)
      ? Buffer.from(serverSalt)
      : (serverSalt ? Buffer.from(serverSalt) : Buffer.alloc(8));
    if (this.serverSalt.length !== 8) throw new RangeError('server_salt must be 8 bytes');
    this.sessionId = sessionId ? Buffer.from(sessionId) : crypto.randomBytes(8);
    if (this.sessionId.length !== 8) throw new RangeError('session_id must be 8 bytes');
    this.role = role;
    this.seqNo = 0;
    this.authKeyId = authKeyIdOf(this.authKey);
  }

  get outgoingX() {
    return this.role === 'server' ? 8 : 0;
  }

  get incomingX() {
    return this.role === 'server' ? 0 : 8;
  }

  /** Encrypt a TL body into an MTProto 2.0 payload. */
  encrypt(body, { contentRelated = false, salt, msgId, seqNo, padding } = {}) {
    const src = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const id = msgId === undefined ? (this.role === 'server' ? newServerMsgId() : newClientMsgId()) : BigInt(msgId);
    const seq = seqNo === undefined ? nextSeqNo(this, contentRelated) : seqNo;
    const plaintext = packMessage({
      salt: salt || this.serverSalt,
      sessionId: this.sessionId,
      msgId: id,
      seqNo: seq,
      body: src,
      padding,
    });
    const x = this.outgoingX;
    const msgKey = computeMsgKey(this.authKey, plaintext, x);
    const { aesKey, aesIv } = deriveAesKeys(this.authKey, msgKey, x);
    return {
      authKeyId: this.authKeyId,
      msgKey,
      ciphertext: igeEncrypt(aesKey, aesIv, plaintext),
      msgId: id,
      seqNo: seq,
    };
  }

  /** Decrypt and verify a received MTProto payload. */
  decrypt(authKeyId8, msgKey16, ciphertext) {
    const expectedId = this.authKeyId;
    const gotId = Buffer.isBuffer(authKeyId8) ? authKeyId8 : Buffer.from(authKeyId8);
    if (gotId.length !== 8 || !gotId.equals(expectedId)) throw new Error('bad auth_key_id');

    const msgKey = Buffer.isBuffer(msgKey16) ? msgKey16 : Buffer.from(msgKey16);
    if (msgKey.length !== 16) throw new RangeError('msg_key must be 16 bytes');

    const x = this.incomingX;
    const { aesKey, aesIv } = deriveAesKeys(this.authKey, msgKey, x);
    const plaintext = igeDecrypt(aesKey, aesIv, Buffer.from(ciphertext));
    if (!computeMsgKey(this.authKey, plaintext, x).equals(msgKey)) {
      throw new Error('msg_key mismatch');
    }

    const msg = unpackMessage(plaintext);
    const wantEven = this.role === 'server';
    if ((msg.msgId & 1n) !== (wantEven ? 0n : 1n)) throw new Error('bad msg_id parity');

    const msgTime = msg.msgId >> 32n;
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (msgTime > now + 30n || msgTime < now - 300n) throw new Error('msg_id out of time range');

    return msg;
  }
}

export default SessionContext;
