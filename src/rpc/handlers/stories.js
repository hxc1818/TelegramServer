// TL handlers for stories and device/push registration.
//
// Every id in METHOD_IDS is grep-verified against the pinned schema/api.tl
// (layer 234). The schema line is recorded next to each entry. Constructors
// used in the responses are likewise verified:
//   updates#74ae4240                 (line 518)
//   storyItem#16a4b93c               (line 1743)
//   stories.stories#63c3dd0a         (line 1748)
//   storyView#b0bdeac5               (line 1750)
//   stories.storyViewsList#59d78fc5  (line 1754)
//   stories.storyViews#de9eed1d      (line 1756)
//   peerStories#9a35e999             (line 1779)
//   stories.peerStories#cae68768     (line 1781)
//   peerNotifySettings#99622c0c      (line 260)
//
// Layer-234 gaps (documented, not silently invented):
//   * stories.getStories / stories.deleteStory do not exist in this layer.
//     The schema declares stories.getStoriesByID#5774ca74 (line 3236) and
//     stories.deleteStories#ae59db5f (line 3231) instead. Programmatic
//     aliases with those names are exported, but they carry NO method id.
//   * stories.storiesSlice and account.pushSettings do not exist in this
//     layer, so stories.stories#63c3dd0a and peerNotifySettings#99622c0c are
//     returned instead.
//   * stories.readStories (line 3238) and stories.getStoriesViews (line 3241)
//     declare Vector<int> / stories.storyViews, not Updates as older docs say.
//     Schema-declared results are returned; `readStoriesUpdates` and
//     `getStoriesViewsUpdates` are exported for the legacy Updates shape.
//   * account.getPushSettings / account.updatePushSettings /
//     account.getContactSignupNotification / account.setContactSignupNotification
//     have no constructor id in layer 234. Their nearest verified equivalents
//     are account.getNotifySettings#12b3ad31 (line 2476) and
//     account.updateNotifySettings#84be5b93 (line 2475); the legacy handlers
//     are exported without ids so they cannot shadow those routes.
//
// PUSH DELIVERY LIMITATION: device tokens and notification preferences are
// persisted via StoryStore only. This server has no APNs/FCM integration and
// sends no real push notifications.
//
// All handlers accept either a TLBuffer positioned after the method id or a
// plain JS object, and return a TL-serialized Buffer.

import { TLBuffer } from '../../tl/buffer.js';
import { isReader, int, long, str, readInputPeer } from './parsers.js';
import { StoryStore } from '../../store/stories.js';

const ID = Object.freeze({
  boolFalse: 0xbc799737,                 // boolFalse#bc799737 (line 1)
  boolTrue: 0x997275b5,                  // boolTrue#997275b5 (line 2)
  vector: 0x1cb5c415,                    // vector#1cb5c415 (line 6)
  user: 0xb1b8cc83,                      // user#b1b8cc83 (line 91)
  peerUser: 0x59511722,                  // peerUser#59511722 (line 75)
  peerChat: 0x36c6019a,                  // peerChat#36c6019a (line 76)
  peerChannel: 0xa2a5371e,               // peerChannel#a2a5371e (line 77)
  messageMediaEmpty: 0x3ded6320,         // messageMediaEmpty#3ded6320 (line 129)
  peerNotifySettings: 0x99622c0c,        // peerNotifySettings#99622c0c (line 260)
  inputNotifyPeer: 0xb8bc5b0c,           // inputNotifyPeer#b8bc5b0c (line 251)
  inputNotifyUsers: 0x193b4417,          // inputNotifyUsers#193b4417 (line 252)
  inputNotifyChats: 0x4a95e84e,          // inputNotifyChats#4a95e84e (line 253)
  inputNotifyBroadcasts: 0xb1db7c7e,     // inputNotifyBroadcasts#b1db7c7e (line 254)
  inputPeerNotifySettings: 0xcacb6ae2,   // inputPeerNotifySettings#cacb6ae2 (line 258)
  updates: 0x74ae4240,                   // updates#74ae4240 (line 518)
  storyViews: 0x8d595cd6,                // storyViews#8d595cd6 (line 1739)
  storyItem: 0x16a4b93c,                 // storyItem#16a4b93c (line 1743)
  storiesStories: 0x63c3dd0a,            // stories.stories#63c3dd0a (line 1748)
  storyView: 0xb0bdeac5,                 // storyView#b0bdeac5 (line 1750)
  storiesStoryViewsList: 0x59d78fc5,     // stories.storyViewsList#59d78fc5 (line 1754)
  storiesStoryViews: 0xde9eed1d,         // stories.storyViews#de9eed1d (line 1756)
  peerStories: 0x9a35e999,               // peerStories#9a35e999 (line 1779)
  storiesPeerStories: 0xcae68768,        // stories.peerStories#cae68768 (line 1781)
});

