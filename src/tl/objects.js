// Hand-written TL codecs for the objects used by the RPC layer.
// Dependency-free ESM. Constructor IDs below were verified against the pinned
// TDesktop layer-234 schema (schema/api.tl + schema/mtproto.tl), NOT from memory:
// a few widely copied IDs are stale in layer 234 (contact, message, inputUser,
// inputPeerChannel, upload.getFile, upload.file, peerChannel, ...).
//
// Each writeX(obj, w?) returns a Buffer (or appends to TLBuffer w when given).
// Each readX(r) parses from a TLBuffer reader. Nested values may be passed as
// pre-serialized Buffers or as plain objects tagged with `_` (e.g. {_: 'user'}).

import { TLBuffer } from './buffer.js';

// ---- constructor IDs ---------------------------------------------------

// MTProto service messages
export const ID_RPC_RESULT = 0xf35c6d01;
export const ID_RPC_ERROR = 0x2144ca19;
export const ID_MSGS_ACK = 0x62d6b459;
export const ID_PING = 0x7abe77ec;
export const ID_PONG = 0x347773c5;
export const ID_MSG_CONTAINER = 0x73f1f8dc;
export const ID_GZIP_PACKED = 0x3072cfa1;
export const ID_NEW_SESSION_CREATED = 0x9ec20908;
export const ID_BAD_MSG_NOTIFICATION = 0xa7eff811;
export const ID_BAD_SERVER_SALT = 0xedab447b;
export const ID_FUTURE_SALT = 0x0949d9dc;
export const ID_FUTURE_SALTS = 0xae500895;
export const ID_VECTOR = 0x1cb5c415;
export const ID_BOOL_TRUE = 0x997275b5;
export const ID_BOOL_FALSE = 0xbc799737;

// Bootstrap / config
export const ID_INVOKE_WITH_LAYER = 0xda9b0d0d;
export const ID_INIT_CONNECTION = 0xc1cd5ea9;
export const ID_HELP_GET_CONFIG = 0xc4f9186b;
export const ID_CONFIG = 0xcc1a241e;
export const ID_DC_OPTION = 0x18b7a10d;
export const ID_HELP_GET_NEAREST_DC = 0x1fb33026;
export const ID_NEAREST_DC = 0x8e1a1775;

// Authorization
export const ID_AUTH_SEND_CODE = 0xa677244f;
export const ID_CODE_SETTINGS = 0xad253d78;
export const ID_AUTH_SENT_CODE = 0x5e002502;
export const ID_AUTH_SENT_CODE_TYPE_SMS = 0xc000bba2;
export const ID_AUTH_SIGN_IN = 0x8d52a951;
export const ID_AUTH_SIGN_UP = 0xaac7b717;
export const ID_AUTH_AUTHORIZATION = 0x2ea2c0d4;
export const ID_USER = 0xb1b8cc83;
export const ID_USER_EMPTY = 0xd3bc4b7a;

// Users / contacts
export const ID_USERS_GET_USERS = 0xd91a548;
export const ID_USERS_GET_FULL_USER = 0xb60f5918;
export const ID_CONTACTS_GET_CONTACTS = 0x5dd69e12;
export const ID_CONTACTS_CONTACTS = 0xeae87e42;
export const ID_CONTACT = 0x145ade0b; // layer 234 (older docs say f911c994)

// Dialogs / messages
export const ID_MESSAGES_GET_DIALOGS = 0xa0f4cb4f;
export const ID_MESSAGES_DIALOGS_SLICE = 0xd1747044;
export const ID_MESSAGES_GET_HISTORY = 0x4423e6c5;
export const ID_MESSAGES_MESSAGES_SLICE = 0x5f206716;
export const ID_MESSAGE = 0x7600b9d3;
export const ID_PEER_USER = 0x59511722;
export const ID_PEER_CHAT = 0x36c6019a;
export const ID_PEER_CHANNEL = 0xa2a5371e; // layer 234 (older docs say b4a9602e)
export const ID_CHAT = 0x41cbf256;
export const ID_CHANNEL = 0x7ad15240;
export const ID_CHAT_PHOTO_EMPTY = 0x37c1011c;
export const ID_MESSAGES_SEND_MESSAGE = 0xfef48f62;
export const ID_UPDATE_SHORT_SENT_MESSAGE = 0x9015e101;

// Updates
export const ID_UPDATES_GET_STATE = 0xedd4882a;
export const ID_UPDATES_STATE = 0xa56c2a3e;
export const ID_UPDATES_GET_DIFFERENCE = 0x19c2f763;
export const ID_UPDATES_DIFFERENCE_EMPTY = 0x5d75a138;
export const ID_UPDATES = 0x74ae4240;
export const ID_UPDATE_SHORT = 0x78d4dec1;
export const ID_UPDATE_NEW_MESSAGE = 0x1f2b0afd;
export const ID_UPDATE_MESSAGE_ID = 0x4e90bfd6;

// Uploads
export const ID_UPLOAD_SAVE_FILE_PART = 0xb304a621;
export const ID_UPLOAD_GET_FILE = 0xbe5335be; // layer 234 (older docs say b15f9c14)
export const ID_UPLOAD_FILE = 0x96a18d5; // layer 234 (older docs say 96dfc3e9)
export const ID_STORAGE_FILE_UNKNOWN = 0xaa963b05;
export const ID_INPUT_FILE = 0xf52ff27f;

// Input peers / users
export const ID_INPUT_PEER_EMPTY = 0x7f3b18ea;
export const ID_INPUT_PEER_SELF = 0x7da07ec9;
export const ID_INPUT_PEER_USER = 0xdde8a54c;
export const ID_INPUT_PEER_CHAT = 0x35a95cb9;
export const ID_INPUT_PEER_CHANNEL = 0x27bcbbfc; // layer 234 (older docs say 20adaef8)
export const ID_INPUT_USER_SELF = 0xf7c1b13f; // layer 234 (older docs say f7c36384)
export const ID_INPUT_USER = 0xf21158c6; // layer 234 (older docs say d8292816)
export const ID_REACTION_EMPTY = 0x79f5d419;

// ---- small helpers -----------------------------------------------------

const OBJECT_WRITERS = new Map();
const OBJECT_READERS = new Map();

function begin(id, w) {
  const b = w || new TLBuffer();
  b.putUint(id);
  return b;
}
function end(b, w) {
  return w ? b : b.buffer;
}
function has(v) {
  return v !== undefined && v !== null;
}
function raw(v) {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}
function callWriter(writer, b, value) {
  // Writers for empty constructors take only (w); all others take (obj, w).
  if (writer.length <= 1) writer(b);
  else writer(value, b);
}
function putValue(b, value, fallbackWriter) {
  if (Buffer.isBuffer(value)) { b.putRaw(value); return; }
  if (value && typeof value === 'object') {
    const writer = (value._ && OBJECT_WRITERS.get(value._)) || fallbackWriter;
    if (writer) { callWriter(writer, b, value); return; }
  }
  if (!has(value) && fallbackWriter) { callWriter(fallbackWriter, b, {}); return; }
  throw new TypeError(`TL: cannot encode value of type ${typeof value}`);
}
function putRawVector(b, items = []) {
  b.putVector(items || [], (item, w) => putValue(w, item));
}
function putLongVector(b, items = []) {
  b.putVector(items || [], (item, w) => w.putLong(item));
}
function putIntVector(b, items = []) {
  b.putVector(items || [], (item, w) => w.putInt(item));
}
function optional(b, flags, bit, value, encode, fallback) {
  if (!(Number(flags) & (1 << bit))) return;
  encode(b, has(value) ? value : fallback);
}
/** Build flags from an explicit `flags` field plus presence of known fields. */
function flagsFrom(obj, fields) {
  let f = Number(obj.flags || 0) >>> 0;
  for (const [bit, field] of fields) {
    if (has(obj[field]) && obj[field] !== false) f |= (1 << bit);
  }
  return f >>> 0;
}
function now() {
  return Math.floor(Date.now() / 1000);
}

// ---- service messages --------------------------------------------------

export function writeRpcResult(obj, result, w) {
  if (obj && typeof obj === 'object' && !Buffer.isBuffer(obj)) {
    w = result;
    result = obj.result;
    obj = obj.reqMsgId;
  }
  const b = begin(ID_RPC_RESULT, w);
  b.putLong(obj);
  b.putRaw(raw(result));
  return end(b, w);
}

export function readRpcResult(r) {
  const reqMsgId = r.long();
  return { reqMsgId, result: Buffer.from(r.raw(r.length - r.offset)) };
}

export function writeRpcError(obj, w) {
  const b = begin(ID_RPC_ERROR, w);
  b.putInt(obj.errorCode);
  b.putString(obj.errorMessage);
  return end(b, w);
}
export function readRpcError(r) {
  return { errorCode: r.int(), errorMessage: r.string() };
}

export function writeMsgsAck(obj, w) {
  const b = begin(ID_MSGS_ACK, w);
  putLongVector(b, Array.isArray(obj) ? obj : obj.msgIds);
  return end(b, w);
}
export function readMsgsAck(r) {
  return { msgIds: r.vector((rr) => rr.long()) };
}

export function writePing(obj, w) {
  const b = begin(ID_PING, w);
  b.putLong(typeof obj === 'object' ? obj.pingId : obj);
  return end(b, w);
}
export function readPing(r) {
  return { pingId: r.long() };
}

export function writePong(obj, w) {
  const b = begin(ID_PONG, w);
  b.putLong(obj.msgId);
  b.putLong(obj.pingId);
  return end(b, w);
}
export function readPong(r) {
  return { msgId: r.long(), pingId: r.long() };
}

export function writeMsgContainer(messages, w) {
  const b = begin(ID_MSG_CONTAINER, w);
  b.putInt(messages.length);
  for (const m of messages) {
    b.putLong(m.msgId);
    b.putInt(m.seqNo);
    const body = raw(m.body);
    b.putInt(body.length);
    b.putRaw(body);
  }
  return end(b, w);
}
export function readMsgContainer(r) {
  const count = r.int();
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push({ msgId: r.long(), seqNo: r.int(), body: Buffer.from(r.raw(r.int())) });
  }
  return { messages };
}

/** caller supplies already-gzipped bytes (zlib.gzipSync) */
export function writeGzipPacked(data, w) {
  const b = begin(ID_GZIP_PACKED, w);
  b.putBytes(raw(data));
  return end(b, w);
}
export function readGzipPacked(r) {
  return { packedData: r.bytes() };
}

