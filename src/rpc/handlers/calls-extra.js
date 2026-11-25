// Layer-234 group-call handlers plus a signaling handler that really relays
// through CallRelay. Every constructor id below was grep-verified against the
// pinned schema/api.tl (layer 234); the schema line is recorded per entry.
//
// Handlers accept either a TLBuffer positioned after the constructor id (the
// form the Router supplies) or a plain parameter object (unit tests / programmatic
// dispatch), matching the convention used by the other handler modules. Each
// handler returns a TL-serialized Buffer.
//
// NOTE: src/rpc/router.js owns its handler table and is out of scope here, so
// this module exports its handlers and METHOD_IDS for direct dispatch /
// registration rather than mutating the router.
//
// NOTE: media is handled by src/relay/call.js. RTP bytes are forwarded opaquely;
// there is NO SRTP encryption/decryption and no ICE/DTLS negotiation in this
// codebase.

import { TLBuffer } from '../../tl/buffer.js';
import * as C from './codecs.js';
import { isReader, readInputPeer, readInputUser } from './parsers.js';
import { currentUser } from './context.js';

const i32 = (v) => Number(v) | 0;
const now = () => Math.floor(Date.now() / 1000);

/** Verified layer-234 constructor ids (schema/api.tl). */
export const GROUP_ID = Object.freeze({
  boolTrue: 0x997275b5,                     // boolTrue#997275b5 (line 2)
  vector: 0x1cb5c415,                       // vector#1cb5c415 (line 6)
  peerUser: 0x59511722,                     // peerUser#59511722 (line 75)
  peerChat: 0x36c6019a,                     // peerChat#36c6019a (line 76)
  peerChannel: 0xa2a5371e,                  // peerChannel#a2a5371e (line 77)
  user: 0xb1b8cc83,                         // user#b1b8cc83 (line 91)
  inputPeerChat: 0x35a95cb9,                // inputPeerChat#35a95cb9 (line 14)
  inputPeerUser: 0xdde8a54c,                // inputPeerUser#dde8a54c (line 15)
  inputPeerChannel: 0x27bcbbfc,             // inputPeerChannel#27bcbbfc (line 16)
  inputUserSelf: 0xf7c1b13f,                // inputUserSelf#f7c1b13f (line 21)
  inputUser: 0xf21158c6,                    // inputUser#f21158c6 (line 22)
  dataJSON: 0x7d748d04,                     // dataJSON#7d748d04 (line 1007)
  inputPhoneCall: 0x1e36fded,               // inputPhoneCall#1e36fded (line 1057)
  updateGroupCallParticipants: 0xf2ebdb4e,  // updateGroupCallParticipants#f2ebdb4e (line 414)
  updateGroupCall: 0x9d2216e0,              // updateGroupCall#9d2216e0 (line 415)
  updates: 0x74ae4240,                      // updates#74ae4240 (line 518)
  groupCallDiscarded: 0x7780bcb4,           // groupCallDiscarded#7780bcb4 (line 1451)
  groupCall: 0xefb2b617,                    // groupCall#efb2b617 (line 1452)
  inputGroupCall: 0xd8aa840f,               // inputGroupCall#d8aa840f (line 1454)
  inputGroupCallSlug: 0xfe06823f,           // inputGroupCallSlug#fe06823f (line 1455)
  inputGroupCallInviteMessage: 0x8c10603f,  // inputGroupCallInviteMessage#8c10603f (line 1456)
  groupCallParticipant: 0x2a3dc7ac,         // groupCallParticipant#2a3dc7ac (line 1458)
  phoneGroupCall: 0x9e727aad,               // phone.groupCall#9e727aad (line 1460)
  phoneGroupParticipants: 0xf47751b6,       // phone.groupParticipants#f47751b6 (line 1462)
  phoneJoinAsPeers: 0xafe5623f,             // phone.joinAsPeers#afe5623f (line 1492)
});

/** Verified RPC constructor ids (schema/api.tl, layer 234). */
export const METHOD_IDS = Object.freeze({
  'phone.createGroupCall': 0x48cdc6d8,
  'phone.joinGroupCall': 0x8fb53057,
  'phone.leaveGroupCall': 0x500377f9,
  'phone.getGroupCall': 0x41845db,
  'phone.getGroupParticipants': 0xc558d8ab,
  'phone.inviteToGroupCall': 0x7b393160,
  'phone.discardGroupCall': 0x7a777135,
  'phone.toggleGroupCallSettings': 0x974392f2,
  'phone.editGroupCallParticipant': 0xa5273abf,
  'phone.editGroupCallTitle': 0x1ca6ac0a,
  'phone.getGroupCallJoinAs': 0xef7c213a,
  'phone.sendSignalingData': 0xff7a9383,
});