// Only ids that actually appear in schema/api.tl. Legacy aliases are exported
// separately as LEGACY_METHOD_NAMES so they can never shadow a real route.
export const METHOD_IDS = Object.freeze({
  'stories.canSendStory': 0x30eb63f0,              // line 3228
  'stories.sendStory': 0x8f9e6898,                 // line 3229
  'stories.editStory': 0x2c63a72b,                 // line 3230
  'stories.deleteStories': 0xae59db5f,             // line 3231
  'stories.togglePinned': 0x9a75a1ef,              // line 3232
  'stories.getAllStories': 0xeeb0d625,             // line 3233
  'stories.getPinnedStories': 0x5821a5dc,          // line 3234
  'stories.getStoriesArchive': 0xb4352016,         // line 3235
  'stories.getStoriesByID': 0x5774ca74,            // line 3236
  'stories.toggleAllStoriesHidden': 0x7c2557c4,    // line 3237
  'stories.readStories': 0xa556dac8,               // line 3238
  'stories.incrementStoryViews': 0xb2028afb,       // line 3239
  'stories.getStoryViewsList': 0x7ed23c57,         // line 3240
  'stories.getStoriesViews': 0x28e16cc8,           // line 3241
  'stories.exportStoryLink': 0x7b8def20,           // line 3242
  'stories.activateStealthMode': 0x57bbd166,       // line 3244
  'stories.sendReaction': 0x7fd736b2,              // line 3245
  'stories.getPeerStories': 0x2c4ada50,            // line 3246
  'stories.getAllReadPeerStories': 0x9b5ae7f9,     // line 3247
  'stories.togglePeerStoriesHidden': 0xbd0415c4,   // line 3250
  'stories.togglePinnedToTop': 0xb297e9b,          // line 3252
  'stories.startLive': 0xd069ccde,                 // line 3260
  'account.registerDevice': 0xec86017a,            // line 2473
  'account.unregisterDevice': 0x6a0d3206,          // line 2474
});

/** Legacy/programmatic names that have no distinct id in layer 234. */
export const LEGACY_METHOD_NAMES = Object.freeze([
  'stories.getStories',
  'stories.deleteStory',
  'stories.deleteStoryBool',
  'stories.readStoriesUpdates',
  'stories.getStoriesViewsUpdates',
  'account.getPushSettings',
  'account.updatePushSettings',
  'account.getContactSignupNotification',
  'account.setContactSignupNotification',
]);

/** Optional aliases for callers that need an id for a legacy name. Every
 *  value is a grep-verified id of the equivalent layer-234 method. */
export const LEGACY_METHOD_IDS = Object.freeze({
  'stories.getStories': 0x5774ca74,            // stories.getStoriesByID (line 3236)
  'stories.deleteStory': 0xae59db5f,           // stories.deleteStories (line 3231)
  'account.getPushSettings': 0x12b3ad31,       // account.getNotifySettings (line 2476)
  'account.updatePushSettings': 0x84be5b93,    // account.updateNotifySettings (line 2475)
});

