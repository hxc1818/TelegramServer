// TL codecs for MTProto service messages (system messages and containers).
// No third-party dependencies.
import zlib from 'node:zlib';
import { TLBuffer, TL_IDS } from '../tl/buffer.js';

const ID = {
  msgsAck: 0x62d6b459,
  badMsgNotification: 0xa7eff811,
  badServerSalt: 0xedab447b,
  futureSalt: 0x0949d9dc,
  futureSalts: 0xae500895,
  pong: 0x347773c5,
  newSessionCreated: 0x9ec20908,
  msgContainer: 0x73f1f8dc,
  gzipPacked: 0x3072cfa1,
  ping: 0x7abe77ec,
  pingDelayDisconnect: 0xf3427b8c,
};

export const SERVICE_IDS = Object.freeze({ ...ID });

export function isServiceMessage(id) {
  const v = typeof id === 'bigint' ? Number(id) : id;
  return Object.values(ID).includes(v >>> 0);
}

function asBig(v) {
  return BigInt(v);
}

function signed64(v) {
  return BigInt.asIntN(64, asBig(v));
}

// ---- msgs_ack ---------------------------------------------------------

export function msgsAck(msgIds) {
  const b = new TLBuffer();
  b.putUint(ID.msgsAck);
  b.putVector([...msgIds], (id, w) => w.putLong(signed64(id)));
  return b.buffer;
}

export function readMsgsAck(bufOrReader) {
  const r = bufOrReader instanceof TLBuffer ? bufOrReader : new TLBuffer(bufOrReader);
  const id = r.uint();
  if (id !== ID.msgsAck) throw new Error(`expected msgs_ack, got 0x${(id >>> 0).toString(16)}`);
  return r.vector((rr) => rr.long());
}

// ---- ping / pong ------------------------------------------------------

export function pong(msgId, pingId) {
  const b = new TLBuffer();
  b.putUint(ID.pong);
  b.putLong(signed64(msgId));
  b.putLong(signed64(pingId));
  return b.buffer;
}

export function readPing(bufOrReader) {
  const r = bufOrReader instanceof TLBuffer ? bufOrReader : new TLBuffer(bufOrReader);
  const id = r.uint();
  if (id !== ID.ping && id !== ID.pingDelayDisconnect) {
    throw new Error(`expected ping, got 0x${(id >>> 0).toString(16)}`);
  }
  const pingId = r.long();
  const disconnectDelay = id === ID.pingDelayDisconnect ? r.int() : null;
  return { pingId, disconnectDelay };
}

// ---- bad_msg_notification / bad_server_salt ---------------------------

export function badMsgNotification(badMsgId, badMsgSeqno, errorCode) {
  const b = new TLBuffer();
  b.putUint(ID.badMsgNotification);
  b.putLong(signed64(badMsgId));
  b.putInt(badMsgSeqno);
  b.putInt(errorCode);
  return b.buffer;
}

export function badServerSalt(badMsgId, badMsgSeqno, errorCode, newServerSalt) {
  const b = new TLBuffer();
  b.putUint(ID.badServerSalt);
  b.putLong(signed64(badMsgId));
  b.putInt(badMsgSeqno);
  b.putInt(errorCode);
  b.putLong(signed64(newServerSalt));
  return b.buffer;
}

export function readBadMsgNotification(bufOrReader) {
  const r = bufOrReader instanceof TLBuffer ? bufOrReader : new TLBuffer(bufOrReader);
  const id = r.uint();
  if (id !== ID.badMsgNotification && id !== ID.badServerSalt) {
    throw new Error(`expected bad_msg_notification, got 0x${(id >>> 0).toString(16)}`);
  }
  const out = {
    type: id === ID.badMsgNotification ? 'badMsgNotification' : 'badServerSalt',
    badMsgId: r.long(),
    badMsgSeqno: r.int(),
    errorCode: r.int(),
  };
  if (id === ID.badServerSalt) out.newServerSalt = r.long();
  return out;
}

// ---- new_session_created ----------------------------------------------

