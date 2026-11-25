// Secret-chat handlers with real MTProto 2.0 end-to-end crypto.
//
// These are drop-in replacements for the five basic handlers in
// src/rpc/handlers/secret.js (requestEncryption, acceptEncryption,
// readEncryptedHistory, sendEncrypted, sendEncryptedFile). Wire them in the
// router by overriding those names; METHOD_IDS below are the SAME schema ids
// (schema/api.tl, layer 234) as the basic module, so no method id changes.
//
// Crypto/spec references are documented in src/crypto/secret.js:
//   https://core.telegram.org/api/end-to-end
//   https://core.telegram.org/schema/end-to-end
//   https://core.telegram.org/mtproto/auth_key
// TL response shapes follow src/rpc/handlers/secret.js (layer 234 ids).
//
// Chat metadata (g_a/g_b/fingerprint/state/qts) is persisted with
// ctx.secretStore. The derived 256-byte AES key and our DH exponent are kept
// in a side cache on that store instance (`__secretE2E`) because SecretStore
// deliberately has no binary key column; export `setE2EState` for callers
// that need to seed/restore it.

import crypto from 'node:crypto';
import { TLBuffer } from '../../tl/buffer.js';
import { isReader } from './parsers.js';
import { SecretStore } from '../../store/secret.js';
import {
  DH_PRIME,
  DH_GENERATOR,
  bigintToBytes,
  deriveE2EKey,
  computeKeyFingerprint,
  computeSharedKeyFingerprint,
  encryptSecretMessage,
  decryptSecretMessage,
} from '../../crypto/secret.js';

// Constructor ids from schema/api.tl (layer 234), same as handlers/secret.js.
const ID = Object.freeze({
  boolTrue: 0x997275b5,
  vector: 0x1cb5c415,
  inputUserEmpty: 0xb98886cf,
  inputUserSelf: 0xf7c1b13f,
  inputUser: 0xf21158c6,
  inputEncryptedChat: 0xf141b5e1,
  inputEncryptedFileEmpty: 0x1837c364,
  inputEncryptedFile: 0x5a17b5e5,
  inputEncryptedFileUploaded: 0x64bd0306,
  inputEncryptedFileBigUploaded: 0x2dc173c8,
  encryptedChatRequested: 0x48f1d94c,
  encryptedChat: 0x61f0d4c7,
  encryptedFileEmpty: 0xc21f497e,
  encryptedFile: 0xa8008cd8,
  encryptedMessage: 0xed18c118,
  encryptedMessageService: 0x23734b06,
  updateNewEncryptedMessage: 0x12bcbd9a,
  updateEncryption: 0xb4a2e88d,
  updateEncryptedMessagesRead: 0x38fe25b7,
  updates: 0x74ae4240,
});

/** RPC method ids, verified against schema/api.tl (layer 234). */
export const METHOD_IDS = Object.freeze({
  'messages.requestEncryption': 0xf64daf43,
  'messages.acceptEncryption': 0x3dbc0415,
  'messages.discardEncryption': 0xf393aea0,
  'messages.setEncryptedTyping': 0x791451ed,
  'messages.readEncryptedHistory': 0x7f4b690a,
  'messages.sendEncrypted': 0x44fa7a15,
  'messages.sendEncryptedFile': 0x5559481d,
  'messages.sendEncryptedService': 0x32d439a4,
  'messages.reportEncryptedSpam': 0x4b0c8c0f,
  'messages.uploadEncryptedFile': 0x5057c497,
});

// End-to-end TL constructors (https://core.telegram.org/schema/end-to-end).
const TL = Object.freeze({
  decryptedMessageLayer: 0x1be31789,
  decryptedMessage8: 0x1f814f1f,
  decryptedMessage17: 0x204d3878,
  decryptedMessage45: 0x36b091de,
  decryptedMessage73: 0x91cc4674,
  decryptedMessageService8: 0xaa48327d,
  decryptedMessageService17: 0x73164160,
  decryptedMessageMediaEmpty: 0x89f5c4a,
});

