// Messaging extras for layer 234. Every constructor id below was verified
// against the pinned schema/api.tl (layer 234) with grep; none are guessed.
// Handlers accept either a TLBuffer positioned after the constructor id (the
// form the Router supplies) or a plain parameter object (unit tests / programmatic
// dispatch), matching the convention used by the other handler modules.
import { TLBuffer } from '../../tl/buffer.js';
import * as C from './codecs.js';
import { isReader, readInputPeer, skipInputReplyTo } from './parsers.js';
import { authKeyIdOf, currentUser } from './context.js';
import { MessagingExtraStore, peerKeyOf } from '../../store/messaging-extra.js';

const i32 = (v) => Number(v) | 0;
const now = () => Math.floor(Date.now() / 1000);

/** Verified layer-234 constructor ids used by this module. */
export const EXTRA_ID = Object.freeze({
  boolTrue: 0x997275b5,                    // boolTrue#997275b5
  vector: 0x1cb5c415,                      // vector#1cb5c415
  peerUser: 0x59511722,                    // peerUser#59511722
  peerChat: 0x36c6019a,                    // peerChat#36c6019a
  peerChannel: 0xa2a5371e,                 // peerChannel#a2a5371e
  message: 0x7600b9d3,                     // message#7600b9d3
  messageFwdHeader: 0x4e4df4bb,            // messageFwdHeader#4e4df4bb
  draftMessage: 0x9cb1d4fa,                // draftMessage#9cb1d4fa
  reactionEmoji: 0x1b2286b8,               // reactionEmoji#1b2286b8
  reactionCount: 0xa3d1cb80,               // reactionCount#a3d1cb80
  messageReactions: 0xa339f0b,             // messageReactions#a339f0b
  updates: 0x74ae4240,                     // updates#74ae4240
  updateShortMessage: 0x313bc7f8,          // updateShortMessage#313bc7f8
  updateNewMessage: 0x1f2b0afd,            // updateNewMessage#1f2b0afd
  updateEditMessage: 0xe40370a3,           // updateEditMessage#e40370a3
  updateDraftMessage: 0xedfc111e,          // updateDraftMessage#edfc111e
  updateMessageReactions: 0x1e297bfa,      // updateMessageReactions#1e297bfa
  messagesSlice: 0x5f206716,               // messages.messagesSlice#5f206716
  affectedHistory: 0xb45c69d1,             // messages.affectedHistory#b45c69d1
  affectedMessages: 0x84d19185,            // messages.affectedMessages#84d19185
  channelDifferenceEmpty: 0x3e11affb,      // updates.channelDifferenceEmpty#3e11affb
  inputReplyToMessage: 0x75c1ad70,         // inputReplyToMessage#75c1ad70
  inputChannel: 0xf35aec28,                // inputChannel#f35aec28
  channelMessagesFilterEmpty: 0x94d42ee7,  // channelMessagesFilterEmpty#94d42ee7
  messageEntityTextUrl: 0x76a6d327,        // messageEntityTextUrl#76a6d327
  messageEntityMentionName: 0xdc7b1140,    // messageEntityMentionName#dc7b1140
  reactionCustomEmoji: 0x8935fc73,         // reactionCustomEmoji#8935fc73
});

/** Verified RPC constructor ids (schema/api.tl, layer 234). */
export const METHOD_IDS = Object.freeze({
  'messages.editMessage': 0xb106e66c,
  'messages.deleteMessages': 0xe58e95d2,
  'messages.forwardMessages': 0x13704a7c,
  'messages.search': 0x29ee847a,
  'messages.searchGlobal': 0x6126a43c,
  'messages.saveDraft': 0xad0fa15c,
  // Layer 234 has no messages.getDrafts / messages.drafts; the equivalent RPC
  // is messages.getAllDrafts -> Updates (verified below).
  'messages.getAllDrafts': 0x6a3f8d65,
  'messages.clearAllDrafts': 0x7e58ee9c,
  'messages.readMentions': 0x36e5bf4d,
  'messages.readReactions': 0x9ec44f93,
  // Layer 234 uses messages.sendReaction (there is no messages.setReaction).
  'messages.sendReaction': 0xd30d78d4,
  'messages.sendScreenshotNotification': 0xa1405817,
  'updates.getChannelDifference': 0x3173d78,
});

