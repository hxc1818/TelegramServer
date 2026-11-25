// Minimal TL object codecs used by the RPC handlers.
//
// src/tl/objects.js is owned by another agent. We try to load it so the
// hand-written codecs there can be used when present, but every codec below is
// self-contained so this module (and the RPC tests) work before that file lands.
import { TLBuffer } from '../../tl/buffer.js';

export const ID = {
  boolTrue: 0x997275b5,
  boolFalse: 0xbc799737,
  vector: 0x1cb5c415,
  user: 0xb1b8cc83,
  userFull: 0xb90c2afd,
  peerUser: 0x59511722,
  peerChat: 0x36c6019a,
  peerChannel: 0xa2a5371e,
  peerNotifySettings: 0x99622c0c,
  peerSettings: 0x2441c84b,
  sentCode: 0x5e002502,
  sentCodeTypeSms: 0xc000bba2,
  sentCodeTypeApp: 0x3dbb5986,
  codeTypeSms: 0x72a3158c,
  authorization: 0x2ea2c0d4,
  state: 0xa56c2a3e,
  differenceEmpty: 0x5d75a138,
  nearestDc: 0x8e1a1775,
  config: 0xcc1a241e,
  dcOption: 0x18b7a10d,
  dialogsSlice: 0xd1747044,
  dialog: 0xfc89f7f3,
  messagesSlice: 0x5f206716,
  message: 0x7600b9d3,
  updateShortSentMessage: 0x9015e101,
  affectedHistory: 0xb45c69d1,
  affectedMessages: 0x84d19185,
  contacts: 0xeae87e42,
  contact: 0x145ade0b,
  uploadFile: 0x96a18d5,
  fileUnknown: 0xaa963b05,
  noAppUpdate: 0xc45a6536,
  langPackDifference: 0xf385c1f6,
  stickers: 0x30a6ec7e,
  pong: 0x347773c5,
  rpcError: 0x2144ca19,
  msgsAck: 0x62d6b459,
  badServerSalt: 0xedab447b,
  gzipPacked: 0x3072cfa1,
  msgContainer: 0x73f1f8dc,
  rpcResult: 0xf35c6d01,
};

let external = null;
try {
  external = await import('../../tl/objects.js');
} catch {
  external = null;
}

export { external as externalObjects };

const u32 = (v) => Number(v) >>> 0;
const i32 = (v) => Number(v) | 0;

export function boolTrue() {
  return new TLBuffer().putUint(ID.boolTrue).buffer;
}

export function boolFalse() {
  return new TLBuffer().putUint(ID.boolFalse).buffer;
}

const USER_BOOL_BITS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 23, 24, 25, 26, 27, 28, 29];
const USER_BOOL_KEYS = {
  10: 'self', 11: 'contact', 12: 'mutualContact', 13: 'deleted', 14: 'bot',
  15: 'botChatHistory', 16: 'botNochats', 17: 'verified', 18: 'restricted',
  20: 'min', 21: 'botInlineGeo', 23: 'support', 24: 'scam', 25: 'applyMinPhoto',
  26: 'fake', 27: 'botAttachMenu', 28: 'premium', 29: 'attachMenuEnabled',
};

/** User, with self/contact/access_hash/first_name/last_name/phone flags. */
export function user(u = {}) {
  const flags = USER_BOOL_BITS.reduce((f, bit) => f | (u[USER_BOOL_KEYS[bit]] ? 1 << bit : 0), 0)
    | (u.accessHash !== undefined && u.accessHash !== null ? 1 : 0)
    | (u.firstName ? 1 << 1 : 0)
    | (u.lastName ? 1 << 2 : 0)
    | (u.username ? 1 << 3 : 0)
    | (u.phone ? 1 << 4 : 0);
  const b = new TLBuffer();
  b.putUint(ID.user).putUint(flags);
  // flags.10?true ... flags.29?true are boxed boolTrue values, in declaration order.
  for (const bit of USER_BOOL_BITS) if (flags & (1 << bit)) b.putUint(ID.boolTrue);
  b.putUint(0); // flags2 (all optional fields omitted)
  b.putLong(u.id || 0);
  if (flags & 1) b.putLong(u.accessHash || 0);
  if (flags & (1 << 1)) b.putString(u.firstName);
  if (flags & (1 << 2)) b.putString(u.lastName);
  if (flags & (1 << 3)) b.putString(u.username);
  if (flags & (1 << 4)) b.putString(u.phone);
  return b.buffer;
}