// ---- context / storage --------------------------------------------------

/** The CallRelay attached to the request context, if any. */
export function relayOf(ctx = {}) {
  if (ctx?.callRelay?.relaySignaling) return ctx.callRelay;
  if (ctx?.relay?.relaySignaling) return ctx.relay;
  if (ctx?.server?.callRelay?.relaySignaling) return ctx.server.callRelay;
  return null;
}

function pick(obj, names, fallback) {
  for (const name of names) {
    if (obj && obj[name] !== undefined && obj[name] !== null) return obj[name];
  }
  return fallback;
}

function callKeyOf(value) {
  if (value === undefined || value === null) return '0';
  return typeof value === 'bigint' ? value.toString(10) : String(value);
}

function asBigInt(value, fallback = 0n) {
  if (value === undefined || value === null || value === '') return fallback;
  try {
    return typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    return fallback;
  }
}

function randomLong() {
  const crypto = process.getBuiltinModule?.('node:crypto');
  if (crypto?.randomBytes) return crypto.randomBytes(8).readBigUInt64LE(0) & 0x7fffffffffffffffn;
  return BigInt(Math.floor(Math.random() * 0x7fffffff));
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(String(value ?? ''), 'base64');
}

function peerIdOf(peer, fallback = 0n) {
  if (peer === undefined || peer === null) return fallback;
  if (typeof peer === 'object') {
    return asBigInt(pick(peer, ['id', 'userId', 'user_id', 'chatId', 'channelId', 'peerId'], fallback), fallback);
  }
  return asBigInt(peer, fallback);
}

function peerTypeOf(peer) {
  const type = typeof peer === 'object' ? pick(peer, ['type', 'peerType'], 'user') : 'user';
  if (type === 'chat' || type === 'channel') return String(type);
  return 'user';
}

function currentUserId(ctx = {}) {
  const explicit = pick(ctx, ['userId', 'user_id'], undefined);
  if (explicit !== undefined) return asBigInt(explicit, 0n);
  if (ctx.user?.id) return asBigInt(ctx.user.id, 0n);
  if (ctx.store?.getUser) return asBigInt(currentUser(ctx.store, ctx)?.id, 0n);
  return 0n;
}

// ---- parameter readers (TLBuffer-after-id or plain object) --------------

function readFlags(r, bitKeys = {}) {
  if (isReader(r)) return r.has(4) ? r.uint() >>> 0 : 0;
  const explicit = pick(r, ['flags'], undefined);
  if (explicit !== undefined) return Number(explicit) >>> 0;
  let flags = 0;
  for (const [bit, names] of Object.entries(bitKeys)) {
    if (names.some((name) => r?.[name] !== undefined && r?.[name] !== null && r?.[name] !== false)) {
      flags |= 1 << Number(bit);
    }
  }
  return flags >>> 0;
}

function skipTrue(r, flags, bit) {
  if (isReader(r) && (flags & (1 << bit)) && r.has(4)) r.uint();
}

function readIntParam(r, names, fallback = 0) {
  if (isReader(r)) return r.has(4) ? r.int() : fallback;
  const v = pick(r, names, fallback);
  const n = Number(v);
  return Number.isFinite(n) ? i32(n) : fallback;
}

function readLongParam(r, names, fallback = 0n) {
  if (isReader(r)) return r.has(8) ? r.long() : fallback;
  return asBigInt(pick(r, names, fallback), fallback);
}

function readStringParam(r, names, fallback = '') {
  if (isReader(r)) return r.has(1) ? r.string() : fallback;
  const v = pick(r, names, fallback);
  return v === undefined ? fallback : String(v);
}

function readBytesParam(r, names, fallback = Buffer.alloc(0)) {
  if (isReader(r)) return r.has(1) ? r.bytes() : fallback;
  const v = pick(r, names, undefined);
  return v === undefined ? fallback : asBuffer(v);
}

function readBoolParam(r, names, fallback = false, bit = -1, flags = 0) {
  if (isReader(r)) {
    if (bit >= 0 && !(flags & (1 << bit))) return false;
    return r.has(4) ? r.uint() === GROUP_ID.boolTrue : fallback;
  }
  if (bit >= 0 && !(flags & (1 << bit))) return false;
  return Boolean(pick(r, names, fallback));
}

