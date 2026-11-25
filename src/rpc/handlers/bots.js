// Bot RPC handlers for layer 234. Every constructor/method id below was
// grep-verified against schema/api.tl (layer 234); none are guessed.
//
// Layer 234 has no messages.getBotData, messages.saveGameScore or
// messages.getSavedMessages functions: the game-score RPC is
// messages.setGameScore#8ef8ecc0 and the scheduled-message RPCs are listed in
// METHOD_IDS below.
//
// Every handler accepts a TLBuffer positioned after the request constructor id
// (the form the Router supplies) or a plain parameter object (unit tests /
// programmatic dispatch). Results are encoded with local TLBuffer encoders so
// no shared handler module has to change.

import { TLBuffer } from '../../tl/buffer.js';
import * as C from './codecs.js';
import { isReader, readInputPeer, readInputUser, skipInputReplyTo } from './parsers.js';
import { authKeyIdOf, currentUser } from './context.js';
import { BotStore } from '../../store/bots.js';

/** Verified layer-234 constructor ids used by this module. */
export const BOT_ID = Object.freeze({
  boolTrue: 0x997275b5,                     // boolTrue#997275b5
  boolFalse: 0xbc799737,                    // boolFalse#bc799737
  vector: 0x1cb5c415,                       // vector#1cb5c415
  messagesBotResults: 0xe021f2f6,           // messages.botResults#e021f2f6
  botInlineResult: 0x11965f3a,              // botInlineResult#11965f3a
  botInlineMessageText: 0x8c7f65e2,         // botInlineMessageText#8c7f65e2
  messagesHighScores: 0x9a3bfd99,           // messages.highScores#9a3bfd99
  highScore: 0x73a379eb,                    // highScore#73a379eb
  messagesMessages: 0x1d73e7ea,             // messages.messages#1d73e7ea
  updates: 0x74ae4240,                      // updates#74ae4240
  updateNewMessage: 0x1f2b0afd,             // updateNewMessage#1f2b0afd
  updateDeleteMessages: 0xa20db0e5,         // updateDeleteMessages#a20db0e5
  updateShortSentMessage: 0x9015e101,       // updateShortSentMessage#9015e101
  affectedHistory: 0xb45c69d1,              // messages.affectedHistory#b45c69d1
  message: 0x7600b9d3,                      // message#7600b9d3
  peerUser: 0x59511722,                     // peerUser#59511722
  peerChat: 0x36c6019a,                     // peerChat#36c6019a
  peerChannel: 0xa2a5371e,                  // peerChannel#a2a5371e
  botsBotInfo: 0xe8a775b0,                  // bots.botInfo#e8a775b0
  botCommand: 0x9852d6d2,                   // botCommand#9852d6d2
  botMenuButtonDefault: 0x7533a588,         // botMenuButtonDefault#7533a588
  inputBotInlineMessageText: 0x3dcd7a87,    // inputBotInlineMessageText#3dcd7a87
});

/** Verified RPC constructor ids (schema/api.tl, layer 234). */
export const METHOD_IDS = Object.freeze({
  'messages.getInlineBotResults': 0x514e999d,
  'messages.sendInlineBotResult': 0xc0cf7646,
  'messages.setGameScore': 0x8ef8ecc0,
  'messages.getGameHighScores': 0xe822649d,
  'messages.getScheduledMessages': 0xbdbb0464,
  'messages.sendScheduledMessages': 0xbd38850a,
  'messages.deleteScheduledMessages': 0x59ae2b16,
  'bots.setBotInfo': 0x10cf3123,
  'bots.getBotInfo': 0xdcd914fd,
  'bots.setBotCommands': 0x517165a,
  'bots.getBotCommands': 0xe34c0dd6,
  'bots.canSendMessage': 0x1359f4e6,
  'bots.checkUsername': 0xe3ac4c61,
  'bots.getBotMenuButton': 0x9c60eb28,
  'bots.getAdminedBots': 0xb0711d83,
});

const i32 = (v) => Number(v) | 0;
const now = () => Math.floor(Date.now() / 1000);
const toBig = (v) => (v === undefined || v === null ? 0n : BigInt(v));

function boolTrue() {
  return new TLBuffer().putUint(BOT_ID.boolTrue).buffer;
}