export function writeNewSessionCreated(obj, w) {
  const b = begin(ID_NEW_SESSION_CREATED, w);
  b.putLong(obj.firstMsgId);
  b.putLong(obj.uniqueId);
  b.putLong(obj.serverSalt);
  return end(b, w);
}
export function readNewSessionCreated(r) {
  return { firstMsgId: r.long(), uniqueId: r.long(), serverSalt: r.long() };
}

export function writeBadMsgNotification(obj, w) {
  const b = begin(ID_BAD_MSG_NOTIFICATION, w);
  b.putLong(obj.badMsgId);
  b.putInt(obj.badMsgSeqno);
  b.putInt(obj.errorCode);
  return end(b, w);
}
export function readBadMsgNotification(r) {
  return { badMsgId: r.long(), badMsgSeqno: r.int(), errorCode: r.int() };
}

export function writeBadServerSalt(obj, w) {
  const b = begin(ID_BAD_SERVER_SALT, w);
  b.putLong(obj.badMsgId);
  b.putInt(obj.badMsgSeqno);
  b.putInt(obj.errorCode);
  b.putLong(obj.newServerSalt);
  return end(b, w);
}
export function readBadServerSalt(r) {
  return {
    badMsgId: r.long(), badMsgSeqno: r.int(), errorCode: r.int(),
    newServerSalt: r.long(),
  };
}

export function writeFutureSalt(obj, w) {
  const b = begin(ID_FUTURE_SALT, w);
  b.putInt(obj.validSince);
  b.putInt(obj.validUntil);
  b.putLong(obj.salt);
  return end(b, w);
}
export function readFutureSalt(r) {
  return { validSince: r.int(), validUntil: r.int(), salt: r.long() };
}

export function writeFutureSalts(obj, w) {
  const b = begin(ID_FUTURE_SALTS, w);
  b.putLong(obj.reqMsgId);
  b.putInt(obj.now);
  putRawVector(b, (obj.salts || []).map((salt) => writeFutureSalt(salt)));
  return end(b, w);
}
export function readFutureSalts(r) {
  return {
    reqMsgId: r.long(), now: r.int(),
    salts: r.vector((rr) => readTlObject(rr)),
  };
}

// ---- bootstrap wrappers / config --------------------------------------

export function writeInvokeWithLayer(obj, w) {
  const b = begin(ID_INVOKE_WITH_LAYER, w);
  b.putInt(obj.layer);
  b.putRaw(raw(obj.query));
  return end(b, w);
}
export function readInvokeWithLayer(r) {
  return { layer: r.int(), query: Buffer.from(r.raw(r.length - r.offset)) };
}

export function writeInitConnection(obj, w) {
  const flags = Number(obj.flags || 0) >>> 0;
  const b = begin(ID_INIT_CONNECTION, w);
  b.putInt(flags);
  b.putInt(obj.apiId ?? 0);
  b.putString(obj.deviceModel ?? 'TelegramServer');
  b.putString(obj.systemVersion ?? '1.0');
  b.putString(obj.appVersion ?? '1.0');
  b.putString(obj.systemLangCode ?? 'en');
  b.putString(obj.langPack ?? '');
  b.putString(obj.langCode ?? 'en');
  optional(b, flags, 0, obj.proxy, (x, v) => putValue(x, v));
  optional(b, flags, 1, obj.params, (x, v) => putValue(x, v));
  b.putRaw(raw(obj.query));
  return end(b, w);
}
export function readInitConnection(r) {
  const flags = r.uint();
  const out = {
    flags,
    apiId: r.int(), deviceModel: r.string(), systemVersion: r.string(),
    appVersion: r.string(), systemLangCode: r.string(), langPack: r.string(),
    langCode: r.string(),
  };
  optional(r, flags, 0, null, (x) => { out.proxy = readTlObject(x); });
  optional(r, flags, 1, null, (x) => { out.params = readTlObject(x); });
  out.query = Buffer.from(r.raw(r.length - r.offset));
  return out;
}

export function writeHelpGetConfig(w) {
  return end(begin(ID_HELP_GET_CONFIG, w), w);
}
export function writeHelpGetNearestDc(w) {
  return end(begin(ID_HELP_GET_NEAREST_DC, w), w);
}

/**
 * config#cc1a241e — every mandatory field of layer 234 is written here.
 * Truncated configs are silently rejected by TDesktop, so keep this in sync
 * with schema/api.tl (including the flags2-era extras reactions_default and
 * autologin_token).
 */
export function writeConfig(obj = {}, w) {
  const ip = obj.publicIp ?? obj.publicIP ?? obj.ip ?? obj.ipAddress ?? '127.0.0.1';
  const port = obj.port ?? 443;
  const thisDc = obj.thisDc ?? 1;
  const date = obj.date ?? now();
  const flags = Number(obj.flags ?? ((1 << 2) | (1 << 15) | (1 << 16))) >>> 0;
  const b = begin(ID_CONFIG, w);

  b.putInt(flags);
  // flags.3 .. flags.17 booleans (none set by default)
  optional(b, flags, 3, obj.defaultP2pContacts, (x) => x.putUint(ID_BOOL_TRUE));
  optional(b, flags, 4, obj.preloadFeaturedStickers, (x) => x.putUint(ID_BOOL_TRUE));
  optional(b, flags, 6, obj.revokePmInbox, (x) => x.putUint(ID_BOOL_TRUE));
  optional(b, flags, 8, obj.blockedMode, (x) => x.putUint(ID_BOOL_TRUE));
  optional(b, flags, 14, obj.forceTryIpv6, (x) => x.putUint(ID_BOOL_TRUE));
  optional(b, flags, 17, obj.fpnvAllowed, (x) => x.putUint(ID_BOOL_TRUE));

  b.putInt(date);
  b.putInt(obj.expires ?? date + 3600);
  b.putBool(obj.testMode ?? false);
  b.putInt(thisDc);
  const dcOptions = obj.dcOptions || [{
    flags: 0, id: thisDc, ipAddress: ip, port,
  }];
  putRawVector(b, dcOptions.map((d) => writeDcOption({
    id: thisDc, ipAddress: ip, port, ...d,
  })));
  b.putString(obj.dcTxtDomainName ?? 'dc1.stel.com');
  b.putInt(obj.chatSizeMax ?? 200);
  b.putInt(obj.megagroupSizeMax ?? 200000);
  b.putInt(obj.forwardedCountMax ?? 100);
  b.putInt(obj.onlineUpdatePeriodMs ?? 30000);
  b.putInt(obj.offlineBlurTimeoutMs ?? 5000);
  b.putInt(obj.offlineIdleTimeoutMs ?? 30000);
  b.putInt(obj.onlineCloudTimeoutMs ?? 1000);
  b.putInt(obj.notifyCloudDelayMs ?? 30000);
  b.putInt(obj.notifyDefaultDelayMs ?? 1500);
  b.putInt(obj.pushChatPeriodMs ?? 1000);
  b.putInt(obj.pushChatLimit ?? 2);
  // layer 234 has no `stickers_faved_limit` (it was removed before 234)
  b.putInt(obj.editTimeLimit ?? 86400);
  b.putInt(obj.revokeTimeLimit ?? 86400);
  b.putInt(obj.revokePmTimeLimit ?? 86400);
  b.putInt(obj.ratingEDecay ?? 2419200);
  b.putInt(obj.stickersRecentLimit ?? 20);
  b.putInt(obj.channelsReadMediaPeriod ?? 86400);
  b.putInt(obj.callReceiveTimeoutMs ?? 2000);
  b.putInt(obj.callRingTimeoutMs ?? 2000);
  b.putInt(obj.callConnectTimeoutMs ?? 10000);
  b.putInt(obj.callPacketTimeoutMs ?? 10000);
  b.putString(obj.meUrlPrefix ?? 'https://t.me/');
  b.putInt(obj.captionLengthMax ?? 1024);
  b.putInt(obj.messageLengthMax ?? 4096);
  b.putInt(obj.webfileDcId ?? thisDc);

  // Optional fields MUST follow declaration order, not bit order.
  optional(b, flags, 0, obj.tmpSessions, (x, v) => x.putInt(v), 0);
  optional(b, flags, 7, obj.autoupdateUrlPrefix, (x, v) => x.putString(v), '');
  optional(b, flags, 9, obj.gifSearchUsername, (x, v) => x.putString(v), '');
  optional(b, flags, 10, obj.venueSearchUsername, (x, v) => x.putString(v), '');
  optional(b, flags, 11, obj.imgSearchUsername, (x, v) => x.putString(v), '');
  optional(b, flags, 12, obj.staticMapsProvider, (x, v) => x.putString(v), '');
  optional(b, flags, 2, obj.suggestedLangCode, (x, v) => x.putString(v), '');
  optional(b, flags, 2, obj.langPackVersion, (x, v) => x.putInt(v), 0);
  optional(b, flags, 2, obj.baseLangPackVersion, (x, v) => x.putInt(v), 0);
  optional(b, flags, 15, obj.reactionsDefault, (x, v) => putValue(x, v), { _: 'reactionEmpty' });
  optional(b, flags, 16, obj.autologinToken, (x, v) => x.putString(v), '');
  return end(b, w);
}

