// TL handlers for basic group / channel support (layer 234).
//
// Every constructor id below was verified against schema/api.tl (pinned at
// layer 234); the schema line is recorded next to each entry. Local TL
// encoders are defined here so codecs.js remains untouched.
//
// Response shapes were chosen to match the layer-234 function result types:
//   messages.createChat / messages.addChatUser / channels.inviteToChannel
//       -> messages.invitedUsers#7f5defa6 wrapping updates#74ae4240
//   channels.createChannel / messages.editChatTitle / channels.editTitle
//       -> updates#74ae4240
//   messages.getChats / channels.getChannels
//       -> messages.chats#64ff9fd5
//   messages.getFullChat / channels.getFullChannel
//       -> messages.chatFull#e5d7d19c
//   channels.getMessages -> messages.messagesSlice#5f206716
// Creating a group returns a fully boxed updates object (rather than a bare
// chat) so TDesktop can parse the declared result constructor; the created
// chat/channel is always included in the Updates.chats vector.

import { TLBuffer } from '../../tl/buffer.js';
import { user as tlUser } from './codecs.js';
import { int, str, isReader } from './parsers.js';
import { GroupStore } from '../../store/groups.js';

// Constructor ids from schema/api.tl (layer 234).
const ID = Object.freeze({
  boolTrue: 0x997275b5,             // boolTrue#997275b5 (line 2)
  peerUser: 0x59511722,             // peerUser#59511722 (line 75)
  peerChat: 0x36c6019a,             // peerChat#36c6019a (line 76)
  peerChannel: 0xa2a5371e,          // peerChannel#a2a5371e (line 77)
  chat: 0x41cbf256,                 // chat#41cbf256 (line 104)
  channel: 0x7ad15240,              // channel#7ad15240 (line 106)
  chatFull: 0x2633421b,             // chatFull#2633421b (line 111)
  channelFull: 0xc4c4dd40,          // channelFull#c4c4dd40 (line 112)
  chatParticipant: 0x38e79fde,      // chatParticipant#38e79fde (line 115)
  chatParticipantCreator: 0xe1f867b8, // chatParticipantCreator#e1f867b8 (line 116)
  chatParticipants: 0x3cbc93f8,     // chatParticipants#3cbc93f8 (line 120)
  chatPhotoEmpty: 0x37c1011c,       // chatPhotoEmpty#37c1011c (line 122)
  message: 0x7600b9d3,              // message#7600b9d3 (line 126)
  messageService: 0x7a800e0a,       // messageService#7a800e0a (line 127)
  photoEmpty: 0x2331b22d,           // photoEmpty#2331b22d (line 229)
  peerNotifySettings: 0x99622c0c,   // peerNotifySettings#99622c0c (line 260)
  messages: 0x1d73e7ea,             // messages.messages#1d73e7ea (line 298)
  messagesSlice: 0x5f206716,        // messages.messagesSlice#5f206716 (line 299)
  chats: 0x64ff9fd5,                // messages.chats#64ff9fd5 (line 303)
  chatsSlice: 0x9cd81144,           // messages.chatsSlice#9cd81144 (line 304)
  messagesChatFull: 0xe5d7d19c,     // messages.chatFull#e5d7d19c (line 306)
  updateNewMessage: 0x1f2b0afd,     // updateNewMessage#1f2b0afd (line 329)
  updateChatParticipants: 0x07761198, // updateChatParticipants#7761198 (line 334)
  updateNewChannelMessage: 0x62ba04d9, // updateNewChannelMessage#62ba04d9 (line 355)
  updates: 0x74ae4240,              // updates#74ae4240 (line 518)
  inputUserEmpty: 0xb98886cf,       // inputUserEmpty#b98886cf (line 20)
  inputUserSelf: 0xf7c1b13f,        // inputUserSelf#f7c1b13f (line 21)
  inputUser: 0xf21158c6,            // inputUser#f21158c6 (line 22)
  inputGeoPointEmpty: 0xe4c123d6,   // inputGeoPointEmpty#e4c123d6 (line 58)
  messageActionChatCreate: 0xbd47cbad, // messageActionChatCreate#bd47cbad (line 151)
  messageActionChatEditTitle: 0xb5a1ce5a, // messageActionChatEditTitle#b5a1ce5a (line 152)
  messageActionChatAddUser: 0x15cefd00, // messageActionChatAddUser#15cefd00 (line 155)
  messageActionChannelCreate: 0x95d2ac92, // messageActionChannelCreate#95d2ac92 (line 158)
  inputChannelEmpty: 0xee8c1e86,    // inputChannelEmpty#ee8c1e86 (line 768)
  inputChannel: 0xf35aec28,         // inputChannel#f35aec28 (line 769)
  inputMessageID: 0xa676a322,       // inputMessageID#a676a322 (line 1166)
  invitedUsers: 0x7f5defa6,         // messages.invitedUsers#7f5defa6 (line 1921)
});