function boolFalse() {
  return new TLBuffer().putUint(BOT_ID.boolFalse).buffer;
}

/** Resolve (or lazily create) the dedicated bot store. */
export function botStoreOf(ctx = {}) {
  if (ctx.botStore) return ctx.botStore;
  if (ctx.store && typeof ctx.store.setInlineResults === 'function') return ctx.store;
  if (!ctx._botStore) {
    const dataDir = ctx.dataDir || ctx.store?.dataDir || ctx.config?.dataDir || './data';
    ctx._botStore = new BotStore(dataDir);
  }
  return ctx._botStore;
}

function userIdOf(ctx = {}) {
  return currentUser(ctx.store, ctx)?.id || Number(ctx.userId) || 0;
}

function nextPts(ctx = {}) {
  if (!ctx.store?.nextPts) return 1;
  return ctx.store.nextPts(userIdOf(ctx), authKeyIdOf(ctx));
}

function resolveBot(bots, ref) {
  if (ref && typeof ref === 'object') {
    return bots.getBot(ref.id ?? ref.userId ?? ref.botId ?? 0);
  }
  if (ref === undefined || ref === null || ref === '') return bots.listBots()[0] || null;
  return bots.getBot(ref);
}

function hashOf(text) {
  let h = 0x811c9dc5;
  const str = String(text);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function readIdVector(r, key = 'id') {
  if (isReader(r)) return r.has(4) ? r.vector((rr) => rr.int()) : [];
  const value = r?.[key] ?? r?.ids ?? [];
  return (Array.isArray(value) ? value : [value]).map((v) => i32(v)).filter(Boolean);
}

function skipGeoPoint(r) {
  if (!isReader(r) || !r.has(4)) return;
  const id = r.uint() >>> 0;
  // inputGeoPoint#48222faf flags:# lat:double long:double accuracy_radius:flags.0?int
  if (id === 0x48222faf) {
    const flags = r.has(4) ? r.uint() : 0;
    if (r.has(16)) r.raw(16);
    if ((flags & 1) && r.has(4)) r.int();
  }
}

function peerKeyOf(peer) {
  const p = peer && typeof peer === 'object' ? peer : { type: 'user', id: Number(peer) || 0 };
  return `${p.type || p.peerType || 'user'}:${Number(p.id ?? p.peerId ?? 0) || 0}`;
}

// ---- local TL encoders --------------------------------------------------
function tlPeer(p = {}) {
  const b = new TLBuffer();
  const type = p.type || p.peerType || 'user';
  const id = toBig(p.id ?? p.peerId ?? 0);
  if (type === 'chat') return b.putUint(BOT_ID.peerChat).putLong(id).buffer;
  if (type === 'channel') return b.putUint(BOT_ID.peerChannel).putLong(id).buffer;
  return b.putUint(BOT_ID.peerUser).putLong(id).buffer;
}

/** message#7600b9d3 (only out / from_id / from_scheduled optional fields). */
function tlMessage(m = {}) {
  const fromId = Number(m.fromId) || 0;
  const flags = (m.out ? 1 << 1 : 0)
    | (fromId ? 1 << 8 : 0)
    | (m.fromScheduled ? 1 << 18 : 0);
  const b = new TLBuffer();
  b.putUint(BOT_ID.message).putUint(flags);
  if (flags & (1 << 1)) b.putUint(BOT_ID.boolTrue); // out:true
  if (flags & (1 << 18)) b.putUint(BOT_ID.boolTrue); // from_scheduled:true
  b.putUint(0); // flags2
  b.putInt(i32(m.id || 0));
  if (flags & (1 << 8)) b.putRaw(tlPeer({ type: 'user', id: fromId }));
  b.putRaw(tlPeer({ type: m.peerType ?? m.type, id: m.peerId ?? m.id }));
  b.putInt(i32(m.date || 0));
  b.putString(m.text || '');
  return b.buffer;
}

function tlUpdates(list = [], users = [], chats = [], date = now(), seq = 0) {
  const b = new TLBuffer();
  b.putUint(BOT_ID.updates);
  b.putVector(list, (item, bb) => bb.putRaw(item));
  b.putVector(users, (u, bb) => bb.putRaw(Buffer.isBuffer(u) ? u : C.user(u)));
  b.putVector(chats, (chat, bb) => bb.putRaw(Buffer.isBuffer(chat) ? chat : chat));
  b.putInt(i32(date)).putInt(i32(seq));
  return b.buffer;
}

function tlUpdateNewMessage(messageBuf, pts, ptsCount = 1) {
  return new TLBuffer()
    .putUint(BOT_ID.updateNewMessage)
    .putRaw(messageBuf)
    .putInt(i32(pts)).putInt(i32(ptsCount)).buffer;
}

function tlUpdateDeleteMessages(ids, pts, ptsCount = 1) {
  return new TLBuffer()
    .putUint(BOT_ID.updateDeleteMessages)
    .putVector(ids, (id, b) => b.putInt(i32(id)))
    .putInt(i32(pts)).putInt(i32(ptsCount)).buffer;
}

/** messages.messages#1d73e7ea. */
function tlMessages(messages = [], users = []) {
  const b = new TLBuffer();
  b.putUint(BOT_ID.messagesMessages);
  b.putVector(messages, (m, bb) => bb.putRaw(Buffer.isBuffer(m) ? m : tlMessage(m)));
  b.putVector([], (_, bb) => bb); // topics
  b.putVector([], (_, bb) => bb); // chats
  b.putVector(users, (u, bb) => bb.putRaw(Buffer.isBuffer(u) ? u : C.user(u)));
  return b.buffer;
}

/** botInlineResult#11965f3a with a botInlineMessageText#8c7f65e2 send_message. */
function tlInlineResult(result = {}) {
  const flags = (result.title ? 1 << 1 : 0)
    | (result.description ? 1 << 2 : 0)
    | (result.url ? 1 << 3 : 0);
  const b = new TLBuffer();
  b.putUint(BOT_ID.botInlineResult).putUint(flags);
  b.putString(result.id ?? '');
  b.putString(result.type ?? 'article');
  if (flags & (1 << 1)) b.putString(result.title);
  if (flags & (1 << 2)) b.putString(result.description);
  if (flags & (1 << 3)) b.putString(result.url);
  b.putUint(BOT_ID.botInlineMessageText).putUint(0);
  b.putString(result.message ?? result.text ?? '');
  return b.buffer;
}

/** messages.botResults#e021f2f6 (gallery / next_offset / switch_pm omitted). */
function tlBotResults({ queryId = 0n, results = [], users = [], cacheTime = 60 } = {}) {
  const b = new TLBuffer();
  b.putUint(BOT_ID.messagesBotResults).putUint(0); // flags
  b.putLong(toBig(queryId));
  b.putVector(results, (result, bb) => bb.putRaw(Buffer.isBuffer(result) ? result : tlInlineResult(result)));
  b.putInt(i32(cacheTime));
  b.putVector(users, (u, bb) => bb.putRaw(Buffer.isBuffer(u) ? u : C.user(u)));
  return b.buffer;
}

/** messages.highScores#9a3bfd99. */
function tlHighScores(scores = [], users = []) {
  const b = new TLBuffer();
  b.putUint(BOT_ID.messagesHighScores);
  b.putVector(scores, (score, bb) => bb
    .putUint(BOT_ID.highScore)
    .putInt(i32(score.pos || 0))
    .putLong(toBig(score.userId ?? score.user_id ?? 0))
    .putInt(i32(score.score || 0)));
  b.putVector(users, (u, bb) => bb.putRaw(Buffer.isBuffer(u) ? u : C.user(u)));
  return b.buffer;
}

/** bots.botInfo#e8a775b0. */
function tlBotInfo(bot = {}) {
  const name = String(bot.username || 'bot');
  return new TLBuffer()
    .putUint(BOT_ID.botsBotInfo)
    .putString(name)
    .putString(`Bot @${name}`)
    .putString('')
    .buffer;
}

function tlBotCommand(cmd = {}) {
  return new TLBuffer()
    .putUint(BOT_ID.botCommand)
    .putUint(0)
    .putString(cmd.command ?? '')
    .putString(cmd.description ?? '')
    .buffer;
}

function botUser(bot) {
  if (!bot) return null;
  return C.user({
    id: bot.id,
    accessHash: bot.accessHash,
    username: bot.username,
    firstName: bot.username,
    bot: true,
  });
}

// ---- handlers -----------------------------------------------------------

/** messages.getInlineBotResults#514e999d -> messages.botResults#e021f2f6. */
export function getInlineBotResults(params, ctx = {}) {
  let botRef;
  let query = '';
  if (isReader(params)) {
    const flags = params.has(4) ? params.uint() : 0;
    botRef = readInputUser(params);
    readInputPeer(params);
    if (flags & 1) skipGeoPoint(params);
    query = params.has(1) ? params.string() : '';
    if (params.has(1)) params.string(); // offset
  } else {
    const p = params || {};
    botRef = p.bot ?? p.userId ?? p.botId;
    query = String(p.query ?? p.q ?? '');
  }
  const bots = botStoreOf(ctx);
  const bot = resolveBot(bots, botRef);
  const stored = bots.getInlineResults(query);
  const results = stored.length ? stored : [{
    id: `inline:${hashOf(query).toString(16)}`,
    type: 'article',
    title: query || 'Demo result',
    description: 'Inline result from demo_bot',
    message: query || 'Hello from demo_bot',
  }];
  const queryId = isReader(params)
    ? BigInt(hashOf(`${bot?.id ?? 0}:${query}`)) | 0x7e00000000000000n
    : (params?.queryId !== undefined ? toBig(params.queryId) : BigInt(hashOf(`${bot?.id ?? 0}:${query}`)) | 0x7e00000000000000n);
  const userBuf = botUser(bot);
  return tlBotResults({
    queryId,
    results,
    users: userBuf ? [userBuf] : [],
    cacheTime: Number(params?.cacheTime ?? 60) || 60,
  });
}

/** messages.sendInlineBotResult#c0cf7646 -> updates#74ae4240. */
export function sendInlineBotResult(params, ctx = {}) {
  let peer;
  let resultId = '';
  let scheduleDate = 0;
  if (isReader(params)) {
    const flags = params.has(4) ? params.uint() : 0;
    peer = readInputPeer(params);
    if (flags & 1) skipInputReplyTo(params);
    if (params.has(8)) params.long(); // random_id
    if (params.has(8)) params.long(); // query_id
    resultId = params.has(1) ? params.string() : '';
    scheduleDate = (flags & (1 << 10)) && params.has(4) ? params.int() : 0;
  } else {
    const p = params || {};
    peer = p.peer ?? { type: 'user', id: 0 };
    resultId = String(p.id ?? p.resultId ?? '');
    scheduleDate = Number(p.scheduleDate ?? 0) || 0;
  }
  const text = String(params?.text ?? params?.message ?? resultId ?? '');
  const bots = botStoreOf(ctx);
  const key = peerKeyOf(peer);
  if (scheduleDate > now()) {
    bots.saveScheduledMessage({ userId: userIdOf(ctx), peerKey: key, text, scheduleDate });
    return tlUpdates([], [], [], now(), 0);
  }
  const userId = userIdOf(ctx);
  const stored = ctx.store?.putMessage?.({
    fromId: userId,
    peerType: peer?.type || peer?.peerType || 'user',
    peerId: Number(peer?.id ?? peer?.peerId ?? 0) || 0,
    text,
    randomId: Number(params?.randomId ?? 0) || 0,
    out: 1,
  }) || { id: 1, fromId: userId, date: now(), text, ...peer };
  const pts = nextPts(ctx);
  return tlUpdates([tlUpdateNewMessage(tlMessage({ ...stored, out: true }), pts)], [], [], now(), 0);
}

/** messages.setGameScore#8ef8ecc0 -> updates#74ae4240. */
export function setGameScore(params, ctx = {}) {
  let gameId = 0;
  let score = 0;
  let userId = userIdOf(ctx);
  if (isReader(params)) {
    if (params.has(4)) params.uint(); // flags
    readInputPeer(params);
    gameId = params.has(4) ? params.int() : 0;
    userId = Number(readInputUser(params).id ?? userId) || userId;
    score = params.has(4) ? params.int() : 0;
  } else {
    const p = params || {};
    gameId = Number(p.id ?? p.gameId ?? 0) || 0;
    score = Number(p.score ?? 0) || 0;
    if (p.userId !== undefined) userId = Number(p.userId) || userId;
  }
  botStoreOf(ctx).saveGameScore(userId, gameId, score);
  return tlUpdates([], [], [], now(), 0);
}

/** messages.getGameHighScores#e822649d -> messages.highScores#9a3bfd99. */
export function getGameHighScores(params, ctx = {}) {
  let gameId = 0;
  if (isReader(params)) {
    readInputPeer(params);
    gameId = params.has(4) ? params.int() : 0;
    readInputUser(params);
  } else {
    gameId = Number(params?.id ?? params?.gameId ?? 0) || 0;
  }
  const rows = botStoreOf(ctx).getGameScores(gameId);
  const scores = rows.map((row, index) => ({ ...row, pos: index + 1 }));
  const users = [];
  if (ctx.store?.getUser) {
    for (const score of scores) {
      const u = ctx.store.getUser(Number(score.userId));
      if (u) users.push(C.user({ ...u, id: u.id }));
    }
  }
  return tlHighScores(scores, users);
}

/** messages.getScheduledMessages#bdbb0464 -> messages.messages#1d73e7ea. */
export function getScheduledMessages(params, ctx = {}) {
  let peer;
  let ids;
  if (isReader(params)) {
    peer = readInputPeer(params);
    ids = params.has(4) ? params.vector((rr) => rr.int()) : [];
  } else {
    peer = params?.peer ?? { type: 'user', id: 0 };
    ids = readIdVector(params);
  }
  const rows = botStoreOf(ctx).listScheduled(userIdOf(ctx))
    .filter((row) => !ids.length || ids.includes(i32(row.id)));
  const messages = rows.map((row) => {
    const [type, id] = String(row.peerKey || peerKeyOf(peer)).split(':');
    return {
      id: row.id,
      out: true,
      fromScheduled: true,
      peerType: type,
      peerId: Number(id) || 0,
      date: row.scheduleDate || row.date,
      text: row.text,
    };
  });
  return tlMessages(messages, []);
}

/** messages.sendScheduledMessages#bd38850a -> updates#74ae4240. */
export function sendScheduledMessages(params, ctx = {}) {
  let peer;
  let ids;
  if (isReader(params)) {
    peer = readInputPeer(params);
    ids = params.has(4) ? params.vector((rr) => rr.int()) : [];
  } else {
    peer = params?.peer ?? { type: 'user', id: 0 };
    ids = readIdVector(params);
  }
  const bots = botStoreOf(ctx);
  const rows = bots.listScheduled(userIdOf(ctx))
    .filter((row) => !ids.length || ids.includes(i32(row.id)));
  const targets = rows.length ? rows : ids.map((id) => ({ id, peerKey: peerKeyOf(peer), text: '', scheduleDate: now() }));
  const updates = [];
  for (const row of targets) {
    bots.deleteScheduled(row.id);
    const [type, id] = String(row.peerKey || peerKeyOf(peer)).split(':');
    const stored = ctx.store?.putMessage?.({
      fromId: userIdOf(ctx),
      peerType: type,
      peerId: Number(id) || 0,
      text: row.text,
      randomId: row.id,
      out: 1,
    }) || { id: row.id, date: now(), text: row.text, peerType: type, peerId: Number(id) || 0 };
    updates.push(tlUpdateNewMessage(tlMessage({ ...stored, out: true }), nextPts(ctx)));
  }
  return tlUpdates(updates, [], [], now(), 0);
}

/** messages.deleteScheduledMessages#59ae2b16 -> updates#74ae4240. */
export function deleteScheduledMessages(params, ctx = {}) {
  let ids;
  if (isReader(params)) {
    readInputPeer(params);
    ids = params.has(4) ? params.vector((rr) => rr.int()) : [];
  } else {
    ids = readIdVector(params);
  }
  const bots = botStoreOf(ctx);
  for (const id of ids) bots.deleteScheduled(id);
  const pts = nextPts(ctx);
  return tlUpdates(ids.length ? [tlUpdateDeleteMessages(ids, pts)] : [], [], [], now(), 0);
}

/** bots.getBotInfo#dcd914fd -> bots.botInfo#e8a775b0. */
export function getBotInfo(params, ctx = {}) {
  let botRef;
  if (isReader(params)) {
    const flags = params.has(4) ? params.uint() : 0;
    if (flags & 1) botRef = readInputUser(params);
    if (params.has(1)) params.string(); // lang_code
  } else {
    botRef = params?.bot ?? params?.userId ?? params?.id;
  }
  const bot = resolveBot(botStoreOf(ctx), botRef);
  return tlBotInfo(bot || { username: 'bot' });
}

/** bots.setBotInfo#10cf3123 -> boolTrue#997275b5. */
export function setBotInfo(params, ctx = {}) {
  if (isReader(params)) {
    const flags = params.has(4) ? params.uint() : 0;
    if (flags & (1 << 2)) readInputUser(params);
    if (params.has(1)) params.string(); // lang_code
    for (const bit of [3, 0, 1]) {
      if ((flags & (1 << bit)) && params.has(1)) params.string();
    }
  }
  return boolTrue();
}

/** bots.canSendMessage#1359f4e6 -> boolTrue#997275b5. */
export function canSendMessage(params, ctx = {}) {
  const ref = isReader(params) ? readInputUser(params) : (params?.bot ?? params?.userId ?? params);
  return botStoreOf(ctx).getBot(typeof ref === 'object' ? (ref?.id ?? 0) : ref) ? boolTrue() : boolFalse();
}

/** bots.checkUsername#e3ac4c61 -> Bool. */
export function checkUsername(params, ctx = {}) {
  let username = '';
  if (isReader(params)) {
    if (params.has(4)) params.uint(); // flags (additional:true consumes no bytes)
    username = params.has(1) ? params.string() : '';
  } else {
    username = String(params?.username ?? '');
  }
  const name = username.replace(/^@/, '');
  return botStoreOf(ctx).getBot(name) ? boolFalse() : boolTrue();
}

/** bots.getBotCommands#e34c0dd6 -> Vector<BotCommand>. */
export function getBotCommands(params, ctx = {}) {
  if (isReader(params)) {
    if (params.has(4)) params.uint(); // scope constructor
    if (params.has(1)) params.string(); // lang_code
  }
  const commands = isReader(params) ? [] : (Array.isArray(params?.commands) ? params.commands : []);
  return new TLBuffer().putVector(commands, (cmd, b) => b.putRaw(tlBotCommand(cmd))).buffer;
}

/** bots.setBotCommands#517165a -> boolTrue#997275b5. */
export function setBotCommands(params, ctx = {}) {
  if (isReader(params)) {
    if (params.has(4)) params.uint(); // scope constructor
    if (params.has(1)) params.string(); // lang_code
    if (params.has(4)) params.vector((rr) => {
      if (rr.has(4)) rr.uint(); // botCommand flags
      if (rr.has(1)) rr.string(); // command
      if (rr.has(1)) rr.string(); // description
    });
  }
  return boolTrue();
}

/** bots.getBotMenuButton#9c60eb28 -> botMenuButtonDefault#7533a588. */
export function getBotMenuButton(params, ctx = {}) {
  if (isReader(params)) readInputUser(params);
  return new TLBuffer().putUint(BOT_ID.botMenuButtonDefault).buffer;
}

/** bots.getAdminedBots#b0711d83 -> Vector<User>. */
export function getAdminedBots(params, ctx = {}) {
  const bots = botStoreOf(ctx).listBots();
  const users = bots.map(botUser).filter(Boolean);
  return new TLBuffer().putVector(users, (buf, b) => b.putRaw(buf)).buffer;
}

/** Kept for symmetry with the other handler modules. */
export const getBotData = getBotInfo;

export default {
  BOT_ID,
  METHOD_IDS,
  getInlineBotResults,
  sendInlineBotResult,
  setGameScore,
  getGameHighScores,
  getScheduledMessages,
  sendScheduledMessages,
  deleteScheduledMessages,
  getBotInfo,
  setBotInfo,
  getBotCommands,
  setBotCommands,
  canSendMessage,
  checkUsername,
  getBotMenuButton,
  getAdminedBots,
};