export function readConfig(r) {
  const flags = r.uint();
  const out = { flags };
  for (const [bit, field] of [
    [3, 'defaultP2pContacts'], [4, 'preloadFeaturedStickers'], [6, 'revokePmInbox'],
    [8, 'blockedMode'], [14, 'forceTryIpv6'], [17, 'fpnvAllowed'],
  ]) {
    out[field] = !!(flags & (1 << bit)) && r.bool();
  }
  out.date = r.int();
  out.expires = r.int();
  out.testMode = r.bool();
  out.thisDc = r.int();
  out.dcOptions = r.vector((rr) => readTlObject(rr));
  out.dcTxtDomainName = r.string();
  out.chatSizeMax = r.int();
  out.megagroupSizeMax = r.int();
  out.forwardedCountMax = r.int();
  out.onlineUpdatePeriodMs = r.int();
  out.offlineBlurTimeoutMs = r.int();
  out.offlineIdleTimeoutMs = r.int();
  out.onlineCloudTimeoutMs = r.int();
  out.notifyCloudDelayMs = r.int();
  out.notifyDefaultDelayMs = r.int();
  out.pushChatPeriodMs = r.int();
  out.pushChatLimit = r.int();
  out.editTimeLimit = r.int();
  out.revokeTimeLimit = r.int();
  out.revokePmTimeLimit = r.int();
  out.ratingEDecay = r.int();
  out.stickersRecentLimit = r.int();
  out.channelsReadMediaPeriod = r.int();
  out.callReceiveTimeoutMs = r.int();
  out.callRingTimeoutMs = r.int();
  out.callConnectTimeoutMs = r.int();
  out.callPacketTimeoutMs = r.int();
  out.meUrlPrefix = r.string();
  out.captionLengthMax = r.int();
  out.messageLengthMax = r.int();
  out.webfileDcId = r.int();
  optional(r, flags, 0, null, (x) => { out.tmpSessions = x.int(); });
  for (const [bit, field] of [
    [7, 'autoupdateUrlPrefix'], [9, 'gifSearchUsername'], [10, 'venueSearchUsername'],
    [11, 'imgSearchUsername'], [12, 'staticMapsProvider'],
  ]) optional(r, flags, bit, null, (x) => { out[field] = x.string(); });
  optional(r, flags, 2, null, (x) => { out.suggestedLangCode = x.string(); });
  optional(r, flags, 2, null, (x) => { out.langPackVersion = x.int(); });
  optional(r, flags, 2, null, (x) => { out.baseLangPackVersion = x.int(); });
  optional(r, flags, 15, null, (x) => { out.reactionsDefault = readTlObject(x); });
  optional(r, flags, 16, null, (x) => { out.autologinToken = x.string(); });
  return out;
}

export function writeDcOption(obj = {}, w) {
  const flags = flagsFrom(obj, [
    [0, 'ipv6'], [1, 'mediaOnly'], [2, 'tcpoOnly'], [3, 'cdn'],
    [4, 'static'], [5, 'thisPortOnly'], [10, 'secret'],
  ]);
  const b = begin(ID_DC_OPTION, w);
  b.putInt(flags);
  b.putInt(obj.id ?? 1);
  b.putString(obj.ipAddress ?? obj.ip ?? '127.0.0.1');
  b.putInt(obj.port ?? 443);
  optional(b, flags, 10, obj.secret, (x, v) => x.putBytes(raw(v)));
  return end(b, w);
}
export function readDcOption(r) {
  const flags = r.uint();
  const out = { flags, id: r.int(), ipAddress: r.string(), port: r.int() };
  optional(r, flags, 10, null, (x) => { out.secret = x.bytes(); });
  return out;
}

export function writeNearestDc(obj, w) {
  const b = begin(ID_NEAREST_DC, w);
  b.putString(obj.country ?? '');
  b.putInt(obj.thisDc ?? 1);
  b.putInt(obj.nearestDc ?? obj.thisDc ?? 1);
  return end(b, w);
}
export function readNearestDc(r) {
  return { country: r.string(), thisDc: r.int(), nearestDc: r.int() };
}

// ---- authorization -----------------------------------------------------

export function writeAuthSendCode(obj, w) {
  const b = begin(ID_AUTH_SEND_CODE, w);
  b.putString(obj.phoneNumber);
  b.putInt(obj.apiId);
  b.putString(obj.apiHash);
  putValue(b, obj.settings, writeCodeSettings);
  return end(b, w);
}

export function writeCodeSettings(obj = {}, w) {
  const flags = flagsFrom(obj, [
    [0, 'allowFlashcall'], [1, 'currentNumber'], [4, 'allowAppHash'],
    [5, 'allowMissedCall'], [7, 'allowFirebase'], [9, 'unknownNumber'],
    [6, 'logoutTokens'], [8, 'token'],
  ]);
  // app_sandbox shares bit 8 with token, so it is only written when token is absent.
  const b = begin(ID_CODE_SETTINGS, w);
  b.putInt(flags);
  optional(b, flags, 0, obj.allowFlashcall, (x) => x.putUint(ID_BOOL_TRUE));
  optional(b, flags, 1, obj.currentNumber, (x) => x.putUint(ID_BOOL_TRUE));
  optional(b, flags, 4, obj.allowAppHash, (x) => x.putUint(ID_BOOL_TRUE));
  optional(b, flags, 5, obj.allowMissedCall, (x) => x.putUint(ID_BOOL_TRUE));
  optional(b, flags, 7, obj.allowFirebase, (x) => x.putUint(ID_BOOL_TRUE));
  optional(b, flags, 9, obj.unknownNumber, (x) => x.putUint(ID_BOOL_TRUE));
  optional(b, flags, 6, obj.logoutTokens, (x, v) => putRawVector(x, v));
  optional(b, flags, 8, obj.token, (x, v) => x.putString(v), '');
  return end(b, w);
}
export function readCodeSettings(r) {
  const flags = r.uint();
  const out = { flags };
  for (const [bit, field] of [
    [0, 'allowFlashcall'], [1, 'currentNumber'], [4, 'allowAppHash'],
    [5, 'allowMissedCall'], [7, 'allowFirebase'], [9, 'unknownNumber'],
  ]) out[field] = !!(flags & (1 << bit)) && r.bool();
  optional(r, flags, 6, null, (x) => { out.logoutTokens = x.vector((rr) => rr.bytes()); });
  optional(r, flags, 8, null, (x) => { out.token = x.string(); });
  return out;
}

export function writeAuthSentCode(obj, w) {
  const flags = flagsFrom(obj, [[1, 'nextType'], [2, 'timeout']]);
  const b = begin(ID_AUTH_SENT_CODE, w);
  b.putInt(flags);
  putValue(b, obj.type, writeAuthSentCodeTypeSms);
  b.putString(obj.phoneCodeHash);
  optional(b, flags, 1, obj.nextType, (x, v) => putValue(x, v));
  optional(b, flags, 2, obj.timeout, (x, v) => x.putInt(v), 0);
  return end(b, w);
}
export function readAuthSentCode(r) {
  const flags = r.uint();
  const out = { flags, type: readTlObject(r), phoneCodeHash: r.string() };
  optional(r, flags, 1, null, (x) => { out.nextType = readTlObject(x); });
  optional(r, flags, 2, null, (x) => { out.timeout = x.int(); });
  return out;
}

export function writeAuthSentCodeTypeSms(obj, w) {
  const b = begin(ID_AUTH_SENT_CODE_TYPE_SMS, w);
  b.putInt(obj.length ?? 5);
  return end(b, w);
}
export function readAuthSentCodeTypeSms(r) {
  return { length: r.int() };
}

export function writeAuthSignIn(obj, w) {
  const flags = flagsFrom(obj, [[0, 'phoneCode'], [1, 'emailVerification']]);
  const b = begin(ID_AUTH_SIGN_IN, w);
  b.putInt(flags);
  b.putString(obj.phoneNumber);
  b.putString(obj.phoneCodeHash);
  optional(b, flags, 0, obj.phoneCode, (x, v) => x.putString(v), '');
  optional(b, flags, 1, obj.emailVerification, (x, v) => putValue(x, v));
  return end(b, w);
}

export function writeAuthSignUp(obj, w) {
  const flags = flagsFrom(obj, [[0, 'noJoinedNotifications']]);
  const b = begin(ID_AUTH_SIGN_UP, w);
  b.putInt(flags);
  b.putString(obj.phoneNumber);
  b.putString(obj.phoneCodeHash);
  b.putString(obj.firstName);
  b.putString(obj.lastName ?? '');
  return end(b, w);
}

export function writeAuthAuthorization(obj, w) {
  const flags = flagsFrom(obj, [
    [1, 'setupPasswordRequired'], [1, 'otherwiseReloginDays'],
    [0, 'tmpSessions'], [2, 'futureAuthToken'],
  ]);
  const b = begin(ID_AUTH_AUTHORIZATION, w);
  b.putInt(flags);
  // setup_password_required and otherwise_relogin_days share bit 1.
  optional(b, flags, 1, obj.setupPasswordRequired, (x) => x.putUint(ID_BOOL_TRUE));
  if ((flags & (1 << 1)) && !obj.setupPasswordRequired) {
    b.putInt(obj.otherwiseReloginDays ?? 0);
  }
  optional(b, flags, 0, obj.tmpSessions, (x, v) => x.putInt(v), 0);
  optional(b, flags, 2, obj.futureAuthToken, (x, v) => x.putBytes(raw(v)));
  putValue(b, obj.user, writeUser);
  return end(b, w);
}
export function readAuthAuthorization(r) {
  const flags = r.uint();
  const out = { flags };
  if (flags & (1 << 1)) {
    const probe = r.uint();
    if (probe === ID_BOOL_TRUE || probe === ID_BOOL_FALSE) {
      out.setupPasswordRequired = probe === ID_BOOL_TRUE;
    } else {
      out.otherwiseReloginDays = probe | 0; // reading an int as uint loses sign, fine for sane values
    }
  }
  optional(r, flags, 0, null, (x) => { out.tmpSessions = x.int(); });
  optional(r, flags, 2, null, (x) => { out.futureAuthToken = x.bytes(); });
  out.user = readTlObject(r);
  return out;
}

// ---- users -------------------------------------------------------------

const USER_BOOL_FIELDS = [
  [10, 'self'], [11, 'contact'], [12, 'mutualContact'], [13, 'deleted'],
  [14, 'bot'], [15, 'botChatHistory'], [16, 'botNochats'], [17, 'verified'],
  [18, 'restricted'], [20, 'min'], [21, 'botInlineGeo'], [23, 'support'],
  [24, 'scam'], [25, 'applyMinPhoto'], [26, 'fake'], [27, 'botAttachMenu'],
  [28, 'premium'], [29, 'attachMenuEnabled'],
];
const USER2_BOOL_FIELDS = [
  [1, 'botCanEdit'], [2, 'closeFriend'], [3, 'storiesHidden'],
  [4, 'storiesUnavailable'], [10, 'contactRequirePremium'], [11, 'botBusiness'],
  [13, 'botHasMainApp'], [16, 'botForumView'], [17, 'botForumCanManageTopics'],
  [18, 'botCanManageBots'], [19, 'botGuestchat'], [20, 'botGuard'],
  [22, 'botForumSidebar'],
];