const toNumber = (v, fallback = 0) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const now = () => Math.floor(Date.now() / 1000);

function storyStoreOf(ctx = {}) {
  if (ctx.storyStore) return ctx.storyStore;
  const store = new StoryStore(ctx.store?.dataDir || './data');
  ctx.storyStore = store;
  return store;
}

function currentUserId(ctx = {}) {
  if (ctx.userId) return toNumber(ctx.userId);
  if (ctx.user?.id) return toNumber(ctx.user.id);
  if (ctx.session?.userId) return toNumber(ctx.session.userId);
  return toNumber(ctx.store?.driver?.all?.('users', {}, { limit: 1 })?.[0]?.id
    ?? ctx.store?.driver?.all?.('users', {}, { limit: 1 })?.[0]?.user_id);
}

// ---- parameter readers ---------------------------------------------------
function readStoryPeer(r, key = 'peer', me = 0) {
  const peer = readInputPeer(r, key);
  if (peer.type === 'self' || !toNumber(peer.id)) return me;
  return toNumber(peer.id);
}

function readIdVector(r, key = 'id') {
  if (isReader(r)) {
    if (!r.has(4)) return [];
    return r.vector((rr) => rr.has(4) ? rr.int() : 0);
  }
  const value = r?.[key] ?? r?.ids ?? r?.id ?? [];
  if (!Array.isArray(value)) return [];
  return value.map((v) => toNumber(v));
}

function readNotifyKey(r, me = 0) {
  if (isReader(r)) {
    if (!r.has(4)) return 'users';
    const ctor = r.uint() >>> 0;
    if (ctor === ID.inputNotifyPeer) {
      const peer = readInputPeer(r);
      if (peer.type === 'self' || !toNumber(peer.id)) return `user:${me}`;
      return `${peer.type || 'user'}:${toNumber(peer.id)}`;
    }
    if (ctor === ID.inputNotifyUsers) return 'users';
    if (ctor === ID.inputNotifyChats) return 'chats';
    if (ctor === ID.inputNotifyBroadcasts) return 'broadcasts';
    return 'unknown';
  }
  const value = r?.peerKey ?? r?.peer ?? r?.key ?? r;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const type = String(value.type || value.peerType || 'users');
    if (type === 'self') return `user:${me}`;
    if (['users', 'chats', 'broadcasts'].includes(type)) return type;
    return `${type}:${toNumber(value.id ?? value.peerId ?? value.userId)}`;
  }
  return 'users';
}

function readNotifySettings(r) {
  if (!isReader(r)) {
    const value = r?.settings ?? r ?? {};
    const out = {};
    if (value.showPreviews !== undefined) out.showPreviews = Boolean(value.showPreviews);
    else if (value.show_previews !== undefined) out.showPreviews = Boolean(value.show_previews);
    if (value.silent !== undefined) out.silent = Boolean(value.silent);
    if (value.muteUntil !== undefined) out.muteUntil = toNumber(value.muteUntil);
    else if (value.mute_until !== undefined) out.muteUntil = toNumber(value.mute_until);
    if (value.storiesMuted !== undefined) out.storiesMuted = Boolean(value.storiesMuted);
    if (value.storiesHideSender !== undefined) out.storiesHideSender = Boolean(value.storiesHideSender);
    return out;
  }
  const out = {};
  if (!r.has(4)) return out;
  r.uint(); // inputPeerNotifySettings#cacb6ae2
  const flags = r.has(4) ? r.uint() : 0;
  if (flags & 1 && r.has(4)) out.showPreviews = r.bool();
  if (flags & 2 && r.has(4)) out.silent = r.bool();
  if (flags & 4 && r.has(4)) out.muteUntil = r.int();
  // NotificationSound fields (flags 3/4/5/8/9/10) are not needed locally; the
  // constructor id is consumed on a best-effort basis.
  if (flags & 8 && r.has(4)) r.uint();
  if (flags & 0x10 && r.has(4)) r.uint();
  if (flags & 0x20 && r.has(4)) r.uint();
  if (flags & 0x40 && r.has(4)) out.storiesMuted = r.bool();
  if (flags & 0x80 && r.has(4)) out.storiesHideSender = r.bool();
  return out;
}

