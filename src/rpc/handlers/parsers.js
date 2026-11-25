// Helpers for reading TL request parameters. Every reader works both with a
// TLBuffer positioned after the constructor id and with a plain JS object
// (used by the unit tests and when a method is dispatched programmatically).
import { TLBuffer } from '../../tl/buffer.js';

export const INPUT_IDS = {
  inputPeerEmpty: 0x7f3b18ea,
  inputPeerSelf: 0x7da07ec9,
  inputPeerChat: 0x35a95cb9,
  inputPeerUser: 0xdde8a54c,
  inputPeerChannel: 0x27bcbbfc,
  inputUserEmpty: 0xb98886cf,
  inputUserSelf: 0xf7c1b13f,
  inputUser: 0xf21158c6,
  peerUser: 0x59511722,
  peerChat: 0x36c6019a,
  peerChannel: 0xa2a5371e,
  inputClientProxy: 0x75588b3f,
  inputReplyToMessage: 0x75c1ad70,
  codeSettings: 0xad253d78,
  jsonNull: 0x3f6d7b68,
  jsonBool: 0xc7345e6a,
  jsonNumber: 0x2be0dfa4,
  jsonString: 0xb71e767a,
  jsonArray: 0xf7444763,
  jsonObject: 0x99c1d49d,
};

export function isReader(v) {
  return v instanceof TLBuffer || (v && typeof v.uint === 'function' && typeof v.has === 'function');
}

export function int(r, key, fallback = 0) {
  if (isReader(r)) return r.has(4) ? r.int() : fallback;
  const v = r?.[key];
  return v === undefined ? fallback : Number(v);
}

export function uint(r, key, fallback = 0) {
  if (isReader(r)) return r.has(4) ? r.uint() : fallback;
  const v = r?.[key];
  return v === undefined ? fallback : Number(v) >>> 0;
}

export function long(r, key, fallback = 0n) {
  if (isReader(r)) return r.has(8) ? r.long() : fallback;
  const v = r?.[key];
  if (v === undefined || v === null) return fallback;
  return BigInt(v);
}

export function str(r, key, fallback = '') {
  if (isReader(r)) return r.has(1) ? r.string() : fallback;
  const v = r?.[key];
  return v === undefined || v === null ? fallback : String(v);
}

export function bytes(r, key, fallback = Buffer.alloc(0)) {
  if (isReader(r)) return r.has(1) ? r.bytes() : fallback;
  const v = r?.[key];
  return Buffer.isBuffer(v) ? v : Buffer.isBuffer(fallback) ? fallback : Buffer.alloc(0);
}

export function readInputPeer(r, key) {
  if (!isReader(r)) {
    const p = r?.[key] ?? r ?? {};
    if (typeof p === 'string') return { type: 'user', id: 0, username: p };
    const type = p.type || p.peerType || (p.chatId ? 'chat' : p.channelId ? 'channel' : 'user');
    const id = p.id ?? p.userId ?? p.chatId ?? p.channelId ?? (p.peerId || 0);
    return { type: String(type), id: Number(id) || 0, accessHash: Number(p.accessHash || 0) };
  }
  const id = r.uint();
  switch (id >>> 0) {
    case INPUT_IDS.inputPeerEmpty:
      return { type: 'empty', id: 0 };
    case INPUT_IDS.inputPeerSelf:
      return { type: 'self', id: 0 };
    case INPUT_IDS.inputPeerChat:
      return { type: 'chat', id: Number(r.long()) };
    case INPUT_IDS.inputPeerUser: {
      const uid = Number(r.long());
      const accessHash = r.long();
      return { type: 'user', id: uid, accessHash };
    }
    case INPUT_IDS.inputPeerChannel: {
      const cid = Number(r.long());
      const accessHash = r.long();
      return { type: 'channel', id: cid, accessHash };
    }
    default:
      return { type: 'unknown', id: 0, constructor: id >>> 0 };
  }
}

export function readPeer(r, key) {
  if (!isReader(r)) return readInputPeer(r, key);
  const id = r.uint();
  switch (id >>> 0) {
    case INPUT_IDS.peerUser:
      return { type: 'user', id: Number(r.long()) };
    case INPUT_IDS.peerChat:
      return { type: 'chat', id: Number(r.long()) };
    case INPUT_IDS.peerChannel:
      return { type: 'channel', id: Number(r.long()) };
    default:
      return { type: 'unknown', id: 0, constructor: id >>> 0 };
  }
}

export function readInputUser(r, key) {
  if (!isReader(r)) {
    const u = r?.[key] ?? r ?? {};
    return { type: u.type || 'user', id: Number(u.id ?? u.userId ?? 0) || 0, accessHash: u.accessHash || 0 };
  }
  const id = r.uint();
  switch (id >>> 0) {
    case INPUT_IDS.inputUserEmpty:
      return { type: 'empty', id: 0 };
    case INPUT_IDS.inputUserSelf:
      return { type: 'self', id: 0 };
    case INPUT_IDS.inputUser: {
      const uid = Number(r.long());
      return { type: 'user', id: uid, accessHash: r.long() };
    }
    default:
      return { type: 'unknown', id: 0, constructor: id >>> 0 };
  }
}

export function skipInputReplyTo(r) {
  if (!isReader(r) || !r.has(4)) return;
  const id = r.uint();
  if (id >>> 0 === INPUT_IDS.inputReplyToMessage) {
    const flags = r.has(4) ? r.uint() : 0;
    if (r.has(4)) r.int(); // reply_to_msg_id
    if (flags & 1 && r.has(4)) r.int(); // top_msg_id
    if (flags & 2 && r.has(4)) readInputPeer(r); // reply_to_peer_id
    if (flags & 4 && r.has(1)) r.string(); // quote_text
  }
}

export function skipCodeSettings(r) {
  if (!isReader(r) || !r.has(4)) return;
  const id = r.uint();
  if (id >>> 0 !== INPUT_IDS.codeSettings) return;
  const flags = r.has(4) ? r.uint() : 0;
  if (flags & (1 << 6) && r.has(4)) r.vector((rr) => rr.bytes()); // logout_tokens
  if (flags & (1 << 8) && r.has(1)) r.string(); // token
}

export function skipInputClientProxy(r) {
  if (!isReader(r) || !r.has(4)) return;
  const id = r.uint();
  if (id >>> 0 === INPUT_IDS.inputClientProxy) {
    if (r.has(1)) r.string();
    if (r.has(4)) r.int();
  }
}

export function skipJSONValue(r, depth = 0) {
  if (!isReader(r) || !r.has(4) || depth > 8) return;
  const id = r.uint();
  switch (id >>> 0) {
    case INPUT_IDS.jsonNull:
      return;
    case INPUT_IDS.jsonBool:
      if (r.has(4)) r.uint();
      return;
    case INPUT_IDS.jsonNumber:
      if (r.has(8)) r.raw(8);
      return;
    case INPUT_IDS.jsonString:
      if (r.has(1)) r.string();
      return;
    case INPUT_IDS.jsonArray:
      if (r.has(4)) {
        const n = r.int();
        for (let i = 0; i < n && r.has(4); i++) skipJSONValue(r, depth + 1);
      }
      return;
    case INPUT_IDS.jsonObject:
      if (r.has(4)) {
        const n = r.int();
        for (let i = 0; i < n && r.has(4); i++) {
          if (r.has(1)) r.string();
          skipJSONValue(r, depth + 1);
        }
      }
      return;
    default:
      return;
  }
}
