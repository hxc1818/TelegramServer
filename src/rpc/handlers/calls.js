// Layer-234 phone-call *signaling* handlers. Every constructor id below was
// grep-verified against the pinned schema/api.tl (layer 234); none are guessed.
//
// Handlers accept either a TLBuffer positioned after the constructor id (the
// form the Router supplies) or a plain parameter object (unit tests / programmatic
// dispatch), matching the convention used by the other handler modules. Each
// handler returns a TL-serialized Buffer.
//
// IMPORTANT LIMITATION: no real RTP/media relay is implemented here. Calls are
// signaling state in CallStore only. There is no ICE/STUN/TURN negotiation, no
// SRTP key exchange, no media packets and no conference/group-call support.
// phone.sendSignalingData and phone.saveCallLog acknowledge requests but do not
// deliver data to the remote peer or store uploaded logs.
//
// Schema notes (verified, layer 234):
//   * phone.getCallConfig#55451fa9 returns DataJSON (dataJSON#7d748d04).
//     There is no `phone.CallConfig` type in this layer.
//   * phone.confirmCall#2efe1722 returns phone.PhoneCall, not boolTrue.
//   * There is no phone.declineCall / phone.getCalls / phone.checkCall /
//     phone.sendCallData / phone.receivedCallData / phone.uploadCallLog in the
//     layer-234 schema. The real RPCs are phone.receivedCall#17d54f61,
//     phone.sendSignalingData#ff7a9383 and phone.saveCallLog#41248786.
//     Compatibility aliases with those task names are exported below but have
//     no entry in METHOD_IDS because they have no verifiable layer-234 id.
//   * There is no phone.calls type either; the getCalls alias returns a plain
//     Vector<PhoneCall> built from the verified vector constructor id.

import { TLBuffer } from '../../tl/buffer.js';
import * as C from './codecs.js';
import { isReader, readInputUser } from './parsers.js';
import { currentUser } from './context.js';
import { CallStore } from '../../store/calls.js';

const i32 = (v) => Number(v) | 0;
const now = () => Math.floor(Date.now() / 1000);

/** Verified layer-234 constructor ids. */
export const CALL_ID = Object.freeze({
  boolTrue: 0x997275b5,                            // boolTrue#997275b5
  boolFalse: 0xbc799737,                           // boolFalse#bc799737
  vector: 0x1cb5c415,                              // vector#1cb5c415
  dataJSON: 0x7d748d04,                            // dataJSON#7d748d04
  inputUser: 0xf21158c6,                           // inputUser#f21158c6
  inputUserSelf: 0xf7c1b13f,                       // inputUserSelf#f7c1b13f
  inputUserEmpty: 0xb98886cf,                      // inputUserEmpty#b98886cf
  inputPhoneCall: 0x1e36fded,                      // inputPhoneCall#1e36fded
  phoneCallEmpty: 0x5366c915,                      // phoneCallEmpty#5366c915
  phoneCallWaiting: 0xc5226f17,                    // phoneCallWaiting#c5226f17
  phoneCallRequested: 0x14b0ed0c,                  // phoneCallRequested#14b0ed0c
  phoneCallAccepted: 0x3660c311,                   // phoneCallAccepted#3660c311
  phoneCall: 0x30535af5,                           // phoneCall#30535af5
  phoneCallDiscarded: 0x50ca4de1,                  // phoneCallDiscarded#50ca4de1
  phoneCallProtocol: 0xfc878fc8,                   // phoneCallProtocol#fc878fc8
  phonePhoneCall: 0xec82e140,                      // phone.phoneCall#ec82e140
  updatePhoneCall: 0xab0f6b1e,                     // updatePhoneCall#ab0f6b1e
  updates: 0x74ae4240,                             // updates#74ae4240
  discardMissed: 0x85e42301,                       // phoneCallDiscardReasonMissed
  discardDisconnect: 0xe095c1a0,                   // phoneCallDiscardReasonDisconnect
  discardHangup: 0x57adc690,                       // phoneCallDiscardReasonHangup
  discardBusy: 0xfaf7e8c9,                         // phoneCallDiscardReasonBusy
  discardMigrate: 0x9fbbf1f7,                      // phoneCallDiscardReasonMigrateConferenceCall
});

