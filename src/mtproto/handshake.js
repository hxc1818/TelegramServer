// MTProto 2.0 authorization-key (DH) handshake, server side.
// Plain envelopes are expected to be unwrapped by the caller: this module
// consumes and produces only TL body bytes.
// No third-party dependencies.
import crypto from 'node:crypto';
import { TLBuffer } from '../tl/buffer.js';
import { rsaFingerprint, rsaPadDecrypt } from '../crypto/rsa.js';
import { igeEncrypt, igeDecrypt } from '../crypto/ige.js';

// Constructors
const REQ_PQ = 0x60469778;
const REQ_PQ_MULTI = 0xbe7e8ef1;
const REQ_DH_PARAMS = 0xd712e4be;
const SET_CLIENT_DH_PARAMS = 0xf5045f1f;
const RES_PQ = 0x05162463;
const SERVER_DH_PARAMS_OK = 0xd0e8075c;
const DH_GEN_OK = 0x3bcbf734;

const P_Q_INNER_DATA = 0x83c95aec;
const P_Q_INNER_DATA_DC = 0xa9f55f95;
const P_Q_INNER_DATA_TEMP = 0x3c6a84d4;
const P_Q_INNER_DATA_TEMP_DC = 0x56fddf88;
const INNER_DATA_IDS = new Set([P_Q_INNER_DATA, P_Q_INNER_DATA_DC, P_Q_INNER_DATA_TEMP, P_Q_INNER_DATA_TEMP_DC]);
const SERVER_DH_INNER_DATA = 0xb5890dba;
const CLIENT_DH_INNER_DATA = 0x6643b654;

const CACHE_TTL_MS = 10 * 60 * 1000;

// Standard Telegram 2048-bit safe prime (big-endian), also embedded in TDesktop's
// mtproto_dh_utils.cpp and published on core.telegram.org/mtproto/auth_key.
export const DEFAULT_DH_PRIME_HEX = [
  'C71CAEB9C6B1C9048E6C522F70F13F73980D40238E3E21C14934D037563D930F',
  '48198A0AA7C14058229493D22530F4DBFA336F6E0AC925139543AED44CCE7C37',
  '20FD51F69458705AC68CD4FE6B6B13ABDC9746512969328454F18FAF8C595F64',
  '2477FE96BB2A941D5BCD1D4AC8CC49880708FA9B378E3C4F3A9060BEE67CF9A4',
  'A4A695811051907E162753B56B0F6B410DBA74D8A84B2A14B3144E0EF1284754',
  'FD17ED950D5965B4B9DD46582DB1178D169C6BC465B0D6FF9CA3928FEF5B9AE4',
  'E418FC15E83EBEA0F87FA9FF5EED70050DED2849F47BF959D956850CE929851F',
  '0D8115F635B105EE2E4E15D04B2454BF6F4FADF034B10403119CD8E3B92FCC5B',
].join('');