const now = () => Math.floor(Date.now() / 1000);
const toNumber = (v, fallback = 0) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const asBig = (v) => {
  try { return BigInt(v === undefined || v === null ? 0 : v); }
  catch { return 0n; }
};
const snake = (key) => String(key || '').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function asReader(params) {
  if (isReader(params)) return params;
  if (Buffer.isBuffer(params)) {
    const r = new TLBuffer(params);
    if (r.has(4)) r.uint(); // tolerate a full body including the method id
    return r;
  }
  return params || {};
}

function readFlags(r) {
  if (isReader(r)) return r.has(4) ? r.uint() : 0;
  const flags = toNumber(r.flags ?? r.flags_);
  return (r.deleteHistory || r.delete_history || r.silent) ? flags | 1 : flags;
}

function readBoolTrue(r, flags, bit, params, key) {
  if (!(flags & (1 << bit))) return false;
  if (isReader(r)) return r.has(4) ? r.uint() === ID.boolTrue : true;
  return Boolean(!params || params[key] !== false);
}

function readInputUser(r) {
  if (!isReader(r)) {
    const p = r.userId ?? r.user_id ?? r.inputUser ?? r.peerId;
    if (p && typeof p === 'object') {
      return { type: String(p.type || 'user'), id: toNumber(p.id ?? p.userId ?? p.user_id), accessHash: asBig(p.accessHash ?? p.access_hash) };
    }
    return { type: 'user', id: toNumber(p), accessHash: asBig(r.accessHash ?? r.access_hash) };
  }
  if (!r.has(4)) return { type: 'empty', id: 0, accessHash: 0n };
  switch (r.uint() >>> 0) {
    case ID.inputUserEmpty: return { type: 'empty', id: 0, accessHash: 0n };
    case ID.inputUserSelf: return { type: 'self', id: 0, accessHash: 0n };
    case ID.inputUser: {
      const id = Number(r.long());
      return { type: 'user', id, accessHash: r.has(8) ? r.long() : 0n };
    }
    default: return { type: 'unknown', id: 0, accessHash: 0n };
  }
}

function readInputEncryptedChat(r) {
  if (!isReader(r)) {
    const p = r.peer ?? r.chat ?? r;
    if (p === null || typeof p !== 'object') return { chatId: toNumber(p), accessHash: 0n };
    return { chatId: toNumber(p.chatId ?? p.chat_id ?? p.id), accessHash: asBig(p.accessHash ?? p.access_hash) };
  }
  if (!r.has(4)) return { chatId: 0, accessHash: 0n };
  const ctor = r.uint() >>> 0;
  if (ctor !== ID.inputEncryptedChat) return { chatId: 0, accessHash: 0n, constructor: ctor };
  return { chatId: r.has(4) ? r.int() : 0, accessHash: r.has(8) ? r.long() : 0n };
}

function readInputEncryptedFile(r) {
  if (!isReader(r)) {
    const f = r.file ?? r;
    if (!f || typeof f === 'number') return null;
    return {
      id: asBig(f.id ?? f.fileId), accessHash: asBig(f.accessHash ?? f.access_hash),
      size: asBig(f.size), dcId: toNumber(f.dcId ?? f.dc_id ?? 1, 1),
      keyFingerprint: toNumber(f.keyFingerprint ?? f.key_fingerprint),
    };
  }
  if (!r.has(4)) return null;
  switch (r.uint() >>> 0) {
    case ID.inputEncryptedFileEmpty: return null;
    case ID.inputEncryptedFile: {
      const id = r.has(8) ? r.long() : 0n;
      return { id, accessHash: r.has(8) ? r.long() : 0n, size: 0n, dcId: 1, keyFingerprint: 0 };
    }
    case ID.inputEncryptedFileUploaded:
    case ID.inputEncryptedFileBigUploaded: {
      const id = r.has(8) ? r.long() : 0n;
      if (r.has(4)) r.int(); // parts
      if (r.has(1) && r.has(4)) r.string(); // md5_checksum (only in non-big)
      return { id, accessHash: 0n, size: 0n, dcId: 1, keyFingerprint: r.has(4) ? r.int() : 0 };
    }
    default: return null;
  }
}

function readInt(r, key, fallback = 0) {
  if (isReader(r)) return r.has(4) ? r.int() : fallback;
  const v = r[key] ?? snake(key);
  return v === undefined || v === null ? fallback : toNumber(v, fallback);
}

function readLong(r, key, fallback = 0n) {
  if (isReader(r)) return r.has(8) ? r.long() : fallback;
  const v = r[key] ?? snake(key);
  return v === undefined || v === null ? fallback : asBig(v);
}