// ---- local TL encoders ---------------------------------------------------
function bool(value = true) {
  return new TLBuffer().putUint(value ? ID.boolTrue : ID.boolFalse).buffer;
}

const boolTrue = () => bool(true);

function encodePeer(peer = {}) {
  const type = String(peer.type || peer.peerType || 'user');
  const ctor = type === 'channel' ? ID.peerChannel : type === 'chat' ? ID.peerChat : ID.peerUser;
  return new TLBuffer().putUint(ctor).putLong(BigInt(toNumber(peer.id ?? peer.peerId))).buffer;
}

function encodeUser(u = {}) {
  const flags = (u.accessHash !== undefined && u.accessHash !== null ? 1 : 0)
    | (u.firstName ? 1 << 1 : 0)
    | (u.lastName ? 1 << 2 : 0)
    | (u.username ? 1 << 3 : 0)
    | (u.phone ? 1 << 4 : 0)
    | (u.self ? 1 << 10 : 0);
  const b = new TLBuffer().putUint(ID.user).putUint(flags);
  if (flags & (1 << 10)) b.putUint(ID.boolTrue); // self:true
  b.putUint(0); // flags2
  b.putLong(BigInt(toNumber(u.id)));
  if (flags & 1) b.putLong(BigInt(toNumber(u.accessHash)));
  if (flags & (1 << 1)) b.putString(u.firstName);
  if (flags & (1 << 2)) b.putString(u.lastName);
  if (flags & (1 << 3)) b.putString(u.username);
  if (flags & (1 << 4)) b.putString(u.phone);
  return b.buffer;
}

function putUsers(b, users = []) {
  b.putVector(users, (u, bb) => bb.putRaw(Buffer.isBuffer(u) ? u : encodeUser(u)));
}

function encodeUpdates({ users = [], date = now() } = {}) {
  const b = new TLBuffer();
  b.putUint(ID.updates);
  b.putVector([], () => {}); // updates
  putUsers(b, users);
  b.putVector([], () => {}); // chats
  b.putInt(date).putInt(0); // date, seq
  return b.buffer;
}

/** storyViews#8d595cd6 with only the mandatory views_count set. */
function encodeStoryViews(count = 0) {
  return new TLBuffer().putUint(ID.storyViews).putUint(0).putInt(toNumber(count)).buffer;
}

/** storyItem#16a4b93c. Media is an empty MessageMedia placeholder: this
 *  local server does not resolve uploaded InputMedia into Photo/Document. */
function encodeStoryItem(story = {}, { viewsCount } = {}) {
  const hasFrom = story.ownerId !== undefined && story.ownerId !== null && toNumber(story.ownerId) !== 0;
  const hasCaption = Boolean(story.text);
  const hasViews = viewsCount !== undefined && viewsCount !== null;
  const flags = (hasCaption ? 1 : 0) | (hasViews ? 1 << 3 : 0) | (hasFrom ? 1 << 18 : 0);
  const b = new TLBuffer().putUint(ID.storyItem).putUint(flags);
  // No boxed bool flags (pinned/public/close_friends/.../out) are set.
  b.putInt(toNumber(story.id)).putInt(toNumber(story.date));
  if (hasFrom) b.putRaw(encodePeer({ type: 'user', id: story.ownerId }));
  b.putInt(toNumber(story.expires ?? story.expireDate));
  if (hasCaption) b.putString(story.text);
  b.putUint(ID.messageMediaEmpty);
  if (hasViews) b.putRaw(encodeStoryViews(viewsCount));
  return b.buffer;
}