export function userFull(u = {}) {
  const b = new TLBuffer();
  b.putUint(ID.userFull).putUint(0).putUint(0).putLong(u.id || 0);
  b.putUint(ID.peerSettings).putUint(0); // settings
  b.putUint(ID.peerNotifySettings).putUint(0); // notify_settings
  b.putInt(i32(u.commonChatsCount || 0));
  return b.buffer;
}

export function peer(p = {}) {
  const type = p.type || p.peerType || 'user';
  if (type === 'chat') return new TLBuffer().putUint(ID.peerChat).putLong(p.id || 0).buffer;
  if (type === 'channel') return new TLBuffer().putUint(ID.peerChannel).putLong(p.id || 0).buffer;
  return new TLBuffer().putUint(ID.peerUser).putLong(p.id || 0).buffer;
}

export function sentCode({ phoneCodeHash = '', length = 5, type = 'sms' } = {}) {
  const b = new TLBuffer();
  b.putUint(ID.sentCode).putUint(0);
  b.putUint(type === 'app' ? ID.sentCodeTypeApp : ID.sentCodeTypeSms).putInt(length);
  b.putString(phoneCodeHash);
  return b.buffer;
}

export function authorization(u = {}) {
  return new TLBuffer().putUint(ID.authorization).putUint(0).putRaw(user(u)).buffer;
}

export function state(s = {}) {
  return new TLBuffer()
    .putUint(ID.state)
    .putInt(i32(s.pts || 0))
    .putInt(i32(s.qts || 0))
    .putInt(i32(s.date || 0))
    .putInt(i32(s.seq || 0))
    .putInt(i32(s.unreadCount ?? s.unread_count ?? 0))
    .buffer;
}

export function differenceEmpty(s = {}) {
  return new TLBuffer().putUint(ID.differenceEmpty).putInt(i32(s.date || 0)).putInt(i32(s.seq || 0)).buffer;
}

export function nearestDc({ country = 'US', thisDc = 1, nearestDc: nearest = 1 } = {}) {
  return new TLBuffer().putUint(ID.nearestDc).putString(country).putInt(i32(thisDc)).putInt(i32(nearest)).buffer;
}

export function dcOption({ id = 1, ip = '127.0.0.1', port = 10443 } = {}) {
  return new TLBuffer()
    .putUint(ID.dcOption)
    .putUint(0)
    .putInt(i32(id))
    .putString(ip)
    .putInt(i32(port))
    .buffer;
}

const CONFIG_NUMBERS = [
  'chatSizeMax', 'megagroupSizeMax', 'forwardedCountMax', 'onlineUpdatePeriodMs',
  'offlineBlurTimeoutMs', 'offlineIdleTimeoutMs', 'onlineCloudTimeoutMs',
  'notifyCloudDelayMs', 'notifyDefaultDelayMs', 'pushChatPeriodMs', 'pushChatLimit',
  'editTimeLimit', 'revokeTimeLimit', 'revokePmTimeLimit', 'ratingEDecay',
  'stickersRecentLimit', 'channelsReadMediaPeriod',
];

const CONFIG_CALL_NUMBERS = [
  'callReceiveTimeoutMs', 'callRingTimeoutMs', 'callConnectTimeoutMs', 'callPacketTimeoutMs',
];

/** help.getConfig result (Config#cc1a241e). */
export function config(c = {}) {
  const b = new TLBuffer();
  b.putUint(ID.config).putUint(0);
  b.putInt(i32(c.date || 0)).putInt(i32(c.expires || 0));
  b.putBool(true); // test_mode
  b.putInt(i32(c.thisDc ?? c.serverId ?? 1));
  b.putVector(c.dcOptions || [], (opt, bb) => bb.putRaw(dcOption(opt)));
  b.putString(c.dcTxtDomainName || '');
  for (const key of CONFIG_NUMBERS) b.putInt(i32(c[key] ?? DEFAULT_CONFIG[key] ?? 0));
  // flags.0 (tmp_sessions) omitted; then the four mandatory call timeouts,
  // me_url_prefix, the optional url/usernames fields, and the final ints.
  for (const key of CONFIG_CALL_NUMBERS) b.putInt(i32(c[key] ?? DEFAULT_CONFIG[key] ?? 0));
  b.putString(c.meUrlPrefix || 'https://me.example');
  b.putInt(i32(c.captionLengthMax ?? 4096)).putInt(i32(c.messageLengthMax ?? 4096));
  b.putInt(i32(c.webfileDcId ?? 1));
  return b.buffer;
}