export function writeUser(obj, w) {
  const flags = flagsFrom(obj, [
    [0, 'accessHash'], [1, 'firstName'], [2, 'lastName'], [3, 'username'],
    [4, 'phone'], [5, 'photo'], [6, 'status'], [14, 'botInfoVersion'],
    [18, 'restrictionReason'], [19, 'botInlinePlaceholder'], [22, 'langCode'],
    [30, 'emojiStatus'], ...USER_BOOL_FIELDS,
  ]);
  const flags2 = flagsFrom(obj, [
    [0, 'usernames'], [5, 'storiesMaxId'], [8, 'color'], [9, 'profileColor'],
    [12, 'botActiveUsers'], [14, 'botVerificationIcon'], [15, 'sendPaidMessagesStars'],
    [21, 'linkedCommunityId'], ...USER2_BOOL_FIELDS,
  ]);
  const b = begin(ID_USER, w);
  b.putInt(flags);
  for (const [bit, field] of USER_BOOL_FIELDS) {
    optional(b, flags, bit, obj[field], (x) => x.putUint(ID_BOOL_TRUE));
  }
  b.putInt(flags2);
  for (const [bit, field] of USER2_BOOL_FIELDS) {
    optional(b, flags2, bit, obj[field], (x) => x.putUint(ID_BOOL_TRUE));
  }
  b.putLong(obj.id);
  optional(b, flags, 0, obj.accessHash, (x, v) => x.putLong(v), 0n);
  optional(b, flags, 1, obj.firstName, (x, v) => x.putString(v), '');
  optional(b, flags, 2, obj.lastName, (x, v) => x.putString(v), '');
  optional(b, flags, 3, obj.username, (x, v) => x.putString(v), '');
  optional(b, flags, 4, obj.phone, (x, v) => x.putString(v), '');
  optional(b, flags, 5, obj.photo, (x, v) => putValue(x, v));
  optional(b, flags, 6, obj.status, (x, v) => putValue(x, v));
  optional(b, flags, 14, obj.botInfoVersion, (x, v) => x.putInt(v), 0);
  optional(b, flags, 18, obj.restrictionReason, (x, v) => putRawVector(x, v));
  optional(b, flags, 19, obj.botInlinePlaceholder, (x, v) => x.putString(v), '');
  optional(b, flags, 22, obj.langCode, (x, v) => x.putString(v), '');
  optional(b, flags, 30, obj.emojiStatus, (x, v) => putValue(x, v));
  optional(b, flags2, 0, obj.usernames, (x, v) => putRawVector(x, v));
  optional(b, flags2, 5, obj.storiesMaxId, (x, v) => putValue(x, v));
  optional(b, flags2, 8, obj.color, (x, v) => putValue(x, v));
  optional(b, flags2, 9, obj.profileColor, (x, v) => putValue(x, v));
  optional(b, flags2, 12, obj.botActiveUsers, (x, v) => x.putInt(v), 0);
  optional(b, flags2, 14, obj.botVerificationIcon, (x, v) => x.putLong(v), 0n);
  optional(b, flags2, 15, obj.sendPaidMessagesStars, (x, v) => x.putLong(v), 0n);
  optional(b, flags2, 21, obj.linkedCommunityId, (x, v) => x.putLong(v), 0n);
  return end(b, w);
}
export function readUser(r) {
  const flags = r.uint();
  const out = { flags };
  for (const [bit, field] of USER_BOOL_FIELDS) {
    out[field] = !!(flags & (1 << bit)) && r.bool();
  }
  const flags2 = r.uint();
  out.flags2 = flags2;
  for (const [bit, field] of USER2_BOOL_FIELDS) {
    out[field] = !!(flags2 & (1 << bit)) && r.bool();
  }
  out.id = r.long();
  optional(r, flags, 0, null, (x) => { out.accessHash = x.long(); });
  optional(r, flags, 1, null, (x) => { out.firstName = x.string(); });
  optional(r, flags, 2, null, (x) => { out.lastName = x.string(); });
  optional(r, flags, 3, null, (x) => { out.username = x.string(); });
  optional(r, flags, 4, null, (x) => { out.phone = x.string(); });
  optional(r, flags, 5, null, (x) => { out.photo = readTlObject(x); });
  optional(r, flags, 6, null, (x) => { out.status = readTlObject(x); });
  optional(r, flags, 14, null, (x) => { out.botInfoVersion = x.int(); });
  optional(r, flags, 18, null, (x) => { out.restrictionReason = x.vector((rr) => readTlObject(rr)); });
  optional(r, flags, 19, null, (x) => { out.botInlinePlaceholder = x.string(); });
  optional(r, flags, 22, null, (x) => { out.langCode = x.string(); });
  optional(r, flags, 30, null, (x) => { out.emojiStatus = readTlObject(x); });
  optional(r, flags2, 0, null, (x) => { out.usernames = x.vector((rr) => readTlObject(rr)); });
  optional(r, flags2, 5, null, (x) => { out.storiesMaxId = readTlObject(x); });
  optional(r, flags2, 8, null, (x) => { out.color = readTlObject(x); });
  optional(r, flags2, 9, null, (x) => { out.profileColor = readTlObject(x); });
  optional(r, flags2, 12, null, (x) => { out.botActiveUsers = x.int(); });
  optional(r, flags2, 14, null, (x) => { out.botVerificationIcon = x.long(); });
  optional(r, flags2, 15, null, (x) => { out.sendPaidMessagesStars = x.long(); });
  optional(r, flags2, 21, null, (x) => { out.linkedCommunityId = x.long(); });
  return out;
}

export function writeUserEmpty(obj, w) {
  const b = begin(ID_USER_EMPTY, w);
  b.putLong(obj.id);
  return end(b, w);
}
export function readUserEmpty(r) {
  return { id: r.long() };
}

// ---- users / contacts RPCs --------------------------------------------

export function writeUsersGetUsers(obj, w) {
  const b = begin(ID_USERS_GET_USERS, w);
  putRawVector(b, Array.isArray(obj) ? obj : obj.id);
  return end(b, w);
}
export function writeUsersGetFullUser(obj, w) {
  const b = begin(ID_USERS_GET_FULL_USER, w);
  putValue(b, obj.id ?? obj, writeInputUser);
  return end(b, w);
}
export function writeContactsGetContacts(obj, w) {
  const b = begin(ID_CONTACTS_GET_CONTACTS, w);
  b.putLong(typeof obj === 'object' ? obj.hash : obj);
  return end(b, w);
}
export function writeContactsContacts(obj, w) {
  const b = begin(ID_CONTACTS_CONTACTS, w);
  putRawVector(b, obj.contacts);
  b.putInt(obj.savedCount ?? obj.contacts?.length ?? 0);
  putRawVector(b, obj.users);
  return end(b, w);
}
export function writeContact(obj, w) {
  const b = begin(ID_CONTACT, w);
  b.putLong(obj.userId);
  b.putBool(obj.mutual ?? false);
  return end(b, w);
}
export function readContact(r) {
  return { userId: r.long(), mutual: r.bool() };
}

// ---- dialogs / messages ------------------------------------------------

export function writeMessagesGetDialogs(obj = {}, w) {
  const flags = flagsFrom(obj, [[0, 'excludePinned'], [1, 'folderId']]);
  const b = begin(ID_MESSAGES_GET_DIALOGS, w);
  b.putInt(flags);
  optional(b, flags, 0, obj.excludePinned, (x) => x.putUint(ID_BOOL_TRUE));
  optional(b, flags, 1, obj.folderId, (x, v) => x.putInt(v), 0);
  b.putInt(obj.offsetDate ?? 0);
  b.putInt(obj.offsetId ?? 0);
  putValue(b, obj.offsetPeer ?? obj.peer, writeInputPeerEmpty);
  b.putInt(obj.limit ?? 20);
  b.putLong(obj.hash ?? 0);
  return end(b, w);
}

export function writeMessagesDialogsSlice(obj, w) {
  const flags = flagsFrom(obj, [[0, 'topics']]);
  const b = begin(ID_MESSAGES_DIALOGS_SLICE, w);
  b.putInt(flags);
  b.putInt(obj.count ?? obj.dialogs?.length ?? 0);
  optional(b, flags, 0, obj.topics, (x, v) => putRawVector(x, v));
  putRawVector(b, obj.dialogs);
  putRawVector(b, obj.messages);
  putRawVector(b, obj.chats);
  putRawVector(b, obj.users);
  return end(b, w);
}

export function writeMessagesGetHistory(obj, w) {
  const b = begin(ID_MESSAGES_GET_HISTORY, w);
  putValue(b, obj.peer, writeInputPeerEmpty);
  b.putInt(obj.offsetId ?? 0);
  b.putInt(obj.offsetDate ?? 0);
  b.putInt(obj.addOffset ?? 0);
  b.putInt(obj.limit ?? 20);
  b.putInt(obj.maxId ?? 0);
  b.putInt(obj.minId ?? 0);
  b.putLong(obj.hash ?? 0);
  return end(b, w);
}

export function writeMessagesMessagesSlice(obj, w) {
  const flags = flagsFrom(obj, [
    [1, 'inexact'], [0, 'nextRate'], [2, 'offsetIdOffset'], [3, 'searchFlood'],
  ]);
  const b = begin(ID_MESSAGES_MESSAGES_SLICE, w);
  b.putInt(flags);
  optional(b, flags, 1, obj.inexact, (x) => x.putUint(ID_BOOL_TRUE));
  b.putInt(obj.count ?? obj.messages?.length ?? 0);
  optional(b, flags, 0, obj.nextRate, (x, v) => x.putInt(v), 0);
  optional(b, flags, 2, obj.offsetIdOffset, (x, v) => x.putInt(v), 0);
  optional(b, flags, 3, obj.searchFlood, (x, v) => putValue(x, v));
  putRawVector(b, obj.messages);
  putRawVector(b, obj.topics ?? []);
  putRawVector(b, obj.chats ?? []);
  putRawVector(b, obj.users ?? []);
  return end(b, w);
}

const MESSAGE_BOOL_FIELDS = [
  [1, 'out'], [4, 'mentioned'], [5, 'mediaUnread'], [13, 'silent'],
  [14, 'post'], [18, 'fromScheduled'], [19, 'legacy'], [21, 'editHide'],
  [24, 'pinned'], [26, 'noforwards'], [27, 'invertMedia'],
];
const MESSAGE2_BOOL_FIELDS = [
  [1, 'offline'], [4, 'videoProcessingPending'], [8, 'paidSuggestedPostStars'],
  [9, 'paidSuggestedPostTon'],
];