function readBytes(r, key, snakeKey) {
  if (isReader(r)) return r.has(1) ? Buffer.from(r.bytes()) : Buffer.alloc(0);
  const v = r[key] ?? r[snakeKey] ?? snake(key);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  return Buffer.alloc(0);
}

function storeOf(ctx = {}) {
  if (ctx.secretStore) return ctx.secretStore;
  const dir = ctx.config?.dataDir || ctx.store?.dataDir || './data';
  const store = new SecretStore(dir);
  ctx.secretStore = store;
  return store;
}

function currentUserId(store, ctx = {}) {
  if (ctx.userId) return toNumber(ctx.userId);
  if (ctx.user?.id) return toNumber(ctx.user.id);
  if (ctx.session?.userId) return toNumber(ctx.session.userId);
  if (typeof store?.getUser !== 'function' || !store?.driver?.all) return 1;
  try {
    const row = store.driver.all('users', {}, { limit: 1 })[0];
    return toNumber(row?.id ?? row?.user_id) || 1;
  } catch { return 1; }
}

function pushUpdate(ctx, update) {
  if (!ctx || typeof ctx !== 'object') return;
  if (!Array.isArray(ctx.secretUpdateQueue)) ctx.secretUpdateQueue = [];
  ctx.secretUpdateQueue.push(update);
}

// ---- per-chat E2E side state -------------------------------------------
function stateOf(store, ctx) {
  const root = store || ctx || {};
  if (!root.__secretE2E) root.__secretE2E = new Map();
  return root.__secretE2E;
}

/** Seed/restore E2E state for a chat (used by callers and tests). */
export function setE2EState(chatId, state, ctx = {}) {
  const store = storeOf(ctx);
  stateOf(store, ctx).set(toNumber(chatId), { ...state });
  return state;
}

export function getE2EState(chatId, ctx = {}) {
  const store = storeOf(ctx);
  return stateOf(store, ctx).get(toNumber(chatId)) || null;
}

function saveState(store, ctx, chatId, patch) {
  const map = stateOf(store, ctx);
  const id = toNumber(chatId);
  map.set(id, { ...(map.get(id) || {}), ...patch });
  return map.get(id);
}

function bigOfBytes(buf) {
  const b = Buffer.from(buf);
  return b.length ? BigInt(`0x${b.toString('hex')}`) : 0n;
}

/** Validate a DH public value as required by https://core.telegram.org/api/end-to-end. */
function validPublic(value) {
  const v = typeof value === 'bigint' ? value : bigOfBytes(value);
  const lower = 1n << 1984n;
  return v > 1n && v < DH_PRIME - 1n && v >= lower && v <= DH_PRIME - lower;
}

/** Generate a fresh DH exponent/public value with the standard Telegram prime. */
function generateDhPair() {
  // 256 random bytes are a 2048-bit exponent; retry if the public value lands
  // too close to 1 or p (the spec's safety recommendation).
  for (;;) {
    const secret = BigInt(`0x${crypto.randomBytes(256).toString('hex')}`) | (1n << 2047n);
    const pub = modPow(DH_GENERATOR, secret, DH_PRIME);
    if (validPublic(pub)) return { secret, publicBytes: bigintToBytes(pub) };
  }
}

function modPow(base, exponent, modulus) {
  if (modulus <= 1n) return 0n;
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    e >>= 1n;
    b = (b * b) % modulus;
  }
  return result;
}

// ---- TL encoders (layer 234) ------------------------------------------
function boolTrue() { return new TLBuffer().putUint(ID.boolTrue).buffer; }
function emptyVector() { return new TLBuffer().putVector([], () => {}).buffer; }

