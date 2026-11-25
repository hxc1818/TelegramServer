// TL handlers for folders / pinned dialogs / chatlists (layer 234).
//
// Every constructor id below was grep-verified against schema/api.tl (pinned
// at layer 234); the schema line is recorded beside each entry. Local TL
// encoders are defined here so codecs.js and the router remain untouched.
//
// Notes on schema availability:
//   messages.getPinnedDialogs#d6b94df2 -> messages.peerDialogs#a749f3e5
//   messages.toggleDialogPin#a731e257  -> Bool (boolTrue#997275b5)
//   chatlists.getChatlistUpdates#89419521 -> chatlists.chatlistUpdates#93bd878d
//   folders.editPeerFolders#6847d0ab -> updates#74ae4240
// `messages.unpinAllDialogs`, `chatlists.getChatlist` and `messages.getFolder`
// are NOT declared in the layer-234 schema. The two former are still provided
// as standalone handlers (their *result* ids are verified) but no method id is
// published for them; `messages.getFolder` is omitted entirely.

import { TLBuffer } from '../../tl/buffer.js';
import { user as tlUser } from './codecs.js';
import { isReader, readInputPeer } from './parsers.js';
import { FolderStore, peerFromKey, peerKeyOf } from '../../store/folders.js';

// Constructor ids from schema/api.tl (layer 234).
export const ID = Object.freeze({
  boolTrue: 0x997275b5,                 // boolTrue#997275b5 (line 2)
  peerUser: 0x59511722,                 // peerUser#59511722 (line 75)
  peerChat: 0x36c6019a,                 // peerChat#36c6019a (line 76)
  peerChannel: 0xa2a5371e,              // peerChannel#a2a5371e (line 77)
  user: 0xb1b8cc83,                     // user#b1b8cc83 (line 91)
  chat: 0x41cbf256,                     // chat#41cbf256 (line 104)
  channel: 0x7ad15240,                  // channel#7ad15240 (line 106)
  chatPhotoEmpty: 0x37c1011c,           // chatPhotoEmpty#37c1011c (line 122)
  message: 0x7600b9d3,                  // message#7600b9d3 (line 126)
  dialog: 0xfc89f7f3,                   // dialog#fc89f7f3 (line 225)
  dialogFolder: 0x71bd134c,             // dialogFolder#71bd134c (line 226)
  peerNotifySettings: 0x99622c0c,       // peerNotifySettings#99622c0c (line 260)
  dialogs: 0x2dfdd993,                  // messages.dialogs#2dfdd993 (line 294)
  dialogsSlice: 0xd1747044,             // messages.dialogsSlice#d1747044 (line 295)
  updateDialogPinned: 0x6e6fe51c,       // updateDialogPinned#6e6fe51c (line 377)
  updatePinnedDialogs: 0xfa0f3ca2,       // updatePinnedDialogs#fa0f3ca2 (line 378)
  updateFolderPeers: 0x19360dc0,        // updateFolderPeers#19360dc0 (line 393)
  state: 0xa56c2a3e,                    // updates.state#a56c2a3e (line 506)
  updates: 0x74ae4240,                  // updates#74ae4240 (line 518)
  peerDialogs: 0xa749f3e5,              // messages.peerDialogs#a749f3e5 (line 872)
  inputDialogPeer: 0xfcaafeb7,          // inputDialogPeer#fcaafeb7 (line 1171)
  inputDialogPeerFolder: 0x64600527,    // inputDialogPeerFolder#64600527 (line 1172)
  dialogPeer: 0xe56dbf05,               // dialogPeer#e56dbf05 (line 1175)
  dialogPeerFolder: 0x514519e2,         // dialogPeerFolder#514519e2 (line 1176)
  folder: 0xff544e65,                   // folder#ff544e65 (line 1334)
  inputFolderPeer: 0xfbd2c296,          // inputFolderPeer#fbd2c296 (line 1336)
  folderPeer: 0xe9baa668,               // folderPeer#e9baa668 (line 1338)
  inputChatlistDialogFilter: 0xf3e0da33, // inputChatlistDialogFilter#f3e0da33 (line 1720)
  chatlistUpdates: 0x93bd878d,          // chatlists.chatlistUpdates#93bd878d (line 1731)
});