function readVectorParam(r, key, decode) {
  if (isReader(r)) return r.has(4) ? r.vector(decode) : [];
  const v = pick(r, [key, `${key}s`], undefined);
  return Array.isArray(v) ? v : [];
}

function readPeerParam(r, key) {
  if (isReader(r)) return r.has(4) ? readInputPeer(r, key) : { type: 'user', id: 0 };
  const p = pick(r, [key, 'peer', 'joinAs', 'participant'], {});
  if (typeof p === 'object') return { ...p };
  return { type: 'user', id: p };
}

function readUserParam(r, keys = ['userId']) {
  if (isReader(r)) return r.has(4) ? readInputUser(r, 'userId') : { type: 'user', id: 0 };
  const u = pick(r, [...keys, 'user', 'user_id'], {});
  if (typeof u === 'object') return { ...u };
  return { type: 'user', id: u };
}

function readInputGroupCall(r) {
  if (!isReader(r)) {
    const v = pick(r, ['call', 'groupCall', 'inputGroupCall', 'id'], {});
    if (typeof v === 'object') {
      return {
        id: asBigInt(pick(v, ['id', 'callId'], 0), 0n),
        accessHash: asBigInt(pick(v, ['accessHash', 'access_hash'], 0), 0n),
        slug: v.slug ?? '',
      };
    }
    return { id: asBigInt(v, 0n), accessHash: asBigInt(pick(r, ['accessHash', 'access_hash'], 0), 0n) };
  }
  if (!r.has(4)) return { id: 0n, accessHash: 0n };
  const ctor = r.uint() >>> 0;
  if (ctor === GROUP_ID.inputGroupCall) {
    return {
      id: r.has(8) ? r.long() : 0n,
      accessHash: r.has(8) ? r.long() : 0n,
    };
  }
  if (ctor === GROUP_ID.inputGroupCallSlug) {
    const slug = r.has(1) ? r.string() : '';
    const found = groupCallsBySlug.get(slug);
    return { id: found?.id ?? 0n, accessHash: found?.accessHash ?? 0n, slug };
  }
  if (ctor === GROUP_ID.inputGroupCallInviteMessage) {
    return { id: 0n, accessHash: 0n, msgId: r.has(4) ? r.int() : 0 };
  }
  return { id: 0n, accessHash: 0n, constructor: ctor };
}

function readInputPhoneCall(r) {
  if (!isReader(r)) {
    const v = pick(r, ['peer', 'call', 'id'], {});
    if (typeof v === 'object') {
      return {
        id: asBigInt(pick(v, ['id', 'callId'], 0), 0n),
        accessHash: asBigInt(pick(v, ['accessHash', 'access_hash'], 0), 0n),
      };
    }
    return { id: asBigInt(v, 0n), accessHash: asBigInt(pick(r, ['accessHash', 'access_hash'], 0), 0n) };
  }
  if (!r.has(4)) return { id: 0n, accessHash: 0n };
  const ctor = r.uint() >>> 0;
  if (ctor !== GROUP_ID.inputPhoneCall) return { id: 0n, accessHash: 0n, constructor: ctor };
  return { id: r.has(8) ? r.long() : 0n, accessHash: r.has(8) ? r.long() : 0n };
}

function readDataJSON(r, names, fallback = '{}') {
  if (isReader(r)) {
    if (!r.has(4)) return fallback;
    const ctor = r.uint() >>> 0;
    if (ctor !== GROUP_ID.dataJSON) return fallback;
    return r.has(1) ? r.string() : fallback;
  }
  const v = pick(r, names, fallback);
  if (v && typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return fallback; }
  }
  return v === undefined ? fallback : String(v);
}

// ---- in-memory group-call state ----------------------------------------
// Group calls are a separate concern from the one-to-one CallStore, which is
// owned by another module; state lives on the request context so callers can
// share it between handlers without touching the store.

const groupCallsBySlug = new Map();

class GroupCallStore {
  constructor() {
    this.calls = new Map();
    this.participants = new Map();
  }

  get(id) {
    return this.calls.get(callKeyOf(id)) || null;
  }