const CHANNEL_BOOL_BITS = [0, 2, 5, 7, 8, 9, 11, 12, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];

const toNumber = (v, fallback = 0) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const now = () => Math.floor(Date.now() / 1000);

// ---- parameter readers (TLBuffer reader or plain object) ----------------
function vectorOf(r, key, decode) {
  if (isReader(r)) return r.vector(decode || ((rr) => rr));
  const value = r?.[key] ?? r?.[`${key}s`];
  return Array.isArray(value) ? value : [];
}

function flagBool(r, flags, bit, key) {
  if (isReader(r)) {
    if (!(flags & (1 << bit))) return false;
    return r.has(4) ? r.uint() === ID.boolTrue : true;
  }
  return Boolean((flags & (1 << bit)) || r?.[key]);
}

function readInputUserValue(r) {
  const ctor = r.uint();
  switch (ctor >>> 0) {
    case ID.inputUserEmpty:
      return 0;
    case ID.inputUserSelf:
      return 0; // resolved to the current user below
    case ID.inputUser: {
      const id = Number(r.long());
      if (r.has(8)) r.long(); // access_hash
      return id;
    }
    default:
      return 0;
  }
}

function inputUserId(value, ctx, me) {
  if (value === undefined || value === null || value === 0 || value === 0n) return me;
  if (typeof value === 'object') {
    const type = String(value.type || '');
    if (type === 'self' || type === 'inputUserSelf') return me;
    return toNumber(value.id ?? value.userId ?? value.user_id ?? value.peerId, me);
  }
  return toNumber(value, me);
}

function userIdsFrom(values, ctx, me) {
  return [...new Set((values || []).map((v) => inputUserId(v, ctx, me)).filter(Boolean))];
}

function readInputChannelValue(r) {
  const ctor = r.uint();
  switch (ctor >>> 0) {
    case ID.inputChannelEmpty:
      return 0;
    case ID.inputChannel: {
      const id = Number(r.long());
      if (r.has(8)) r.long(); // access_hash
      return id;
    }
    default:
      return 0;
  }
}

function inputChannelId(value, ctx) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'object') {
    return toNumber(value.id ?? value.channelId ?? value.channel_id ?? value.peerId);
  }
  return toNumber(value);
}

function currentUserId(store, ctx = {}) {
  if (ctx.userId) return toNumber(ctx.userId);
  if (ctx.user?.id) return toNumber(ctx.user.id);
  if (ctx.session?.userId) return toNumber(ctx.session.userId);
  const first = store?.driver?.all?.('users', {}, { limit: 1 })?.[0];
  return first ? toNumber(first.id ?? first.user_id) : 0;
}

function groupStoreOf(ctx = {}) {
  if (ctx.groupStore) return ctx.groupStore;
  const groupStore = new GroupStore(ctx.store?.dataDir || './data');
  ctx.groupStore = groupStore;
  return groupStore;
}

function usersForTl(store, ids) {
  return [...new Set((ids || []).map(Number).filter(Boolean))].map((id) => {
    const u = store?.getUser?.(id);
    return u ? { ...u } : { id };
  });
}

