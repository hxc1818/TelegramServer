// TL handlers for secret chats (layer 234).
//
// All constructor ids below were grep-verified against schema/api.tl pinned at
// layer 234; the schema line is recorded next to each entry. Local TL encoders
// are defined here so handlers/codecs.js and the router remain untouched.
//
// Response shapes:
//   messages.requestEncryption  -> encryptedChatRequested#48f1d94c (declared
//                                  EncryptedChat result); with
//                                  ctx.secretUpdates === true the same event is
//                                  returned as updates#74ae4240 containing
//                                  updateEncryption#b4a2e88d.
//   messages.acceptEncryption   -> encryptedChat#61f0d4c7
//   messages.discardEncryption  -> boolTrue#997275b5
//   messages.sendEncrypted(File)-> updates#74ae4240 containing
//                                  updateNewEncryptedMessage#12bcbd9a (the
//                                  declared messages.SentEncryptedMessage is
//                                  available via ctx.secretSchemaResult).
//   messages.uploadEncryptedFile -> encryptedFile#a8008cd8
//
// ---------------------------------------------------------------------------
// 端到端加密限制 / E2E LIMITATION (IMPORTANT)
// ---------------------------------------------------------------------------
// This module implements the RPC and data layer ONLY. It does NOT perform the
// secret-chat Diffie-Hellman key exchange, does NOT derive the shared secret
// (nor its key fingerprint), and does NOT encrypt or decrypt message payloads.
// The `data`/`g_a`/`g_b` byte fields are treated as OPAQUE bytes: they are
// stored base64-encoded and echoed back verbatim inside encryptedMessage.
// Real end-to-end encryption requires the secret chat key, which this server
// never computes. Do NOT use these chats for genuinely secret communication.
//
// Layer-234 methods that do not exist in schema/api.tl and therefore have NO
// verifiable constructor id are intentionally absent from METHOD_IDS:
// messages.getEncryptedChats, messages.getEncryptedHistory,
// messages.getEncryptedUpdates, updates.getSecretChatDifferences. Local helper
// functions with those names are exported for callers that want the stored
// data, but they are not wire methods. updates.getDifference is handled in
// handlers/updates.js and already carries new_encrypted_messages.

import { TLBuffer } from '../../tl/buffer.js';
import { isReader } from './parsers.js';
import { SecretStore } from '../../store/secret.js';

// Constructor ids from schema/api.tl (layer 234).
const ID = Object.freeze({
  boolTrue: 0x997275b5, // boolTrue#997275b5 (line 2)
  boolFalse: 0xbc799737, // boolFalse#bc799737 (line 1)
  vector: 0x1cb5c415, // vector#1cb5c415 (line 6)
  inputUserEmpty: 0xb98886cf, // inputUserEmpty#b98886cf (line 20)
  inputUserSelf: 0xf7c1b13f, // inputUserSelf#f7c1b13f (line 21)
  inputUser: 0xf21158c6, // inputUser#f21158c6 (line 22)
  inputEncryptedChat: 0xf141b5e1, // inputEncryptedChat#f141b5e1 (line 546)
  inputEncryptedFileEmpty: 0x1837c364, // inputEncryptedFileEmpty#1837c364 (line 551)
  inputEncryptedFileUploaded: 0x64bd0306, // inputEncryptedFileUploaded#64bd0306 (line 552)
  inputEncryptedFile: 0x5a17b5e5, // inputEncryptedFile#5a17b5e5 (line 553)
  inputEncryptedFileBigUploaded: 0x2dc173c8, // inputEncryptedFileBigUploaded#2dc173c8 (line 554)
  encryptedChatEmpty: 0xab7ec0a0, // encryptedChatEmpty#ab7ec0a0 (line 540)
  encryptedChatWaiting: 0x66b25953, // encryptedChatWaiting#66b25953 (line 541)
  encryptedChatRequested: 0x48f1d94c, // encryptedChatRequested#48f1d94c (line 542)
  encryptedChat: 0x61f0d4c7, // encryptedChat#61f0d4c7 (line 543)
  encryptedChatDiscarded: 0x1e1c7c45, // encryptedChatDiscarded#1e1c7c45 (line 544)
  encryptedFileEmpty: 0xc21f497e, // encryptedFileEmpty#c21f497e (line 548)
  encryptedFile: 0xa8008cd8, // encryptedFile#a8008cd8 (line 549)
  encryptedMessage: 0xed18c118, // encryptedMessage#ed18c118 (line 556)
  encryptedMessageService: 0x23734b06, // encryptedMessageService#23734b06 (line 557)
  sentEncryptedMessage: 0x560f8935, // messages.sentEncryptedMessage#560f8935 (line 562)
  sentEncryptedFile: 0x9493ff32, // messages.sentEncryptedFile#9493ff32 (line 563)
  updateNewEncryptedMessage: 0x12bcbd9a, // updateNewEncryptedMessage#12bcbd9a (line 338)
  updateEncryptedChatTyping: 0x1710f156, // updateEncryptedChatTyping#1710f156 (line 339)
  updateEncryption: 0xb4a2e88d, // updateEncryption#b4a2e88d (line 340)
  updateEncryptedMessagesRead: 0x38fe25b7, // updateEncryptedMessagesRead#38fe25b7 (line 341)
  updatesState: 0xa56c2a3e, // updates.state#a56c2a3e (line 506)
  updatesDifference: 0xb78fca40, // updates.difference#b78fca40 (line 509)
  updates: 0x74ae4240, // updates#74ae4240 (line 518)
  user: 0xb1b8cc83, // user#b1b8cc83 (line 91)
});