  create(record) {
    const call = {
      id: asBigInt(record.id, 0n),
      accessHash: asBigInt(record.accessHash, 0n),
      peer: record.peer || { type: 'user', id: 0 },
      title: String(record.title ?? ''),
      scheduleDate: readIntParam(record, ['scheduleDate', 'schedule_date'], 0),
      muted: Boolean(record.muted),
      messagesEnabled: Boolean(record.messagesEnabled),
      creatorId: asBigInt(record.creatorId, 0n),
      inviteLink: String(record.inviteLink ?? ''),
      discarded: false,
      duration: 0,
      version: 1,
      date: now(),
      ...record,
    };
    call.id = asBigInt(record.id, 0n);
    call.accessHash = asBigInt(record.accessHash, 0n);
    this.calls.set(callKeyOf(call.id), call);
    if (call.inviteLink) groupCallsBySlug.set(call.inviteLink, call);
    return call;
  }

  update(id, patch = {}) {
    const call = this.get(id);
    if (!call) return null;
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) call[key] = value;
    }
    call.version = (call.version || 0) + 1;
    return call;
  }

  _bucket(id) {
    const key = callKeyOf(id);
    let bucket = this.participants.get(key);
    if (!bucket) {
      bucket = new Map();
      this.participants.set(key, bucket);
    }
    return bucket;
  }

  list(id) {
    return [...this._bucket(id).values()];
  }

  join(id, userId, patch = {}) {
    const bucket = this._bucket(id);
    const key = callKeyOf(userId);
    const existing = bucket.get(key);
    const participant = {
      userId: asBigInt(userId, 0n),
      peer: { type: 'user', id: asBigInt(userId, 0n) },
      date: now(),
      muted: false,
      left: false,
      source: 0,
      volume: 0,
      ...(existing || {}),
      ...patch,
      peer: patch.peer || existing?.peer || { type: 'user', id: asBigInt(userId, 0n) },
    };
    bucket.set(key, participant);
    this.update(id, {});
    return participant;
  }

  setParticipant(id, userId, patch = {}) {
    const bucket = this._bucket(id);
    const key = callKeyOf(userId);
    const existing = bucket.get(key);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    bucket.set(key, updated);
    this.update(id, {});
    return updated;
  }

  leave(id, userId) {
    const bucket = this._bucket(id);
    const key = callKeyOf(userId);
    const existing = bucket.get(key);
    if (!existing) return false;
    bucket.set(key, { ...existing, left: true });
    this.update(id, {});
    return true;
  }

  invite(id, users) {
    for (const user of users) {
      const uid = peerIdOf(user, 0n);
      if (uid) this.join(id, uid, { peer: { type: 'user', id: uid } });
    }
  }
}

/** Group-call state attached to the context (not to the shared CallStore). */
export function groupCallsOf(ctx = {}) {
  if (ctx?.groupCallStore) return ctx.groupCallStore;
  if (ctx?._groupCallStore) return ctx._groupCallStore;
  const store = new GroupCallStore();
  if (ctx && typeof ctx === 'object') ctx._groupCallStore = store;
  return store;
}

// ---- local TL encoders --------------------------------------------------

function tlPeer(p = {}) {
  const type = peerTypeOf(p);
  const id = Number(peerIdOf(p, 0n));
  const b = new TLBuffer();
  if (type === 'chat') return b.putUint(GROUP_ID.peerChat).putLong(id).buffer;
  if (type === 'channel') return b.putUint(GROUP_ID.peerChannel).putLong(id).buffer;
  return b.putUint(GROUP_ID.peerUser).putLong(id).buffer;
}

function tlInputGroupCall(ref = {}) {
  return new TLBuffer()
    .putUint(GROUP_ID.inputGroupCall)
    .putLong(asBigInt(ref.id, 0n))
    .putLong(asBigInt(ref.accessHash, 0n))
    .buffer;
}

function tlUsers(ctx, ids = []) {
  if (!ctx?.store?.getUser) return [];
  const unique = [...new Set(ids.map((id) => Number(asBigInt(id, 0n))).filter(Boolean))];
  return unique.map((id) => ctx.store.getUser(id)).filter(Boolean).map((u) => C.user(u));
}