function putUsers(b, users) {
  b.putVector(users, (u, bb) => bb.putRaw(Buffer.isBuffer(u) ? u : tlUser(u)));
}

function putChats(b, chats) {
  b.putVector(chats, (c, bb) => bb.putRaw(Buffer.isBuffer(c) ? c : encodeChat(c)));
}

// ---- TL encoders --------------------------------------------------------
function encodePeer(type, id) {
  const ctor = type === 'channel' ? ID.peerChannel : type === 'chat' ? ID.peerChat : ID.peerUser;
  return new TLBuffer().putUint(ctor).putLong(BigInt(toNumber(id))).buffer;
}

function encodeChat(chat) {
  const b = new TLBuffer();
  const creator = Boolean(chat.creator);
  const flags = creator ? 1 : 0; // chat#41cbf256: creator:flags.0?true
  b.putUint(ID.chat).putUint(flags);
  if (creator) b.putUint(ID.boolTrue);
  b.putLong(BigInt(toNumber(chat.id)));
  b.putString(chat.title || '');
  b.putUint(ID.chatPhotoEmpty); // photo:ChatPhoto
  b.putInt(toNumber(chat.participantsCount ?? chat.members?.length));
  b.putInt(toNumber(chat.date));
  b.putInt(toNumber(chat.version, 1));
  return b.buffer;
}

function encodeChannel(channel) {
  const b = new TLBuffer();
  const creator = Boolean(channel.creator);
  const flags = (creator ? 1 : 0)
    | (channel.broadcast ? 1 << 5 : 0)
    | (channel.megagroup ? 1 << 8 : 0);
  b.putUint(ID.channel).putUint(flags);
  // flags.0..flags.30 boxed trues, in declaration order.
  for (const bit of CHANNEL_BOOL_BITS) if (flags & (1 << bit)) b.putUint(ID.boolTrue);
  b.putUint(0); // flags2
  b.putLong(BigInt(toNumber(channel.id)));
  b.putString(channel.title || '');
  b.putUint(ID.chatPhotoEmpty); // photo:ChatPhoto
  b.putInt(toNumber(channel.date));
  return b.buffer;
}

function encodeParticipants(chatId, members, creatorId, version = 1) {
  const b = new TLBuffer();
  b.putUint(ID.chatParticipants).putLong(BigInt(toNumber(chatId)));
  b.putVector(members || [], (uid, bb) => {
    if (toNumber(uid) === toNumber(creatorId)) {
      bb.putUint(ID.chatParticipantCreator).putUint(0).putLong(BigInt(toNumber(uid)));
    } else {
      bb.putUint(ID.chatParticipant).putUint(0)
        .putLong(BigInt(toNumber(uid)))
        .putLong(BigInt(toNumber(creatorId)))
        .putInt(0); // date
    }
  });
  b.putInt(toNumber(version, 1));
  return b.buffer;
}

function encodeChatFull(chat, participants) {
  return new TLBuffer()
    .putUint(ID.chatFull).putUint(0)
    .putLong(BigInt(toNumber(chat.id)))
    .putString(chat.about || '')
    .putRaw(participants)
    .putUint(ID.peerNotifySettings).putUint(0) // notify_settings
    .buffer;
}

function encodeChannelFull(channel) {
  // flags = flags2 = 0, so all optional fields are omitted.
  return new TLBuffer()
    .putUint(ID.channelFull).putUint(0).putUint(0)
    .putLong(BigInt(toNumber(channel.id)))
    .putString(channel.about || '')
    .putInt(0).putInt(0).putInt(0) // read_inbox/outbox/unread
    .putUint(ID.photoEmpty).putLong(0n) // chat_photo:Photo
    .putUint(ID.peerNotifySettings).putUint(0)
    .putVector([], (_, b) => b) // bot_info
    .putInt(channel.pts ?? 1) // pts
    .buffer;
}

function encodeUpdates({ updates = [], users = [], chats = [], date, seq = 0 } = {}) {
  const b = new TLBuffer();
  b.putUint(ID.updates);
  b.putVector(updates, (u, bb) => bb.putRaw(u));
  putUsers(b, users);
  putChats(b, chats);
  b.putInt(toNumber(date, now())).putInt(toNumber(seq));
  return b.buffer;
}