export function writeMessage(obj, w) {
  const flags = flagsFrom(obj, [
    [8, 'fromId'], [29, 'fromBoostsApplied'], [28, 'savedPeerId'], [2, 'fwdFrom'],
    [11, 'viaBotId'], [3, 'replyTo'], [9, 'media'], [6, 'replyMarkup'],
    [7, 'entities'], [10, 'views'], [10, 'forwards'], [23, 'replies'],
    [15, 'editDate'], [16, 'postAuthor'], [17, 'groupedId'], [20, 'reactions'],
    [22, 'restrictionReason'], [25, 'ttlPeriod'], [30, 'quickReplyShortcutId'],
    ...MESSAGE_BOOL_FIELDS,
  ]);
  const flags2 = flagsFrom(obj, [
    [12, 'fromRank'], [0, 'viaBusinessBotId'], [19, 'guestchatViaFrom'],
    [2, 'effect'], [3, 'factcheck'], [5, 'reportDeliveryUntilDate'],
    [6, 'paidMessageStars'], [7, 'suggestedPost'], [10, 'scheduleRepeatPeriod'],
    [11, 'summaryFromLanguage'], [13, 'richMessage'], ...MESSAGE2_BOOL_FIELDS,
  ]);
  const b = begin(ID_MESSAGE, w);
  b.putInt(flags);
  for (const [bit, field] of MESSAGE_BOOL_FIELDS) {
    optional(b, flags, bit, obj[field], (x) => x.putUint(ID_BOOL_TRUE));
  }
  b.putInt(flags2);
  for (const [bit, field] of MESSAGE2_BOOL_FIELDS) {
    optional(b, flags2, bit, obj[field], (x) => x.putUint(ID_BOOL_TRUE));
  }
  b.putInt(obj.id);
  optional(b, flags, 8, obj.fromId, (x, v) => putValue(x, v));
  optional(b, flags, 29, obj.fromBoostsApplied, (x, v) => x.putInt(v), 0);
  optional(b, flags2, 12, obj.fromRank, (x, v) => x.putString(v), '');
  putValue(b, obj.peerId ?? obj.peer, writePeerUser);
  optional(b, flags, 28, obj.savedPeerId, (x, v) => putValue(x, v));
  optional(b, flags, 2, obj.fwdFrom, (x, v) => putValue(x, v));
  optional(b, flags, 11, obj.viaBotId, (x, v) => x.putLong(v), 0n);
  optional(b, flags2, 0, obj.viaBusinessBotId, (x, v) => x.putLong(v), 0n);
  optional(b, flags2, 19, obj.guestchatViaFrom, (x, v) => putValue(x, v));
  optional(b, flags, 3, obj.replyTo, (x, v) => putValue(x, v));
  b.putInt(obj.date ?? now());
  b.putString(obj.message ?? '');
  optional(b, flags, 9, obj.media, (x, v) => putValue(x, v));
  optional(b, flags, 6, obj.replyMarkup, (x, v) => putValue(x, v));
  optional(b, flags, 7, obj.entities, (x, v) => putRawVector(x, v));
  optional(b, flags, 10, obj.views, (x, v) => x.putInt(v), 0);
  optional(b, flags, 10, obj.forwards, (x, v) => x.putInt(v), 0);
  optional(b, flags, 23, obj.replies, (x, v) => putValue(x, v));
  optional(b, flags, 15, obj.editDate, (x, v) => x.putInt(v), 0);
  optional(b, flags, 16, obj.postAuthor, (x, v) => x.putString(v), '');
  optional(b, flags, 17, obj.groupedId, (x, v) => x.putLong(v), 0n);
  optional(b, flags, 20, obj.reactions, (x, v) => putValue(x, v));
  optional(b, flags, 22, obj.restrictionReason, (x, v) => putRawVector(x, v));
  optional(b, flags, 25, obj.ttlPeriod, (x, v) => x.putInt(v), 0);
  optional(b, flags, 30, obj.quickReplyShortcutId, (x, v) => x.putInt(v), 0);
  optional(b, flags2, 2, obj.effect, (x, v) => x.putLong(v), 0n);
  optional(b, flags2, 3, obj.factcheck, (x, v) => putValue(x, v));
  optional(b, flags2, 5, obj.reportDeliveryUntilDate, (x, v) => x.putInt(v), 0);
  optional(b, flags2, 6, obj.paidMessageStars, (x, v) => x.putLong(v), 0n);
  optional(b, flags2, 7, obj.suggestedPost, (x, v) => putValue(x, v));
  optional(b, flags2, 10, obj.scheduleRepeatPeriod, (x, v) => x.putInt(v), 0);
  optional(b, flags2, 11, obj.summaryFromLanguage, (x, v) => x.putString(v), '');
  optional(b, flags2, 13, obj.richMessage, (x, v) => putValue(x, v));
  return end(b, w);
}
export function readMessage(r) {
  const flags = r.uint();
  const out = { flags };
  for (const [bit, field] of MESSAGE_BOOL_FIELDS) {
    out[field] = !!(flags & (1 << bit)) && r.bool();
  }
  const flags2 = r.uint();
  out.flags2 = flags2;
  for (const [bit, field] of MESSAGE2_BOOL_FIELDS) {
    out[field] = !!(flags2 & (1 << bit)) && r.bool();
  }
  out.id = r.int();
  optional(r, flags, 8, null, (x) => { out.fromId = readPeer(x); });
  optional(r, flags, 29, null, (x) => { out.fromBoostsApplied = x.int(); });
  optional(r, flags2, 12, null, (x) => { out.fromRank = x.string(); });
  out.peerId = readPeer(r);
  optional(r, flags, 28, null, (x) => { out.savedPeerId = readPeer(x); });
  optional(r, flags, 2, null, (x) => { out.fwdFrom = readTlObject(x); });
  optional(r, flags, 11, null, (x) => { out.viaBotId = x.long(); });
  optional(r, flags2, 0, null, (x) => { out.viaBusinessBotId = x.long(); });
  optional(r, flags2, 19, null, (x) => { out.guestchatViaFrom = readPeer(x); });
  optional(r, flags, 3, null, (x) => { out.replyTo = readTlObject(x); });
  out.date = r.int();
  out.message = r.string();
  optional(r, flags, 9, null, (x) => { out.media = readTlObject(x); });
  optional(r, flags, 6, null, (x) => { out.replyMarkup = readTlObject(x); });
  optional(r, flags, 7, null, (x) => { out.entities = x.vector((rr) => readTlObject(rr)); });
  optional(r, flags, 10, null, (x) => { out.views = x.int(); });
  optional(r, flags, 10, null, (x) => { out.forwards = x.int(); });
  optional(r, flags, 23, null, (x) => { out.replies = readTlObject(x); });
  optional(r, flags, 15, null, (x) => { out.editDate = x.int(); });
  optional(r, flags, 16, null, (x) => { out.postAuthor = x.string(); });
  optional(r, flags, 17, null, (x) => { out.groupedId = x.long(); });
  optional(r, flags, 20, null, (x) => { out.reactions = readTlObject(x); });
  optional(r, flags, 22, null, (x) => { out.restrictionReason = x.vector((rr) => readTlObject(rr)); });
  optional(r, flags, 25, null, (x) => { out.ttlPeriod = x.int(); });
  optional(r, flags, 30, null, (x) => { out.quickReplyShortcutId = x.int(); });
  optional(r, flags2, 2, null, (x) => { out.effect = x.long(); });
  optional(r, flags2, 3, null, (x) => { out.factcheck = readTlObject(x); });
  optional(r, flags2, 5, null, (x) => { out.reportDeliveryUntilDate = x.int(); });
  optional(r, flags2, 6, null, (x) => { out.paidMessageStars = x.long(); });
  optional(r, flags2, 7, null, (x) => { out.suggestedPost = readTlObject(x); });
  optional(r, flags2, 10, null, (x) => { out.scheduleRepeatPeriod = x.int(); });
  optional(r, flags2, 11, null, (x) => { out.summaryFromLanguage = x.string(); });
  optional(r, flags2, 13, null, (x) => { out.richMessage = readTlObject(x); });
  return out;
}

export function writePeerUser(obj, w) {
  const b = begin(ID_PEER_USER, w);
  b.putLong(typeof obj === 'object' ? obj.userId : obj);
  return end(b, w);
}
export function writePeerChat(obj, w) {
  const b = begin(ID_PEER_CHAT, w);
  b.putLong(typeof obj === 'object' ? obj.chatId : obj);
  return end(b, w);
}
export function writePeerChannel(obj, w) {
  const b = begin(ID_PEER_CHANNEL, w);
  b.putLong(typeof obj === 'object' ? obj.channelId : obj);
  return end(b, w);
}
export function readPeer(r) {
  const id = r.uint();
  if (id === ID_PEER_USER) return { _: 'peerUser', userId: r.long() };
  if (id === ID_PEER_CHAT) return { _: 'peerChat', chatId: r.long() };
  if (id === ID_PEER_CHANNEL) return { _: 'peerChannel', channelId: r.long() };
  throw new Error(`readPeer: unsupported constructor 0x${id.toString(16)}`);
}

const CHAT_BOOL_FIELDS = [
  [0, 'creator'], [2, 'left'], [5, 'deactivated'], [23, 'callActive'],
  [24, 'callNotEmpty'], [25, 'noforwards'],
];
export function writeChat(obj, w) {
  const flags = flagsFrom(obj, [
    ...CHAT_BOOL_FIELDS, [6, 'migratedTo'], [14, 'adminRights'],
    [18, 'defaultBannedRights'],
  ]);
  const b = begin(ID_CHAT, w);
  b.putInt(flags);
  for (const [bit, field] of CHAT_BOOL_FIELDS) {
    optional(b, flags, bit, obj[field], (x) => x.putUint(ID_BOOL_TRUE));
  }
  b.putLong(obj.id);
  b.putString(obj.title ?? '');
  putValue(b, obj.photo, writeChatPhotoEmpty);
  b.putInt(obj.participantsCount ?? 0);
  b.putInt(obj.date ?? now());
  b.putInt(obj.version ?? 1);
  optional(b, flags, 6, obj.migratedTo, (x, v) => putValue(x, v));
  optional(b, flags, 14, obj.adminRights, (x, v) => putValue(x, v));
  optional(b, flags, 18, obj.defaultBannedRights, (x, v) => putValue(x, v));
  return end(b, w);
}