/** The exact result constructor of phone.getCallConfig in layer 234. */
export const CALL_CONFIG_TYPE_ID = CALL_ID.dataJSON;

/** Verified RPC constructor ids (schema/api.tl, layer 234). */
export const METHOD_IDS = Object.freeze({
  'phone.getCallConfig': 0x55451fa9,
  'phone.requestCall': 0x42ff96ed,
  'phone.acceptCall': 0x3bd2b4a0,
  'phone.confirmCall': 0x2efe1722,
  'phone.receivedCall': 0x17d54f61,
  'phone.discardCall': 0xb2cbc1c0,
  'phone.setCallRating': 0x59ead627,
  'phone.saveCallDebug': 0x277add7e,
  'phone.sendSignalingData': 0xff7a9383,
  'phone.saveCallLog': 0x41248786,
});

const REASON_BY_ID = Object.freeze({
  [CALL_ID.discardMissed]: 'missed',
  [CALL_ID.discardDisconnect]: 'disconnect',
  [CALL_ID.discardHangup]: 'hangup',
  [CALL_ID.discardBusy]: 'busy',
  [CALL_ID.discardMigrate]: 'migrate',
});
const REASON_ID_BY_NAME = Object.freeze(Object.fromEntries(
  Object.entries(REASON_BY_ID).map(([id, name]) => [name, Number(id)]),
));

// ---- storage / parameter helpers ---------------------------------------
export function callsOf(ctx = {}) {
  if (ctx.callStore) return ctx.callStore;
  if (ctx.calls) return ctx.calls;
  if (!ctx._callStore) ctx._callStore = new CallStore(ctx.store?.dataDir || './data');
  return ctx._callStore;
}

function randomLong() {
  const crypto = process.getBuiltinModule?.('node:crypto');
  if (crypto?.randomBytes) return crypto.randomBytes(8).readBigUInt64LE(0) & 0x7fffffffffffffffn;
  return BigInt(Math.floor(Math.random() * 0x7fffffff));
}

function b64(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return String(value ?? '');
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(String(value ?? ''), 'base64');
}

function readFlags(r, obj, flagKeys = {}) {
  if (isReader(r)) return r.has(4) ? r.uint() : 0;
  let flags = 0;
  for (const [bit, names] of Object.entries(flagKeys)) {
    if (names.some((name) => Boolean(obj?.[name]))) flags |= 1 << Number(bit);
  }
  return flags;
}

function skipFlagBool(r, flags, bit) {
  if (isReader(r) && (flags & (1 << bit)) && r.has(4)) r.uint(); // boxed true
}

function pick(obj, names, fallback) {
  for (const name of names) {
    if (obj && obj[name] !== undefined && obj[name] !== null) return obj[name];
  }
  return fallback;
}

function readInt(r, names, fallback = 0) {
  if (isReader(r)) return r.has(4) ? r.int() : fallback;
  const v = pick(r, names, fallback);
  return i32(v);
}

function readLong(r, names, fallback = 0n) {
  if (isReader(r)) return r.has(8) ? r.long() : fallback;
  const v = pick(r, names, fallback);
  return v === undefined || v === null ? fallback : BigInt(v);
}

function readBytes(r, names, fallback = Buffer.alloc(0)) {
  if (isReader(r)) return r.has(1) ? r.bytes() : fallback;
  const v = pick(r, names, undefined);
  return v === undefined ? fallback : asBuffer(v);
}

function readString(r, names, fallback = '') {
  if (isReader(r)) return r.has(1) ? r.string() : fallback;
  const v = pick(r, names, fallback);
  return v === undefined || v === null ? fallback : String(v);
}