function encodeEncryptedChat(chat, kind, opts = {}) {
  const viewerId = toNumber(opts.viewerId);
  const adminId = viewerId && viewerId === chat.otherUserId ? chat.otherUserId : chat.userId;
  const participantId = adminId === chat.userId ? chat.otherUserId : chat.userId;
  const accessHash = asBig(opts.accessHash ?? chat.accessHash);
  const b = new TLBuffer();
  if (kind === 'accepted') {
    return b.putUint(ID.encryptedChat).putInt(toNumber(chat.id)).putLong(accessHash)
      .putInt(toNumber(opts.date ?? chat.date)).putLong(BigInt(adminId)).putLong(BigInt(participantId))
      .putBytes(opts.gB ?? chat.gB ?? Buffer.alloc(0))
      .putLong(asBig(opts.keyFingerprint ?? chat.keyFingerprint)).buffer;
  }
  return b.putUint(ID.encryptedChatRequested).putUint(0)
    .putInt(toNumber(chat.id)).putLong(accessHash).putInt(toNumber(opts.date ?? chat.date))
    .putLong(BigInt(adminId)).putLong(BigInt(participantId))
    .putBytes(opts.gA ?? chat.gA ?? Buffer.alloc(0)).buffer;
}

function encodeEncryptedFile(file) {
  if (!file || !asBig(file.id)) return new TLBuffer().putUint(ID.encryptedFileEmpty).buffer;
  return new TLBuffer().putUint(ID.encryptedFile).putLong(asBig(file.id)).putLong(asBig(file.accessHash))
    .putLong(asBig(file.size)).putInt(toNumber(file.dcId ?? 1, 1)).putInt(toNumber(file.keyFingerprint)).buffer;
}

function encodeEncryptedMessage({ randomId = 0n, chatId = 0, date = 0, data = Buffer.alloc(0), file = null, service = false }) {
  const b = new TLBuffer();
  b.putUint(service ? ID.encryptedMessageService : ID.encryptedMessage);
  b.putLong(asBig(randomId)).putInt(toNumber(chatId)).putInt(toNumber(date)).putBytes(data);
  if (!service) b.putRaw(encodeEncryptedFile(file));
  return b.buffer;
}

function encodeUpdateNewEncryptedMessage(message, qts) {
  return new TLBuffer().putUint(ID.updateNewEncryptedMessage).putRaw(message).putInt(toNumber(qts)).buffer;
}

function encodeUpdates(updates, { date, seq } = {}) {
  const b = new TLBuffer().putUint(ID.updates);
  b.putVector(updates, (u, bb) => bb.putRaw(u));
  b.putRaw(emptyVector());
  b.putRaw(emptyVector());
  return b.putInt(toNumber(date) || now()).putInt(toNumber(seq)).buffer;
}

// ---- inner decryptedMessage parser ------------------------------------
/** Parse a decryptedMessage / decryptedMessageLayer TL object. */
export function parseDecryptedMessage(tlData) {
  const r = new TLBuffer(Buffer.from(tlData));
  const ctor = r.has(4) ? r.uint() >>> 0 : 0;
  if (ctor === TL.decryptedMessageLayer) {
    if (r.has(1)) r.bytes(); // random_bytes
    const layer = r.has(4) ? r.int() : 0;
    const inSeqNo = r.has(4) ? r.int() : 0;
    const outSeqNo = r.has(4) ? r.int() : 0;
    const inner = r.has(4) ? parseDecryptedMessage(r.raw(r.length - r.offset)) : { constructor: 0, text: '' };
    return { ...inner, layer, inSeqNo, outSeqNo };
  }
  if (ctor === TL.decryptedMessage8) {
    const randomId = r.has(8) ? r.long() : 0n;
    if (r.has(1)) r.bytes(); // random_bytes
    const text = r.has(1) ? r.string() : '';
    return { constructor: ctor, kind: 'message', randomId, text, layer: 8 };
  }
  if (ctor === TL.decryptedMessage17) {
    const randomId = r.has(8) ? r.long() : 0n;
    if (r.has(4)) r.int(); // ttl
    const text = r.has(1) ? r.string() : '';
    return { constructor: ctor, kind: 'message', randomId, text, layer: 17 };
  }
  if (ctor === TL.decryptedMessage45 || ctor === TL.decryptedMessage73) {
    const flags = r.has(4) ? r.uint() : 0;
    void flags; // flags.1 / flags.5 are `true` flags with no payload
    const randomId = r.has(8) ? r.long() : 0n;
    if (r.has(4)) r.int(); // ttl
    const text = r.has(1) ? r.string() : '';
    return { constructor: ctor, kind: 'message', randomId, text, layer: ctor === TL.decryptedMessage73 ? 73 : 45 };
  }
  if (ctor === TL.decryptedMessageService8 || ctor === TL.decryptedMessageService17) {
    const randomId = r.has(8) ? r.long() : 0n;
    if (ctor === TL.decryptedMessageService8 && r.has(1)) r.bytes();
    return { constructor: ctor, kind: 'service', randomId, text: '', layer: ctor === TL.decryptedMessageService17 ? 17 : 8 };
  }
  return { constructor: ctor, kind: 'unknown', randomId: 0n, text: '', layer: 0 };
}