const CHANNEL_BOOL_FIELDS = [
  [0, 'creator'], [2, 'left'], [5, 'broadcast'], [7, 'verified'],
  [8, 'megagroup'], [9, 'restricted'], [11, 'signatures'], [12, 'min'],
  [19, 'scam'], [20, 'hasLink'], [21, 'hasGeo'], [22, 'slowmodeEnabled'],
  [23, 'callActive'], [24, 'callNotEmpty'], [25, 'fake'], [26, 'gigagroup'],
  [27, 'noforwards'], [28, 'joinToSend'], [29, 'joinRequest'], [30, 'forum'],
];
const CHANNEL2_BOOL_FIELDS = [
  [1, 'storiesHidden'], [2, 'storiesHiddenMin'], [3, 'storiesUnavailable'],
  [12, 'signatureProfiles'], [15, 'autotranslation'],
  [16, 'broadcastMessagesAllowed'], [17, 'monoforum'], [19, 'forumTabs'],
  [21, 'inNews'], [23, 'forumSidebar'],
];
export function writeChannel(obj, w) {
  const flags = flagsFrom(obj, [
    ...CHANNEL_BOOL_FIELDS, [13, 'accessHash'], [6, 'username'],
    [9, 'restrictionReason'], [14, 'adminRights'], [15, 'bannedRights'],
    [18, 'defaultBannedRights'], [17, 'participantsCount'],
  ]);
  const flags2 = flagsFrom(obj, [
    ...CHANNEL2_BOOL_FIELDS, [0, 'usernames'], [4, 'storiesMaxId'],
    [7, 'color'], [8, 'profileColor'], [9, 'emojiStatus'], [10, 'level'],
    [11, 'subscriptionUntilDate'], [13, 'botVerificationIcon'],
    [14, 'sendPaidMessagesStars'], [18, 'linkedMonoforumId'],
    [20, 'linkedCommunityId'], [22, 'pinnedMsgId'],
  ]);
  const b = begin(ID_CHANNEL, w);
  b.putInt(flags);
  for (const [bit, field] of CHANNEL_BOOL_FIELDS) {
    optional(b, flags, bit, obj[field], (x) => x.putUint(ID_BOOL_TRUE));
  }
  b.putInt(flags2);
  for (const [bit, field] of CHANNEL2_BOOL_FIELDS) {
    optional(b, flags2, bit, obj[field], (x) => x.putUint(ID_BOOL_TRUE));
  }
  b.putLong(obj.id);
  optional(b, flags, 13, obj.accessHash, (x, v) => x.putLong(v), 0n);
  b.putString(obj.title ?? '');
  optional(b, flags, 6, obj.username, (x, v) => x.putString(v), '');
  putValue(b, obj.photo, writeChatPhotoEmpty);
  b.putInt(obj.date ?? now());
  optional(b, flags, 9, obj.restrictionReason, (x, v) => putRawVector(x, v));
  optional(b, flags, 14, obj.adminRights, (x, v) => putValue(x, v));
  optional(b, flags, 15, obj.bannedRights, (x, v) => putValue(x, v));
  optional(b, flags, 18, obj.defaultBannedRights, (x, v) => putValue(x, v));
  optional(b, flags, 17, obj.participantsCount, (x, v) => x.putInt(v), 0);
  optional(b, flags2, 0, obj.usernames, (x, v) => putRawVector(x, v));
  optional(b, flags2, 4, obj.storiesMaxId, (x, v) => putValue(x, v));
  optional(b, flags2, 7, obj.color, (x, v) => putValue(x, v));
  optional(b, flags2, 8, obj.profileColor, (x, v) => putValue(x, v));
  optional(b, flags2, 9, obj.emojiStatus, (x, v) => putValue(x, v));
  optional(b, flags2, 10, obj.level, (x, v) => x.putInt(v), 0);
  optional(b, flags2, 11, obj.subscriptionUntilDate, (x, v) => x.putInt(v), 0);
  optional(b, flags2, 13, obj.botVerificationIcon, (x, v) => x.putLong(v), 0n);
  optional(b, flags2, 14, obj.sendPaidMessagesStars, (x, v) => x.putLong(v), 0n);
  optional(b, flags2, 18, obj.linkedMonoforumId, (x, v) => x.putLong(v), 0n);
  optional(b, flags2, 20, obj.linkedCommunityId, (x, v) => x.putLong(v), 0n);
  optional(b, flags2, 22, obj.pinnedMsgId, (x, v) => x.putInt(v), 0);
  return end(b, w);
}

export function writeChatPhotoEmpty(w) {
  return end(begin(ID_CHAT_PHOTO_EMPTY, w), w);
}

export function readChat(r) {
  const flags = r.uint();
  const out = { flags };
  for (const [bit, field] of CHAT_BOOL_FIELDS) {
    out[field] = !!(flags & (1 << bit)) && r.bool();
  }
  out.id = r.long();
  out.title = r.string();
  out.photo = readTlObject(r);
  out.participantsCount = r.int();
  out.date = r.int();
  out.version = r.int();
  optional(r, flags, 6, null, (x) => { out.migratedTo = readTlObject(x); });
  optional(r, flags, 14, null, (x) => { out.adminRights = readTlObject(x); });
  optional(r, flags, 18, null, (x) => { out.defaultBannedRights = readTlObject(x); });
  return out;
}

export function readChannel(r) {
  const flags = r.uint();
  const out = { flags };
  for (const [bit, field] of CHANNEL_BOOL_FIELDS) {
    out[field] = !!(flags & (1 << bit)) && r.bool();
  }
  const flags2 = r.uint();
  out.flags2 = flags2;
  for (const [bit, field] of CHANNEL2_BOOL_FIELDS) {
    out[field] = !!(flags2 & (1 << bit)) && r.bool();
  }
  out.id = r.long();
  optional(r, flags, 13, null, (x) => { out.accessHash = x.long(); });
  out.title = r.string();
  optional(r, flags, 6, null, (x) => { out.username = x.string(); });
  out.photo = readTlObject(r);
  out.date = r.int();
  optional(r, flags, 9, null, (x) => { out.restrictionReason = x.vector((rr) => readTlObject(rr)); });
  optional(r, flags, 14, null, (x) => { out.adminRights = readTlObject(x); });
  optional(r, flags, 15, null, (x) => { out.bannedRights = readTlObject(x); });
  optional(r, flags, 18, null, (x) => { out.defaultBannedRights = readTlObject(x); });
  optional(r, flags, 17, null, (x) => { out.participantsCount = x.int(); });
  optional(r, flags2, 0, null, (x) => { out.usernames = x.vector((rr) => readTlObject(rr)); });
  optional(r, flags2, 4, null, (x) => { out.storiesMaxId = readTlObject(x); });
  optional(r, flags2, 7, null, (x) => { out.color = readTlObject(x); });
  optional(r, flags2, 8, null, (x) => { out.profileColor = readTlObject(x); });
  optional(r, flags2, 9, null, (x) => { out.emojiStatus = readTlObject(x); });
  optional(r, flags2, 10, null, (x) => { out.level = x.int(); });
  optional(r, flags2, 11, null, (x) => { out.subscriptionUntilDate = x.int(); });
  optional(r, flags2, 13, null, (x) => { out.botVerificationIcon = x.long(); });
  optional(r, flags2, 14, null, (x) => { out.sendPaidMessagesStars = x.long(); });
  optional(r, flags2, 18, null, (x) => { out.linkedMonoforumId = x.long(); });
  optional(r, flags2, 20, null, (x) => { out.linkedCommunityId = x.long(); });
  optional(r, flags2, 22, null, (x) => { out.pinnedMsgId = x.int(); });
  return out;
}

export function writeMessagesSendMessage(obj, w) {
  const flags = flagsFrom(obj, [
    [1, 'noWebpage'], [5, 'silent'], [6, 'background'], [7, 'clearDraft'],
    [14, 'noforwards'], [15, 'updateStickersetsOrder'], [16, 'invertMedia'],
    [19, 'allowPaidFloodskip'], [0, 'replyTo'], [2, 'replyMarkup'],
    [3, 'entities'], [10, 'scheduleDate'], [24, 'scheduleRepeatPeriod'],
    [13, 'sendAs'], [17, 'quickReplyShortcut'], [18, 'effect'],
    [21, 'allowPaidStars'], [22, 'suggestedPost'], [23, 'richMessage'],
  ]);
  const b = begin(ID_MESSAGES_SEND_MESSAGE, w);
  b.putInt(flags);
  for (const [bit, field] of [
    [1, 'noWebpage'], [5, 'silent'], [6, 'background'], [7, 'clearDraft'],
    [14, 'noforwards'], [15, 'updateStickersetsOrder'], [16, 'invertMedia'],
    [19, 'allowPaidFloodskip'],
  ]) optional(b, flags, bit, obj[field], (x) => x.putUint(ID_BOOL_TRUE));
  putValue(b, obj.peer, writeInputPeerEmpty);
  optional(b, flags, 0, obj.replyTo, (x, v) => putValue(x, v));
  b.putString(obj.message ?? '');
  b.putLong(obj.randomId ?? 0);
  optional(b, flags, 2, obj.replyMarkup, (x, v) => putValue(x, v));
  optional(b, flags, 3, obj.entities, (x, v) => putRawVector(x, v));
  optional(b, flags, 10, obj.scheduleDate, (x, v) => x.putInt(v), 0);
  optional(b, flags, 24, obj.scheduleRepeatPeriod, (x, v) => x.putInt(v), 0);
  optional(b, flags, 13, obj.sendAs, (x, v) => putValue(x, v));
  optional(b, flags, 17, obj.quickReplyShortcut, (x, v) => putValue(x, v));
  optional(b, flags, 18, obj.effect, (x, v) => x.putLong(v), 0n);
  optional(b, flags, 21, obj.allowPaidStars, (x, v) => x.putLong(v), 0n);
  optional(b, flags, 22, obj.suggestedPost, (x, v) => putValue(x, v));
  optional(b, flags, 23, obj.richMessage, (x, v) => putValue(x, v));
  return end(b, w);
}