function readPhoneCallPeer(r, key) {
  if (!isReader(r)) {
    const p = pick(r, [key, 'peer', 'id'], {});
    if (typeof p === 'object') {
      return { id: BigInt(pick(p, ['id', 'callId'], 0)), accessHash: BigInt(pick(p, ['accessHash', 'access_hash'], 0)) };
    }
    return { id: BigInt(p), accessHash: BigInt(pick(r, ['accessHash', 'access_hash'], 0)) };
  }
  if (!r.has(4)) return { id: 0n, accessHash: 0n };
  const ctor = r.uint();
  if (ctor !== CALL_ID.inputPhoneCall) return { id: 0n, accessHash: 0n, constructor: ctor >>> 0 };
  return {
    id: r.has(8) ? r.long() : 0n,
    accessHash: r.has(8) ? r.long() : 0n,
  };
}

/** Consume a PhoneCallProtocol when reading a wire request; ignore it when absent. */
function readProtocol(r, fallback = {}) {
  if (!isReader(r) || !r.has(4)) return fallback;
  const ctor = r.uint();
  if (ctor !== CALL_ID.phoneCallProtocol) return fallback;
  const flags = r.has(4) ? r.uint() : 0;
  const minLayer = r.has(4) ? r.int() : 0;
  const maxLayer = r.has(4) ? r.int() : 0;
  let libraryVersions = [];
  if (r.has(4)) {
    try { libraryVersions = r.vector((rr) => rr.string()); } catch { /* truncated */ }
  }
  return { udpP2p: Boolean(flags & 1), udpReflector: Boolean(flags & 2), minLayer, maxLayer, libraryVersions };
}

function readDataJSON(r, names, fallback = '{}') {
  if (isReader(r)) {
    if (!r.has(4)) return fallback;
    const ctor = r.uint();
    if (ctor !== CALL_ID.dataJSON) return fallback;
    return r.has(1) ? r.string() : fallback;
  }
  const v = pick(r, names, fallback);
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return fallback; }
  }
  return v === undefined ? fallback : String(v);
}

function readReason(r, name = 'reason') {
  if (isReader(r)) {
    if (!r.has(4)) return 'hangup';
    const ctor = r.uint() >>> 0;
    return REASON_BY_ID[ctor] || 'hangup';
  }
  const v = pick(r, [name, 'reasonId'], 'hangup');
  if (typeof v === 'number' || typeof v === 'bigint') return REASON_BY_ID[Number(v)] || 'hangup';
  return String(v || 'hangup');
}

function callFor(ctx, peer, { create = false } = {}) {
  const store = callsOf(ctx);
  let call = store.getCall(peer.id);
  if (call) return call;
  if (!create) return store.createCall({
    id: peer.id,
    accessHash: peer.accessHash || randomLong(),
    callerId: 0,
    calleeId: 0,
    date: now(),
    status: 'empty',
  });
  return store.createCall({
    id: peer.id,
    accessHash: peer.accessHash || randomLong(),
    callerId: currentUser(ctx.store, ctx)?.id || ctx.userId || 0,
    calleeId: 0,
    date: now(),
  });
}

// ---- local TL encoders -------------------------------------------------
function tlPhoneCallProtocol(p = {}) {
  const flags = (p.udpP2p ? 1 : 0) | (p.udpReflector ? 2 : 0);
  const versions = Array.isArray(p.libraryVersions) ? p.libraryVersions : [];
  return new TLBuffer()
    .putUint(CALL_ID.phoneCallProtocol)
    .putUint(flags)
    .putInt(i32(p.minLayer ?? 65))
    .putInt(i32(p.maxLayer ?? 234))
    .putVector(versions, (v, b) => b.putString(v))
    .buffer;
}