// ---- handlers ----------------------------------------------------------
/** messages.requestEncryption#f64daf43 user_id:InputUser random_id:int g_a:bytes */
export function requestEncryption(params, ctx = {}) {
  const r = asReader(params);
  const target = readInputUser(r);
  const randomId = readInt(r, 'randomId');
  const gA = readBytes(r, 'gA', 'g_a');
  if (!validPublic(gA)) throw new Error('requestEncryption: invalid g_a');
  const store = storeOf(ctx);
  const me = currentUserId(store, ctx);
  const otherUserId = toNumber(target.id) || (target.type === 'self' ? me : 0);
  const { secret, publicBytes: gB } = generateDhPair();
  const shared = modPow(bigOfBytes(gA), secret, DH_PRIME);
  const key = deriveE2EKey(shared);
  const fingerprint = computeSharedKeyFingerprint(key);
  const chat = store.createChat({
    userId: me, otherUserId, accessHash: target.accessHash || 0,
    keyFingerprint: fingerprint, state: 'requested', gA, gB, randomId, date: now(),
  });
  saveState(store, ctx, chat.id, { secret, gA, gB, key, fingerprint, x: 0 });
  ctx.secretChatId = chat.id;
  ctx.secretChatGKey = key;
  ctx.secretChatFingerprint = fingerprint;
  // The requester already knows its own g_a, so the reply exposes our freshly
  // generated g_b in the EncryptedChat.g_a_or_b slot (chat.gA keeps the
  // client's value for key derivation).
  return encodeEncryptedChat(chat, 'requested', { viewerId: me, gA: gB, keyFingerprint: fingerprint });
}

/** messages.acceptEncryption#3dbc0415 peer:InputEncryptedChat g_b:bytes key_fingerprint:long */
export function acceptEncryption(params, ctx = {}) {
  const r = asReader(params);
  const peer = readInputEncryptedChat(r);
  const gB = readBytes(r, 'gB', 'g_b');
  const provided = readLong(r, 'keyFingerprint', 'key_fingerprint');
  const store = storeOf(ctx);
  const existing = store.getChat(peer.chatId);
  const chat = existing || store.createChat({ id: peer.chatId, userId: currentUserId(store, ctx) });
  const state = stateOf(store, ctx).get(chat.id) || {};
  if (!validPublic(gB)) throw new Error('acceptEncryption: invalid g_b');
  let key = state.key ? deriveE2EKey(state.key) : null;
  if (!key && state.secret !== undefined) {
    key = deriveE2EKey(modPow(bigOfBytes(gB), BigInt(state.secret), DH_PRIME));
  }
  if (!key) throw new Error('acceptEncryption: no E2E key state for chat');
  const fingerprint = computeSharedKeyFingerprint(key);
  const canonical = computeKeyFingerprint(key, gB);
  if (provided !== fingerprint && provided !== canonical) {
    throw new Error('acceptEncryption: key_fingerprint mismatch');
  }
  store.updateChat(chat.id, {
    gB, keyFingerprint: fingerprint, accessHash: peer.accessHash || chat.accessHash,
    state: 'accepted',
  });
  saveState(store, ctx, chat.id, { gB, key, fingerprint });
  const accepted = store.getChat(chat.id);
  const update = new TLBuffer().putUint(ID.updateEncryption)
    .putRaw(encodeEncryptedChat(accepted, 'accepted', {
      viewerId: currentUserId(store, ctx), gB, keyFingerprint: fingerprint,
    }))
    .putInt(toNumber(accepted.date)).buffer;
  pushUpdate(ctx, update);
  return encodeEncryptedChat(accepted, 'accepted', { viewerId: currentUserId(store, ctx), gB, keyFingerprint: fingerprint });
}