/** RPC method ids, verified against schema/api.tl (layer 234). */
export const METHOD_IDS = Object.freeze({
  'messages.requestEncryption': 0xf64daf43, // line 2664
  'messages.acceptEncryption': 0x3dbc0415, // line 2665
  'messages.discardEncryption': 0xf393aea0, // line 2666
  'messages.setEncryptedTyping': 0x791451ed, // line 2667
  'messages.readEncryptedHistory': 0x7f4b690a, // line 2668
  'messages.sendEncrypted': 0x44fa7a15, // line 2669
  'messages.sendEncryptedFile': 0x5559481d, // line 2670
  'messages.sendEncryptedService': 0x32d439a4, // line 2671
  'messages.reportEncryptedSpam': 0x4b0c8c0f, // line 2673
  'messages.uploadEncryptedFile': 0x5057c497, // line 2731
});

const toNumber = (v, fallback = 0) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const now = () => Math.floor(Date.now() / 1000);
const asBig = (v) => {
  try { return BigInt(v === undefined || v === null ? 0 : v); }
  catch { return 0n; }
};

// ---- parameter readers (TLBuffer positioned after the method id, or object) ----
function readFlags(r) {
  if (isReader(r)) return r.has(4) ? r.uint() : 0;
  if (!r || typeof r !== 'object') return 0;
  let flags = toNumber(r.flags);
  if (r.deleteHistory || r.delete_history || r.silent) flags |= 1 << 0;
  return flags;
}

function readFlagTrue(r, flags, bit, key, params) {
  if (!(flags & (1 << bit))) return false;
  if (isReader(r)) return r.has(4) ? r.uint() === ID.boolTrue : true;
  return Boolean(!params || params[key] !== false);
}

function readInputUser(r, key) {
  if (!isReader(r)) {
    const root = r || {};
    const p = root[key] ?? root.user_id ?? root.inputUser;
    if (p === null || typeof p !== 'object') {
      return {
        type: 'user',
        id: toNumber(p ?? root.userId ?? root.otherUserId ?? root.peerId),
        accessHash: toNumber(root.accessHash ?? root.access_hash),
      };
    }
    return {
      type: String(p.type || 'user'),
      id: toNumber(p.id ?? p.userId ?? p.user_id ?? p.peerId ?? root.userId),
      accessHash: toNumber(p.accessHash ?? p.access_hash ?? root.accessHash ?? root.access_hash),
    };
  }
  if (!r.has(4)) return { id: 0, accessHash: 0, type: 'empty' };
  switch (r.uint() >>> 0) {
    case ID.inputUserEmpty:
      return { id: 0, accessHash: 0, type: 'empty' };
    case ID.inputUserSelf:
      return { id: 0, accessHash: 0, type: 'self' };
    case ID.inputUser: {
      const id = Number(r.long());
      const accessHash = r.has(8) ? r.long() : 0n;
      return { id, accessHash, type: 'user' };
    }
    default:
      return { id: 0, accessHash: 0, type: 'unknown' };
  }
}