function sha1(...parts) {
  const h = crypto.createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest();
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

function toBig(buf) {
  return BigInt(`0x${buf.toString('hex') || '0'}`);
}

function toBE(bufOrBig, size = 256) {
  const v = typeof bufOrBig === 'bigint' ? bufOrBig : toBig(bufOrBig);
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const raw = Buffer.from(hex, 'hex');
  if (raw.length > size) throw new RangeError('integer does not fit in target buffer');
  return Buffer.concat([Buffer.alloc(size - raw.length), raw]);
}

function factorize(n) {
  if (n < 4n) throw new RangeError('pq is too small');
  if ((n & 1n) === 0n) return [2n, n / 2n];
  for (let d = 3n; d * d <= n; d += 2n) {
    if (n % d === 0n) return [d, n / d];
  }
  throw new Error('cannot factorize pq (use a product of two primes)');
}

export class Handshake {
  constructor({ rsaKeys, serverNonce, pq, dhPrimeHex } = {}) {
    if (!rsaKeys || !rsaKeys.n || !rsaKeys.e) throw new Error('Handshake requires rsaKeys');
    this.rsaKeys = rsaKeys;
    this.dhPrime = Buffer.from(dhPrimeHex || DEFAULT_DH_PRIME_HEX, 'hex');
    if (this.dhPrime.length !== 256) throw new RangeError('dh_prime must be 256 bytes');

    let p;
    let q;
    if (pq === undefined || pq === null) {
      p = 17n;
      q = 19n;
    } else if (typeof pq === 'object' && !Buffer.isBuffer(pq) && pq.p !== undefined) {
      p = BigInt(pq.p);
      q = BigInt(pq.q);
    } else {
      let n;
      if (Buffer.isBuffer(pq)) n = toBig(pq);
      else if (typeof pq === 'bigint') n = pq;
      else if (typeof pq === 'number') n = BigInt(pq);
      else if (/^\d+$/.test(String(pq))) n = BigInt(pq);
      else n = toBig(Buffer.from(String(pq), 'hex'));
      [p, q] = factorize(n);
    }
    if (p === q || p < 3n || q < 3n || (p & 1n) === 0n || (q & 1n) === 0n) {
      throw new RangeError('pq must be a product of two distinct odd primes');
    }
    this.p = toBE(p, Math.ceil(p.toString(16).length / 2));
    this.q = toBE(q, Math.ceil(q.toString(16).length / 2));
    this.pq = toBE(p * q, Math.ceil((p * q).toString(16).length / 2));
    this.fingerprint = rsaFingerprint(rsaKeys.n, rsaKeys.e);

    this.serverNonce = serverNonce ? Buffer.from(serverNonce) : null;
    this.reset();
  }

  reset() {
    this.nonce = null;
    this.newNonce = null;
    this._a = null;
    this._tmpAesKey = null;
    this._tmpAesIv = null;
    this.authKey = null;
    this.authKeyId = null;
    this.serverSalt = null;
    this._cache = new Map();
  }

  _cacheKey(body) {
    return Buffer.from(body).toString('hex');
  }

  _cached(body) {
    const key = this._cacheKey(body);
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > CACHE_TTL_MS) {
      this._cache.delete(key);
      return null;
    }
    const out = { response: entry.response };
    if (entry.authKey) out.authKey = entry.authKey;
    if (entry.serverSalt) out.serverSalt = entry.serverSalt;
    return out;
  }

  _remember(body, result) {
    this._cache.set(this._cacheKey(body), {
      response: result.response,
      authKey: result.authKey || null,
      serverSalt: result.serverSalt || null,
      at: Date.now(),
    });
  }

  /** Process an unwrapped plaintext TL body. */
  processPlain(bodyBuffer) {
    const body = Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(bodyBuffer);
    const cached = this._cached(body);
    if (cached) return cached;

    const r = new TLBuffer(body);
    if (!r.has(4)) throw new RangeError('handshake body is too short');
    const id = r.uint();
    let result;
    switch (id) {
      case REQ_PQ:
      case REQ_PQ_MULTI:
        result = { response: this.handleProbe(body) };
        break;
      case REQ_DH_PARAMS:
        result = this._handleReqDHParams(body);
        break;
      case SET_CLIENT_DH_PARAMS:
        result = this._handleSetClientDHParams(body);
        break;
      default:
        throw new Error(`unsupported handshake constructor 0x${(id >>> 0).toString(16)}`);
    }
    this._remember(body, result);
    return result;
  }

  /** Fake `req_pq` probe (also handles `req_pq_multi`). */
  handleProbe(bodyBuffer) {
    const r = new TLBuffer(Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(bodyBuffer));
    const id = r.uint();
    if (id !== REQ_PQ && id !== REQ_PQ_MULTI) throw new Error('expected req_pq / req_pq_multi');
    const nonce = Buffer.from(r.int128());
    this.nonce = nonce;
    if (!this.serverNonce) this.serverNonce = crypto.randomBytes(16);

    const b = new TLBuffer();
    b.putUint(RES_PQ);
    b.putInt128(nonce);
    b.putInt128(this.serverNonce);
    b.putBytes(this.pq);
    b.putVector([this.fingerprint], (fp, w) => w.putLong(BigInt.asIntN(64, fp)));
    return b.buffer;
  }

  _handleReqDHParams(body) {
    const r = new TLBuffer(body);
    const id = r.uint();
    if (id !== REQ_DH_PARAMS) throw new Error('expected req_DH_params');
    const nonce = Buffer.from(r.int128());
    const serverNonce = Buffer.from(r.int128());
    const p = r.bytes();
    const q = r.bytes();
    const fingerprint = BigInt.asUintN(64, r.long());
    const encryptedData = r.bytes();

    if (!this.nonce || !nonce.equals(this.nonce)) throw new Error('handshake nonce mismatch');
    if (!this.serverNonce || !serverNonce.equals(this.serverNonce)) throw new Error('handshake server_nonce mismatch');
    if (fingerprint !== this.fingerprint) throw new Error('unknown public key fingerprint');
    if (!p.equals(this.p) || !q.equals(this.q)) throw new Error('p/q mismatch');

    const dataWithPadding = rsaPadDecrypt(encryptedData, this.rsaKeys);
    const d = new TLBuffer(dataWithPadding);
    const innerId = d.uint();
    if (!INNER_DATA_IDS.has(innerId)) {
      throw new Error(`unknown p_q_inner_data constructor 0x${(innerId >>> 0).toString(16)}`);
    }
    const pq = d.bytes();
    const ip = d.bytes();
    const iq = d.bytes();
    const innerNonce = Buffer.from(d.int128());
    const innerServerNonce = Buffer.from(d.int128());
    const newNonce = Buffer.from(d.int256());
    // p_q_inner_data_dc / *_temp_dc carry an extra dc (and possibly expires_in);
    // they are intentionally ignored here.

    if (!innerNonce.equals(nonce) || !innerServerNonce.equals(serverNonce)) {
      throw new Error('p_q_inner_data nonce mismatch');
    }
    if (toBig(ip) * toBig(iq) !== toBig(pq)) throw new Error('p*q does not equal pq');
    if (!pq.equals(this.pq)) throw new Error('pq mismatch');
    this.newNonce = newNonce;

    const prime = toBig(this.dhPrime);
    this._a = BigInt(`0x${crypto.randomBytes(32).toString('hex')}`) | 1n;
    const gA = modPow(3n, this._a, prime);
    const gABuf = toBE(gA);

    const ans = new TLBuffer();
    ans.putUint(SERVER_DH_INNER_DATA);
    ans.putInt128(nonce);
    ans.putInt128(serverNonce);
    ans.putInt(3);
    ans.putBytes(this.dhPrime);
    ans.putBytes(gABuf);
    ans.putInt(Math.floor(Date.now() / 1000));
    const answer = ans.buffer;

    const answerHash = sha1(answer);
    const padLen = (16 - ((answerHash.length + answer.length) % 16)) % 16;
    const answerWithHash = Buffer.concat([answerHash, answer, crypto.randomBytes(padLen)]);

    const shaNewServer = sha1(newNonce, serverNonce);
    const shaServerNew = sha1(serverNonce, newNonce);
    const shaNewNew = sha1(newNonce, newNonce);
    this._tmpAesKey = Buffer.concat([shaNewServer, shaServerNew.subarray(0, 12)]);
    this._tmpAesIv = Buffer.concat([shaServerNew.subarray(12, 20), shaNewNew, newNonce.subarray(0, 4)]);
    const encryptedAnswer = igeEncrypt(this._tmpAesKey, this._tmpAesIv, answerWithHash);

    const b = new TLBuffer();
    b.putUint(SERVER_DH_PARAMS_OK);
    b.putInt128(nonce);
    b.putInt128(serverNonce);
    b.putBytes(encryptedAnswer);
    return { response: b.buffer };
  }

  _handleSetClientDHParams(body) {
    const r = new TLBuffer(body);
    const id = r.uint();
    if (id !== SET_CLIENT_DH_PARAMS) throw new Error('expected set_client_DH_params');
    const nonce = Buffer.from(r.int128());
    const serverNonce = Buffer.from(r.int128());
    const encryptedData = r.bytes();

    if (!this.nonce || !nonce.equals(this.nonce)) throw new Error('set_client_DH_params nonce mismatch');
    if (!this.serverNonce || !serverNonce.equals(this.serverNonce)) {
      throw new Error('set_client_DH_params server_nonce mismatch');
    }
    if (!this._tmpAesKey || !this._tmpAesIv || !this._a || !this.newNonce) {
      throw new Error('handshake state missing: req_DH_params was not processed');
    }

    const plain = igeDecrypt(this._tmpAesKey, this._tmpAesIv, encryptedData);
    const hash = plain.subarray(0, 20);
    const dataPart = plain.subarray(20);

    const d = new TLBuffer(dataPart);
    const innerId = d.uint();
    if (innerId !== CLIENT_DH_INNER_DATA) {
      throw new Error(`unknown client_DH_inner_data constructor 0x${(innerId >>> 0).toString(16)}`);
    }
    const innerNonce = Buffer.from(d.int128());
    const innerServerNonce = Buffer.from(d.int128());
    d.long(); // retry_id (0 on first attempt)
    const gB = Buffer.from(d.bytes());
    // The hash covers the TL object only, not the random padding that follows it.
    if (!hash.equals(sha1(dataPart.subarray(0, d.offset)))) {
      throw new Error('client_DH_inner_data hash mismatch');
    }
    if (!innerNonce.equals(nonce) || !innerServerNonce.equals(serverNonce)) {
      throw new Error('client_DH_inner_data nonce mismatch');
    }

    const prime = toBig(this.dhPrime);
    const gBBig = toBig(gB);
    if (gBBig <= 1n || gBBig >= prime - 1n) throw new Error('invalid g_b');
    const authKeyBig = modPow(gBBig, this._a, prime);
    const authKey = toBE(authKeyBig);
    this.authKey = authKey;

    const authHash = sha1(authKey);
    this.authKeyId = BigInt.asIntN(64, authHash.readBigUInt64LE(12));
    const auxHash = authHash.subarray(0, 8); // high 64 bits of SHA1(auth_key)
    const newNonceHash = sha1(this.newNonce, Buffer.from([1]), auxHash).subarray(4, 20);

    const salt = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) salt[i] = this.newNonce[i] ^ serverNonce[i];
    this.serverSalt = salt;

    const b = new TLBuffer();
    b.putUint(DH_GEN_OK);
    b.putInt128(nonce);
    b.putInt128(serverNonce);
    b.putInt128(newNonceHash);
    return { response: b.buffer, authKey, serverSalt: salt };
  }
}

export default Handshake;