function encodeInvitedUsers(updates) {
  const b = new TLBuffer().putUint(ID.invitedUsers).putRaw(updates);
  b.putVector([], (_, bb) => bb); // missing_invitees
  return b.buffer;
}

function encodeMessage(message, peerType, peerId) {
  const b = new TLBuffer();
  const fromId = toNumber(message.fromId);
  const flags = (message.out ? 1 << 1 : 0) | (fromId ? 1 << 8 : 0);
  b.putUint(ID.message).putUint(flags);
  if (flags & (1 << 1)) b.putUint(ID.boolTrue);
  b.putUint(0); // flags2
  b.putInt(toNumber(message.id));
  if (flags & (1 << 8)) b.putRaw(encodePeer('user', fromId));
  b.putRaw(encodePeer(peerType, peerId));
  b.putInt(toNumber(message.date));
  b.putString(message.text || '');
  return b.buffer;
}

function encodeServiceMessage({ id, fromId, peerType, peerId, date, action, out = false }) {
  const b = new TLBuffer();
  const flags = (out ? 1 << 1 : 0) | (fromId ? 1 << 8 : 0);
  b.putUint(ID.messageService).putUint(flags);
  if (flags & (1 << 1)) b.putUint(ID.boolTrue);
  b.putInt(toNumber(id));
  if (flags & (1 << 8)) b.putRaw(encodePeer('user', fromId));
  b.putRaw(encodePeer(peerType, peerId));
  b.putInt(toNumber(date, now()));
  b.putRaw(action);
  return b.buffer;
}

function chatCreateAction(title, ids) {
  return new TLBuffer()
    .putUint(ID.messageActionChatCreate)
    .putString(title || '')
    .putVector(ids || [], (id, b) => b.putLong(BigInt(toNumber(id))))
    .buffer;
}

function channelCreateAction(title) {
  return new TLBuffer().putUint(ID.messageActionChannelCreate).putString(title || '').buffer;
}

function editTitleAction(title) {
  return new TLBuffer().putUint(ID.messageActionChatEditTitle).putString(title || '').buffer;
}

function encodedChat(chat) {
  if (!chat) return null;
  return chat.type === 'channel' ? encodeChannel(chat) : encodeChat(chat);
}

function emptyChatFullResult() {
  const full = encodeChatFull({ id: 0, about: '' }, encodeParticipants(0, [], 0, 0));
  return new TLBuffer()
    .putUint(ID.messagesChatFull)
    .putRaw(full)
    .putVector([], (_, b) => b)
    .putVector([], (_, b) => b)
    .buffer;
}

// The viewer-relative `creator` flag is set by handlers, not by the store.
function viewAs(chat, me) {
  return chat ? { ...chat, creator: chat.creatorId === me } : chat;
}

// ---- handlers -----------------------------------------------------------
/** messages.createChat#92ceddd4 -> messages.invitedUsers */
export function createChat(params, ctx = {}) {
  const gs = groupStoreOf(ctx);
  const store = ctx?.store;
  const me = currentUserId(store, ctx);
  let flags = 0;
  let inputs = [];
  let title = '';
  if (isReader(params)) {
    flags = params.int();
    inputs = params.vector(readInputUserValue);
    title = params.string();
    if (flags & 1 && params.has(4)) params.int(); // ttl_period
  } else {
    flags = int(params, 'flags', 0);
    inputs = vectorOf(params, 'users');
    title = str(params, 'title', '');
  }
  const ids = userIdsFrom(inputs, ctx, me);
  const chat = gs.createChat({ title, creatorId: me, members: ids, creator: true });
  const pts = gs.nextPts();
  const action = chatCreateAction(title, ids);
  const msg = encodeServiceMessage({
    id: pts, fromId: me, peerType: 'chat', peerId: chat.id, date: chat.date, action,
  });
  const update = new TLBuffer()
    .putUint(ID.updateNewMessage).putRaw(msg).putInt(pts).putInt(1).buffer;
  return encodeInvitedUsers(encodeUpdates({
    updates: [update],
    users: usersForTl(store, [me, ...ids]),
    chats: [{ ...chat, creator: true }],
    date: chat.date,
    seq: 1,
  }));
}