// Verified *method* ids only. The router (owned by another agent) is not
// modified; these are exposed for callers/tests that dispatch by hand.
export const METHOD_IDS = Object.freeze({
  'messages.getDialogs': 0xa0f4cb4f,        // line 2642
  'messages.toggleDialogPin': 0xa731e257,   // line 2718
  'messages.getPinnedDialogs': 0xd6b94df2,  // line 2720
  'folders.editPeerFolders': 0x6847d0ab,    // line 3205
  'chatlists.getChatlistUpdates': 0x89419521, // line 3222
});

const CHAT_BOOL_BITS = [0, 2, 5, 23, 24, 25];
const CHANNEL_BOOL_BITS = [0, 2, 5, 7, 8, 9, 11, 12, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
const USER_BOOL_BITS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 23, 24, 25, 26, 27, 28, 29];

const toNumber = (v, fallback = 0) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const now = () => Math.floor(Date.now() / 1000);

function folderStoreOf(ctx = {}) {
  if (ctx.folderStore) return ctx.folderStore;
  const folderStore = new FolderStore(ctx.store?.dataDir || './data');
  ctx.folderStore = folderStore;
  return folderStore;
}

function userIdOf(store, ctx = {}) {
  if (ctx.userId) return toNumber(ctx.userId);
  if (ctx.user?.id) return toNumber(ctx.user.id);
  if (ctx.session?.userId) return toNumber(ctx.session.userId);
  const first = store?.driver?.all?.('users', {}, { limit: 1 })?.[0];
  return first ? toNumber(first.id ?? first.user_id) : 0;
}

// ---- TL encoders --------------------------------------------------------
function encodePeer(value) {
  const p = peerFromKey(typeof value === 'string' ? value : peerKeyOf(value));
  const ctor = p.type === 'channel' ? ID.peerChannel : p.type === 'chat' ? ID.peerChat : ID.peerUser;
  return new TLBuffer().putUint(ctor).putLong(BigInt(toNumber(p.id))).buffer;
}

function encodeFolder(folder = {}) {
  // folder#ff544e65: flags = 0, so photo (flags.3) is omitted.
  return new TLBuffer()
    .putUint(ID.folder)
    .putUint(0)
    .putInt(toNumber(folder.id))
    .putString(folder.title ?? '')
    .buffer;
}

function encodeDialog(dialog = {}) {
  const folderId = toNumber(dialog.folderId ?? dialog.folder_id);
  const pinned = Boolean(dialog.pinned);
  // dialog#fc89f7f3: pinned:flags.2?true, folder_id:flags.4?int.
  const flags = (pinned ? 1 << 2 : 0) | (folderId ? 1 << 4 : 0);
  const b = new TLBuffer();
  b.putUint(ID.dialog).putUint(flags);
  if (pinned) b.putUint(ID.boolTrue);
  b.putRaw(encodePeer(dialog.peerKey ?? dialog));
  b.putInt(toNumber(dialog.topMessage ?? dialog.top_message));
  b.putInt(toNumber(dialog.readInboxMaxId ?? dialog.read_inbox_max_id));
  b.putInt(toNumber(dialog.readOutboxMaxId ?? dialog.read_outbox_max_id));
  b.putInt(toNumber(dialog.unreadCount ?? dialog.unread_count));
  b.putInt(toNumber(dialog.unreadMentionsCount ?? dialog.unread_mentions_count));
  b.putInt(toNumber(dialog.unreadReactionsCount ?? dialog.unread_reactions_count));
  b.putInt(toNumber(dialog.unreadPollVotesCount ?? dialog.unread_poll_votes_count));
  b.putUint(ID.peerNotifySettings).putUint(0);
  if (folderId) b.putInt(folderId);
  return b.buffer;
}

function encodeDialogFolder(dialog = {}, folder = {}) {
  const pinned = Boolean(dialog.pinned);
  // dialogFolder#71bd134c: pinned:flags.2?true.
  const flags = pinned ? 1 << 2 : 0;
  const b = new TLBuffer();
  b.putUint(ID.dialogFolder).putUint(flags);
  if (pinned) b.putUint(ID.boolTrue);
  b.putRaw(encodeFolder(folder));
  b.putRaw(encodePeer(dialog.peerKey ?? dialog));
  b.putInt(toNumber(dialog.topMessage ?? dialog.top_message));
  const unread = toNumber(dialog.unreadCount ?? dialog.unread_count);
  b.putInt(0); // unread_muted_peers_count
  b.putInt(unread); // unread_unmuted_peers_count
  b.putInt(0); // unread_muted_messages_count
  b.putInt(unread); // unread_unmuted_messages_count
  return b.buffer;
}