// ---- context / storage helpers ----------------------------------------
export function extraOf(ctx = {}) {
  if (ctx.messagingExtra) return ctx.messagingExtra;
  if (ctx.extra) return ctx.extra;
  if (!ctx._messagingExtra) {
    ctx._messagingExtra = new MessagingExtraStore(ctx.store?.dataDir || './data');
  }
  return ctx._messagingExtra;
}

function resolvePeer(peer, ctx) {
  const p = peer && typeof peer === 'object' ? peer : { type: 'user', id: Number(peer) || 0 };
  if (p.type === 'self') return { type: 'user', id: currentUser(ctx.store, ctx)?.id || 0 };
  return { type: String(p.type || p.peerType || 'user'), id: Number(p.id ?? p.peerId ?? 0) || 0 };
}

function draftKeyOf(peer, ctx) {
  return peerKeyOf(resolvePeer(peer, ctx));
}

function nextPts(ctx) {
  const store = ctx.store;
  if (!store?.nextPts) return 0;
  return store.nextPts(currentUser(store, ctx)?.id || 0, authKeyIdOf(ctx));
}

function usersOf(store, messages) {
  if (!store?.getUser) return [];
  const ids = new Set(messages.map((m) => Number(m.fromId)).filter(Boolean));
  return [...ids].map((id) => store.getUser(id)).filter(Boolean);
}

// ---- local TL encoders -------------------------------------------------
function tlPeer(p = {}) {
  const b = new TLBuffer();
  const type = p.type || p.peerType || 'user';
  const id = Number(p.id ?? p.peerId ?? 0) || 0;
  if (type === 'chat') return b.putUint(EXTRA_ID.peerChat).putLong(id).buffer;
  if (type === 'channel') return b.putUint(EXTRA_ID.peerChannel).putLong(id).buffer;
  return b.putUint(EXTRA_ID.peerUser).putLong(id).buffer;
}

function tlFwdHeader(meta = {}) {
  const b = new TLBuffer();
  const hasFrom = Boolean(meta.fwdFromPeer);
  const flags = hasFrom ? 1 : 0; // flags.0?from_id
  b.putUint(EXTRA_ID.messageFwdHeader).putUint(flags);
  if (flags & 1) {
    const [type, id] = String(meta.fwdFromPeer).split(':');
    b.putRaw(tlPeer({ type, id: Number(id) || 0 }));
  }
  b.putInt(i32(meta.fwdDate || 0));
  return b.buffer;
}

/**
 * message#7600b9d3. Only out/from_id/fwd_from/edit_date optional fields are
 * ever emitted; flags2 is always zero.
 */
function tlMessage(m = {}, meta = {}) {
  meta = meta || {};
  const fromId = Number(m.fromId) || 0;
  const flags = (m.out ? 1 << 1 : 0)
    | (fromId ? 1 << 8 : 0)
    | (meta.fwdFromPeer ? 1 << 2 : 0)
    | (meta.editDate ? 1 << 15 : 0);
  const b = new TLBuffer();
  b.putUint(EXTRA_ID.message).putUint(flags);
  if (flags & (1 << 1)) b.putUint(EXTRA_ID.boolTrue); // out:true
  b.putUint(0); // flags2
  b.putInt(i32(m.id || 0));
  if (flags & (1 << 8)) b.putRaw(tlPeer({ type: 'user', id: fromId }));
  b.putRaw(tlPeer(m)); // peer_id
  if (flags & (1 << 2)) b.putRaw(tlFwdHeader(meta)); // fwd_from (before date)
  b.putInt(i32(m.date || 0));
  b.putString(meta.text ?? m.text ?? '');
  if (flags & (1 << 15)) b.putInt(i32(meta.editDate)); // edit_date
  return b.buffer;
}