function readInputEncryptedChat(r, key) {
  if (!isReader(r)) {
    const p = r?.[key] ?? r?.peer ?? r ?? {};
    if (p === null || typeof p !== 'object') return { chatId: toNumber(p), accessHash: 0 };
    return {
      chatId: toNumber(p.chatId ?? p.chat_id ?? p.id ?? p.peerId),
      accessHash: toNumber(p.accessHash ?? p.access_hash),
    };
  }
  if (!r.has(4)) return { chatId: 0, accessHash: 0 };
  const ctor = r.uint() >>> 0;
  if (ctor !== ID.inputEncryptedChat) {
    // Unknown/empty InputEncryptedChat: no further fixed fields to consume.
    return { chatId: 0, accessHash: 0, constructor: ctor };
  }
  const chatId = r.has(4) ? r.int() : 0;
  const accessHash = r.has(8) ? r.long() : 0n;
  return { chatId, accessHash };
}

function readInputEncryptedFile(r, key) {
  if (!isReader(r)) {
    const f = r?.[key] ?? r?.file ?? r ?? {};
    if (!f || typeof f !== 'object') return null;
    return {
      id: toNumber(f.id ?? f.fileId),
      accessHash: toNumber(f.accessHash ?? f.access_hash),
      size: toNumber(f.size),
      dcId: toNumber(f.dcId ?? f.dc_id ?? 1, 1),
      keyFingerprint: toNumber(f.keyFingerprint ?? f.key_fingerprint),
    };
  }
  if (!r.has(4)) return null;
  switch (r.uint() >>> 0) {
    case ID.inputEncryptedFileEmpty:
      return null;
    case ID.inputEncryptedFile: {
      const id = r.has(8) ? r.long() : 0n;
      const accessHash = r.has(8) ? r.long() : 0n;
      return { id, accessHash, size: 0, dcId: 1, keyFingerprint: 0 };
    }
    case ID.inputEncryptedFileUploaded: {
      const id = r.has(8) ? r.long() : 0n;
      if (r.has(4)) r.int(); // parts
      if (r.has(1)) r.string(); // md5_checksum
      const keyFingerprint = r.has(4) ? r.int() : 0;
      return { id, accessHash: 0n, size: 0, dcId: 1, keyFingerprint };
    }
    case ID.inputEncryptedFileBigUploaded: {
      const id = r.has(8) ? r.long() : 0n;
      if (r.has(4)) r.int(); // parts
      const keyFingerprint = r.has(4) ? r.int() : 0;
      return { id, accessHash: 0n, size: 0, dcId: 1, keyFingerprint };
    }
    default:
      return null;
  }
}

function readInt(r, key, fallback = 0) {
  if (isReader(r)) return r.has(4) ? r.int() : fallback;
  const v = r?.[key] ?? r?.[`${key}_id`] ?? r?.[snake(key)];
  return v === undefined || v === null ? fallback : toNumber(v, fallback);
}

function readLong(r, key, fallback = 0n) {
  if (isReader(r)) return r.has(8) ? r.long() : fallback;
  const v = r?.[key] ?? r?.[snake(key)];
  return v === undefined || v === null ? fallback : asBig(v);
}

function readBytes(r, key, snakeKey) {
  if (isReader(r)) return r.has(1) ? Buffer.from(r.bytes()) : Buffer.alloc(0);
  const v = r?.[key] ?? r?.[snakeKey] ?? r?.[snake(key)];
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  return Buffer.alloc(0);
}