/** Encode one of the seven PhoneCall constructors based on signaling status. */
export function tlPhoneCall(call = {}, ctx = {}) {
  const id = BigInt(call.id ?? 0);
  const accessHash = BigInt(call.accessHash ?? 0);
  const date = i32(call.date || 0);
  const adminId = BigInt(call.callerId ?? 0);
  const participantId = BigInt(call.calleeId ?? 0);
  const video = Boolean(call.video);
  const status = String(call.status || 'requested');
  const videoBit = video ? 1 << 6 : 0;
  const b = new TLBuffer();

  if (status === 'requested') {
    return b.putUint(CALL_ID.phoneCallRequested).putUint(videoBit)
      .putLong(id).putLong(accessHash).putInt(date).putLong(adminId).putLong(participantId)
      .putBytes(asBuffer(call.gAHash)).putRaw(tlPhoneCallProtocol(call.protocol)).buffer;
  }
  if (status === 'accepted') {
    return b.putUint(CALL_ID.phoneCallAccepted).putUint(videoBit)
      .putLong(id).putLong(accessHash).putInt(date).putLong(adminId).putLong(participantId)
      .putBytes(asBuffer(call.gB)).putRaw(tlPhoneCallProtocol(call.protocol)).buffer;
  }
  if (status === 'waiting' || status === 'received') {
    const hasReceiveDate = Boolean(call.acceptedDate);
    const flags = videoBit | (hasReceiveDate ? 1 : 0);
    b.putUint(CALL_ID.phoneCallWaiting).putUint(flags)
      .putLong(id).putLong(accessHash).putInt(date).putLong(adminId).putLong(participantId)
      .putRaw(tlPhoneCallProtocol(call.protocol));
    if (hasReceiveDate) b.putInt(i32(call.acceptedDate));
    return b.buffer;
  }
  if (status === 'active' || status === 'talking' || status === 'connected') {
    const flags = (1 << 5) | videoBit | (1 << 8); // p2p_allowed, video, conference_supported
    return b.putUint(CALL_ID.phoneCall).putUint(flags)
      .putLong(id).putLong(accessHash).putInt(date).putLong(adminId).putLong(participantId)
      .putBytes(asBuffer(call.gA || call.gB)).putLong(BigInt(call.keyFingerprint ?? 0))
      .putRaw(tlPhoneCallProtocol(call.protocol))
      .putVector([], (_, bb) => bb) // connections: no relay endpoints are ever created
      .putInt(i32(call.acceptedDate || 0)).buffer;
  }
  if (status === 'discarded' || status === 'declined') {
    const reason = String(call.reason || 'hangup');
    const reasonId = REASON_ID_BY_NAME[reason] ?? CALL_ID.discardHangup;
    const hasDuration = Boolean(call.duration);
    // bits: 0 = reason present, 1 = duration present, 2 = need_rating, 6 = video
    const flags = 1 | (1 << 2) | videoBit | (hasDuration ? 1 << 1 : 0);
    b.putUint(CALL_ID.phoneCallDiscarded).putUint(flags)
      .putLong(id)
      .putUint(reasonId);
    if (hasDuration) b.putInt(i32(call.duration));
    return b.buffer;
  }
  return b.putUint(CALL_ID.phoneCallEmpty).putLong(id).buffer;
}

function tlUsers(call = {}, ctx = {}) {
  const store = ctx.store;
  if (!store?.getUser) return [];
  const ids = new Set([call.callerId, call.calleeId].map((v) => Number(v)).filter(Boolean));
  return [...ids].map((id) => store.getUser(id)).filter(Boolean).map((u) => C.user(u));
}

/** phone.PhoneCall#ec82e140 wrapper. */
export function tlPhonePhoneCall(call = {}, ctx = {}) {
  return new TLBuffer()
    .putUint(CALL_ID.phonePhoneCall)
    .putRaw(tlPhoneCall(call, ctx))
    .putVector(tlUsers(call, ctx), (u, b) => b.putRaw(u))
    .buffer;
}

/** updates#74ae4240 carrying an updatePhoneCall for the signaling state. */
function tlCallUpdates(call = {}, ctx = {}) {
  const update = new TLBuffer().putUint(CALL_ID.updatePhoneCall).putRaw(tlPhoneCall(call, ctx)).buffer;
  return new TLBuffer()
    .putUint(CALL_ID.updates)
    .putVector([update], (u, b) => b.putRaw(u))
    .putVector(tlUsers(call, ctx), (u, b) => b.putRaw(u))
    .putVector([], (_, b) => b)
    .putInt(i32(call.endDate || call.date || now()))
    .putInt(0)
    .buffer;
}

function tlVector(rawItems) {
  return new TLBuffer().putVector(rawItems, (item, b) => b.putRaw(item)).buffer;
}