function encodeMessage(message = {}) {
  const fromId = toNumber(message.fromId ?? message.from_id);
  const flags = (message.out ? 1 << 1 : 0) | (fromId ? 1 << 8 : 0);
  const b = new TLBuffer();
  b.putUint(ID.message).putUint(flags);
  if (flags & (1 << 1)) b.putUint(ID.boolTrue);
  b.putUint(0); // flags2
  b.putInt(toNumber(message.id));
  if (fromId) b.putRaw(encodePeer({ type: 'user', id: fromId }));
  b.putRaw(encodePeer(peerKeyOf(message)));
  b.putInt(toNumber(message.date));
  b.putString(message.text ?? '');
  return b.buffer;
}

function encodeState(s = {}) {
  const b = new TLBuffer().putUint(ID.state);
  b.putInt(toNumber(s.pts));
  b.putInt(toNumber(s.qts));
  b.putInt(toNumber(s.date));
  b.putInt(toNumber(s.seq));
  b.putInt(toNumber(s.unread_count ?? s.unreadCount));
  return b.buffer;
}

function encodeChat(chat = {}) {
  const type = chat.type === 'channel' ? 'channel' : 'chat';
  const b = new TLBuffer();
  if (type === 'channel') {
    b.putUint(ID.channel).putUint(0).putUint(0); // flags, flags2
  } else {
    b.putUint(ID.chat).putUint(0); // flags
  }
  b.putLong(BigInt(toNumber(chat.id)));
  b.putString(chat.title ?? '');
  b.putUint(ID.chatPhotoEmpty);
  if (type === 'chat') {
    b.putInt(toNumber(chat.participantsCount ?? chat.members?.length));
    b.putInt(toNumber(chat.date));
    b.putInt(toNumber(chat.version, 1));
  } else {
    b.putInt(toNumber(chat.date));
  }
  return b.buffer;
}

function putUsers(b, users) {
  b.putVector(users, (u, bb) => bb.putRaw(Buffer.isBuffer(u) ? u : tlUser(u)));
}

function putChats(b, chats) {
  b.putVector(chats, (c, bb) => bb.putRaw(Buffer.isBuffer(c) ? c : encodeChat(c)));
}

function encodeUpdates({ updates = [], users = [], chats = [], date, seq = 0 } = {}) {
  const b = new TLBuffer().putUint(ID.updates);
  b.putVector(updates, (u, bb) => bb.putRaw(u));
  putUsers(b, users);
  putChats(b, chats);
  b.putInt(toNumber(date, now())).putInt(toNumber(seq));
  return b.buffer;
}

function chatsForDialogs(dialogs, ctx = {}) {
  const gs = ctx.groupStore;
  if (!gs?.getChat) return [];
  const out = [];
  for (const d of dialogs) {
    const p = peerFromKey(d.peerKey);
    const chat = p.type === 'chat' ? gs.getChat(p.id) : p.type === 'channel' ? gs.getChannel(p.id) : null;
    if (chat) out.push(encodeChat({ ...chat, type: p.type }));
  }
  return out;
}

function usersFor(store, ids) {
  return [...new Set((ids || []).map(Number).filter(Boolean))].map((id) => {
    const u = store?.getUser?.(id);
    return u ? { ...u, self: u.self ?? false } : { id };
  });
}

function messagesFor(store, dialogs) {
  return dialogs.map((d) => store?.getMessage?.(d.topMessage)).filter(Boolean);
}

// ---- dialog selection helper -------------------------------------------
/**
 * Dialogs for a user, annotated with `peerKey` and the authoritative `pinned`
 * bit from FolderStore. When folderId is non-zero only dialogs assigned to (or
 * listed in) that folder are returned. Useful for filtering messages.getDialogs
 * by folder_id without touching the existing handler.
 */
export function filterDialogsByFolder(userId, folderId, ctx = {}) {
  const fs = folderStoreOf(ctx);
  const pinned = new Set(fs.listPinned(userId));
  const folderPeers = folderId ? new Set(fs.listFolderPeers(folderId)) : null;
  const dialogs = ctx.store?.listDialogs?.(userId) || [];
  return dialogs.map((d) => {
    const key = peerKeyOf(d);
    return { ...d, peerKey: key, pinned: pinned.has(key), folderId: fs.getDialogFolder(userId, key) };
  }).filter((d) => {
    if (!folderId) return true;
    if (fs.getDialogFolder(userId, d.peerKey) === folderId) return true;
    return folderPeers.has(d.peerKey);
  });
}