function tlUpdates(list = [], users = [], chats = [], date = now(), seq = 0) {
  const b = new TLBuffer();
  b.putUint(EXTRA_ID.updates);
  b.putVector(list, (item, bb) => bb.putRaw(item));
  b.putVector(users, (u, bb) => bb.putRaw(Buffer.isBuffer(u) ? u : C.user(u)));
  b.putVector(chats, (c, bb) => bb.putRaw(Buffer.isBuffer(c) ? c : c));
  b.putInt(i32(date)).putInt(i32(seq));
  return b.buffer;
}

function tlUpdateEditMessage(messageBuf, pts, ptsCount = 1) {
  return new TLBuffer()
    .putUint(EXTRA_ID.updateEditMessage)
    .putRaw(messageBuf)
    .putInt(i32(pts)).putInt(i32(ptsCount)).buffer;
}

function tlUpdateNewMessage(messageBuf, pts, ptsCount = 1) {
  return new TLBuffer()
    .putUint(EXTRA_ID.updateNewMessage)
    .putRaw(messageBuf)
    .putInt(i32(pts)).putInt(i32(ptsCount)).buffer;
}

function tlMessagesSlice(messages, users = []) {
  const b = new TLBuffer();
  b.putUint(EXTRA_ID.messagesSlice).putUint(0); // flags (no inexact/next_rate/etc.)
  b.putInt(i32(messages.length));
  b.putVector(messages, (m, bb) => bb.putRaw(Buffer.isBuffer(m) ? m : tlMessage(m)));
  b.putVector([], (_, bb) => bb); // topics
  b.putVector([], (_, bb) => bb); // chats
  b.putVector(users, (u, bb) => bb.putRaw(Buffer.isBuffer(u) ? u : C.user(u)));
  return b.buffer;
}

function tlAffectedHistory(pts, ptsCount = 1, offset = 0) {
  return new TLBuffer()
    .putUint(EXTRA_ID.affectedHistory)
    .putInt(i32(pts)).putInt(i32(ptsCount)).putInt(i32(offset)).buffer;
}

function tlAffectedMessages(pts, ptsCount = 1) {
  return new TLBuffer()
    .putUint(EXTRA_ID.affectedMessages)
    .putInt(i32(pts)).putInt(i32(ptsCount)).buffer;
}

function tlDraftMessage(draft = {}) {
  const b = new TLBuffer();
  b.putUint(EXTRA_ID.draftMessage).putUint(0); // flags (no webpage/reply/entities/media)
  b.putString(draft.text ?? '');
  b.putInt(i32(draft.date || 0));
  return b.buffer;
}

function tlUpdateDraftMessage(peer, draft) {
  const b = new TLBuffer();
  b.putUint(EXTRA_ID.updateDraftMessage).putUint(0); // flags: no top_msg_id/saved_peer_id
  b.putRaw(tlPeer(peer));
  b.putRaw(tlDraftMessage(draft));
  return b.buffer;
}

function tlReactionEmoji(emoji) {
  return new TLBuffer().putUint(EXTRA_ID.reactionEmoji).putString(String(emoji)).buffer;
}

function tlReactionCount(emoji, count) {
  const b = new TLBuffer();
  b.putUint(EXTRA_ID.reactionCount).putUint(0); // flags: no chosen_order
  b.putRaw(tlReactionEmoji(emoji));
  b.putInt(i32(count));
  return b.buffer;
}

function tlMessageReactions(counts) {
  const b = new TLBuffer();
  b.putUint(EXTRA_ID.messageReactions).putUint(0); // flags: no recent_reactions/top_reactors
  b.putVector(counts, (entry, bb) => bb.putRaw(tlReactionCount(entry.emoji, entry.count)));
  return b.buffer;
}