/** messages.readEncryptedHistory#7f4b690a peer:InputEncryptedChat max_date:int */
export function readEncryptedHistory(params, ctx = {}) {
  const r = asReader(params);
  const peer = readInputEncryptedChat(r);
  const maxDate = readInt(r, 'maxDate');
  const store = storeOf(ctx);
  const messages = store.listMessages(peer.chatId);
  for (const m of messages) if (toNumber(m.date) <= maxDate) store.markRead(peer.chatId, m.id);
  const state = store.updateState(peer.chatId, undefined, undefined, undefined);
  const qts = toNumber(state?.qts);
  const date = now();
  void qts; // updateEncryptedMessagesRead carries chat_id/max_date/date only
  pushUpdate(ctx, new TLBuffer().putUint(ID.updateEncryptedMessagesRead)
    .putInt(peer.chatId).putInt(maxDate).putInt(date).buffer);
  return boolTrue();
}

function sendEncryptedCommon(params, ctx, { service = false, fileMode = false } = {}) {
  const r = asReader(params);
  const flags = readFlags(r);
  readBoolTrue(r, flags, 0, params, 'silent');
  const peer = readInputEncryptedChat(r);
  const randomId = readLong(r, 'randomId');
  const data = readBytes(r, 'data');
  const file = fileMode ? readInputEncryptedFile(r) : null;
  const store = storeOf(ctx);
  const chat = ensureChat(store, peer.chatId, ctx);
  const state = stateOf(store, ctx).get(chat.id);
  if (!state?.key) throw new Error('sendEncrypted: no E2E key for chat');
  const key = deriveE2EKey(state.key);
  // Decrypt the client's envelope (client is the chat originator: x = 0),
  // verify msg_key + fingerprint, then re-encrypt for the peer (x = 8).
  const decrypted = decryptSecretMessage(key, data, { x: toNumber(state.x ?? 0), fingerprint: state.fingerprint });
  const parsed = parseDecryptedMessage(decrypted.tlData);
  const outgoing = encryptSecretMessage(key, decrypted.tlData, {
    x: 8, fingerprint: state.fingerprint || computeSharedKeyFingerprint(key),
  });
  const date = (!isReader(params) && params?.date !== undefined) ? toNumber(params.date) || now() : now();
  store.putMessage({
    chatId: chat.id, randomId, text: parsed.text || decrypted.tlData.toString('base64'), date,
  });
  const chatState = store.updateState(chat.id, undefined, toNumber(chat.qts) + 1, chat.seq);
  saveState(store, ctx, chat.id, {
    plaintext: decrypted.tlData.toString('base64'),
    parsed,
    lastEncrypted: outgoing.toString('base64'),
  });
  const message = encodeEncryptedMessage({ randomId, chatId: chat.id, date, data: outgoing, file, service });
  const update = encodeUpdateNewEncryptedMessage(message, chatState.qts);
  pushUpdate(ctx, update);
  if (ctx.secretSchemaResult === true) {
    return new TLBuffer().putUint(fileMode && file ? 0x9493ff32 : 0x560f8935)
      .putInt(date).putRaw(fileMode ? encodeEncryptedFile(file) : Buffer.alloc(0)).buffer;
    // (sentEncryptedMessage#560f8935 has no file field; sentEncryptedFile does)
  }
  return encodeUpdates([update], { date, seq: chatState.seq });
}

function ensureChat(store, chatId, ctx = {}) {
  return store.getChat(chatId) || store.createChat({ id: toNumber(chatId), userId: currentUserId(store, ctx), state: 'requested' });
}

/** messages.sendEncrypted#44fa7a15 */
export function sendEncrypted(params, ctx = {}) { return sendEncryptedCommon(params, ctx); }
/** messages.sendEncryptedFile#5559481d */
export function sendEncryptedFile(params, ctx = {}) { return sendEncryptedCommon(params, ctx, { fileMode: true }); }
/** messages.sendEncryptedService#32d439a4 */
export function sendEncryptedService(params, ctx = {}) { return sendEncryptedCommon(params, ctx, { service: true }); }

export { ID as TL_IDS, modPow, validPublic };

export default {
  METHOD_IDS,
  requestEncryption,
  acceptEncryption,
  readEncryptedHistory,
  sendEncrypted,
  sendEncryptedFile,
  sendEncryptedService,
  parseDecryptedMessage,
  setE2EState,
  getE2EState,
};