export const DEFAULT_CONFIG = {
  chatSizeMax: 200,
  megagroupSizeMax: 1000000,
  forwardedCountMax: 100,
  onlineUpdatePeriodMs: 120000,
  offlineBlurTimeoutMs: 5000,
  offlineIdleTimeoutMs: 30000,
  onlineCloudTimeoutMs: 300000,
  notifyCloudDelayMs: 30000,
  notifyDefaultDelayMs: 1500,
  pushChatPeriodMs: 60000,
  pushChatLimit: 2,
  editTimeLimit: 172800,
  revokeTimeLimit: 172800,
  revokePmTimeLimit: 172800,
  ratingEDecay: 2419200,
  stickersRecentLimit: 30,
  channelsReadMediaPeriod: 86400,
  callReceiveTimeoutMs: 20000,
  callRingTimeoutMs: 90000,
  callConnectTimeoutMs: 30000,
  callPacketTimeoutMs: 10000,
};

export function dialog(d = {}) {
  const flags = d.pinned ? 1 << 2 : 0;
  const b = new TLBuffer();
  b.putUint(ID.dialog).putUint(flags);
  if (flags & (1 << 2)) b.putUint(ID.boolTrue); // pinned:true
  b.putRaw(peer(d));
  b.putInt(i32(d.topMessage || 0));
  b.putInt(i32(d.readInboxMaxId || 0));
  b.putInt(i32(d.readOutboxMaxId || 0));
  b.putInt(i32(d.unreadCount || 0));
  b.putInt(0).putInt(0).putInt(0); // mentions, reactions, poll votes
  b.putUint(ID.peerNotifySettings).putUint(0);
  return b.buffer;
}

export function message(m = {}) {
  const fromId = m.fromId !== undefined && m.fromId !== null && m.fromId !== 0;
  const flags = (m.out ? 1 << 1 : 0) | (fromId ? 1 << 8 : 0);
  const b = new TLBuffer();
  b.putUint(ID.message).putUint(flags);
  if (flags & (1 << 1)) b.putUint(ID.boolTrue); // out:true
  b.putUint(0); // flags2
  b.putInt(i32(m.id || 0));
  if (fromId) b.putRaw(peer({ type: 'user', id: m.fromId }));
  b.putRaw(peer(m));
  b.putInt(i32(m.date || 0));
  b.putString(m.text || '');
  return b.buffer;
}

export function dialogsSlice({ count = 0, dialogs: ds = [], messages: ms = [], chats = [], users = [] } = {}) {
  const b = new TLBuffer();
  b.putUint(ID.dialogsSlice).putUint(0).putInt(i32(count));
  b.putVector([], (_, bb) => bb);
  b.putVector(ds, (d, bb) => bb.putRaw(dialog(d)));
  b.putVector(ms, (m, bb) => bb.putRaw(message(m)));
  b.putVector(chats, (c, bb) => bb.putRaw(c));
  b.putVector(users, (u, bb) => bb.putRaw(Buffer.isBuffer(u) ? u : user(u)));
  return b.buffer;
}

export function messagesSlice({ count = 0, messages: ms = [], chats = [], users = [] } = {}) {
  const b = new TLBuffer();
  b.putUint(ID.messagesSlice).putUint(0).putInt(i32(count));
  b.putVector(ms, (m, bb) => bb.putRaw(Buffer.isBuffer(m) ? m : message(m)));
  b.putVector([], (_, bb) => bb); // topics
  b.putVector(chats, (c, bb) => bb.putRaw(Buffer.isBuffer(c) ? c : c));
  b.putVector(users, (u, bb) => bb.putRaw(Buffer.isBuffer(u) ? u : user(u)));
  return b.buffer;
}