function tlUpdateMessageReactions(peer, msgId, reactionsBuf) {
  const b = new TLBuffer();
  b.putUint(EXTRA_ID.updateMessageReactions).putUint(0); // flags: no top_msg_id/saved_peer_id
  b.putRaw(tlPeer(peer));
  b.putInt(i32(msgId));
  b.putRaw(reactionsBuf);
  return b.buffer;
}

function tlChannelDifferenceEmpty(pts) {
  return new TLBuffer()
    .putUint(EXTRA_ID.channelDifferenceEmpty)
    .putUint(0) // flags: no final:true, no timeout
    .putInt(i32(pts)).buffer;
}

/** updateShortMessage#313bc7f8 (kept as an alternative edit/forward result). */
export function tlUpdateShortMessage({ out = true, id = 0, userId = 0, text = '', pts = 0, ptsCount = 1, date = 0 } = {}) {
  const flags = out ? 1 << 1 : 0;
  const b = new TLBuffer();
  b.putUint(EXTRA_ID.updateShortMessage).putUint(flags);
  if (flags & (1 << 1)) b.putUint(EXTRA_ID.boolTrue);
  b.putInt(i32(id)).putLong(userId).putString(text);
  b.putInt(i32(pts)).putInt(i32(ptsCount)).putInt(i32(date));
  return b.buffer;
}

// ---- request parsing helpers ------------------------------------------
function readIdVector(r, key, fallback = []) {
  if (isReader(r)) return r.has(4) ? r.vector((rr) => rr.int()) : fallback;
  const value = r?.[key] ?? r?.ids ?? fallback;
  return (Array.isArray(value) ? value : [value]).map((v) => Number(v) || 0).filter(Boolean);
}

function readLongVector(r, key) {
  if (isReader(r)) return r.has(4) ? r.vector((rr) => rr.long()) : [];
  const value = r?.[key] ?? [];
  return (Array.isArray(value) ? value : [value]).map((v) => BigInt(v || 0));
}

function skipReaction(r) {
  const id = r.uint();
  if (id >>> 0 === EXTRA_ID.reactionEmoji && r.has(1)) r.string();
  else if (id >>> 0 === EXTRA_ID.reactionCustomEmoji && r.has(8)) r.raw(8);
}

function readMessageEntity(r) {
  const id = r.has(4) ? r.uint() : 0;
  const offset = r.has(4) ? r.int() : 0;
  const length = r.has(4) ? r.int() : 0;
  const entity = { id: id >>> 0, offset, length };
  if (id >>> 0 === EXTRA_ID.messageEntityTextUrl && r.has(1)) entity.url = r.string();
  if (id >>> 0 === EXTRA_ID.messageEntityMentionName && r.has(8)) entity.userId = Number(r.long());
  return entity;
}

function reactionList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v : v?.emoticon ?? v?.emoji ?? '')).filter(Boolean);
  }
  if (typeof value === 'string') return [value];
  return [];
}

// ---- handlers ----------------------------------------------------------
/** messages.editMessage#b106e66c -> updates#74ae4240 / updateEditMessage. */
export function editMessage(r, ctx = {}) {
  const store = ctx.store;
  const extra = extraOf(ctx);
  let peer;
  let msgId;
  let text;
  let editDate;
  if (isReader(r)) {
    const flags = r.uint();
    peer = readInputPeer(r);
    msgId = r.has(4) ? r.int() : 0;
    text = (flags & (1 << 11)) && r.has(1) ? r.string() : '';
    editDate = (flags & (1 << 15)) && r.has(4) ? r.int() : now();
  } else {
    const p = r || {};
    peer = p.peer ?? { type: 'user', id: 0 };
    msgId = Number(p.id ?? p.msgId ?? 0) || 0;
    text = String(p.message ?? p.text ?? '');
    editDate = Number(p.editDate ?? p.date ?? now()) || now();
  }
  const stored = store?.getMessage?.(msgId) || null;
  const meta = extra.editMessage(msgId, text, editDate);
  if (stored && store.driver?.update) store.driver.update('messages', { id: msgId }, { text });
  const message = stored || {
    id: msgId,
    fromId: currentUser(store, ctx)?.id || 0,
    peerType: resolvePeer(peer, ctx).type,
    peerId: resolvePeer(peer, ctx).id,
    date: meta.editDate,
    text,
  };
  const pts = nextPts(ctx);
  const update = tlUpdateEditMessage(tlMessage(message, meta), pts, 1);
  return tlUpdates([update], usersOf(store, [message]), [], now(), 0);
}