export function writeUpdateShortSentMessage(obj, w) {
  const flags = flagsFrom(obj, [[1, 'out'], [9, 'media'], [7, 'entities'], [25, 'ttlPeriod']]);
  const b = begin(ID_UPDATE_SHORT_SENT_MESSAGE, w);
  b.putInt(flags);
  optional(b, flags, 1, obj.out, (x) => x.putUint(ID_BOOL_TRUE));
  b.putInt(obj.id);
  b.putInt(obj.pts);
  b.putInt(obj.ptsCount);
  b.putInt(obj.date ?? now());
  optional(b, flags, 9, obj.media, (x, v) => putValue(x, v));
  optional(b, flags, 7, obj.entities, (x, v) => putRawVector(x, v));
  optional(b, flags, 25, obj.ttlPeriod, (x, v) => x.putInt(v), 0);
  return end(b, w);
}
export function readUpdateShortSentMessage(r) {
  const flags = r.uint();
  const out = { flags };
  out.out = !!(flags & (1 << 1)) && r.bool();
  out.id = r.int();
  out.pts = r.int();
  out.ptsCount = r.int();
  out.date = r.int();
  optional(r, flags, 9, null, (x) => { out.media = readTlObject(x); });
  optional(r, flags, 7, null, (x) => { out.entities = x.vector((rr) => readTlObject(rr)); });
  optional(r, flags, 25, null, (x) => { out.ttlPeriod = x.int(); });
  return out;
}

// ---- updates -----------------------------------------------------------

export function writeUpdatesGetState(w) {
  return end(begin(ID_UPDATES_GET_STATE, w), w);
}
export function writeUpdatesGetDifference(obj = {}, w) {
  const flags = flagsFrom(obj, [[1, 'ptsLimit'], [0, 'ptsTotalLimit'], [2, 'qtsLimit']]);
  const b = begin(ID_UPDATES_GET_DIFFERENCE, w);
  b.putInt(flags);
  b.putInt(obj.pts);
  optional(b, flags, 1, obj.ptsLimit, (x, v) => x.putInt(v), 0);
  optional(b, flags, 0, obj.ptsTotalLimit, (x, v) => x.putInt(v), 0);
  b.putInt(obj.date);
  b.putInt(obj.qts);
  optional(b, flags, 2, obj.qtsLimit, (x, v) => x.putInt(v), 0);
  return end(b, w);
}

export function writeUpdatesState(obj, w) {
  const b = begin(ID_UPDATES_STATE, w);
  b.putInt(obj.pts ?? 0);
  b.putInt(obj.qts ?? 0);
  b.putInt(obj.date ?? now());
  b.putInt(obj.seq ?? 0);
  b.putInt(obj.unreadCount ?? 0);
  return end(b, w);
}
export function readUpdatesState(r) {
  return {
    pts: r.int(), qts: r.int(), date: r.int(), seq: r.int(),
    unreadCount: r.int(),
  };
}

export function writeUpdatesDifferenceEmpty(obj, w) {
  const b = begin(ID_UPDATES_DIFFERENCE_EMPTY, w);
  b.putInt(obj.date ?? now());
  b.putInt(obj.seq ?? 0);
  return end(b, w);
}
export function readUpdatesDifferenceEmpty(r) {
  return { date: r.int(), seq: r.int() };
}

export function writeUpdates(obj, w) {
  const b = begin(ID_UPDATES, w);
  putRawVector(b, obj.updates ?? []);
  putRawVector(b, obj.users ?? []);
  putRawVector(b, obj.chats ?? []);
  b.putInt(obj.date ?? now());
  b.putInt(obj.seq ?? 0);
  return end(b, w);
}
export function readUpdates(r) {
  return {
    updates: r.vector((rr) => readTlObject(rr)),
    users: r.vector((rr) => readTlObject(rr)),
    chats: r.vector((rr) => readTlObject(rr)),
    date: r.int(), seq: r.int(),
  };
}

export function writeUpdateShort(obj, w) {
  const b = begin(ID_UPDATE_SHORT, w);
  putValue(b, obj.update, writeTaggedUpdate);
  b.putInt(obj.date ?? now());
  return end(b, w);
}
export function readUpdateShort(r) {
  return { update: readUpdate(r), date: r.int() };
}

export function writeUpdateNewMessage(obj, w) {
  const b = begin(ID_UPDATE_NEW_MESSAGE, w);
  putValue(b, obj.message, writeMessage);
  b.putInt(obj.pts);
  b.putInt(obj.ptsCount ?? 1);
  return end(b, w);
}
export function readUpdateNewMessage(r) {
  return { message: readTlObject(r), pts: r.int(), ptsCount: r.int() };
}

export function writeUpdateMessageID(obj, w) {
  const b = begin(ID_UPDATE_MESSAGE_ID, w);
  b.putInt(obj.id);
  b.putLong(obj.randomId);
  return end(b, w);
}
export function readUpdateMessageID(r) {
  return { id: r.int(), randomId: r.long() };
}

function writeTaggedUpdate(obj, w) {
  if (!obj || !obj._) throw new TypeError('writeUpdateShort: update must have `_`');
  const writer = OBJECT_WRITERS.get(obj._);
  if (!writer) throw new TypeError(`writeUpdateShort: unknown update ${obj._}`);
  writer(obj, w);
}
export function readUpdate(r) {
  const id = r.uint();
  if (id === ID_UPDATE_NEW_MESSAGE) return { _: 'updateNewMessage', ...readUpdateNewMessage(r) };
  if (id === ID_UPDATE_MESSAGE_ID) return { _: 'updateMessageID', ...readUpdateMessageID(r) };
  throw new Error(`readUpdate: unsupported constructor 0x${id.toString(16)}`);
}

// ---- uploads -----------------------------------------------------------

export function writeUploadSaveFilePart(obj, w) {
  const b = begin(ID_UPLOAD_SAVE_FILE_PART, w);
  b.putLong(obj.fileId);
  b.putInt(obj.filePart);
  b.putBytes(raw(obj.bytes));
  return end(b, w);
}
export function writeUploadGetFile(obj, w) {
  const flags = flagsFrom(obj, [[0, 'precise'], [1, 'cdnSupported']]);
  const b = begin(ID_UPLOAD_GET_FILE, w);
  b.putInt(flags);
  optional(b, flags, 0, obj.precise, (x) => x.putUint(ID_BOOL_TRUE));
  optional(b, flags, 1, obj.cdnSupported, (x) => x.putUint(ID_BOOL_TRUE));
  putValue(b, obj.location);
  b.putLong(obj.offset ?? 0);
  b.putInt(obj.limit ?? 1024 * 1024);
  return end(b, w);
}
export function writeUploadFile(obj, w) {
  const b = begin(ID_UPLOAD_FILE, w);
  if (typeof obj.type === 'number' || typeof obj.type === 'bigint') {
    b.putUint(obj.type);
  } else {
    putValue(b, obj.type, (x) => x.putUint(ID_STORAGE_FILE_UNKNOWN));
  }
  b.putInt(obj.mtime ?? now());
  b.putBytes(raw(obj.bytes ?? Buffer.alloc(0)));
  return end(b, w);
}
export function readUploadFile(r) {
  const type = r.uint();
  return { type, mtime: r.int(), bytes: r.bytes() };
}
export function writeInputFile(obj, w) {
  const b = begin(ID_INPUT_FILE, w);
  b.putLong(obj.id);
  b.putInt(obj.parts);
  b.putString(obj.name);
  b.putString(obj.md5Checksum ?? '');
  return end(b, w);
}
export function readInputFile(r) {
  return {
    id: r.long(), parts: r.int(), name: r.string(), md5Checksum: r.string(),
  };
}

// ---- input peers / users ----------------------------------------------

export function writeInputPeerEmpty(w) {
  return end(begin(ID_INPUT_PEER_EMPTY, w), w);
}
export function writeInputPeerSelf(w) {
  return end(begin(ID_INPUT_PEER_SELF, w), w);
}
export function writeInputPeerUser(obj, w) {
  const b = begin(ID_INPUT_PEER_USER, w);
  b.putLong(obj.userId);
  b.putLong(obj.accessHash ?? 0);
  return end(b, w);
}
export function writeInputPeerChat(obj, w) {
  const b = begin(ID_INPUT_PEER_CHAT, w);
  b.putLong(typeof obj === 'object' ? obj.chatId : obj);
  return end(b, w);
}
export function writeInputPeerChannel(obj, w) {
  const b = begin(ID_INPUT_PEER_CHANNEL, w);
  b.putLong(obj.channelId);
  b.putLong(obj.accessHash ?? 0);
  return end(b, w);
}
export function writeInputUserSelf(w) {
  return end(begin(ID_INPUT_USER_SELF, w), w);
}
export function writeInputUser(obj, w) {
  const b = begin(ID_INPUT_USER, w);
  b.putLong(obj.userId);
  b.putLong(obj.accessHash ?? 0);
  return end(b, w);
}
export function readInputPeer(r) {
  const id = r.uint();
  if (id === ID_INPUT_PEER_EMPTY) return { _: 'inputPeerEmpty' };
  if (id === ID_INPUT_PEER_SELF) return { _: 'inputPeerSelf' };
  if (id === ID_INPUT_PEER_USER) return { _: 'inputPeerUser', userId: r.long(), accessHash: r.long() };
  if (id === ID_INPUT_PEER_CHAT) return { _: 'inputPeerChat', chatId: r.long() };
  if (id === ID_INPUT_PEER_CHANNEL) return { _: 'inputPeerChannel', channelId: r.long(), accessHash: r.long() };
  throw new Error(`readInputPeer: unsupported constructor 0x${id.toString(16)}`);
}
export function readInputUser(r) {
  const id = r.uint();
  if (id === ID_INPUT_USER_SELF) return { _: 'inputUserSelf' };
  if (id === ID_INPUT_USER) return { _: 'inputUser', userId: r.long(), accessHash: r.long() };
  throw new Error(`readInputUser: unsupported constructor 0x${id.toString(16)}`);
}

// ---- tagged-object dispatch -------------------------------------------