/** groupCall#efb2b617 (or groupCallDiscarded#7780bcb4 when discarded). */
export function tlGroupCall(call = {}) {
  const b = new TLBuffer();
  if (call.discarded) {
    return b.putUint(GROUP_ID.groupCallDiscarded)
      .putLong(asBigInt(call.id, 0n))
      .putLong(asBigInt(call.accessHash, 0n))
      .putInt(i32(call.duration || 0)).buffer;
  }
  const title = String(call.title ?? '');
  const flags = (call.muted ? 1 << 1 : 0)
    | (title ? 1 << 3 : 0)
    | (call.conference ? 1 << 14 : 0)
    | (call.creatorId ? 1 << 15 : 0)
    | (call.inviteLink ? 1 << 16 : 0);
  b.putUint(GROUP_ID.groupCall).putUint(flags);
  // All "true" fields, in declaration order.
  for (const bit of [1, 2, 6, 8, 9, 11, 12, 13, 14, 15, 17, 18, 19]) {
    if (flags & (1 << bit)) b.putUint(GROUP_ID.boolTrue);
  }
  b.putLong(asBigInt(call.id, 0n))
    .putLong(asBigInt(call.accessHash, 0n))
    .putInt(i32(call.participantsCount ?? 0));
  if (flags & (1 << 3)) b.putString(title);
  if (flags & (1 << 4)) b.putInt(i32(call.streamDcId || 0));
  if (flags & (1 << 5)) b.putInt(i32(call.recordStartDate || 0));
  if (flags & (1 << 7)) b.putInt(i32(call.scheduleDate || 0));
  if (flags & (1 << 10)) b.putInt(i32(call.unmutedVideoCount || 0));
  b.putInt(i32(call.unmutedVideoLimit ?? 0)).putInt(i32(call.version || 0));
  if (flags & (1 << 16)) b.putString(call.inviteLink);
  if (flags & (1 << 20)) b.putLong(asBigInt(call.sendPaidMessagesStars, 0n));
  if (flags & (1 << 21)) b.putRaw(tlPeer(call.defaultSendAs || {}));
  return b.buffer;
}

/** groupCallParticipant#2a3dc7ac. No video/presentation objects are emitted. */
export function tlGroupCallParticipant(p = {}) {
  const muted = Boolean(p.muted);
  const left = Boolean(p.left);
  const self = Boolean(p.self);
  const hasVolume = p.volume !== undefined && p.volume !== null && Number(p.volume) !== 0;
  const flags = (muted ? 1 : 0) | (left ? 1 << 1 : 0) | (self ? 1 << 12 : 0) | (hasVolume ? 1 << 7 : 0);
  const b = new TLBuffer().putUint(GROUP_ID.groupCallParticipant).putUint(flags);
  for (const bit of [0, 1, 2, 4, 5, 8, 9, 10, 12, 15]) {
    if (flags & (1 << bit)) b.putUint(GROUP_ID.boolTrue);
  }
  b.putRaw(tlPeer(p.peer || { type: 'user', id: p.userId }))
    .putInt(i32(p.date || 0));
  if (flags & (1 << 3)) b.putInt(i32(p.activeDate || 0));
  b.putInt(i32(p.source || 0));
  if (flags & (1 << 7)) b.putInt(i32(p.volume || 0));
  if (flags & (1 << 11)) b.putString(p.about || '');
  if (flags & (1 << 13)) b.putLong(asBigInt(p.raiseHandRating, 0n));
  if (flags & (1 << 16)) b.putLong(asBigInt(p.paidStarsTotal, 0n));
  return b.buffer;
}

function tlVector(items, encode) {
  return new TLBuffer().putVector(items, encode).buffer;
}

function tlUpdates(list, users = [], chats = [], date = now(), seq = 0) {
  return new TLBuffer()
    .putUint(GROUP_ID.updates)
    .putVector(list, (item, b) => b.putRaw(item))
    .putVector(users, (u, b) => b.putRaw(Buffer.isBuffer(u) ? u : C.user(u)))
    .putVector(chats, (chat, b) => b.putRaw(Buffer.isBuffer(chat) ? chat : tlPeer(chat)))
    .putInt(i32(date)).putInt(i32(seq)).buffer;
}

function tlUpdateGroupCall(call, ctx) {
  const flags = call.peer ? 1 << 1 : 0;
  const b = new TLBuffer().putUint(GROUP_ID.updateGroupCall).putUint(flags);
  if (flags & (1 << 1)) b.putRaw(tlPeer(call.peer));
  b.putRaw(tlGroupCall(call));
  void ctx;
  return b.buffer;
}

function tlUpdateGroupCallParticipants(call, participants) {
  return new TLBuffer()
    .putUint(GROUP_ID.updateGroupCallParticipants)
    .putRaw(tlInputGroupCall(call))
    .putVector(participants, (p, b) => b.putRaw(tlGroupCallParticipant(p)))
    .putInt(i32(call.version || 0)).buffer;
}