/** messages.deleteMessages#e58e95d2 -> messages.affectedMessages#84d19185. */
export function deleteMessages(r, ctx = {}) {
  let flags = 0;
  let ids = [];
  if (isReader(r)) {
    flags = r.uint();
    ids = r.has(4) ? r.vector((rr) => rr.int()) : [];
  } else {
    flags = Number(r?.flags || 0);
    ids = readIdVector(r, 'id');
  }
  extraOf(ctx).markDeleted(ids);
  const pts = nextPts(ctx);
  return tlAffectedMessages(pts, 1);
}

/** messages.forwardMessages#13704a7c -> updates#74ae4240 / updateNewMessage. */
export function forwardMessages(r, ctx = {}) {
  let fromPeer;
  let ids;
  let randomIds;
  let toPeer;
  if (isReader(r)) {
    r.uint(); // flags (bool flags consume no bytes)
    fromPeer = readInputPeer(r);
    ids = r.has(4) ? r.vector((rr) => rr.int()) : [];
    randomIds = r.has(4) ? r.vector((rr) => rr.long()) : [];
    toPeer = readInputPeer(r);
  } else {
    const p = r || {};
    fromPeer = p.fromPeer ?? p.from_peer ?? { type: 'user', id: 0 };
    ids = readIdVector(p, 'id');
    randomIds = readLongVector(p, 'randomId');
    toPeer = p.toPeer ?? p.to_peer ?? { type: 'user', id: 0 };
  }
  const store = ctx.store;
  const extra = extraOf(ctx);
  const target = resolvePeer(toPeer, ctx);
  const senderId = currentUser(store, ctx)?.id || 0;
  const pts = nextPts(ctx);
  const updates = [];
  const created = [];
  for (let i = 0; i < ids.length; i++) {
    const source = store?.getMessage?.(ids[i]);
    const msg = store?.putMessage?.({
      fromId: senderId,
      peerType: target.type,
      peerId: target.id,
      text: source?.text ?? '',
      randomId: Number(randomIds[i] ?? 0n),
    }) || {
      id: i + 1, fromId: senderId, peerType: target.type, peerId: target.id,
      date: now(), text: source?.text ?? '',
    };
    const meta = extra.addForward(msg.id, fromPeer, ids[i]);
    created.push(msg);
    updates.push(tlUpdateNewMessage(tlMessage(msg, meta), pts, 1));
  }
  return tlUpdates(updates, usersOf(store, created), [], now(), 0);
}

function allMessages(store, limit) {
  if (store?.listMessages) {
    // Callers without a peer fall back to the raw driver used by core Store.
    const rows = store.driver?.all?.('messages', {}, { limit }) || [];
    return rows.map((row) => store.getMessage(row.id ?? row.userId)).filter(Boolean);
  }
  return [];
}