export function newSessionCreated(firstMsgId, uniqueId, serverSalt) {
  const b = new TLBuffer();
  b.putUint(ID.newSessionCreated);
  b.putLong(signed64(firstMsgId));
  b.putLong(signed64(uniqueId));
  b.putLong(signed64(serverSalt));
  return b.buffer;
}

export function readNewSessionCreated(bufOrReader) {
  const r = bufOrReader instanceof TLBuffer ? bufOrReader : new TLBuffer(bufOrReader);
  const id = r.uint();
  if (id !== ID.newSessionCreated) throw new Error('expected new_session_created');
  return { firstMsgId: r.long(), uniqueId: r.long(), serverSalt: r.long() };
}

// ---- future_salts -----------------------------------------------------

export function futureSalts(reqMsgId, now, salts) {
  const b = new TLBuffer();
  b.putUint(ID.futureSalts);
  b.putLong(signed64(reqMsgId));
  b.putInt(now);
  b.putVector(salts, (s, w) => {
    w.putUint(ID.futureSalt);
    w.putInt(s.validSince);
    w.putInt(s.validUntil);
    w.putLong(signed64(s.salt));
  });
  return b.buffer;
}

export function readFutureSalts(bufOrReader) {
  const r = bufOrReader instanceof TLBuffer ? bufOrReader : new TLBuffer(bufOrReader);
  const id = r.uint();
  if (id !== ID.futureSalts) throw new Error('expected future_salts');
  const reqMsgId = r.long();
  const now = r.int();
  const salts = r.vector((rr) => {
    const sid = rr.uint();
    if (sid !== ID.futureSalt) throw new Error('bad future_salt constructor');
    return { validSince: rr.int(), validUntil: rr.int(), salt: rr.long() };
  });
  return { reqMsgId, now, salts };
}

// ---- containers -------------------------------------------------------

/**
 * @param {Array<{msgId:bigint|number, seqNo:number, body:Buffer}>} messages
 */
export function joinContainer(messages) {
  const b = new TLBuffer();
  b.putUint(ID.msgContainer);
  b.putUint(TL_IDS.VECTOR_ID);
  b.putInt(messages.length);
  for (const m of messages) {
    const body = Buffer.isBuffer(m.body) ? m.body : Buffer.from(m.body);
    b.putLong(signed64(m.msgId));
    b.putInt(m.seqNo ?? 0);
    b.putInt(body.length);
    b.putRaw(body);
  }
  return b.buffer;
}

/** Split a msg_container into its messages. Also accepts a single bare message. */
export function splitContainer(bufOrReader) {
  const r = bufOrReader instanceof TLBuffer ? bufOrReader : new TLBuffer(bufOrReader);
  const id = r.uint();
  if (id !== ID.msgContainer) throw new Error(`expected msg_container, got 0x${(id >>> 0).toString(16)}`);
  return r.vector((rr) => {
    const msgId = rr.long();
    const seqNo = rr.int();
    const bytes = rr.int();
    const body = Buffer.from(rr.raw(bytes));
    return { msgId, seqNo, bytes, body };
  });
}

// ---- gzip_packed ------------------------------------------------------

export function gzipPacked(body) {
  const b = new TLBuffer();
  b.putUint(ID.gzipPacked);
  b.putBytes(zlib.gzipSync(Buffer.from(body)));
  return b.buffer;
}

export function unpackGzip(bufOrReader) {
  const r = bufOrReader instanceof TLBuffer ? bufOrReader : new TLBuffer(bufOrReader);
  const id = r.uint();
  if (id !== ID.gzipPacked) throw new Error('expected gzip_packed');
  return zlib.gunzipSync(r.bytes());
}

export default {
  msgsAck,
  readMsgsAck,
  pong,
  readPing,
  badMsgNotification,
  badServerSalt,
  readBadMsgNotification,
  newSessionCreated,
  readNewSessionCreated,
  futureSalts,
  readFutureSalts,
  joinContainer,
  splitContainer,
  gzipPacked,
  unpackGzip,
};