function groupCallUpdates(call, ctx, participants = []) {
  if (!call) return tlUpdates([], [], [], now(), 0);
  const users = tlUsers(ctx, [
    ...participants.map((p) => p.userId),
    call.creatorId,
  ]);
  return tlUpdates([tlUpdateGroupCall(call, ctx)], users, []);
}

function participantsUpdates(call, ctx) {
  if (!call) return tlUpdates([], [], [], now(), 0);
  const participants = groupCallsOf(ctx).list(call.id);
  const users = tlUsers(ctx, participants.map((p) => p.userId));
  return tlUpdates([tlUpdateGroupCallParticipants(call, participants)], users, []);
}

/** phone.groupCall#9e727aad (the declared result of phone.getGroupCall). */
export function tlPhoneGroupCall(call, participants = [], ctx = {}) {
  const b = new TLBuffer()
    .putUint(GROUP_ID.phoneGroupCall)
    .putRaw(tlGroupCall(call || {}))
    .putVector(participants, (p, bb) => bb.putRaw(tlGroupCallParticipant(p)))
    .putString('')
    .putVector([], (_, bb) => bb)
    .putVector(tlUsers(ctx, [
      ...participants.map((p) => p.userId),
      call?.creatorId,
    ]), (u, bb) => bb.putRaw(u));
  return b.buffer;
}

/** phone.groupParticipants#f47751b6. */
export function tlPhoneGroupParticipants(call, participants = [], ctx = {}) {
  return new TLBuffer()
    .putUint(GROUP_ID.phoneGroupParticipants)
    .putInt(i32(participants.length))
    .putVector(participants, (p, b) => b.putRaw(tlGroupCallParticipant(p)))
    .putString('')
    .putVector([], (_, b) => b)
    .putVector(tlUsers(ctx, participants.map((p) => p.userId)), (u, b) => b.putRaw(u))
    .putInt(i32(call?.version || 0)).buffer;
}

/** phone.joinAsPeers#afe5623f. */
export function tlPhoneJoinAsPeers(peer, ctx = {}) {
  const me = currentUserId(ctx);
  const type = peerTypeOf(peer);
  const id = peerIdOf(peer, me);
  const peers = [tlPeer(type === 'user' ? { type: 'user', id: me || id } : { type, id })];
  return new TLBuffer()
    .putUint(GROUP_ID.phoneJoinAsPeers)
    .putVector(peers, (p, b) => b.putRaw(p))
    .putVector([], (_, b) => b)
    .putVector(tlUsers(ctx, [me || id]), (u, b) => b.putRaw(u)).buffer;
}

// ---- RPC handlers -------------------------------------------------------

/** phone.createGroupCall#48cdc6d8 -> Updates. */
export function createGroupCall(params = {}, ctx = {}) {
  const flags = readFlags(params, { 2: ['rtmpStream', 'rtmp_stream'] });
  skipTrue(params, flags, 2); // rtmp_stream
  const peer = readPeerParam(params, 'peer');
  const randomId = readIntParam(params, ['randomId', 'random_id'], 0);
  const title = isReader(params)
    ? ((flags & 1) && params.has(1) ? params.string() : '')
    : readStringParam(params, ['title'], '');
  const scheduleDate = isReader(params)
    ? ((flags & 2) && params.has(4) ? params.int() : 0)
    : readIntParam(params, ['scheduleDate', 'schedule_date'], 0);
  const explicitId = isReader(params) ? undefined : pick(params, ['id', 'callId'], undefined);
  const id = explicitId !== undefined
    ? asBigInt(explicitId, 0n)
    : (BigInt(Math.abs(randomId)) || randomLong());
  const call = groupCallsOf(ctx).create({
    id,
    accessHash: isReader(params) ? randomLong() : (pick(params, ['accessHash'], undefined) ?? randomLong()),
    peer,
    title,
    scheduleDate,
    creatorId: currentUserId(ctx),
  });
  return groupCallUpdates(call, ctx);
}