/** Search helper shared by messages.search and messages.searchGlobal. */
function doSearch(r, ctx, withPeer) {
  const store = ctx.store;
  let peer = null;
  let q = '';
  let limit = 20;
  if (isReader(r)) {
    const flags = r.uint();
    if (withPeer) {
      peer = readInputPeer(r);
      q = r.has(1) ? r.string() : '';
      if (flags & 1 && r.has(4)) readInputPeer(r); // from_id
      if (flags & 4 && r.has(4)) readInputPeer(r); // saved_peer_id
      if (flags & 8 && r.has(4)) r.vector(skipReaction); // saved_reaction
      if (flags & 2 && r.has(4)) r.int(); // top_msg_id
      if (r.has(4)) r.uint(); // filter
      for (let i = 0; i < 4 && r.has(4); i++) r.int(); // min/max date, offset_id, add_offset
    } else {
      if (flags & 1 && r.has(4)) r.int(); // folder_id
      if (flags & 16 && r.has(8)) { r.long(); r.long(); } // community
      q = r.has(1) ? r.string() : '';
      if (r.has(4)) r.uint(); // filter
      for (let i = 0; i < 3 && r.has(4); i++) r.int(); // min/max date, offset_rate
      if (r.has(4)) readInputPeer(r); // offset_peer
      if (r.has(4)) r.int(); // offset_id
    }
    limit = r.has(4) ? r.int() : 20;
  } else {
    const p = r || {};
    peer = p.peer ?? null;
    q = String(p.q ?? p.query ?? '');
    limit = Number(p.limit ?? 20) || 20;
  }
  let messages;
  if (peer) {
    const resolved = resolvePeer(peer, ctx);
    messages = store?.listMessages?.(resolved.type, resolved.id, Math.min(Math.max(limit, 1), 100)) || [];
  } else {
    messages = allMessages(store, Math.min(Math.max(limit, 1), 100));
  }
  const needle = q.toLowerCase();
  if (needle) messages = messages.filter((m) => String(m.text ?? '').toLowerCase().includes(needle));
  return tlMessagesSlice(messages, usersOf(store, messages));
}

/** messages.search#29ee847a -> messages.messagesSlice#5f206716. */
export function search(r, ctx = {}) {
  return doSearch(r, ctx, true);
}

/** messages.searchGlobal#6126a43c -> messages.messagesSlice#5f206716. */
export function searchGlobal(r, ctx = {}) {
  return doSearch(r, ctx, false);
}

/** messages.saveDraft#ad0fa15c -> boolTrue#997275b5. */
export function saveDraft(r, ctx = {}) {
  let peer;
  let text = '';
  let entities = [];
  if (isReader(r)) {
    const flags = r.uint();
    peer = readInputPeer(r);
    text = r.has(1) ? r.string() : '';
    if ((flags & 8) && r.has(4)) {
      entities = r.vector(readMessageEntity);
    }
  } else {
    const p = r || {};
    peer = p.peer ?? { type: 'user', id: 0 };
    text = String(p.message ?? p.text ?? '');
    entities = Array.isArray(p.entities) ? p.entities : [];
  }
  extraOf(ctx).setDraft(draftKeyOf(peer, ctx), text, entities);
  return new TLBuffer().putUint(EXTRA_ID.boolTrue).buffer;
}

/**
 * Layer 234 has no messages.getDrafts / messages.drafts constructor. The
 * equivalent RPC is messages.getAllDrafts#6a3f8d65 -> updates#74ae4240
 * carrying updateDraftMessage#edfc111e updates.
 */
export function getAllDrafts(r, ctx = {}) {
  const drafts = extraOf(ctx).listDrafts();
  const updates = drafts.map((draft) => {
    const [type, id] = draft.peerKey.split(':');
    return tlUpdateDraftMessage({ type, id: Number(id) || 0 }, draft);
  });
  return tlUpdates(updates, [], [], now(), 0);
}

/** Backwards-friendly alias; emits layer-234 Updates, not a messages.drafts box. */
export const getDrafts = getAllDrafts;

/** messages.clearAllDrafts#7e58ee9c -> boolTrue#997275b5. */
export function clearAllDrafts(r, ctx = {}) {
  const extra = extraOf(ctx);
  for (const draft of extra.listDrafts()) extra.clearDraft(draft.peerKey);
  return new TLBuffer().putUint(EXTRA_ID.boolTrue).buffer;
}