for (const [tag, writer] of [
  ['rpcError', writeRpcError], ['msgsAck', writeMsgsAck], ['pong', writePong],
  ['newSessionCreated', writeNewSessionCreated], ['badMsgNotification', writeBadMsgNotification],
  ['badServerSalt', writeBadServerSalt], ['futureSalt', writeFutureSalt],
  ['futureSalts', writeFutureSalts], ['config', writeConfig], ['dcOption', writeDcOption],
  ['nearestDc', writeNearestDc], ['codeSettings', writeCodeSettings],
  ['auth.sentCode', writeAuthSentCode], ['auth.sentCodeTypeSms', writeAuthSentCodeTypeSms],
  ['auth.authorization', writeAuthAuthorization],
  ['user', writeUser], ['userEmpty', writeUserEmpty], ['contact', writeContact],
  ['peerUser', writePeerUser], ['peerChat', writePeerChat], ['peerChannel', writePeerChannel],
  ['chat', writeChat], ['channel', writeChannel], ['chatPhotoEmpty', writeChatPhotoEmpty],
  ['message', writeMessage], ['updates.state', writeUpdatesState],
  ['updates.differenceEmpty', writeUpdatesDifferenceEmpty], ['updates', writeUpdates],
  ['updateShort', writeUpdateShort], ['updateNewMessage', writeUpdateNewMessage],
  ['updateMessageID', writeUpdateMessageID],
  ['updateShortSentMessage', writeUpdateShortSentMessage],
  ['upload.file', writeUploadFile], ['inputFile', writeInputFile],
  ['inputPeerEmpty', writeInputPeerEmpty], ['inputPeerSelf', writeInputPeerSelf],
  ['inputPeerUser', writeInputPeerUser], ['inputPeerChat', writeInputPeerChat],
  ['inputPeerChannel', writeInputPeerChannel],
  ['inputUserSelf', writeInputUserSelf], ['inputUser', writeInputUser],
  ['reactionEmpty', (obj, w) => end(begin(ID_REACTION_EMPTY, w), w)],
]) OBJECT_WRITERS.set(tag, writer);

for (const [id, reader] of [
  [ID_RPC_RESULT, readRpcResult], [ID_RPC_ERROR, readRpcError],
  [ID_MSGS_ACK, readMsgsAck], [ID_PING, readPing],
  [ID_PONG, readPong], [ID_NEW_SESSION_CREATED, readNewSessionCreated],
  [ID_BAD_MSG_NOTIFICATION, readBadMsgNotification], [ID_BAD_SERVER_SALT, readBadServerSalt],
  [ID_FUTURE_SALT, readFutureSalt], [ID_FUTURE_SALTS, readFutureSalts],
  [ID_MSG_CONTAINER, readMsgContainer], [ID_GZIP_PACKED, readGzipPacked],
  [ID_INVOKE_WITH_LAYER, readInvokeWithLayer], [ID_INIT_CONNECTION, readInitConnection],
  [ID_CONFIG, readConfig], [ID_DC_OPTION, readDcOption], [ID_NEAREST_DC, readNearestDc],
  [ID_CODE_SETTINGS, readCodeSettings], [ID_AUTH_SENT_CODE, readAuthSentCode],
  [ID_AUTH_SENT_CODE_TYPE_SMS, readAuthSentCodeTypeSms],
  [ID_AUTH_AUTHORIZATION, readAuthAuthorization],
  [ID_USER, readUser], [ID_USER_EMPTY, readUserEmpty], [ID_CONTACT, readContact],
  [ID_MESSAGE, readMessage], [ID_CHAT, readChat], [ID_CHANNEL, readChannel],
  [ID_UPDATES_STATE, readUpdatesState],
  [ID_UPDATES_DIFFERENCE_EMPTY, readUpdatesDifferenceEmpty], [ID_UPDATES, readUpdates],
  [ID_UPDATE_SHORT, readUpdateShort], [ID_UPDATE_NEW_MESSAGE, readUpdateNewMessage],
  [ID_UPDATE_MESSAGE_ID, readUpdateMessageID],
  [ID_UPDATE_SHORT_SENT_MESSAGE, readUpdateShortSentMessage],
  [ID_UPLOAD_FILE, readUploadFile], [ID_INPUT_FILE, readInputFile],
  [ID_INPUT_PEER_EMPTY, (r) => ({ _: 'inputPeerEmpty' })],
  [ID_INPUT_PEER_SELF, (r) => ({ _: 'inputPeerSelf' })],
  [ID_INPUT_PEER_USER, (r) => ({ _: 'inputPeerUser', userId: r.long(), accessHash: r.long() })],
  [ID_INPUT_PEER_CHAT, (r) => ({ _: 'inputPeerChat', chatId: r.long() })],
  [ID_INPUT_PEER_CHANNEL, (r) => ({ _: 'inputPeerChannel', channelId: r.long(), accessHash: r.long() })],
  [ID_INPUT_USER_SELF, (r) => ({ _: 'inputUserSelf' })],
  [ID_INPUT_USER, (r) => ({ _: 'inputUser', userId: r.long(), accessHash: r.long() })],
  [ID_PEER_USER, (r) => ({ _: 'peerUser', userId: r.long() })],
  [ID_PEER_CHAT, (r) => ({ _: 'peerChat', chatId: r.long() })],
  [ID_PEER_CHANNEL, (r) => ({ _: 'peerChannel', channelId: r.long() })],
  [ID_CHAT_PHOTO_EMPTY, (r) => ({ _: 'chatPhotoEmpty' })],
  [ID_REACTION_EMPTY, (r) => ({ _: 'reactionEmpty' })],
  [ID_STORAGE_FILE_UNKNOWN, (r) => ({ _: 'storage.fileUnknown' })],
]) OBJECT_READERS.set(id, reader);

/** Read one tagged TL object (constructor ID is consumed here). */
export function readTlObject(r) {
  const id = r.uint();
  const reader = OBJECT_READERS.get(id);
  if (!reader) throw new Error(`readTlObject: unsupported constructor 0x${id.toString(16)}`);
  return { _: objectTagForId(id), ...reader(r) };
}

const TAGS_BY_ID = new Map();
for (const [tag, id] of [
  ['rpcResult', ID_RPC_RESULT], ['rpcError', ID_RPC_ERROR], ['msgsAck', ID_MSGS_ACK],
  ['ping', ID_PING], ['pong', ID_PONG], ['msgContainer', ID_MSG_CONTAINER],
  ['gzipPacked', ID_GZIP_PACKED], ['newSessionCreated', ID_NEW_SESSION_CREATED],
  ['badMsgNotification', ID_BAD_MSG_NOTIFICATION], ['badServerSalt', ID_BAD_SERVER_SALT],
  ['futureSalt', ID_FUTURE_SALT], ['futureSalts', ID_FUTURE_SALTS],
  ['invokeWithLayer', ID_INVOKE_WITH_LAYER], ['initConnection', ID_INIT_CONNECTION],
  ['help.getConfig', ID_HELP_GET_CONFIG], ['config', ID_CONFIG], ['dcOption', ID_DC_OPTION],
  ['help.getNearestDc', ID_HELP_GET_NEAREST_DC], ['nearestDc', ID_NEAREST_DC],
  ['auth.sendCode', ID_AUTH_SEND_CODE], ['codeSettings', ID_CODE_SETTINGS],
  ['auth.sentCode', ID_AUTH_SENT_CODE],
  ['auth.sentCodeTypeSms', ID_AUTH_SENT_CODE_TYPE_SMS],
  ['auth.signIn', ID_AUTH_SIGN_IN], ['auth.signUp', ID_AUTH_SIGN_UP],
  ['auth.authorization', ID_AUTH_AUTHORIZATION], ['user', ID_USER],
  ['userEmpty', ID_USER_EMPTY], ['users.getUsers', ID_USERS_GET_USERS],
  ['users.getFullUser', ID_USERS_GET_FULL_USER],
  ['contacts.getContacts', ID_CONTACTS_GET_CONTACTS], ['contacts.contacts', ID_CONTACTS_CONTACTS],
  ['contact', ID_CONTACT], ['messages.getDialogs', ID_MESSAGES_GET_DIALOGS],
  ['messages.dialogsSlice', ID_MESSAGES_DIALOGS_SLICE],
  ['messages.getHistory', ID_MESSAGES_GET_HISTORY],
  ['messages.messagesSlice', ID_MESSAGES_MESSAGES_SLICE], ['message', ID_MESSAGE],
  ['peerUser', ID_PEER_USER], ['peerChat', ID_PEER_CHAT], ['peerChannel', ID_PEER_CHANNEL],
  ['chat', ID_CHAT], ['channel', ID_CHANNEL], ['chatPhotoEmpty', ID_CHAT_PHOTO_EMPTY],
  ['messages.sendMessage', ID_MESSAGES_SEND_MESSAGE],
  ['updates.getState', ID_UPDATES_GET_STATE], ['updates.state', ID_UPDATES_STATE],
  ['updates.getDifference', ID_UPDATES_GET_DIFFERENCE],
  ['updates.differenceEmpty', ID_UPDATES_DIFFERENCE_EMPTY], ['updates', ID_UPDATES],
  ['updateShort', ID_UPDATE_SHORT], ['updateNewMessage', ID_UPDATE_NEW_MESSAGE],
  ['updateMessageID', ID_UPDATE_MESSAGE_ID],
  ['updateShortSentMessage', ID_UPDATE_SHORT_SENT_MESSAGE],
  ['upload.saveFilePart', ID_UPLOAD_SAVE_FILE_PART], ['upload.getFile', ID_UPLOAD_GET_FILE],
  ['upload.file', ID_UPLOAD_FILE], ['storage.fileUnknown', ID_STORAGE_FILE_UNKNOWN],
  ['inputFile', ID_INPUT_FILE], ['inputPeerEmpty', ID_INPUT_PEER_EMPTY],
  ['inputPeerSelf', ID_INPUT_PEER_SELF], ['inputPeerUser', ID_INPUT_PEER_USER],
  ['inputPeerChat', ID_INPUT_PEER_CHAT], ['inputPeerChannel', ID_INPUT_PEER_CHANNEL],
  ['inputUserSelf', ID_INPUT_USER_SELF], ['inputUser', ID_INPUT_USER],
  ['reactionEmpty', ID_REACTION_EMPTY],
]) TAGS_BY_ID.set(id, tag);

function objectTagForId(id) {
  return TAGS_BY_ID.get(id) || `unknown_${id.toString(16)}`;
}

/** Convenience lookup tables for the RPC router. */
export const OBJECT_IDS = Object.fromEntries(TAGS_BY_ID);