/** phone.joinGroupCall#8fb53057 -> Updates. */
export function joinGroupCall(params = {}, ctx = {}) {
  const flags = readFlags(params, {
    0: ['muted'], 1: ['inviteHash', 'invite_hash'],
    2: ['videoStopped', 'video_stopped'], 3: ['publicKey', 'block'],
  });
  skipTrue(params, flags, 0); // muted
  skipTrue(params, flags, 2); // video_stopped
  const ref = readInputGroupCall(params);
  const joinAs = readPeerParam(params, 'joinAs');
  if (isReader(params) && (flags & (1 << 1)) && params.has(1)) params.string(); // invite_hash
  if (isReader(params) && (flags & (1 << 3))) {
    if (params.has(16)) params.int256(); // public_key
    if (params.has(1)) params.bytes(); // block
  }
  readDataJSON(params, ['params']); // opaque signaling params
  const store = groupCallsOf(ctx);
  const call = store.get(ref.id);
  if (call) {
    const uid = peerIdOf(joinAs, currentUserId(ctx));
    store.join(call.id, uid, {
      peer: { type: peerTypeOf(joinAs), id: uid },
      muted: Boolean(flags & 1),
      self: Boolean(uid && uid === currentUserId(ctx)),
    });
  }
  return participantsUpdates(call, ctx);
}

/** phone.leaveGroupCall#500377f9 -> Updates. */
export function leaveGroupCall(params = {}, ctx = {}) {
  const ref = readInputGroupCall(params);
  const source = readIntParam(params, ['source'], 0);
  const store = groupCallsOf(ctx);
  const call = store.get(ref.id);
  if (call) {
    const uid = isReader(params) ? currentUserId(ctx) : peerIdOf(pick(params, ['userId', 'user'], currentUserId(ctx)), currentUserId(ctx));
    store.leave(call.id, uid);
  }
  void source;
  return participantsUpdates(call, ctx);
}

/** phone.getGroupCall#41845db -> phone.GroupCall (phone.groupCall#9e727aad). */
export function getGroupCall(params = {}, ctx = {}) {
  const ref = readInputGroupCall(params);
  readIntParam(params, ['limit'], 0);
  const call = groupCallsOf(ctx).get(ref.id);
  if (!call) return tlPhoneGroupCall({ id: ref.id, accessHash: ref.accessHash }, [], ctx);
  const participants = groupCallsOf(ctx).list(call.id);
  return tlPhoneGroupCall(call, participants, ctx);
}

/** phone.getGroupParticipants#c558d8ab -> phone.GroupParticipants. */
export function getGroupParticipants(params = {}, ctx = {}) {
  const ref = readInputGroupCall(params);
  const ids = readVectorParam(params, 'ids', (r) => (r.has(4) ? readInputPeer(r, 'id') : { type: 'user', id: 0 }));
  readVectorParam(params, 'sources', (r) => r.int());
  readStringParam(params, ['offset'], '');
  readIntParam(params, ['limit'], 0);
  const store = groupCallsOf(ctx);
  const call = store.get(ref.id);
  let participants = call ? store.list(call.id) : [];
  if (ids.length) {
    const wanted = new Set(ids.map((id) => callKeyOf(peerIdOf(id, 0n))));
    participants = participants.filter((p) => wanted.has(callKeyOf(p.userId)));
  }
  return tlPhoneGroupParticipants(call, participants, ctx);
}

/** phone.inviteToGroupCall#7b393160 -> Updates. */
export function inviteToGroupCall(params = {}, ctx = {}) {
  const ref = readInputGroupCall(params);
  const users = readVectorParam(params, 'users', (r) => (r.has(4) ? readInputUser(r, 'users') : { type: 'user', id: 0 }));
  const store = groupCallsOf(ctx);
  const call = store.get(ref.id);
  if (call) store.invite(call.id, users);
  return participantsUpdates(call, ctx);
}

/** phone.discardGroupCall#7a777135 -> Updates. */
export function discardGroupCall(params = {}, ctx = {}) {
  const ref = readInputGroupCall(params);
  const store = groupCallsOf(ctx);
  const call = store.get(ref.id);
  if (call) {
    store.update(call.id, { discarded: true, duration: now() - call.date });
    call.discarded = true;
    call.duration = Math.max(0, now() - call.date);
  }
  return groupCallUpdates(call, ctx);
}