function snake(key) {
  return String(key || '').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function asReader(params) {
  if (isReader(params)) return params;
  if (Buffer.isBuffer(params)) {
    const r = new TLBuffer(params);
    if (r.has(4)) r.uint(); // tolerate a full body including the method id
    return r;
  }
  return params || {};
}

function storeOf(ctx = {}) {
  if (ctx.secretStore) return ctx.secretStore;
  const store = new SecretStore(ctx.store?.dataDir || './data');
  ctx.secretStore = store;
  return store;
}

function currentUserId(store, ctx = {}) {
  if (ctx.userId) return toNumber(ctx.userId);
  if (ctx.user?.id) return toNumber(ctx.user.id);
  if (ctx.session?.userId) return toNumber(ctx.session.userId);
  // A standalone SecretStore has no users table; only the main Store does.
  if (typeof store?.getUser !== 'function' || !store?.driver?.all) return 1;
  try {
    const first = store.driver.all('users', {}, { limit: 1 })[0];
    return toNumber(first?.id ?? first?.user_id) || 1;
  } catch {
    return 1;
  }
}

/** Handlers also expose generated updates here for the server to deliver. */
function pushUpdate(ctx, update) {
  if (!ctx || typeof ctx !== 'object') return;
  if (!Array.isArray(ctx.secretUpdateQueue)) ctx.secretUpdateQueue = [];
  ctx.secretUpdateQueue.push(update);
}

// ---- TL encoders --------------------------------------------------------
function boolTrue() {
  return new TLBuffer().putUint(ID.boolTrue).buffer;
}

function emptyVector() {
  return new TLBuffer().putVector([], () => {}).buffer;
}

function encodeEncryptedChat(chat, kind, opts = {}) {
  const viewerId = toNumber(opts.viewerId);
  const adminId = viewerId && viewerId === chat.otherUserId ? chat.otherUserId : chat.userId;
  const participantId = adminId === chat.userId ? chat.otherUserId : chat.userId;
  const accessHash = asBig(opts.accessHash ?? chat.accessHash);
  const date = toNumber(opts.date ?? chat.date);
  const b = new TLBuffer();
  switch (kind) {
    case 'empty':
      return b.putUint(ID.encryptedChatEmpty).putInt(toNumber(chat.id)).buffer;
    case 'waiting':
      return b.putUint(ID.encryptedChatWaiting).putInt(toNumber(chat.id)).putLong(accessHash)
        .putInt(date).putLong(BigInt(adminId)).putLong(BigInt(participantId)).buffer;
    case 'discarded': {
      const deleted = Boolean(opts.deleteHistory);
      b.putUint(ID.encryptedChatDiscarded).putUint(deleted ? (1 << 0) : 0);
      if (deleted) b.putUint(ID.boolTrue);
      return b.putInt(toNumber(chat.id)).buffer;
    }
    case 'accepted':
      return b.putUint(ID.encryptedChat).putInt(toNumber(chat.id)).putLong(accessHash)
        .putInt(date).putLong(BigInt(adminId)).putLong(BigInt(participantId))
        .putBytes(opts.gB ?? chat.gB ?? chat.gA ?? Buffer.alloc(0))
        .putLong(asBig(opts.keyFingerprint ?? chat.keyFingerprint)).buffer;
    case 'requested':
    default:
      return b.putUint(ID.encryptedChatRequested).putUint(0) // flags (folder_id omitted)
        .putInt(toNumber(chat.id)).putLong(accessHash).putInt(date)
        .putLong(BigInt(adminId)).putLong(BigInt(participantId))
        .putBytes(opts.gA ?? chat.gA ?? Buffer.alloc(0)).buffer;
  }
}

function encodeEncryptedFile(file) {
  if (!file || !toNumber(file.id)) return new TLBuffer().putUint(ID.encryptedFileEmpty).buffer;
  return new TLBuffer()
    .putUint(ID.encryptedFile)
    .putLong(asBig(file.id)).putLong(asBig(file.accessHash))
    .putLong(asBig(file.size)).putInt(toNumber(file.dcId ?? 1, 1))
    .putInt(toNumber(file.keyFingerprint)).buffer;
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

function encodeUpdateEncryption(chat, date, viewerId, kind = 'requested', extra = {}) {
  return new TLBuffer().putUint(ID.updateEncryption)
    .putRaw(encodeEncryptedChat(chat, kind, { viewerId, ...extra }))
    .putInt(toNumber(date)).buffer;
}

function encodeUpdates(updates = [], { date, seq } = {}) {
  const b = new TLBuffer().putUint(ID.updates);
  b.putVector(updates, (u, bb) => bb.putRaw(u));
  b.putRaw(emptyVector()); // users
  b.putRaw(emptyVector()); // chats
  return b.putInt(toNumber(date) || now()).putInt(toNumber(seq)).buffer;
}

function encodeState(state = {}) {
  return new TLBuffer()
    .putUint(ID.updatesState)
    .putInt(toNumber(state.pts))
    .putInt(toNumber(state.qts))
    .putInt(toNumber(state.date))
    .putInt(toNumber(state.seq))
    .putInt(toNumber(state.unreadCount ?? state.unread_count)).buffer;
}

function encodeSentEncryptedMessage(date, file = null) {
  if (file && toNumber(file.id)) {
    return new TLBuffer().putUint(ID.sentEncryptedFile).putInt(toNumber(date))
      .putRaw(encodeEncryptedFile(file)).buffer;
  }
  return new TLBuffer().putUint(ID.sentEncryptedMessage).putInt(toNumber(date)).buffer;
}

function ensureChat(store, chatId, opts = {}) {
  const existing = store.getChat(chatId);
  if (existing) return existing;
  return store.createChat({
    id: toNumber(chatId),
    userId: toNumber(opts.userId),
    otherUserId: toNumber(opts.otherUserId),
    accessHash: opts.accessHash || 0,
    state: 'requested',
  });
}

function messageTextOf(params, data) {
  if (params && !isReader(params) && params.text !== undefined && params.data === undefined) {
    return String(params.text);
  }
  // Opaque E2E ciphertext is never decrypted; keep the exact bytes in base64.
  return Buffer.from(data).toString('base64');
}

// ---- handlers -----------------------------------------------------------
/** messages.requestEncryption#f64daf43 user_id:InputUser random_id:int g_a:bytes = EncryptedChat */
export function requestEncryption(params, ctx = {}) {
  const r = asReader(params);
  const target = readInputUser(r, 'userId');
  const randomId = readInt(r, 'randomId');
  const gA = readBytes(r, 'gA', 'g_a');
  const store = storeOf(ctx);
  const me = currentUserId(store, ctx);
  const otherUserId = toNumber(target.id) || (target.type === 'self' ? me : 0);
  const chat = store.createChat({
    userId: me,
    otherUserId,
    accessHash: target.accessHash || 0,
    keyFingerprint: 0,
    state: 'requested',
    gA,
    randomId,
    date: now(),
  });
  ctx.secretChatId = chat.id;
  if (ctx.secretUpdates === true) {
    const update = encodeUpdateEncryption(chat, chat.date, me, 'requested', { gA });
    pushUpdate(ctx, update);
    return encodeUpdates([update], { date: chat.date, seq: chat.seq });
  }
  return encodeEncryptedChat(chat, 'requested', { viewerId: me, gA });
}

/** messages.acceptEncryption#3dbc0415 peer:InputEncryptedChat g_b:bytes key_fingerprint:long = EncryptedChat */
export function acceptEncryption(params, ctx = {}) {
  const r = asReader(params);
  const peer = readInputEncryptedChat(r, 'peer');
  const gB = readBytes(r, 'gB', 'g_b');
  const keyFingerprint = readLong(r, 'keyFingerprint', 'key_fingerprint');
  const store = storeOf(ctx);
  const me = currentUserId(store, ctx);
  const chat = ensureChat(store, peer.chatId, { userId: peer.chatId ? 0 : me });
  store.updateChat(chat.id, {
    gB,
    keyFingerprint,
    accessHash: peer.accessHash || chat.accessHash,
    state: 'accepted',
  });
  const accepted = store.getChat(chat.id);
  const update = encodeUpdateEncryption(accepted, accepted.date, me, 'accepted', { gB, keyFingerprint });
  pushUpdate(ctx, update);
  return encodeEncryptedChat(accepted, 'accepted', { viewerId: me, gB, keyFingerprint });
}

/** messages.discardEncryption#f393aea0 flags:# delete_history:flags.0?true chat_id:int = Bool */
export function discardEncryption(params, ctx = {}) {
  const r = asReader(params);
  const flags = readFlags(r);
  const deleteHistory = readFlagTrue(r, flags, 0, 'deleteHistory', params);
  const chatId = readInt(r, 'chatId');
  const store = storeOf(ctx);
  store.discardChat(chatId);
  if (deleteHistory) store.clearMessages(chatId);
  const discarded = store.getChat(chatId) || { id: chatId };
  pushUpdate(ctx, encodeUpdateEncryption(discarded, now(), currentUserId(store, ctx), 'discarded', { deleteHistory }));
  return boolTrue();
}

/** messages.setEncryptedTyping#791451ed peer:InputEncryptedChat typing:Bool = Bool */
export function setEncryptedTyping(params, ctx = {}) {
  const r = asReader(params);
  const peer = readInputEncryptedChat(r, 'peer');
  const typing = isReader(r) && r.has(4) ? r.uint() === ID.boolTrue : Boolean(params?.typing);
  if (typing) pushUpdate(ctx, new TLBuffer().putUint(ID.updateEncryptedChatTyping).putInt(peer.chatId).buffer);
  return boolTrue();
}

/** messages.readEncryptedHistory#7f4b690a peer:InputEncryptedChat max_date:int = Bool */
export function readEncryptedHistory(params, ctx = {}) {
  const r = asReader(params);
  const peer = readInputEncryptedChat(r, 'peer');
  const maxDate = readInt(r, 'maxDate');
  const store = storeOf(ctx);
  // Approximate: the store tracks read ids, while this RPC carries max_date.
  store.markRead(peer.chatId, maxDate);
  const date = now();
  pushUpdate(ctx, new TLBuffer().putUint(ID.updateEncryptedMessagesRead)
    .putInt(peer.chatId).putInt(maxDate).putInt(date).buffer);
  return boolTrue();
}

function sendEncryptedCommon(params, ctx, { service = false, fileMode = false } = {}) {
  const r = asReader(params);
  const flags = readFlags(r);
  readFlagTrue(r, flags, 0, 'silent', params); // silent (opaque to this server)
  const peer = readInputEncryptedChat(r, 'peer');
  const randomId = readLong(r, 'randomId');
  const data = readBytes(r, 'data');
  const file = fileMode ? readInputEncryptedFile(r, 'file') : null;
  const store = storeOf(ctx);
  const chat = ensureChat(store, peer.chatId, {
    userId: currentUserId(store, ctx),
    accessHash: peer.accessHash,
  });
  const date = (!isReader(params) && params?.date !== undefined) ? toNumber(params.date) || now() : now();
  store.putMessage({
    chatId: chat.id,
    randomId,
    text: messageTextOf(params, data),
    date,
  });
  const state = store.updateState(chat.id, undefined, chat.qts + 1, chat.seq);
  const message = encodeEncryptedMessage({ randomId, chatId: chat.id, date, data, file, service });
  const update = encodeUpdateNewEncryptedMessage(message, state.qts);
  pushUpdate(ctx, update);
  if (ctx.secretSchemaResult === true) {
    return encodeSentEncryptedMessage(date, fileMode ? file : null);
  }
  return encodeUpdates([update], { date, seq: state.seq });
}

/** messages.sendEncrypted#44fa7a15 flags:# silent:flags.0?true peer:InputEncryptedChat random_id:long data:bytes = messages.SentEncryptedMessage */
export function sendEncrypted(params, ctx = {}) {
  return sendEncryptedCommon(params, ctx);
}

/** messages.sendEncryptedFile#5559481d flags:# silent:flags.0?true peer:InputEncryptedChat random_id:long data:bytes file:InputEncryptedFile = messages.SentEncryptedMessage */
export function sendEncryptedFile(params, ctx = {}) {
  return sendEncryptedCommon(params, ctx, { fileMode: true });
}

/** messages.sendEncryptedService#32d439a4 peer:InputEncryptedChat random_id:long data:bytes = messages.SentEncryptedMessage */
export function sendEncryptedService(params, ctx = {}) {
  return sendEncryptedCommon(params, ctx, { service: true });
}

/** messages.reportEncryptedSpam#4b0c8c0f peer:InputEncryptedChat = Bool */
export function reportEncryptedSpam(params, ctx = {}) {
  const r = asReader(params);
  readInputEncryptedChat(r, 'peer');
  storeOf(ctx);
  return boolTrue();
}

/** messages.uploadEncryptedFile#5057c497 peer:InputEncryptedChat file:InputEncryptedFile = EncryptedFile */
export function uploadEncryptedFile(params, ctx = {}) {
  const r = asReader(params);
  readInputEncryptedChat(r, 'peer');
  const file = readInputEncryptedFile(r, 'file');
  storeOf(ctx);
  return encodeEncryptedFile(file);
}

// ---- local helpers (NOT wire methods: absent from layer 234) ------------
/** Return stored secret messages as updates containing updateNewEncryptedMessage. */
export function getEncryptedHistory(params, ctx = {}) {
  const r = asReader(params);
  const chatId = isReader(r) ? readInt(r, 'chatId') : toNumber(params?.chatId ?? params?.chat_id ?? params?.peer?.chatId);
  const store = storeOf(ctx);
  const state = store.getState(chatId) || { qts: 0, seq: 0 };
  const updates = store.listMessages(chatId).map((m) => encodeUpdateNewEncryptedMessage(
    encodeEncryptedMessage({
      randomId: m.randomId,
      chatId,
      date: m.date,
      data: Buffer.from(String(m.text), 'utf8'),
    }),
    state.qts,
  ));
  return encodeUpdates(updates, { date: state.date, seq: state.seq });
}

/** Alias with an optional max_id filter; same wire shape as getEncryptedHistory. */
export function getEncryptedUpdates(params, ctx = {}) {
  // Layer 234 has no such RPC; this helper simply returns the stored encrypted
  // messages in the same updates container as getEncryptedHistory. Any max_id
  // filtering is left to the caller (see secretUpdateQueue / listMessages).
  return getEncryptedHistory(params, ctx);
}

/** Local updates.difference#b78fca40 carrying stored encrypted messages. */
export function getSecretChatDifferences(params, ctx = {}) {
  const chatId = toNumber(params?.chatId ?? params?.chat_id ?? params?.peer?.chatId);
  const store = storeOf(ctx);
  const state = store.getState(chatId) || { qts: 0, seq: 0, date: now(), unreadCount: 0 };
  const messages = store.listMessages(chatId).map((m) => encodeEncryptedMessage({
    randomId: m.randomId,
    chatId,
    date: m.date,
    data: Buffer.from(String(m.text), 'utf8'),
  }));
  const b = new TLBuffer().putUint(ID.updatesDifference).putUint(0); // flags (topics omitted)
  b.putRaw(emptyVector()); // new_messages
  b.putVector(messages, (m, bb) => bb.putRaw(m));
  b.putRaw(emptyVector()); // other_updates
  b.putRaw(emptyVector()); // chats
  b.putRaw(emptyVector()); // users
  b.putRaw(encodeState({ ...state, pts: 0 }));
  return b.buffer;
}

export { ID as TL_IDS };

export default {
  METHOD_IDS,
  requestEncryption,
  acceptEncryption,
  discardEncryption,
  setEncryptedTyping,
  readEncryptedHistory,
  sendEncrypted,
  sendEncryptedFile,
  sendEncryptedService,
  reportEncryptedSpam,
  uploadEncryptedFile,
  getEncryptedHistory,
  getEncryptedUpdates,
  getSecretChatDifferences,
};
