// MTProto TCP framing codecs: abridged, intermediate and padded intermediate.
// The 4-byte protocol id (0xefefefef / 0xeeeeeeee / 0xdddddddd) lives in the
// obfuscation prefix; `transportIdOf` recognizes it. Frames themselves start
// with their length field.
//
// Abridged:       [len/4 (1 byte) | 0x7f + 3-byte LE len/4][payload]
// Intermediate:   [4-byte LE byte length][payload]
// Padded:         [4-byte LE total length][payload][0..15 random pad bytes]
// No third-party dependencies.
import crypto from 'node:crypto';

const ID_ABRIDGED = 0xefefefef;
const ID_INTERMEDIATE = 0xeeeeeeee;
const ID_PADDED = 0xdddddddd;
const QUICK_ACK_BIT = 0x80000000;

function asBuffer(v) {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

export class FrameCodec {
  /**
   * @param {'abridged'|'intermediate'|'padded'} transportId
   * @param {object} [opts] `side: 'server'|'client'` disambiguates quick-ack tokens.
   */
  constructor(transportId = 'abridged', { side = 'server' } = {}) {
    if (!['abridged', 'intermediate', 'padded'].includes(transportId)) {
      throw new RangeError(`unknown MTProto transport: ${transportId}`);
    }
    this.transportId = transportId;
    this.side = side;
    this._buf = Buffer.alloc(0);
    this.onQuickAck = null; // optional callback(tokenBuffer, rawLengthField)
    this.lastQuickAck = null;
  }

  /** Recognize the transport id from the first bytes of the obfuscation prefix. */
  transportIdOf(prefixBytes) {
    if (!prefixBytes || prefixBytes.length < 1) return null;
    const b = asBuffer(prefixBytes);
    if (b[0] === 0xef) return 'abridged';
    if (b.length < 4) return null;
    const v = b.readUInt32LE(0);
    if (v === ID_INTERMEDIATE) return 'intermediate';
    if (v === ID_PADDED) return 'padded';
    return null;
  }

  /** Feed bytes from the stream; returns every complete payload Buffer. */
  feed(chunk) {
    if (chunk !== undefined && chunk !== null && chunk.length) {
      const src = asBuffer(chunk);
      this._buf = this._buf.length ? Buffer.concat([this._buf, src]) : Buffer.from(src);
    }
    const out = [];
    for (;;) {
      const frame = this._parseOne();
      if (!frame) break;
      if (frame.kind === 'ack') {
        this._buf = this._buf.subarray(frame.consumed);
        this.lastQuickAck = frame.token;
        if (typeof this.onQuickAck === 'function') this.onQuickAck(frame.token, frame.raw);
        continue;
      }
      if (frame.kind === 'incomplete') break;
      this._buf = this._buf.subarray(frame.consumed);
      if (frame.quickAck) {
        this.lastQuickAck = frame.payload.subarray(0, 4);
        if (typeof this.onQuickAck === 'function') this.onQuickAck(this.lastQuickAck, null);
      }
      out.push(frame.payload);
    }
    return out;
  }

  _parseOne() {
    const b = this._buf;
    if (this.transportId === 'abridged') return this._parseAbridged(b);
    return this._parseIntermediate(b);
  }

  _parseAbridged(b) {
    if (b.length < 1) return null;
    const h = b[0];

    // 0xff: extended header used when a quick-ack is requested for a large frame.
    if (h === 0xff) {
      if (b.length < 4) return { kind: 'incomplete' };
      const words = b.readUIntLE(1, 3);
      const len = words * 4;
      if (b.length < 4 + len) return { kind: 'incomplete' };
      return { kind: 'frame', payload: Buffer.from(b.subarray(4, 4 + len)), consumed: 4 + len, quickAck: true };
    }
    if (h === 0x7f) {
      if (b.length < 4) return { kind: 'incomplete' };
      const words = b.readUIntLE(1, 3);
      const len = words * 4;
      if (b.length < 4 + len) return { kind: 'incomplete' };
      return { kind: 'frame', payload: Buffer.from(b.subarray(4, 4 + len)), consumed: 4 + len, quickAck: false };
    }

    if (h & 0x80) {
      const words = h & 0x7f;
      if (this.side === 'client') {
        // Server quick-ack tokens are sent as a bswapped standalone 4-byte packet.
        return { kind: 'ack', token: Buffer.from(b.subarray(0, 4)), consumed: 4, raw: h };
      }
      const len = words * 4;
      if (b.length < 1 + len) return { kind: 'incomplete' };
      return { kind: 'frame', payload: Buffer.from(b.subarray(1, 1 + len)), consumed: 1 + len, quickAck: true };
    }

    const len = h * 4;
    if (b.length < 1 + len) return { kind: 'incomplete' };
    return { kind: 'frame', payload: Buffer.from(b.subarray(1, 1 + len)), consumed: 1 + len, quickAck: false };
  }

  _parseIntermediate(b) {
    if (b.length < 4) return null;
    const raw = b.readUInt32LE(0);
    const flagged = (raw & QUICK_ACK_BIT) !== 0;
    const len = raw & 0x7fffffff;

    if (flagged && this.side === 'client') {
      // A standalone quick-ack token (4 bytes total for intermediate).
      return { kind: 'ack', token: Buffer.from(b.subarray(0, 4)), consumed: 4, raw };
    }

    if (flagged && this.transportId === 'padded' && len <= 16) {
      if (b.length < 4 + len) return { kind: 'incomplete' };
      const body = b.subarray(4, 4 + len);
      if (body.length >= 4 && body.readUInt32LE(0) === 0xffffffff) {
        return { kind: 'ack', token: Buffer.from(body.subarray(4, 8)), consumed: 4 + len, raw };
      }
    }

    if (b.length < 4 + len) return { kind: 'incomplete' };
    return {
      kind: 'frame',
      payload: Buffer.from(b.subarray(4, 4 + len)),
      consumed: 4 + len,
      quickAck: flagged,
    };
  }

  /** Encode one payload (TL body / encrypted MTProto frame). */
  encode(payload, { quickAck = false } = {}) {
    const p = asBuffer(payload);
    if (this.transportId === 'abridged') return this._encodeAbridged(p, quickAck);

    let pad = Buffer.alloc(0);
    if (this.transportId === 'padded') {
      pad = crypto.randomBytes(crypto.randomInt(0, 16));
    }
    const total = p.length + pad.length;
    if (total > 0x7fffffff) throw new RangeError('MTProto frame too large');
    const header = Buffer.alloc(4);
    header.writeUInt32LE((total | (quickAck ? QUICK_ACK_BIT : 0)) >>> 0, 0);
    return Buffer.concat([header, p, pad]);
  }

  _encodeAbridged(p, quickAck) {
    if (p.length % 4 !== 0) throw new RangeError('abridged payload length must be a multiple of 4');
    const words = p.length / 4;
    if (words > 0x7fffff) throw new RangeError('abridged frame too large');

    if (words < 127) {
      const h = quickAck ? (words | 0x80) & 0xff : words;
      return Buffer.concat([Buffer.from([h]), p]);
    }
    const len3 = Buffer.from([words & 0xff, (words >> 8) & 0xff, (words >> 16) & 0xff]);
    return Buffer.concat([Buffer.from([quickAck ? 0xff : 0x7f]), len3, p]);
  }

  /** Encode a quick-ack reply for a token received from the peer. */
  encodeQuickAck(token) {
    const t = asBuffer(token);
    if (t.length < 4) throw new RangeError('quick-ack token must be at least 4 bytes');
    if (this.transportId === 'abridged') {
      // bswap the 4-byte token and send it as a standalone packet.
      return Buffer.from([t[3], t[2], t[1], t[0]]);
    }
    if (this.transportId === 'padded') {
      const body = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), t.subarray(0, 4)]);
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length | QUICK_ACK_BIT, 0);
      return Buffer.concat([header, body]);
    }
    const header = Buffer.alloc(4);
    header.writeUInt32LE((t.readUInt32LE(0) | QUICK_ACK_BIT) >>> 0, 0);
    return header;
  }
}

export function transportIdOf(prefixBytes) {
  return new FrameCodec('abridged').transportIdOf(prefixBytes);
}

export const TRANSPORT_IDS = {
  abridged: ID_ABRIDGED,
  intermediate: ID_INTERMEDIATE,
  padded: ID_PADDED,
};

export default FrameCodec;