// ---- RPC handlers ------------------------------------------------------

/** phone.getCallConfig#55451fa9 -> DataJSON#7d748d04 (NOT phone.CallConfig). */
export function getCallConfig() {
  // A minimal static config. The "no relay" flags make the media limitation
  // explicit to any client inspecting the result.
  const config = JSON.stringify({
    connections: [],
    encryption: [],
    signaling_only: true,
    media_relay: false,
  });
  return new TLBuffer().putUint(CALL_ID.dataJSON).putString(config).buffer;
}

/** phone.requestCall#42ff96ed -> phone.PhoneCall (phoneCallRequested). */
export function requestCall(params, ctx = {}) {
  const flags = readFlags(params, params, { 0: ['video'] });
  skipFlagBool(params, flags, 0);
  const inputUser = readInputUser(params, 'userId');
  const calleeId = Number(inputUser.id ?? pick(params, ['userId', 'user_id', 'calleeId'], 0)) || 0;
  const randomId = readInt(params, ['randomId', 'random_id'], 0);
  const gAHash = readBytes(params, ['gAHash', 'g_a_hash']);
  const protocol = readProtocol(params);
  const callerId = Number(currentUser(ctx.store, ctx)?.id || ctx.userId || 0);
  const id = pick(params, ['id'], undefined) ?? (randomId ? BigInt(Math.abs(randomId)) : randomLong());
  const store = callsOf(ctx);
  let call = store.createCall({
    id,
    accessHash: pick(params, ['accessHash'], undefined) ?? randomLong(),
    callerId,
    calleeId,
    video: Boolean(flags & 1),
    date: pick(params, ['date'], undefined) ?? now(),
  });
  // CallStore.createCall intentionally takes only the core fields; signaling
  // blobs and protocol settings are attached immediately afterwards.
  call = store.updateCall(call.id, { gAHash: b64(gAHash), protocol: JSON.stringify(protocol) }) || call;
  return tlPhonePhoneCall(call, ctx);
}

/** phone.acceptCall#3bd2b4a0 -> phone.PhoneCall (phoneCallAccepted). */
export function acceptCall(params, ctx = {}) {
  const peer = readPhoneCallPeer(params, 'peer');
  const gB = readBytes(params, ['gB', 'g_b']);
  const protocol = readProtocol(params);
  const store = callsOf(ctx);
  let call = callFor(ctx, peer);
  call = store.updateCall(peer.id, {
    status: 'accepted',
    acceptedDate: now(),
    gB: b64(gB),
    protocol: JSON.stringify(protocol),
  }) || call;
  return tlPhonePhoneCall(call, ctx);
}

/** phone.confirmCall#2efe1722 -> phone.PhoneCall (phoneCall). */
export function confirmCall(params, ctx = {}) {
  const peer = readPhoneCallPeer(params, 'peer');
  const gA = readBytes(params, ['gA', 'g_a']);
  const keyFingerprint = readLong(params, ['keyFingerprint', 'key_fingerprint'], 0n);
  const protocol = readProtocol(params);
  const store = callsOf(ctx);
  let call = callFor(ctx, peer);
  call = store.updateCall(peer.id, {
    status: 'active',
    gA: b64(gA),
    keyFingerprint: String(keyFingerprint),
    protocol: JSON.stringify(protocol),
  }) || call;
  return tlPhonePhoneCall(call, ctx);
}

/** phone.receivedCall#17d54f61 -> Bool (boolTrue). */
export function receivedCall(params, ctx = {}) {
  const peer = readPhoneCallPeer(params, 'peer');
  let call = callFor(ctx, peer);
  call = callsOf(ctx).updateCall(peer.id, { status: 'waiting', acceptedDate: now() }) || call;
  return new TLBuffer().putUint(CALL_ID.boolTrue).buffer;
}