/** channels.createChannel#91006707 -> updates */
export function createChannel(params, ctx = {}) {
  const gs = groupStoreOf(ctx);
  const store = ctx?.store;
  const me = currentUserId(store, ctx);
  let flags = 0;
  let title = '';
  let about = '';
  let broadcast = false;
  let megagroup = false;
  if (isReader(params)) {
    flags = params.int();
    broadcast = flagBool(params, flags, 0, 'broadcast');
    megagroup = flagBool(params, flags, 1, 'megagroup');
    if (flags & (1 << 3) && params.has(4)) params.uint(); // for_import
    if (flags & (1 << 5) && params.has(4)) params.uint(); // forum
    title = params.string();
    about = params.string();
    if (flags & (1 << 2)) {
      if (params.has(4)) params.uint(); // geo_point constructor
      if (params.has(1)) params.string(); // address
    }
    if (flags & (1 << 4) && params.has(4)) params.int(); // ttl_period
  } else {
    flags = int(params, 'flags', 0);
    title = str(params, 'title', '');
    about = str(params, 'about', '');
    broadcast = flagBool(params, flags, 0, 'broadcast');
    megagroup = flagBool(params, flags, 1, 'megagroup');
  }
  const channel = gs.createChannel({
    title, about, creatorId: me, broadcast, megagroup, members: [me], creator: true,
  });
  const pts = gs.nextPts();
  const action = megagroup ? chatCreateAction(title, [me]) : channelCreateAction(title);
  const msg = encodeServiceMessage({
    id: pts, fromId: me, peerType: 'channel', peerId: channel.id, date: channel.date, action,
  });
  const update = new TLBuffer()
    .putUint(ID.updateNewChannelMessage).putRaw(msg).putInt(pts).putInt(1).buffer;
  return encodeUpdates({
    updates: [update],
    users: usersForTl(store, [me]),
    chats: [encodeChannel({ ...channel, creator: true })],
    date: channel.date,
    seq: 1,
  });
}

/** messages.addChatUser#cbc6d107 -> messages.invitedUsers */
export function addChatUser(params, ctx = {}) {
  const gs = groupStoreOf(ctx);
  const store = ctx?.store;
  const me = currentUserId(store, ctx);
  let chatId = 0;
  let input = 0;
  if (isReader(params)) {
    chatId = Number(params.long());
    input = readInputUserValue(params);
    if (params.has(4)) params.int(); // fwd_limit
  } else {
    chatId = toNumber(params?.chatId ?? params?.chat_id ?? params?.id ?? params?.peerId);
    input = params?.user_id ?? params?.userId ?? params?.user ?? 0;
    int(params, 'fwd_limit', 0);
  }
  const userId = inputUserId(input, ctx, me);
  let chat = gs.getChat(chatId) || gs.getChannel(chatId);
  if (chat && userId) gs.addMember(chatId, userId);
  chat = gs.getChat(chatId) || gs.getChannel(chatId);
  if (!chat) {
    return encodeInvitedUsers(encodeUpdates({ users: usersForTl(store, [userId]), date: now(), seq: 1 }));
  }
  const pts = gs.nextPts();
  const participants = encodeParticipants(chat.id, chat.members, chat.creatorId, chat.version + 1);
  const update = new TLBuffer().putUint(ID.updateChatParticipants).putRaw(participants).buffer;
  return encodeInvitedUsers(encodeUpdates({
    updates: [update],
    users: usersForTl(store, [userId]),
    chats: [encodedChat(viewAs(chat, me))],
    date: now(),
    seq: 1,
  }));
}