function encodeStories(stories = [], { users = [] } = {}) {
  const b = new TLBuffer();
  b.putUint(ID.storiesStories).putUint(0);
  b.putInt(stories.length);
  b.putVector(stories, (story, bb) => bb.putRaw(encodeStoryItem(story)));
  b.putVector([], () => {}); // pinned_to_top (flags.0 not set)
  b.putVector([], () => {}); // chats
  putUsers(b, users);
  return b.buffer;
}

function encodePeerStories(peer = {}, stories = [], { users = [], maxReadId } = {}) {
  const inner = new TLBuffer();
  inner.putUint(ID.peerStories).putUint(maxReadId === undefined ? 0 : 1);
  inner.putRaw(encodePeer(peer));
  if (maxReadId !== undefined) inner.putInt(toNumber(maxReadId));
  inner.putVector(stories, (story, bb) => bb.putRaw(encodeStoryItem(story)));
  const b = new TLBuffer().putUint(ID.storiesPeerStories).putRaw(inner.buffer);
  b.putVector([], () => {}); // chats
  putUsers(b, users);
  return b.buffer;
}

function encodeStoryViewsList(views = [], { users = [], count, viewsCount, forwardsCount = 0, reactionsCount = 0, nextOffset } = {}) {
  const flags = nextOffset ? 1 : 0;
  const b = new TLBuffer().putUint(ID.storiesStoryViewsList).putUint(flags);
  b.putInt(count ?? views.length).putInt(viewsCount ?? views.length);
  b.putInt(forwardsCount).putInt(reactionsCount);
  b.putVector(views, (view, bb) => {
    bb.putUint(ID.storyView).putUint(0);
    bb.putLong(BigInt(toNumber(view.userId))).putInt(toNumber(view.date));
  });
  b.putVector([], () => {}); // chats
  putUsers(b, users);
  if (flags & 1) b.putString(nextOffset);
  return b.buffer;
}

function encodeStoriesStoryViews(entries = [], { users = [] } = {}) {
  const b = new TLBuffer().putUint(ID.storiesStoryViews);
  b.putVector(entries, (entry, bb) => bb.putRaw(encodeStoryViews(entry.views ?? 0)));
  putUsers(b, users);
  return b.buffer;
}

function encodeIntVector(ids = []) {
  return new TLBuffer().putVector(ids, (id, bb) => bb.putInt(toNumber(id))).buffer;
}

function encodePeerNotifySettings(settings = {}) {
  const show = settings.showPreviews;
  const silent = settings.silent;
  const mute = settings.muteUntil;
  const storiesMuted = settings.storiesMuted;
  const storiesHideSender = settings.storiesHideSender;
  const flags = (show !== undefined ? 1 : 0) | (silent !== undefined ? 2 : 0)
    | (mute !== undefined ? 4 : 0) | (storiesMuted !== undefined ? 0x40 : 0)
    | (storiesHideSender !== undefined ? 0x80 : 0);
  const b = new TLBuffer().putUint(ID.peerNotifySettings).putUint(flags);
  if (show !== undefined) b.putBool(Boolean(show));
  if (silent !== undefined) b.putBool(Boolean(silent));
  if (mute !== undefined) b.putInt(toNumber(mute));
  if (storiesMuted !== undefined) b.putBool(Boolean(storiesMuted));
  if (storiesHideSender !== undefined) b.putBool(Boolean(storiesHideSender));
  return b.buffer;
}

function usersFor(ctx, ids) {
  return ids.map((id) => ctx.store?.getUser?.(id)).filter(Boolean);
}