export function updateShortSentMessage({ out = true, id = 0, pts = 0, ptsCount = 1, date = 0 } = {}) {
  const b = new TLBuffer();
  b.putUint(ID.updateShortSentMessage).putUint(out ? 1 << 1 : 0);
  if (out) b.putUint(ID.boolTrue); // out:true
  b.putInt(i32(id)).putInt(i32(pts)).putInt(i32(ptsCount)).putInt(i32(date));
  return b.buffer;
}

export function affectedHistory({ pts = 0, ptsCount = 1, offset = 0 } = {}) {
  return new TLBuffer().putUint(ID.affectedHistory).putInt(i32(pts)).putInt(i32(ptsCount)).putInt(i32(offset)).buffer;
}

export function affectedMessages({ pts = 0, ptsCount = 1 } = {}) {
  return new TLBuffer().putUint(ID.affectedMessages).putInt(i32(pts)).putInt(i32(ptsCount)).buffer;
}

export function contacts({ list = [], users: us = [], savedCount } = {}) {
  const b = new TLBuffer();
  b.putUint(ID.contacts);
  b.putVector(list, (c, bb) => bb.putUint(ID.contact).putLong(c.userId || 0).putBool(!!c.mutual));
  b.putInt(i32(savedCount ?? list.length));
  b.putVector(us, (u, bb) => bb.putRaw(Buffer.isBuffer(u) ? u : user(u)));
  return b.buffer;
}

export function uploadFile({ data = Buffer.alloc(0), mtime = 0, partial = false } = {}) {
  return new TLBuffer()
    .putUint(ID.uploadFile)
    .putUint(partial ? 0x40bc6f52 : ID.fileUnknown)
    .putInt(i32(mtime))
    .putBytes(data)
    .buffer;
}

export function noAppUpdate() {
  return new TLBuffer().putUint(ID.noAppUpdate).buffer;
}

export function langPackDifference({ langCode = 'en', fromVersion = 0, version = 1 } = {}) {
  return new TLBuffer()
    .putUint(ID.langPackDifference)
    .putString(langCode).putInt(i32(fromVersion)).putInt(i32(version))
    .putVector([], (_, bb) => bb)
    .buffer;
}

export function stickers({ hash = 0 } = {}) {
  return new TLBuffer().putUint(ID.stickers).putLong(hash).putVector([], (_, bb) => bb).buffer;
}

export function pong({ msgId = 0n, pingId = 0n } = {}) {
  return new TLBuffer().putUint(ID.pong).putLong(msgId).putLong(pingId).buffer;
}

export function rpcError({ code = -501, message = 'NOT_IMPLEMENTED' } = {}) {
  return new TLBuffer().putUint(ID.rpcError).putInt(i32(code)).putString(message).buffer;
}

export function msgsAck(ids = []) {
  return new TLBuffer().putUint(ID.msgsAck).putVector(ids, (id, bb) => bb.putLong(id)).buffer;
}

export function badServerSalt({ badMsgId = 0n, badMsgSeqno = 0, errorCode = 32, newServerSalt = 0n } = {}) {
  return new TLBuffer()
    .putUint(ID.badServerSalt)
    .putLong(badMsgId).putInt(i32(badMsgSeqno)).putInt(i32(errorCode)).putLong(newServerSalt)
    .buffer;
}

export function gzipPacked(data) {
  return new TLBuffer().putUint(ID.gzipPacked).putBytes(data).buffer;
}

export function rpcResult(reqMsgId, result) {
  return new TLBuffer().putUint(ID.rpcResult).putLong(reqMsgId).putRaw(result).buffer;
}

export default {
  ID, boolTrue, boolFalse, user, userFull, peer, sentCode, authorization, state,
  differenceEmpty, nearestDc, config, dcOption, dialog, message, dialogsSlice,
  messagesSlice, updateShortSentMessage, affectedHistory, affectedMessages,
  contacts, uploadFile, noAppUpdate, langPackDifference, stickers, pong, rpcError,
  msgsAck, badServerSalt, gzipPacked, rpcResult,
};