/** channels.inviteToChannel#c9e33d54 -> messages.invitedUsers */
export function inviteToChannel(params, ctx = {}) {
  const gs = groupStoreOf(ctx);
  const store = ctx?.store;
  const me = currentUserId(store, ctx);
  let channelId = 0;
  let inputs = [];
  if (isReader(params)) {
    channelId = readInputChannelValue(params);
    inputs = params.vector(readInputUserValue);
  } else {
    channelId = inputChannelId(params?.channel ?? params, ctx);
    inputs = vectorOf(params, 'users');
  }
  const ids = userIdsFrom(inputs, ctx, me);
  for (const uid of ids) gs.addMember(channelId, uid);
  let channel = gs.getChannel(channelId);
  if (!channel) {
    return encodeInvitedUsers(encodeUpdates({ users: usersForTl(store, ids), date: now(), seq: 1 }));
  }
  const pts = gs.nextPts();
  const participants = encodeParticipants(channel.id, channel.members, channel.creatorId, channel.version + 1);
  const update = new TLBuffer().putUint(ID.updateChatParticipants).putRaw(participants).buffer;
  return encodeInvitedUsers(encodeUpdates({
    updates: [update],
    users: usersForTl(store, ids),
    chats: [encodeChannel(viewAs(channel, me))],
    date: now(),
    seq: 1,
  }));
}

/** messages.getChats#49e9528f -> messages.chats */
export function getChats(params, ctx = {}) {
  const gs = groupStoreOf(ctx);
  const me = currentUserId(ctx?.store, ctx);
  let ids = [];
  if (isReader(params)) ids = params.vector((r) => Number(r.long()));
  else ids = vectorOf(params, 'id').map(toNumber);
  const chats = ids.map((id) => gs.getChat(id) || gs.getChannel(id)).filter(Boolean)
    .map((c) => encodedChat(viewAs(c, me)));
  return new TLBuffer().putUint(ID.chats).putVector(chats, (c, b) => b.putRaw(c)).buffer;
}

/** channels.getChannels#a7f6bbb -> messages.chats */
export function getChannels(params, ctx = {}) {
  const gs = groupStoreOf(ctx);
  const me = currentUserId(ctx?.store, ctx);
  let ids = [];
  if (isReader(params)) ids = params.vector(readInputChannelValue);
  else ids = vectorOf(params, 'id').map((v) => inputChannelId(v, ctx));
  const chats = ids.map((id) => gs.getChannel(id) || gs.getChat(id)).filter(Boolean)
    .map((c) => encodedChat(viewAs(c, me)));
  return new TLBuffer().putUint(ID.chats).putVector(chats, (c, b) => b.putRaw(c)).buffer;
}

/** messages.getFullChat#aeb00b34 -> messages.chatFull */
export function getFullChat(params, ctx = {}) {
  const gs = groupStoreOf(ctx);
  const store = ctx?.store;
  const id = isReader(params)
    ? Number(params.long())
    : toNumber(params?.chat_id ?? params?.chatId ?? params?.id ?? params?.peerId);
  const me = currentUserId(store, ctx);
  const chat = gs.getChat(id);
  if (!chat) return emptyChatFullResult();
  const participants = encodeParticipants(chat.id, chat.members, chat.creatorId, chat.version);
  return new TLBuffer()
    .putUint(ID.messagesChatFull)
    .putRaw(encodeChatFull(chat, participants))
    .putVector([encodeChat(viewAs(chat, me))], (c, b) => b.putRaw(c))
    .putVector(usersForTl(store, chat.members), (u, b) => b.putRaw(Buffer.isBuffer(u) ? u : tlUser(u)))
    .buffer;
}

/** channels.getFullChannel#8736a09 -> messages.chatFull */
export function getFullChannel(params, ctx = {}) {
  const gs = groupStoreOf(ctx);
  const store = ctx?.store;
  const id = isReader(params)
    ? readInputChannelValue(params)
    : inputChannelId(params?.channel ?? params, ctx);
  const me = currentUserId(store, ctx);
  const channel = gs.getChannel(id);
  if (!channel) return emptyChatFullResult();
  return new TLBuffer()
    .putUint(ID.messagesChatFull)
    .putRaw(encodeChannelFull(channel))
    .putVector([encodeChannel(viewAs(channel, me))], (c, b) => b.putRaw(c))
    .putVector(usersForTl(store, channel.members), (u, b) => b.putRaw(Buffer.isBuffer(u) ? u : tlUser(u)))
    .buffer;
}