// ---- stories methods -----------------------------------------------------
export function sendStory(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  const me = currentUserId(ctx);
  let ownerId = me;
  let text = '';
  let media = null;
  let id;
  let expires = 0;
  if (isReader(r)) {
    const flags = r.has(4) ? r.uint() : 0;
    ownerId = readStoryPeer(r, 'peer', me);
    // Wire mode stops after peer: InputMedia has variable length and is not
    // needed to create the local story record.
    void flags;
  } else {
    const o = r || {};
    ownerId = readStoryPeer(o, 'peer', me);
    text = String(o.caption ?? o.text ?? '');
    media = o.media ?? null;
    const seed = o.id ?? o.randomId ?? o.random_id;
    if (seed !== undefined && seed !== null) id = Number(BigInt(seed) & 0x7fffffffn);
    const period = o.period ?? o.expiresIn;
    expires = toNumber(o.expires ?? o.expireDate ?? (period ? now() + toNumber(period) : 0));
  }
  store.createStory({ id, ownerId, media, text, date: now(), expires });
  return encodeUpdates({ users: usersFor(ctx, [ownerId]) });
}

export function getStoriesByID(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  const me = currentUserId(ctx);
  const ownerId = readStoryPeer(r, 'peer', me);
  const ids = isReader(r) ? readIdVector(r) : (r?.id ?? r?.ids ?? []);
  const stories = (Array.isArray(ids) && ids.length
    ? ids.map((id) => store.getStory(id)).filter(Boolean)
    : store.listStories(ownerId))
    .filter((story) => !ownerId || story.ownerId === ownerId);
  return encodeStories(stories, { users: usersFor(ctx, [ownerId]) });
}

/** Legacy name: layer 234 has no stories.getStories constructor. */
export const getStories = getStoriesByID;

function readOffsetLimit(r, ctx) {
  if (isReader(r)) {
    const peer = readStoryPeer(r, 'peer', currentUserId(ctx));
    const offset = r.has(4) ? r.int() : 0;
    const limit = r.has(4) ? r.int() : 20;
    return { ownerId: peer, offset, limit };
  }
  return {
    ownerId: readStoryPeer(r || {}, 'peer', currentUserId(ctx)),
    offset: toNumber(r?.offset),
    limit: toNumber(r?.limit, 20) || 20,
  };
}

export function getPinnedStories(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  const { ownerId, offset, limit } = readOffsetLimit(r, ctx);
  const stories = store.listStories(ownerId).slice(Math.max(0, offset), Math.max(0, offset) + limit);
  return encodeStories(stories, { users: usersFor(ctx, [ownerId]) });
}

export const getStoriesArchive = getPinnedStories;

export function getPeerStories(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  const me = currentUserId(ctx);
  let ownerId = me;
  let maxReadId;
  if (isReader(r)) {
    ownerId = readStoryPeer(r, 'peer', me);
  } else {
    ownerId = readStoryPeer(r || {}, 'peer', me);
    if (r?.maxReadId !== undefined) maxReadId = toNumber(r.maxReadId);
  }
  const stories = store.listStories(ownerId);
  return encodePeerStories(
    { type: 'user', id: ownerId },
    stories,
    { users: usersFor(ctx, [ownerId]), maxReadId },
  );
}

export function readStories(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  const me = currentUserId(ctx);
  const ownerId = readStoryPeer(r, 'peer', me);
  const maxId = isReader(r) ? (r.has(4) ? r.int() : 0) : toNumber(r?.maxId ?? r?.max_id ?? 0);
  const ids = store.listStories(ownerId)
    .map((story) => story.id)
    .filter((id) => !maxId || id <= maxId);
  for (const id of ids) store.viewStory(id, me);
  return encodeIntVector(ids);
}

/** Legacy Updates-shaped variant of stories.readStories. */
export function readStoriesUpdates(r, ctx = {}) {
  const me = currentUserId(ctx);
  readStories(r, ctx);
  return encodeUpdates({ users: usersFor(ctx, [me]) });
}

export function deleteStories(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  const me = currentUserId(ctx);
  const ownerId = readStoryPeer(r, 'peer', me);
  const requested = readIdVector(r);
  const ids = requested.length ? requested : store.listStories(ownerId).map((s) => s.id);
  const deleted = ids.filter((id) => store.deleteStory(id));
  return encodeIntVector(deleted);
}