function putDialogs(b, dialogs, folderId, fs, useFolderDialog = true) {
  b.putVector(dialogs, (d, bb) => {
    if (folderId && useFolderDialog) {
      bb.putRaw(encodeDialogFolder(d, fs.getFolder(folderId) || { id: folderId, title: '' }));
    } else {
      bb.putRaw(encodeDialog(d));
    }
  });
}

function dialogsSliceResult(dialogs, folderId, userId, ctx, useFolderDialog = true) {
  const fs = folderStoreOf(ctx);
  const store = ctx.store;
  const messages = messagesFor(store, dialogs);
  const users = usersFor(store, [userId, ...messages.map((m) => m.fromId)]);
  const chats = chatsForDialogs(dialogs, ctx);
  const b = new TLBuffer().putUint(ID.dialogsSlice).putUint(0).putInt(dialogs.length);
  b.putVector([], (_, bb) => bb); // topics (flags.0 absent)
  putDialogs(b, dialogs, folderId, fs, useFolderDialog);
  b.putVector(messages, (m, bb) => bb.putRaw(encodeMessage(m)));
  putChats(b, chats);
  putUsers(b, users);
  return b.buffer;
}

function peerDialogsResult(dialogs, folderId, userId, ctx) {
  const fs = folderStoreOf(ctx);
  const store = ctx.store;
  const messages = messagesFor(store, dialogs);
  const users = usersFor(store, [userId, ...messages.map((m) => m.fromId)]);
  const chats = chatsForDialogs(dialogs, ctx);
  const b = new TLBuffer().putUint(ID.peerDialogs).putUint(0); // flags, topics absent
  putDialogs(b, dialogs, folderId, fs);
  b.putVector(messages, (m, bb) => bb.putRaw(encodeMessage(m)));
  putChats(b, chats);
  putUsers(b, users);
  b.putRaw(encodeState(store?.getState?.(userId) || {}));
  return b.buffer;
}

// ---- parameter readers --------------------------------------------------
function folderIdOf(params, isReaderInput) {
  if (isReaderInput) {
    if (!params.has(4)) return 0;
    return params.int();
  }
  return toNumber(params?.folder_id ?? params?.folderId ?? params?.id);
}

function chatlistIdOf(params, isReaderInput) {
  if (isReaderInput) {
    if (!params.has(4)) return 0;
    const ctor = params.uint();
    return ctor >>> 0 === ID.inputChatlistDialogFilter ? params.int() : 0;
  }
  const chatlist = params?.chatlist ?? params;
  return toNumber(params?.filter_id ?? params?.filterId ?? chatlist?.filter_id ?? chatlist?.filterId ?? chatlist?.id);
}

function inputDialogPeerOf(params, isReaderInput) {
  if (!isReaderInput) return params?.peer ?? params;
  if (!params.has(4)) return null;
  const ctor = params.uint();
  if (ctor >>> 0 === ID.inputDialogPeer) return readInputPeer(params);
  if (ctor >>> 0 === ID.inputDialogPeerFolder) {
    return { type: 'folder', id: params.has(4) ? params.int() : 0 };
  }
  return null;
}

// ---- handlers -----------------------------------------------------------
/** messages.getPinnedDialogs#d6b94df2 -> messages.peerDialogs#a749f3e5. */
export function getPinnedDialogs(params, ctx = {}) {
  const store = ctx.store;
  const fs = folderStoreOf(ctx);
  const userId = userIdOf(store, ctx);
  const folderId = folderIdOf(params, isReader(params));
  const order = fs.listPinned(userId);
  const dialogs = filterDialogsByFolder(userId, folderId, ctx)
    .filter((d) => d.pinned)
    .sort((a, b) => order.indexOf(a.peerKey) - order.indexOf(b.peerKey));
  return peerDialogsResult(dialogs, folderId, userId, ctx);
}

