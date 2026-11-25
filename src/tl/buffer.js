// Minimal TL wire-format codec. No dependencies.
// Spec: https://core.telegram.org/mtproto/serialize

const VECTOR_ID = 0x1cb5c415;
const BOOL_TRUE_ID = 0x997275b5;
const BOOL_FALSE_ID = 0xbc799737;

export class TLBuffer {
  constructor(buf = Buffer.alloc(0)) {
    this._chunks = [];
    this._read = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    this.offset = 0;
  }

  // ---- writing -------------------------------------------------------
  putRaw(buf) {
    this._chunks.push(Buffer.from(buf));
    return this;
  }

  putInt(v) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(Number(v) | 0, 0);
    return this.putRaw(b);
  }

  putUint(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(Number(v) >>> 0, 0);
    return this.putRaw(b);
  }

  putLong(v) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(v), 0);
    return this.putRaw(b);
  }

  putInt128(buf) {
    const b = Buffer.from(buf);
    if (b.length !== 16) throw new RangeError('int128 must be 16 bytes');
    return this.putRaw(b);
  }

  putInt256(buf) {
    const b = Buffer.from(buf);
    if (b.length !== 32) throw new RangeError('int256 must be 32 bytes');
    return this.putRaw(b);
  }

  putBool(v) {
    return this.putUint(v ? BOOL_TRUE_ID : BOOL_FALSE_ID);
  }

  putBytes(buf) {
    return this.putRaw(tlString(buf));
  }

  putString(str) {
    return this.putBytes(Buffer.from(String(str), 'utf8'));
  }

  putVector(items, encode) {
    this.putUint(VECTOR_ID);
    this.putInt(items.length);
    for (const item of items) encode(item, this);
    return this;
  }

  get buffer() {
    return Buffer.concat(this._chunks);
  }

  get length() {
    return this._read.length;
  }

  // ---- reading -------------------------------------------------------
  has(n) {
    return this.offset + n <= this._read.length;
  }

  raw(n) {
    if (!this.has(n)) throw new RangeError(`TLBuffer: need ${n} bytes at ${this.offset}, have ${this._read.length}`);
    const out = this._read.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  int() {
    return this.raw(4).readInt32LE(0);
  }

  uint() {
    return this.raw(4).readUInt32LE(0);
  }

  long() {
    return this.raw(8).readBigInt64LE(0);
  }

  ulong() {
    return this.raw(8).readBigUInt64LE(0);
  }

  int128() {
    return Buffer.from(this.raw(16));
  }

  int256() {
    return Buffer.from(this.raw(32));
  }

  bool() {
    const id = this.uint();
    if (id === BOOL_TRUE_ID) return true;
    if (id === BOOL_FALSE_ID) return false;
    throw new Error(`TLBuffer: bad Bool constructor 0x${id.toString(16)}`);
  }

  bytes() {
    const first = this.raw(1)[0];
    let len;
    if (first === 254) {
      const l = this.raw(3);
      len = l[0] | (l[1] << 8) | (l[2] << 16);
    } else {
      len = first;
    }
    const out = Buffer.from(this.raw(len));
    const pad = (4 - ((first === 254 ? 4 : 1) + len) % 4) % 4;
    if (pad) this.raw(pad);
    return out;
  }

  string() {
    return this.bytes().toString('utf8');
  }

  vector(decode) {
    const id = this.uint();
    if (id !== VECTOR_ID) throw new Error(`TLBuffer: bad vector id 0x${id.toString(16)}`);
    const count = this.int();
    if (count < 0 || count > 1_000_000) throw new Error('TLBuffer: bad vector size');
    const out = [];
    for (let i = 0; i < count; i++) out.push(decode(this));
    return out;
  }
}

// TL-serialize a byte string with the 4-byte padding rule.
export function tlString(buf) {
  const src = Buffer.from(buf);
  const n = src.length;
  if (n <= 253) {
    const pad = (4 - ((1 + n) % 4)) % 4;
    return Buffer.concat([Buffer.from([n]), src, Buffer.alloc(pad)]);
  }
  const header = Buffer.from([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
  const pad = (4 - ((4 + n) % 4)) % 4;
  return Buffer.concat([header, src, Buffer.alloc(pad)]);
}

export const TL_IDS = { VECTOR_ID, BOOL_TRUE_ID, BOOL_FALSE_ID };