/** Legacy name: layer 234 has no stories.deleteStory constructor. */
export function deleteStory(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  const me = currentUserId(ctx);
  const ownerId = readStoryPeer(r, 'peer', me);
  const id = isReader(r)
    ? (r.has(4) ? r.int() : 0)
    : toNumber(r?.id ?? r?.storyId ?? r?.story_id);
  if (id) store.deleteStory(id);
  else for (const story of store.listStories(ownerId)) store.deleteStory(story.id);
  return encodeUpdates({ users: usersFor(ctx, [ownerId]) });
}

export function deleteStoryBool(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  const id = isReader(r) ? (r.has(4) ? r.int() : 0) : toNumber(r?.id ?? r?.storyId);
  return bool(store.deleteStory(id));
}

export function getStoryViewsList(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  const me = currentUserId(ctx);
  let id = 0;
  let offset = '';
  let limit = 20;
  if (isReader(r)) {
    const flags = r.has(4) ? r.uint() : 0;
    readStoryPeer(r, 'peer', me);
    if (flags & 2 && r.has(1)) r.string(); // q
    id = r.has(4) ? r.int() : 0;
    offset = r.has(1) ? r.string() : '';
    limit = r.has(4) ? r.int() : 20;
  } else {
    readStoryPeer(r || {}, 'peer', me);
    id = toNumber(r?.id ?? r?.storyId);
    offset = String(r?.offset ?? '');
    limit = toNumber(r?.limit, 20) || 20;
  }
  const allViews = store.listViews(id);
  const start = offset ? Number(offset) || 0 : 0;
  const views = allViews.slice(start, start + limit);
  return encodeStoryViewsList(views, {
    users: usersFor(ctx, views.map((v) => v.userId)),
    count: allViews.length,
    viewsCount: allViews.length,
  });
}

export function getStoriesViews(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  const me = currentUserId(ctx);
  const ownerId = readStoryPeer(r, 'peer', me);
  const ids = isReader(r) ? readIdVector(r) : (r?.id ?? r?.ids ?? []);
  const entries = (Array.isArray(ids) && ids.length ? ids : store.listStories(ownerId).map((s) => s.id))
    .map((id) => ({ id, views: store.listViews(id).length }));
  return encodeStoriesStoryViews(entries);
}

/** Legacy Updates-shaped variant of stories.getStoriesViews. */
export function getStoriesViewsUpdates(r, ctx = {}) {
  const me = currentUserId(ctx);
  getStoriesViews(r, ctx);
  return encodeUpdates({ users: usersFor(ctx, [me]) });
}

export function incrementStoryViews(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  const me = currentUserId(ctx);
  const ownerId = readStoryPeer(r, 'peer', me);
  const requested = readIdVector(r);
  const ids = requested.length ? requested : store.listStories(ownerId).map((s) => s.id);
  for (const id of ids) store.viewStory(id, me);
  return boolTrue();
}

export function canSendStory() {
  // stories.canSendStoryCount#c387c04e count_remains:int (line 2089)
  return new TLBuffer().putUint(0xc387c04e).putInt(10).buffer;
}

// ---- account device / push methods ---------------------------------------
export function registerDevice(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  let token = '';
  let type = 0;
  if (isReader(r)) {
    if (r.has(4)) r.uint(); // flags (no_muted:flags.0?true)
    type = r.has(4) ? r.int() : 0;
    token = r.has(1) ? r.string() : '';
    // app_sandbox:Bool, secret:bytes, other_uids:Vector<long> are ignored.
  } else {
    token = String(r?.token ?? r?.deviceToken ?? '');
    type = toNumber(r?.type ?? r?.tokenType ?? 0);
  }
  store.addDevice({ userId: currentUserId(ctx), token, type });
  return boolTrue();
}

