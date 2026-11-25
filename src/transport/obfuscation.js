// MTProto transport obfuscation (AES-256-CTR), shared by client and server.
//
// Wire layout (first 64 bytes, the "initialization payload"):
//   [0..55]  random plaintext
//   [56..59] protocol id (0xEFEFEFEF abridged / 0xDDDDDDDD padded)
//   [60..61] dc_id (int16 LE)
//   [62..63] random
// Bytes 56..63 are AES-CTR encrypted; bytes 0..55 go out in the clear.
// Every following byte in both directions continues the same CTR stream.
//
// Key schedule (from the point of view of the party that generated the nonce):
//   send key = nonce[8:40], send iv = nonce[40:56]
//   receive key = SHA256(reverse(nonce[8:56])[0:32])
//   receive iv  = reverse(nonce[8:56])[32:48]
//
// No third-party dependencies.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const PROTOCOL_IDS = {
  abridged: 0xefefefef,
  intermediate: 0xeeeeeeee,
  padded: 0xdddddddd,
};

function asBuffer(v) {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

export class ObfuscationCodec {
  /**
   * @param {object} opts
   * @param {Buffer} [opts.nonce] 64-byte init payload. Generated randomly when omitted.
   * @param {'client'|'server'} [opts.role] 'client' generates the nonce; 'server' receives it.
   * @param {'abridged'|'intermediate'|'padded'} [opts.protocol]
   * @param {number} [opts.dcId] dc id written into bytes 60..61 of the prefix.
   */
  constructor({ nonce, role = 'client', protocol = 'abridged', dcId = 0 } = {}) {
    if (role !== 'client' && role !== 'server') throw new RangeError('obfuscation role must be client or server');
    if (nonce !== undefined && (!Buffer.isBuffer(nonce) || nonce.length !== 64)) {
      throw new RangeError('obfuscation nonce must be 64 bytes');
    }
    this.role = role;
    this.protocol = PROTOCOL_IDS[protocol] === undefined ? 'abridged' : protocol;
    this.dcId = dcId | 0;
    this.nonce = nonce ? Buffer.from(nonce) : (role === 'client' ? crypto.randomBytes(64) : null);
    this._prefixSent = this.role !== 'client';
    // A peer that already knows the nonce (client, or server created from a
    // prefix) does not need to parse another prefix on incoming data.
    this._prefixReceived = !!this.nonce;
    this._incoming = Buffer.alloc(0);
    this._sendCipher = null;
    this._recvCipher = null;
    this.sendKey = null;
    this.sendIv = null;
    this.recvKey = null;
    this.recvIv = null;
    if (this.nonce) this._deriveKeys();
  }

  _deriveKeys() {
    const n = this.nonce;
    // reverse(nonce[8:56]) -> 48 bytes; first 32 feed SHA256 for the key,
    // last 16 are used directly as the IV.
    const rev = Buffer.from(n.subarray(8, 56)).reverse();
    const hashedKey = crypto.createHash('sha256').update(rev.subarray(0, 32)).digest();
    const hashedIv = rev.subarray(32, 48);

    if (this.role === 'client') {
      this.sendKey = Buffer.from(n.subarray(8, 40));
      this.sendIv = Buffer.from(n.subarray(40, 56));
      this.recvKey = hashedKey;
      this.recvIv = hashedIv;
    } else {
      this.recvKey = Buffer.from(n.subarray(8, 40));
      this.recvIv = Buffer.from(n.subarray(40, 56));
      this.sendKey = hashedKey;
      this.sendIv = hashedIv;
    }
    this._sendCipher = this.sendKey ? crypto.createCipheriv('aes-256-ctr', this.sendKey, this.sendIv) : null;
    this._recvCipher = this.recvKey ? crypto.createCipheriv('aes-256-ctr', this.recvKey, this.recvIv) : null;
  }

  _makePrefix() {
    const init = Buffer.from(this.nonce);
    init.writeUInt32LE(PROTOCOL_IDS[this.protocol] >>> 0, 56);
    init.writeInt16LE(this.dcId, 60);
    // Consume the keystream for the first 56 bytes (they are sent in the clear),
    // then encrypt only the 8 protocol/dc/random bytes.
    this._sendCipher.update(init.subarray(0, 56));
    const encryptedTail = this._sendCipher.update(init.subarray(56, 64));
    return Buffer.concat([init.subarray(0, 56), encryptedTail]);
  }

  /** Encrypt a buffer. The first call also emits the 64-byte prefix. */
  encode(buf) {
    if (!this._sendCipher) throw new Error('ObfuscationCodec: send keys are not initialized');
    const src = asBuffer(buf);
    const parts = [];
    if (!this._prefixSent) {
      parts.push(this._makePrefix());
      this._prefixSent = true;
    }
    if (src.length) parts.push(this._sendCipher.update(src));
    if (parts.length === 0) return Buffer.alloc(0);
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  /** Incremental receive: handles the 64-byte prefix and decrypts buffered bytes. */
  feed(chunk) {
    const src = chunk === undefined || chunk === null ? Buffer.alloc(0) : asBuffer(chunk);
    if (src.length) {
      this._incoming = this._incoming.length ? Buffer.concat([this._incoming, src]) : Buffer.from(src);
    }
    if (!this._prefixReceived) {
      if (this._incoming.length < 64) return Buffer.alloc(0);
      const prefix = this._incoming.subarray(0, 64);
      this._incoming = this._incoming.subarray(64);
      this._acceptPrefix(prefix);
    }
    if (!this._incoming.length) return Buffer.alloc(0);
    const out = this._recvCipher.update(this._incoming);
    this._incoming = Buffer.alloc(0);
    return out;
  }

  /** Decode a complete received buffer (prefix included on the first call). */
  decode(buf) {
    return this.feed(buf);
  }

  _acceptPrefix(prefix) {
    if (!this._recvCipher) {
      // Server that did not receive the prefix up front (e.g. `new ObfuscationCodec({ role: 'server' })`).
      this.nonce = Buffer.from(prefix);
      this._deriveKeys();
    }
    // The peer advanced its CTR stream by the whole 64-byte prefix.
    this._recvCipher.update(prefix);
    this._prefixReceived = true;
  }

  /** Build a server-side codec directly from an already received 64-byte prefix. */
  static fromPrefix(prefix) {
    if (!Buffer.isBuffer(prefix) || prefix.length < 64) {
      throw new RangeError('obfuscation prefix must be at least 64 bytes');
    }
    const codec = new ObfuscationCodec({ nonce: Buffer.from(prefix.subarray(0, 64)), role: 'server' });
    codec._recvCipher.update(prefix.subarray(0, 64));
    codec._prefixReceived = true;
    return codec;
  }
}

/**
 * Wraps a net.Socket (or any EventEmitter-like duplex stream) and exposes
 * deobfuscated 'data' events. `.write()` encrypts before handing bytes to the
 * underlying socket. Defaults to the server side of the handshake.
 */
export class ObfuscatedSocket extends EventEmitter {
  constructor(socket, { role = 'server', protocol = 'abridged', dcId = 0, nonce } = {}) {
    super();
    if (!socket || typeof socket.on !== 'function' || typeof socket.write !== 'function') {
      throw new TypeError('ObfuscatedSocket expects a duplex socket');
    }
    this.socket = socket;
    this.codec = null;
    this._pending = Buffer.alloc(0);

    if (role === 'client') {
      this.codec = new ObfuscationCodec({ role: 'client', protocol, dcId, nonce });
      this._ready = true;
    } else {
      this._ready = false;
    }

    socket.on('data', (chunk) => this._onData(chunk));
    for (const ev of ['error', 'close', 'end', 'connect', 'timeout', 'drain']) {
      socket.on(ev, (...args) => this.emit(ev, ...args));
    }
  }

  _onData(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!this.codec) {
      this._pending = this._pending.length ? Buffer.concat([this._pending, data]) : Buffer.from(data);
      if (this._pending.length < 64) return;
      const prefix = this._pending.subarray(0, 64);
      this._pending = this._pending.subarray(64);
      this.codec = ObfuscationCodec.fromPrefix(prefix);
      this._ready = true;
      this.emit('obfuscationReady', this.codec);
      if (this._pending.length) {
        const rest = this._pending;
        this._pending = Buffer.alloc(0);
        const plain = this.codec.feed(rest);
        if (plain.length) this.emit('data', plain);
      }
      return;
    }
    const plain = this.codec.feed(data);
    if (plain.length) this.emit('data', plain);
  }

  get ready() {
    return this._ready;
  }

  write(buf, encoding, cb) {
    if (!this.codec) throw new Error('ObfuscatedSocket: cannot write before the obfuscation prefix is received');
    let payload = buf;
    let callback = cb;
    if (typeof encoding === 'function') {
      callback = encoding;
    } else if (typeof encoding === 'string') {
      payload = Buffer.from(buf, encoding);
    }
    return this.socket.write(this.codec.encode(payload), callback);
  }

  end(...args) {
    return this.socket.end(...args);
  }

  destroy(...args) {
    return this.socket.destroy(...args);
  }

  setTimeout(...args) {
    return this.socket.setTimeout(...args);
  }

  setNoDelay(...args) {
    return this.socket.setNoDelay(...args);
  }

  setKeepAlive(...args) {
    return this.socket.setKeepAlive(...args);
  }

  pause() {
    return this.socket.pause();
  }

  resume() {
    return this.socket.resume();
  }

  pipe(...args) {
    return this.socket.pipe(...args);
  }
}

export default ObfuscatedSocket;