/** messages.toggleDialogPin#a731e257 -> Bool (boolTrue#997275b5). */
export function toggleDialogPin(params, ctx = {}) {
  const fs = folderStoreOf(ctx);
  const userId = userIdOf(ctx.store, ctx);
  const reader = isReader(params);
  const flags = reader ? (params.has(4) ? params.int() : 0) : toNumber(params?.flags);
  const pinned = reader
    ? Boolean(flags & 1) && (!params.has(4) || params.uint() === ID.boolTrue)
    : Boolean(params?.pinned ?? (flags & 1));
  const peer = inputDialogPeerOf(params, reader);
  if (peer) fs.pinDialog(userId, peerKeyOf(peer), pinned);
  return new TLBuffer().putUint(ID.boolTrue).buffer;
}

/** messages.unpinAllDialogs (not in layer 234) -> Bool (boolTrue#997275b5). */
export function unpinAllDialogs(params, ctx = {}) {
  const fs = folderStoreOf(ctx);
  fs.unpinAll(userIdOf(ctx.store, ctx));
  return new TLBuffer().putUint(ID.boolTrue).buffer;
}

/** chatlists.getChatlistUpdates#89419521 -> chatlists.chatlistUpdates#93bd878d. */
export function getChatlistUpdates(params, ctx = {}) {
  const fs = folderStoreOf(ctx);
  const userId = userIdOf(ctx.store, ctx);
  const filterId = chatlistIdOf(params, isReader(params));
  const peers = fs.listFolderPeers(filterId);
  const missing = peers.filter((key) => fs.getDialogFolder(userId, key) !== filterId);
  const b = new TLBuffer().putUint(ID.chatlistUpdates);
  b.putVector(missing, (key, bb) => bb.putRaw(encodePeer(key)));
  putChats(b, ctx.chats || []);
  putUsers(b, ctx.users || []);
  return b.buffer;
}

/** chatlists.getChatlist (not in layer 234) -> messages.dialogsSlice#d1747044. */
export function getChatlist(params, ctx = {}) {
  const userId = userIdOf(ctx.store, ctx);
  const filterId = chatlistIdOf(params, isReader(params));
  const dialogs = filterDialogsByFolder(userId, filterId, ctx);
  // chatlists carry plain dialog#fc89f7f3 objects with folder_id (flags.4).
  return dialogsSliceResult(dialogs, filterId, userId, ctx, false);
}

/** folders.editPeerFolders#6847d0ab -> updates#74ae4240. */
export function editPeerFolders(params, ctx = {}) {
  const fs = folderStoreOf(ctx);
  const store = ctx.store;
  const userId = userIdOf(store, ctx);
  const reader = isReader(params);
  let entries = [];
  if (reader) {
    entries = params.vector((r) => {
      const ctor = r.uint();
      if (ctor >>> 0 !== ID.inputFolderPeer) return null;
      const peer = readInputPeer(r);
      return { peer, folderId: r.int() };
    }).filter(Boolean);
  } else {
    const list = params?.folder_peers ?? params?.folderPeers ?? params?.peers ?? [];
    entries = (Array.isArray(list) ? list : []).map((e) => ({
      peer: e?.peer ?? e?.peer_id ?? e?.peerId ?? e,
      folderId: toNumber(e?.folder_id ?? e?.folderId ?? e?.folder),
    }));
  }
  const folderPeers = [];
  for (const entry of entries) {
    const key = peerKeyOf(entry.peer);
    const folderId = toNumber(entry.folderId);
    if (!key) continue;
    if (folderId > 0) {
      fs.addPeerToFolder(folderId, key);
      fs.markDialogFolder(userId, key, folderId);
    } else {
      for (const folder of fs.listFolders(userId)) fs.removePeerFromFolder(folder.id, key);
      fs.markDialogFolder(userId, key, 0);
    }
    folderPeers.push({ key, folderId });
  }
  const pts = store?.nextPts
    ? store.nextPts(userId, ctx.authKeyId ?? ctx.session?.authKeyId)
    : 1;
  const update = new TLBuffer()
    .putUint(ID.updateFolderPeers)
    .putVector(folderPeers, (e, bb) => bb.putUint(ID.folderPeer).putRaw(encodePeer(e.key)).putInt(e.folderId))
    .putInt(pts)
    .putInt(Math.max(1, folderPeers.length))
    .buffer;
  return encodeUpdates({ updates: [update], users: [], chats: [], date: now(), seq: 0 });
}

export default {
  ID,
  METHOD_IDS,
  getPinnedDialogs,
  toggleDialogPin,
  unpinAllDialogs,
  getChatlistUpdates,
  getChatlist,
  editPeerFolders,
  filterDialogsByFolder,
};