/** phone.discardCall#b2cbc1c0 -> Updates. */
export function discardCall(params, ctx = {}) {
  const flags = readFlags(params, params, { 0: ['video'] });
  skipFlagBool(params, flags, 0);
  const peer = readPhoneCallPeer(params, 'peer');
  const duration = readInt(params, ['duration'], 0);
  const reason = readReason(params, 'reason');
  if (isReader(params) && params.has(8)) params.long(); // connection_id
  const store = callsOf(ctx);
  let call = callFor(ctx, peer);
  call = store.discardCall(peer.id, { reason, duration, video: Boolean(flags & 1) }) || call;
  return tlCallUpdates(call, ctx);
}

/** phone.setCallRating#59ead627 -> Updates. */
export function setCallRating(params, ctx = {}) {
  const flags = readFlags(params, params, { 0: ['userInitiative', 'user_initiative'] });
  skipFlagBool(params, flags, 0);
  const peer = readPhoneCallPeer(params, 'peer');
  const rating = readInt(params, ['rating'], 0);
  readString(params, ['comment']); // consumed but not persisted (no schema field)
  const store = callsOf(ctx);
  let call = callFor(ctx, peer);
  call = store.setRating(peer.id, rating) || call;
  return tlCallUpdates(call, ctx);
}

/** phone.saveCallDebug#277add7e -> Bool (boolTrue). */
export function saveCallDebug(params, ctx = {}) {
  readPhoneCallPeer(params, 'peer');
  readDataJSON(params, ['debug']); // consumed; no debug transport is implemented
  return new TLBuffer().putUint(CALL_ID.boolTrue).buffer;
}

/** phone.sendSignalingData#ff7a9383 -> Bool (boolTrue), but no peer delivery. */
export function sendSignalingData(params, ctx = {}) {
  const peer = readPhoneCallPeer(params, 'peer');
  const data = readBytes(params, ['data']);
  // Signaling blobs are acknowledged only. They are deliberately not routed to
  // the callee: there is no real signaling transport or media relay here.
  void peer; void data; void ctx;
  return new TLBuffer().putUint(CALL_ID.boolTrue).buffer;
}

/** phone.saveCallLog#41248786 -> Bool (boolTrue); the InputFile is ignored. */
export function saveCallLog(params, ctx = {}) {
  readPhoneCallPeer(params, 'peer');
  if (isReader(params) && params.has(4)) params.uint(); // inputFile constructor
  void ctx;
  return new TLBuffer().putUint(CALL_ID.boolTrue).buffer;
}

// ---- compatibility aliases (NOT layer-234 RPCs) -----------------------
// Exported for callers using older naming. They have no verified method id in
// layer 234, so they are intentionally absent from METHOD_IDS / the router.

/** phone.checkCall (absent from layer 234) -> phone.PhoneCall. */
export function checkCall(params, ctx = {}) {
  const peer = readPhoneCallPeer(params, 'peer');
  return tlPhonePhoneCall(callFor(ctx, peer), ctx);
}

/** phone.getCalls (absent from layer 234) -> vector#1cb5c415 of PhoneCall. */
export function getCalls(params, ctx = {}) {
  const userId = Number(pick(params, ['userId', 'user_id', 'id'],
    Number(currentUser(ctx.store, ctx)?.id || ctx.userId || 0))) || 0;
  const calls = callsOf(ctx).listCalls(userId);
  return tlVector(calls.map((call) => tlPhoneCall(call, ctx)));
}

/** phone.declineCall (absent from layer 234) -> bare phoneCallDiscarded#50ca4de1. */
export function declineCall(params, ctx = {}) {
  const peer = readPhoneCallPeer(params, 'peer');
  const store = callsOf(ctx);
  let call = callFor(ctx, peer);
  call = store.declineCall(peer.id) || call;
  return tlPhoneCall(call, ctx);
}

/** Aliases matching the names used in the task brief. */
export const sendCallData = sendSignalingData;
export const receivedCallData = receivedCall;
export const uploadCallLog = saveCallLog;

export default {
  CALL_ID,
  METHOD_IDS,
  getCallConfig,
  requestCall,
  acceptCall,
  confirmCall,
  receivedCall,
  discardCall,
  setCallRating,
  saveCallDebug,
  sendSignalingData,
  saveCallLog,
  checkCall,
  getCalls,
  declineCall,
  sendCallData,
  receivedCallData,
  uploadCallLog,
};