/** messages.readMentions#36e5bf4d -> messages.affectedHistory#b45c69d1. */
export function readMentions(r, ctx = {}) {
  if (isReader(r)) {
    const flags = r.uint();
    readInputPeer(r);
    if ((flags & 1) && r.has(4)) r.int(); // top_msg_id
  }
  return tlAffectedHistory(nextPts(ctx), 1, 0);
}

/** messages.readReactions#9ec44f93 -> messages.affectedHistory#b45c69d1. */
export function readReactions(r, ctx = {}) {
  if (isReader(r)) {
    const flags = r.uint();
    readInputPeer(r);
    if ((flags & 1) && r.has(4)) r.int(); // top_msg_id
    if ((flags & 2) && r.has(4)) readInputPeer(r); // saved_peer_id
  }
  return tlAffectedHistory(nextPts(ctx), 1, 0);
}

/** messages.sendReaction#d30d78d4 (layer 234) -> updates#74ae4240. */
export function sendReaction(r, ctx = {}) {
  const extra = extraOf(ctx);
  let peer;
  let msgId;
  let emojis = [];
  if (isReader(r)) {
    const flags = r.uint();
    peer = readInputPeer(r);
    msgId = r.has(4) ? r.int() : 0;
    if (flags & 1 && r.has(4)) {
      emojis = r.vector((rr) => {
        const id = rr.uint();
        if (id >>> 0 === EXTRA_ID.reactionEmoji && rr.has(1)) return rr.string();
        if (id >>> 0 === EXTRA_ID.reactionCustomEmoji && rr.has(8)) {
          return `custom:${rr.long()}`;
        }
        return '';
      }).filter(Boolean);
    }
  } else {
    const p = r || {};
    peer = p.peer ?? { type: 'user', id: 0 };
    msgId = Number(p.id ?? p.msgId ?? 0) || 0;
    emojis = reactionList(p.reaction ?? p.reactions ?? p.emoji);
  }
  for (const emoji of emojis) extra.addReaction(msgId, emoji);
  const counts = new Map();
  for (const emoji of extra.getReactions(msgId)) counts.set(emoji, 1);
  const entries = [...counts].map(([emoji, count]) => ({ emoji, count }));
  const update = tlUpdateMessageReactions(
    resolvePeer(peer, ctx), msgId, tlMessageReactions(entries),
  );
  return tlUpdates([update], [], [], now(), 0);
}

/** Backwards-friendly alias; layer 234's RPC is messages.sendReaction. */
export const setReaction = sendReaction;

/** messages.sendScreenshotNotification#a1405817 -> updates#74ae4240. */
export function sendScreenshotNotification(r, ctx = {}) {
  if (isReader(r)) {
    readInputPeer(r);
    skipInputReplyTo(r);
    if (r.has(8)) r.long(); // random_id
  }
  return tlUpdates([], [], [], now(), 0);
}

/** updates.getChannelDifference#3173d78 -> updates.channelDifferenceEmpty#3e11affb. */
export function getChannelDifference(r, ctx = {}) {
  let pts = 0;
  if (isReader(r)) {
    r.uint(); // flags (force:true consumes no bytes)
    if (r.has(8)) r.long(); // channel_id
    if (r.has(8)) r.long(); // access_hash
    if (r.has(4)) r.uint(); // filter (channelMessagesFilterEmpty)
    pts = r.has(4) ? r.int() : 0;
    if (r.has(4)) r.int(); // limit
  } else {
    pts = Number(r?.pts ?? 0) || 0;
  }
  return tlChannelDifferenceEmpty(pts);
}

export default {
  editMessage, deleteMessages, forwardMessages, search, searchGlobal,
  saveDraft, getAllDrafts, getDrafts, clearAllDrafts, readMentions,
  readReactions, sendReaction, setReaction, sendScreenshotNotification,
  getChannelDifference,
};