/** phone.toggleGroupCallSettings#974392f2 -> Updates. */
export function toggleGroupCallSettings(params = {}, ctx = {}) {
  const flags = readFlags(params, {
    1: ['resetInviteHash', 'reset_invite_hash'],
    0: ['joinMuted', 'join_muted'],
    2: ['messagesEnabled', 'messages_enabled'],
    3: ['sendPaidMessagesStars'],
  });
  skipTrue(params, flags, 1); // reset_invite_hash
  const ref = readInputGroupCall(params);
  const joinMuted = readBoolParam(params, ['joinMuted', 'join_muted'], false, 0, flags);
  const messagesEnabled = readBoolParam(params, ['messagesEnabled', 'messages_enabled'], false, 2, flags);
  const sendPaidMessagesStars = (flags & (1 << 3))
    ? readLongParam(params, ['sendPaidMessagesStars'], 0n)
    : undefined;
  const store = groupCallsOf(ctx);
  const call = store.get(ref.id);
  if (call) {
    store.update(call.id, {
      muted: joinMuted,
      messagesEnabled,
      ...(sendPaidMessagesStars !== undefined ? { sendPaidMessagesStars } : {}),
    });
    call.muted = joinMuted;
    call.messagesEnabled = messagesEnabled;
    if (sendPaidMessagesStars !== undefined) call.sendPaidMessagesStars = sendPaidMessagesStars;
  }
  return groupCallUpdates(call, ctx);
}

/** phone.editGroupCallParticipant#a5273abf -> Updates. */
export function editGroupCallParticipant(params = {}, ctx = {}) {
  const flags = readFlags(params, {
    0: ['muted'], 1: ['volume'], 2: ['raiseHand', 'raise_hand'],
    3: ['videoStopped'], 4: ['videoPaused'], 5: ['presentationPaused'],
  });
  const ref = readInputGroupCall(params);
  const participant = readPeerParam(params, 'participant');
  const patch = {};
  if (flags & (1 << 0)) patch.muted = readBoolParam(params, ['muted'], false, 0, flags);
  if (flags & (1 << 1)) patch.volume = readIntParam(params, ['volume'], 0);
  if (flags & (1 << 2)) patch.raiseHand = readBoolParam(params, ['raiseHand', 'raise_hand'], false, 2, flags);
  if (flags & (1 << 3)) patch.videoStopped = readBoolParam(params, ['videoStopped'], false, 3, flags);
  if (flags & (1 << 4)) patch.videoPaused = readBoolParam(params, ['videoPaused'], false, 4, flags);
  if (flags & (1 << 5)) patch.presentationPaused = readBoolParam(params, ['presentationPaused'], false, 5, flags);
  const store = groupCallsOf(ctx);
  const call = store.get(ref.id);
  if (call) store.setParticipant(call.id, peerIdOf(participant, 0n), patch);
  return participantsUpdates(call, ctx);
}

/** phone.editGroupCallTitle#1ca6ac0a -> Updates. */
export function editGroupCallTitle(params = {}, ctx = {}) {
  const ref = readInputGroupCall(params);
  const title = readStringParam(params, ['title'], '');
  const store = groupCallsOf(ctx);
  const call = store.get(ref.id);
  if (call) {
    store.update(call.id, { title });
    call.title = title;
  }
  return groupCallUpdates(call, ctx);
}

/** phone.getGroupCallJoinAs#ef7c213a -> phone.JoinAsPeers. */
export function getGroupCallJoinAs(params = {}, ctx = {}) {
  const peer = readPeerParam(params, 'peer');
  return tlPhoneJoinAsPeers(peer, ctx);
}

/**
 * phone.sendSignalingData#ff7a9383 -> Bool (boolTrue). Unlike the legacy
 * handler in calls.js, this variant fans the opaque blob out through the
 * CallRelay found on the context (ctx.callRelay).
 */
export function sendSignalingData(params = {}, ctx = {}) {
  const peer = readInputPhoneCall(params);
  const data = readBytesParam(params, ['data']);
  const relay = relayOf(ctx);
  if (relay && typeof relay.relaySignaling === 'function') {
    try {
      relay.relaySignaling(peer.id, currentUserId(ctx), data);
    } catch {
      // Delivery is best-effort; RPCs still acknowledge the request.
    }
  }
  return new TLBuffer().putUint(GROUP_ID.boolTrue).buffer;
}

export default {
  GROUP_ID,
  METHOD_IDS,
  relayOf,
  createGroupCall,
  joinGroupCall,
  leaveGroupCall,
  getGroupCall,
  getGroupParticipants,
  inviteToGroupCall,
  discardGroupCall,
  toggleGroupCallSettings,
  editGroupCallParticipant,
  editGroupCallTitle,
  getGroupCallJoinAs,
  sendSignalingData,
};