export function unregisterDevice(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  let token = '';
  if (isReader(r)) {
    if (r.has(4)) r.int(); // token_type
    token = r.has(1) ? r.string() : '';
  } else {
    token = String(r?.token ?? r?.deviceToken ?? '');
  }
  store.removeDevice(token);
  return boolTrue();
}

/** Legacy: no account.getPushSettings id in layer 234. Uses the same
 *  peerNotifySettings result as account.getNotifySettings#12b3ad31. */
export function getPushSettings(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  const key = readNotifyKey(r, currentUserId(ctx));
  return encodePeerNotifySettings(store.getPushSettings(key) || {});
}

/** Legacy: no account.updatePushSettings id in layer 234. */
export function updatePushSettings(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  const me = currentUserId(ctx);
  let key;
  let settings;
  if (isReader(r)) {
    // Legacy declaration: flags:# silent:flags.0?true peer:InputNotifyPeer
    // settings:InputPeerNotifySettings. No layer-234 id exists for this name.
    const flags = r.has(4) ? r.uint() : 0;
    key = readNotifyKey(r, me);
    settings = readNotifySettings(r);
    if (flags & 1) settings.silent = true;
  } else {
    key = readNotifyKey(r, me);
    settings = readNotifySettings(r);
  }
  store.setPushSettings(key, settings);
  return boolTrue();
}

const CONTACT_SIGNUP_KEY = 'contactSignupNotification';

export function getContactSignupNotification(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  const settings = store.getPushSettings(CONTACT_SIGNUP_KEY) || {};
  return bool(settings.silent !== true);
}

export function setContactSignupNotification(r, ctx = {}) {
  const store = storyStoreOf(ctx);
  let silent = false;
  if (isReader(r)) {
    silent = r.has(4) ? r.bool() : false;
  } else {
    const o = r || {};
    if (o.silent !== undefined) silent = Boolean(o.silent);
    else if (o.on !== undefined) silent = !Boolean(o.on);
    else if (o.enabled !== undefined) silent = !Boolean(o.enabled);
    else if (o.value !== undefined) silent = !Boolean(o.value);
  }
  store.setPushSettings(CONTACT_SIGNUP_KEY, { silent });
  return boolTrue();
}

// Both short names and fully qualified method names are provided for callers
// that dispatch by method name.
export default {
  sendStory, getStoriesByID, getStories, getPinnedStories, getStoriesArchive,
  getPeerStories, readStories, readStoriesUpdates, deleteStories, deleteStory,
  deleteStoryBool, getStoryViewsList, getStoriesViews, getStoriesViewsUpdates,
  incrementStoryViews, canSendStory, registerDevice, unregisterDevice,
  getPushSettings, updatePushSettings, getContactSignupNotification,
  setContactSignupNotification,

  'stories.sendStory': sendStory,
  'stories.getStories': getStories,
  'stories.getStoriesByID': getStoriesByID,
  'stories.getPinnedStories': getPinnedStories,
  'stories.getStoriesArchive': getStoriesArchive,
  'stories.getPeerStories': getPeerStories,
  'stories.readStories': readStories,
  'stories.readStoriesUpdates': readStoriesUpdates,
  'stories.deleteStories': deleteStories,
  'stories.deleteStory': deleteStory,
  'stories.deleteStoryBool': deleteStoryBool,
  'stories.getStoryViewsList': getStoryViewsList,
  'stories.getStoriesViews': getStoriesViews,
  'stories.getStoriesViewsUpdates': getStoriesViewsUpdates,
  'stories.incrementStoryViews': incrementStoryViews,
  'stories.canSendStory': canSendStory,
  'account.registerDevice': registerDevice,
  'account.unregisterDevice': unregisterDevice,
  'account.getPushSettings': getPushSettings,
  'account.updatePushSettings': updatePushSettings,
  'account.getContactSignupNotification': getContactSignupNotification,
  'account.setContactSignupNotification': setContactSignupNotification,
};