/** messages.editChatTitle#73783ffd -> updates */
export function editChatTitle(params, ctx = {}) {
  const gs = groupStoreOf(ctx);
  const store = ctx?.store;
  const me = currentUserId(store, ctx);
  const id = isReader(params)
    ? Number(params.long())
    : toNumber(params?.chat_id ?? params?.chatId ?? params?.id);
  const title = isReader(params) ? params.string() : str(params, 'title', '');
  const chat = gs.updateChat(id, { title });
  const pts = gs.nextPts();
  const msg = encodeServiceMessage({
    id: pts, fromId: me, peerType: 'chat', peerId: id,
    date: chat?.date || now(), action: editTitleAction(title), out: true,
  });
  const update = new TLBuffer()
    .putUint(ID.updateNewMessage).putRaw(msg).putInt(pts).putInt(1).buffer;
  return encodeUpdates({
    updates: [update],
    users: usersForTl(store, [me]),
    chats: chat ? [encodeChat(viewAs(chat, me))] : [],
    date: now(),
    seq: 1,
  });
}

/** channels.editTitle#566decd0 -> updates */
export function editTitle(params, ctx = {}) {
  const gs = groupStoreOf(ctx);
  const store = ctx?.store;
  const me = currentUserId(store, ctx);
  let id = 0;
  let title = '';
  if (isReader(params)) {
    id = readInputChannelValue(params);
    title = params.string();
  } else {
    id = inputChannelId(params?.channel ?? params, ctx);
    title = str(params, 'title', '');
  }
  const channel = gs.updateChannel(id, { title });
  const pts = gs.nextPts();
  const msg = encodeServiceMessage({
    id: pts, fromId: me, peerType: 'channel', peerId: id,
    date: channel?.date || now(), action: editTitleAction(title), out: true,
  });
  const update = new TLBuffer()
    .putUint(ID.updateNewChannelMessage).putRaw(msg).putInt(pts).putInt(1).buffer;
  return encodeUpdates({
    updates: [update],
    users: usersForTl(store, [me]),
    chats: channel ? [encodeChannel(viewAs(channel, me))] : [],
    date: now(),
    seq: 1,
  });
}

/** channels.getMessages#ad8c9a23 -> messages.messagesSlice */
export function getMessages(params, ctx = {}) {
  const gs = groupStoreOf(ctx);
  let channelId = 0;
  let requested = [];
  if (isReader(params)) {
    channelId = readInputChannelValue(params);
    requested = params.vector((r) => {
      const ctor = r.uint();
      return ctor >>> 0 === ID.inputMessageID ? Number(r.int()) : 0;
    });
  } else {
    channelId = inputChannelId(params?.channel ?? params, ctx);
    requested = vectorOf(params, 'id').map((v) => inputMessageIdValue(v));
  }
  const stored = gs.listMessages('channel', channelId, 1000).slice().reverse();
  const messages = requested.length ? stored.filter((m) => requested.includes(m.id)) : stored;
  const users = usersForTl(ctx?.store, messages.map((m) => m.fromId));
  const b = new TLBuffer();
  b.putUint(ID.messagesSlice).putUint(0).putInt(messages.length);
  b.putVector(messages, (m, bb) => bb.putRaw(encodeMessage(m, 'channel', channelId)));
  b.putVector([], (_, bb) => bb); // topics
  b.putVector([], (_, bb) => bb); // chats
  putUsers(b, users);
  return b.buffer;
}

function inputMessageIdValue(value) {
  if (value && typeof value === 'object') return toNumber(value.id);
  return toNumber(value);
}

export default {
  ID,
  createChat,
  createChannel,
  addChatUser,
  inviteToChannel,
  getChats,
  getChannels,
  getFullChat,
  getFullChannel,
  editChatTitle,
  editTitle,
  getMessages,
};
