// TL handlers for account / contacts / auth authorization (schema/api.tl,
// layer 234). Every constructor id below was grep-verified against the pinned
// schema; the source line is recorded next to each entry. Response shapes use
// the declared result type of each function. Local TL encoders live in this
// file so codecs.js stays untouched.
//
// Notable layer-234 differences from older layers (no id exists in the pinned
// schema, so the declared type is used instead):
//   - contacts.addContact / deleteContacts -> Updates#74ae4240 (there is no
//     contacts.contactAdded constructor in this layer).
//   - account.getWallPapers -> account.wallPapers#cdc3858c (there is no
//     help.wallPapers / wallPapersSlice constructor in this layer).
//   - account.setStatus is the legacy name; the schema declares
//     account.updateStatus#6628562c (Bool). Both names are exported.
//   - contacts.block / unblock -> boolTrue (their result type is Bool).

import { TLBuffer } from '../../tl/buffer.js';
import { isReader, int, long, str, bytes, readInputPeer, readInputUser } from './parsers.js';
import { AccountStore } from '../../store/account.js';

// Constructor ids from schema/api.tl (layer 234).
const ID = Object.freeze({
  boolFalse: 0xbc799737,                  // boolFalse#bc799737 (line 1)
  boolTrue: 0x997275b5,                   // boolTrue#997275b5 (line 2)
  vector: 0x1cb5c415,                     // vector#1cb5c415 (line 6)
  inputUserEmpty: 0xb98886cf,             // inputUserEmpty#b98886cf (line 20)
  inputUserSelf: 0xf7c1b13f,              // inputUserSelf#f7c1b13f (line 21)
  inputUser: 0xf21158c6,                  // inputUser#f21158c6 (line 22)
  inputPhoneContact: 0x6a1dc4be,          // inputPhoneContact#6a1dc4be (line 25)
  user: 0xb1b8cc83,                       // user#b1b8cc83 (line 91)
  peerUser: 0x59511722,                   // peerUser#59511722 (line 75)
  peerChat: 0x36c6019a,                   // peerChat#36c6019a (line 76)
  peerChannel: 0xa2a5371e,                // peerChannel#a2a5371e (line 77)
  inputNotifyPeer: 0xb8bc5b0c,            // inputNotifyPeer#b8bc5b0c (line 251)
  inputNotifyUsers: 0x193b4417,           // inputNotifyUsers#193b4417 (line 252)
  inputNotifyChats: 0x4a95e84e,           // inputNotifyChats#4a95e84e (line 253)
  inputNotifyBroadcasts: 0xb1db7c7e,      // inputNotifyBroadcasts#b1db7c7e (line 254)
  inputPeerNotifySettings: 0xcacb6ae2,    // inputPeerNotifySettings#cacb6ae2 (line 258)
  peerNotifySettings: 0x99622c0c,         // peerNotifySettings#99622c0c (line 260)
  importedContact: 0xc13e3c50,            // importedContact#c13e3c50 (line 282)
  contactsImportedContacts: 0x77d01c3b,   // contacts.importedContacts#77d01c3b (line 289)
  contactsBlocked: 0xade1591,             // contacts.blocked#ade1591 (line 291)
  updates: 0x74ae4240,                    // updates#74ae4240 (line 518)
  privacyRules: 0x50a04e45,               // account.privacyRules#50a04e45 (line 661)
  accountWallPapers: 0xcdc3858c,          // account.wallPapers#cdc3858c (line 1315)
  accountThemes: 0x9a3d8c6d,              // account.themes#9a3d8c6d (line 1360)
  peerBlocked: 0xe8fd8014,                // peerBlocked#e8fd8014 (line 1447)
  notificationSoundDefault: 0x97e8bebe,   // notificationSoundDefault#97e8bebe (line 1582)
  notificationSoundNone: 0x6f0c34df,      // notificationSoundNone#6f0c34df (line 1583)
  notificationSoundLocal: 0x830b9ae4,     // notificationSoundLocal#830b9ae4 (line 1584)
  notificationSoundRingtone: 0xff6c8049,  // notificationSoundRingtone#ff6c8049 (line 1585)
  textWithEntities: 0x751f3146,           // textWithEntities#751f3146 (line 1695)
  authAuthorization: 0x2ea2c0d4,          // auth.authorization#2ea2c0d4 (line 246)
  authExportedAuthorization: 0xb434e2b8,  // auth.exportedAuthorization#b434e2b8 (line 249)
});

// Method ids from schema/api.tl (layer 234).
export const METHOD_IDS = Object.freeze({
  'account.updateProfile': 0x78515775,          // line 2478
  'account.updateStatus': 0x6628562c,           // line 2479
  'account.setStatus': 0x6628562c,              // legacy name for updateStatus
  'account.getWallPapers': 0x7967d36,           // line 2480
  'account.updateUsername': 0x3e0bdd7c,         // line 2483
  'account.getPrivacy': 0xdadbc950,             // line 2484
  'account.setPrivacy': 0xc9f81ce8,             // line 2485
  'account.getNotifySettings': 0x12b3ad31,      // line 2476
  'account.updateNotifySettings': 0x84be5b93,   // line 2475
  'account.getThemes': 0x7206e458,              // line 2534
  'contacts.importContacts': 0x2c800be5,        // line 2613
  'contacts.deleteContacts': 0x96a0e00,         // line 2614
  'contacts.block': 0x2e2e8734,                 // line 2616
  'contacts.unblock': 0xb550d328,               // line 2617
  'contacts.getBlocked': 0x9a868f80,            // line 2618
  'contacts.addContact': 0xd9ba2e54,            // line 2626
  'auth.exportAuthorization': 0xe5bfffcd,       // line 2447
  'auth.importAuthorization': 0xa57a7dad,       // line 2448
});

const USER_BOOL_BITS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 23, 24, 25, 26, 27, 28, 29];

const PRIVACY_KEYS = Object.freeze({
  0x4f96cb18: 'statusTimestamp', // inputPrivacyKeyStatusTimestamp (line 605)
  0xbdfb0426: 'chatInvite',       // inputPrivacyKeyChatInvite (line 606)
  0xfabadc5f: 'phoneCall',        // inputPrivacyKeyPhoneCall (line 607)
  0xdb9e70d2: 'phoneP2P',         // inputPrivacyKeyPhoneP2P (line 608)
  0xa4dd4c08: 'forwards',         // inputPrivacyKeyForwards (line 609)
  0x5719bacc: 'profilePhoto',     // inputPrivacyKeyProfilePhoto (line 610)
  0x352dafa: 'phoneNumber',       // inputPrivacyKeyPhoneNumber (line 611)
  0xd1219bdd: 'addedByPhone',     // inputPrivacyKeyAddedByPhone (line 612)
  0xaee69d68: 'voiceMessages',    // inputPrivacyKeyVoiceMessages (line 613)
  0x3823cc40: 'about',            // inputPrivacyKeyAbout (line 614)
  0xd65a11cc: 'birthday',         // inputPrivacyKeyBirthday (line 615)
});

const INPUT_PRIVACY_RULES = Object.freeze({
  0xd09e07b: 'allowContacts',            // inputPrivacyValueAllowContacts (line 635)
  0x184b35ce: 'allowAll',                // inputPrivacyValueAllowAll (line 636)
  0x131cc67f: 'allowUsers',              // inputPrivacyValueAllowUsers (line 637)
  0xba52007: 'disallowContacts',         // inputPrivacyValueDisallowContacts (line 638)
  0xd66b66c9: 'disallowAll',             // inputPrivacyValueDisallowAll (line 639)
  0x90110467: 'disallowUsers',           // inputPrivacyValueDisallowUsers (line 640)
  0x840649cf: 'allowChatParticipants',   // inputPrivacyValueAllowChatParticipants (line 641)
  0xe94f0f86: 'disallowChatParticipants',// inputPrivacyValueDisallowChatParticipants (line 642)
  0x2f453e49: 'allowCloseFriends',       // inputPrivacyValueAllowCloseFriends (line 643)
  0x77cdc9f1: 'allowPremium',            // inputPrivacyValueAllowPremium (line 644)
  0x5a4fcce5: 'allowBots',               // inputPrivacyValueAllowBots (line 645)
  0xc4e57915: 'disallowBots',            // inputPrivacyValueDisallowBots (line 646)
});

const OUTPUT_PRIVACY_RULES = Object.freeze({
  allowContacts: 0xfffe1bac,            // privacyValueAllowContacts (line 648)
  allowAll: 0x65427b82,                 // privacyValueAllowAll (line 649)
  allowUsers: 0xb8905fb2,               // privacyValueAllowUsers (line 650)
  disallowContacts: 0xf888fa1a,         // privacyValueDisallowContacts (line 651)
  disallowAll: 0x8b73e763,              // privacyValueDisallowAll (line 652)
  disallowUsers: 0xe4621141,            // privacyValueDisallowUsers (line 653)
  allowChatParticipants: 0x6b134e8e,    // privacyValueAllowChatParticipants (line 654)
  disallowChatParticipants: 0x41c87565, // privacyValueDisallowChatParticipants (line 655)
  allowCloseFriends: 0xf7e8d89b,        // privacyValueAllowCloseFriends (line 656)
  allowPremium: 0xece9814b,             // privacyValueAllowPremium (line 657)
  allowBots: 0x21461b5d,                // privacyValueAllowBots (line 658)
  disallowBots: 0xf6a5f82f,             // privacyValueDisallowBots (line 659)
});

const toNumber = (v, fallback = 0) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function accountStoreOf(ctx = {}) {
  if (ctx.accountStore) return ctx.accountStore;
  const accountStore = new AccountStore(ctx.store?.dataDir || './data');
  ctx.accountStore = accountStore;
  return accountStore;
}

function currentUserId(ctx = {}) {
  if (ctx.userId) return toNumber(ctx.userId);
  if (ctx.user?.id) return toNumber(ctx.user.id);
  if (ctx.session?.userId) return toNumber(ctx.session.userId);
  const first = ctx.store?.driver?.all?.('users', {}, { limit: 1 })?.[0];
  return first ? toNumber(first.id ?? first.user_id) : 0;
}

// ---- local TL encoders --------------------------------------------------
function boolTrue() {
  return new TLBuffer().putUint(ID.boolTrue).buffer;
}

function encodeUser(u = {}) {
  const userFlags = USER_BOOL_BITS.reduce((f, bit) => {
    const key = USER_BOOL_KEYS[bit];
    return key && u[key] ? f | (1 << bit) : f;
  }, 0)
    | (u.accessHash !== undefined && u.accessHash !== null ? 1 : 0)
    | (u.firstName ? 1 << 1 : 0)
    | (u.lastName ? 1 << 2 : 0)
    | (u.username ? 1 << 3 : 0)
    | (u.phone ? 1 << 4 : 0);
  const b = new TLBuffer();
  b.putUint(ID.user).putUint(userFlags);
  for (const bit of USER_BOOL_BITS) if (userFlags & (1 << bit)) b.putUint(ID.boolTrue);
  b.putUint(0); // flags2 (all optional fields omitted)
  b.putLong(BigInt(toNumber(u.id ?? u.userId)));
  if (userFlags & 1) b.putLong(BigInt(toNumber(u.accessHash)));
  if (userFlags & (1 << 1)) b.putString(u.firstName);
  if (userFlags & (1 << 2)) b.putString(u.lastName);
  if (userFlags & (1 << 3)) b.putString(u.username);
  if (userFlags & (1 << 4)) b.putString(u.phone);
  return b.buffer;
}

const USER_BOOL_KEYS = {
  10: 'self', 11: 'contact', 12: 'mutualContact', 13: 'deleted', 14: 'bot',
  15: 'botChatHistory', 16: 'botNochats', 17: 'verified', 18: 'restricted',
  20: 'min', 21: 'botInlineGeo', 23: 'support', 24: 'scam', 25: 'applyMinPhoto',
  26: 'fake', 27: 'botAttachMenu', 28: 'premium', 29: 'attachMenuEnabled',
};

function encodePeer(peer = {}) {
  const type = String(peer.type || peer.peerType || 'user');
  const ctor = type === 'channel' ? ID.peerChannel : type === 'chat' ? ID.peerChat : ID.peerUser;
  return new TLBuffer().putUint(ctor).putLong(BigInt(toNumber(peer.id ?? peer.peerId))).buffer;
}

function putUsers(b, users) {
  b.putVector(users, (u, bb) => bb.putRaw(Buffer.isBuffer(u) ? u : encodeUser(u)));
}

function encodeUpdates({ users = [] } = {}) {
  const b = new TLBuffer();
  b.putUint(ID.updates);
  b.putVector([], () => {}); // updates
  putUsers(b, users);
  b.putVector([], () => {}); // chats
  b.putInt(Math.floor(Date.now() / 1000)).putInt(0); // date, seq
  return b.buffer;
}

function encodePeerNotifySettings(settings = {}) {
  const show = settings.showPreviews !== undefined ? settings.showPreviews : settings.show_previews;
  const silent = settings.silent;
  const mute = settings.muteUntil !== undefined ? settings.muteUntil : settings.mute_until;
  const flags = (show !== undefined ? 1 : 0) | (silent !== undefined ? 2 : 0) | (mute !== undefined ? 4 : 0);
  const b = new TLBuffer();
  b.putUint(ID.peerNotifySettings).putUint(flags);
  if (show !== undefined) b.putBool(Boolean(show));
  if (silent !== undefined) b.putBool(Boolean(silent));
  if (mute !== undefined) b.putInt(toNumber(mute));
  return b.buffer;
}

function encodePrivacyRules(rules = [], users = []) {
  const encoded = rules.map((rule) => {
    const type = typeof rule === 'string' ? rule : String(rule?.type || 'allowAll');
    const ctor = OUTPUT_PRIVACY_RULES[type] || OUTPUT_PRIVACY_RULES.allowAll;
    const b = new TLBuffer().putUint(ctor);
    if (type === 'allowUsers' || type === 'disallowUsers') {
      const ids = (Array.isArray(rule.users) ? rule.users : []).map(Number);
      b.putVector(ids, (id, bb) => bb.putLong(BigInt(id)));
    } else if (type === 'allowChatParticipants' || type === 'disallowChatParticipants') {
      const ids = (Array.isArray(rule.chats) ? rule.chats : []).map(Number);
      b.putVector(ids, (id, bb) => bb.putLong(BigInt(id)));
    }
    return b.buffer;
  });
  const b = new TLBuffer();
  b.putUint(ID.privacyRules);
  b.putVector(encoded, (buf, bb) => bb.putRaw(buf));
  b.putVector([], () => {}); // chats
  putUsers(b, users);
  return b.buffer;
}

function encodeImportedContacts(imported, users) {
  const b = new TLBuffer();
  b.putUint(ID.contactsImportedContacts);
  b.putVector(imported || [], (item, bb) => bb
    .putUint(ID.importedContact)
    .putLong(BigInt(toNumber(item.userId)))
    .putLong(BigInt(toNumber(item.clientId))));
  b.putVector([], () => {}); // popular_invites
  b.putVector([], () => {}); // retry_contacts
  putUsers(b, users);
  return b.buffer;
}

function encodeExportedAuthorization(id, token) {
  return new TLBuffer()
    .putUint(ID.authExportedAuthorization)
    .putLong(BigInt(toNumber(id)))
    .putString(token)
    .buffer;
}

function encodeAuthorization(user) {
  return new TLBuffer().putUint(ID.authAuthorization).putUint(0).putRaw(encodeUser(user || {})).buffer;
}

// ---- parameter readers -------------------------------------------------
function readPrivacyKey(r) {
  if (isReader(r)) {
    if (!r.has(4)) return 'statusTimestamp';
    return PRIVACY_KEYS[r.uint() >>> 0] || 'unknown';
  }
  const value = r?.key ?? r ?? 'statusTimestamp';
  if (typeof value === 'string') return PRIVACY_KEYS[Number(value) >>> 0] || value;
  if (typeof value === 'number') return PRIVACY_KEYS[value >>> 0] || 'unknown';
  if (value && typeof value === 'object') {
    return value.type || value.key || PRIVACY_KEYS[toNumber(value.constructor)] || 'unknown';
  }
  return 'statusTimestamp';
}

function readPrivacyRules(r) {
  if (isReader(r)) {
    if (!r.has(4)) return [];
    return r.vector((rr) => {
      const ctor = rr.uint() >>> 0;
      const type = INPUT_PRIVACY_RULES[ctor] || 'allowAll';
      const out = { type };
      if (type === 'allowUsers' || type === 'disallowUsers') {
        out.users = rr.vector((x) => toNumber(readInputUser(x).id));
      } else if (type === 'allowChatParticipants' || type === 'disallowChatParticipants') {
        out.chats = rr.vector((x) => toNumber(x.long())).map(Number);
      }
      return out;
    });
  }
  const value = r?.rules || [];
  if (!Array.isArray(value)) return [];
  return value.map((rule) => (typeof rule === 'string' ? { type: rule } : { ...rule }));
}

function readNotifyPeerKey(r, me) {
  if (isReader(r)) {
    if (!r.has(4)) return 'users';
    const ctor = r.uint() >>> 0;
    if (ctor === ID.inputNotifyPeer) {
      const peer = readInputPeer(r);
      if (peer.type === 'self') return `user:${me}`;
      return `${peer.type || 'user'}:${toNumber(peer.id)}`;
    }
    if (ctor === ID.inputNotifyUsers) return 'users';
    if (ctor === ID.inputNotifyChats) return 'chats';
    if (ctor === ID.inputNotifyBroadcasts) return 'broadcasts';
    return 'unknown';
  }
  const peer = r?.peer ?? r?.peerKey ?? r ?? 'users';
  if (typeof peer === 'string') return peer;
  if (peer && typeof peer === 'object') {
    const type = String(peer.type || peer.peerType || 'users');
    if (type === 'self') return `user:${me}`;
    if (['users', 'chats', 'broadcasts'].includes(type)) return type;
    return `${type}:${toNumber(peer.id ?? peer.peerId)}`;
  }
  return 'users';
}

function skipNotificationSound(r) {
  if (!r.has(4)) return;
  const ctor = r.uint() >>> 0;
  if (ctor === ID.notificationSoundLocal && r.has(1)) {
    r.string();
    if (r.has(1)) r.string();
  } else if (ctor === ID.notificationSoundRingtone && r.has(8)) {
    r.long();
  }
}

function readInputNotifySettings(r) {
  if (!isReader(r)) {
    const value = r?.settings ?? r ?? {};
    const out = {};
    if (value.showPreviews !== undefined) out.showPreviews = Boolean(value.showPreviews);
    else if (value.show_previews !== undefined) out.showPreviews = Boolean(value.show_previews);
    if (value.silent !== undefined) out.silent = Boolean(value.silent);
    if (value.muteUntil !== undefined) out.muteUntil = toNumber(value.muteUntil);
    else if (value.mute_until !== undefined) out.muteUntil = toNumber(value.mute_until);
    return out;
  }
  const out = {};
  if (!r.has(4)) return out;
  r.uint(); // inputPeerNotifySettings#cacb6ae2
  const flags = r.has(4) ? r.uint() : 0;
  if (flags & 1 && r.has(4)) out.showPreviews = r.bool();
  if (flags & 2 && r.has(4)) out.silent = r.bool();
  if (flags & 4 && r.has(4)) out.muteUntil = r.int();
  if (flags & 8) skipNotificationSound(r);
  if (flags & (1 << 6) && r.has(4)) out.storiesMuted = r.bool();
  if (flags & (1 << 7) && r.has(4)) out.storiesHideSender = r.bool();
  if (flags & (1 << 8)) skipNotificationSound(r);
  return out;
}

function skipTextWithEntities(r) {
  // textWithEntities#751f3146 text:string entities:Vector<MessageEntity>.
  if (!r.has(4)) return;
  r.uint();
  if (r.has(1)) r.string();
  if (r.has(4)) {
    r.uint(); // vector id
    if (r.has(4)) r.int(); // entity count (entities are left untouched)
  }
}

function readInputUserIds(r) {
  if (isReader(r)) {
    if (!r.has(4)) return [];
    return r.vector((rr) => toNumber(readInputUser(rr).id));
  }
  const value = r?.id ?? r?.ids ?? r?.users ?? [];
  if (!Array.isArray(value)) return [];
  return value.map((v) => (v && typeof v === 'object'
    ? toNumber(v.id ?? v.userId ?? v.user_id ?? v.peerId)
    : toNumber(v)));
}

function readInputContacts(r) {
  if (!isReader(r)) {
    const value = r?.contacts ?? [];
    if (!Array.isArray(value)) return [];
    return value.map((c = {}) => ({
      clientId: toNumber(c.clientId ?? c.client_id),
      phone: String(c.phone ?? c.phone_number ?? ''),
      firstName: String(c.firstName ?? c.first_name ?? ''),
      lastName: String(c.lastName ?? c.last_name ?? ''),
    }));
  }
  if (!r.has(4)) return [];
  return r.vector((rr) => {
    const ctor = rr.uint() >>> 0;
    const flags = rr.has(4) ? rr.uint() : 0;
    const clientId = rr.has(8) ? Number(rr.long()) : 0;
    const phone = rr.has(1) ? rr.string() : '';
    const firstName = rr.has(1) ? rr.string() : '';
    const lastName = rr.has(1) ? rr.string() : '';
    if (flags & 1) skipTextWithEntities(rr);
    return { ctor, clientId, phone, firstName, lastName };
  });
}

// ---- account methods ---------------------------------------------------
export function updateProfile(r, ctx) {
  const me = currentUserId(ctx);
  let patch = {};
  if (isReader(r)) {
    const flags = r.has(4) ? r.uint() : 0;
    if (flags & 1 && r.has(1)) patch.firstName = r.string();
    if (flags & 2 && r.has(1)) patch.lastName = r.string();
    if (flags & 4 && r.has(1)) patch.about = r.string();
  } else {
    const o = r || {};
    for (const [src, key] of [['firstName', 'firstName'], ['first_name', 'firstName'],
      ['lastName', 'lastName'], ['last_name', 'lastName'], ['about', 'about']]) {
      if (o[src] !== undefined) patch[key] = String(o[src]);
    }
  }
  const profile = accountStoreOf(ctx).setProfile(me, patch);
  const existing = ctx.store?.getUser?.(me) || {};
  return encodeUser({
    ...existing,
    id: me,
    firstName: profile.firstName,
    lastName: profile.lastName,
    username: profile.username,
  });
}

export function updateUsername(r, ctx) {
  const me = currentUserId(ctx);
  const username = isReader(r) ? (r.has(1) ? r.string() : '') : str(r, 'username', '');
  const profile = accountStoreOf(ctx).setUsername(me, username);
  const existing = ctx.store?.getUser?.(me) || {};
  return encodeUser({
    ...existing,
    id: me,
    firstName: profile.firstName,
    lastName: profile.lastName,
    username: profile.username,
  });
}

export function setPrivacy(r, ctx) {
  const store = accountStoreOf(ctx);
  const key = readPrivacyKey(r);
  const rules = readPrivacyRules(r);
  store.setPrivacy(key, rules);
  return encodePrivacyRules(store.getPrivacy(key) || rules, []);
}

export function getPrivacy(r, ctx) {
  const key = readPrivacyKey(r);
  const rules = accountStoreOf(ctx).getPrivacy(key);
  return encodePrivacyRules(rules && rules.length ? rules : [{ type: 'allowAll' }], []);
}

export function getNotifySettings(r, ctx) {
  const me = currentUserId(ctx);
  const key = readNotifyPeerKey(r, me);
  const settings = accountStoreOf(ctx).getNotifySettings(key);
  return encodePeerNotifySettings(settings || {});
}

export function updateNotifySettings(r, ctx) {
  const me = currentUserId(ctx);
  const key = readNotifyPeerKey(r, me);
  const settings = readInputNotifySettings(r);
  accountStoreOf(ctx).setNotifySettings(key, settings);
  return boolTrue();
}

function readStatus(r) {
  if (isReader(r)) return r.has(4) ? r.bool() : false;
  const o = r || {};
  if (o.online !== undefined) return Boolean(o.online);
  if (o.offline !== undefined) return !Boolean(o.offline);
  return false;
}

export function setStatus(r, ctx) {
  accountStoreOf(ctx).setStatus(currentUserId(ctx), readStatus(r));
  return boolTrue();
}

export const updateStatus = setStatus;

export function getWallPapers(r, ctx) {
  const hash = long(r, 'hash', 0n);
  const b = new TLBuffer();
  b.putUint(ID.accountWallPapers).putLong(hash);
  b.putVector([], () => {}); // wallpapers
  return b.buffer;
}

export function getThemes(r, ctx) {
  const hash = isReader(r)
    ? (r.has(1) ? (r.string(), r.has(8) ? r.long() : 0n) : 0n)
    : long(r, 'hash', 0n);
  const b = new TLBuffer();
  b.putUint(ID.accountThemes).putLong(hash);
  b.putVector([], () => {}); // themes
  return b.buffer;
}

// ---- contacts methods --------------------------------------------------
export function addContact(r, ctx) {
  const me = currentUserId(ctx);
  const store = accountStoreOf(ctx);
  let id = 0;
  let firstName = '';
  let lastName = '';
  let phone = '';
  if (isReader(r)) {
    const flags = r.has(4) ? r.uint() : 0;
    if (flags & 1 && r.has(4)) r.uint(); // add_phone_privacy_exception:true
    const input = readInputUser(r);
    id = input?.type === 'self' ? me : toNumber(input?.id);
    if (r.has(1)) firstName = r.string();
    if (r.has(1)) lastName = r.string();
    if (r.has(1)) phone = r.string();
    if (flags & 2) skipTextWithEntities(r);
  } else {
    const o = r || {};
    id = toNumber(o.peerId ?? o.contactId ?? o.userId ?? o.id);
    firstName = String(o.firstName ?? o.first_name ?? '');
    lastName = String(o.lastName ?? o.last_name ?? '');
    phone = String(o.phone ?? o.phone_number ?? '');
  }
  const row = store.addContact(me, { phone, firstName, lastName, peerId: id });
  try { ctx.store?.addContact?.(me, phone, id || row.peerId); } catch { /* main store optional */ }
  const users = id ? [ctx.store?.getUser?.(id) || { id, firstName, lastName }] : [];
  return encodeUpdates({ users });
}

export function deleteContacts(r, ctx) {
  const me = currentUserId(ctx);
  const store = accountStoreOf(ctx);
  const ids = readInputUserIds(r).map((id) => id || me);
  for (const id of ids) {
    for (const contact of store.listContacts(me)) {
      if (contact.peerId === id) store.removeContact(me, contact.phone);
    }
    try { ctx.store?.driver?.delete?.('contacts', { userId: me, peerId: id }); } catch { /* optional */ }
  }
  const users = ids.map((id) => ctx.store?.getUser?.(id)).filter(Boolean);
  return encodeUpdates({ users });
}

export function importContacts(r, ctx) {
  const me = currentUserId(ctx);
  const store = accountStoreOf(ctx);
  const contacts = readInputContacts(r);
  const imported = [];
  const users = [];
  for (const contact of contacts) {
    const peerId = contact.peerId
      || toNumber(ctx.store?.getUserByPhone?.(contact.phone)?.id)
      || 0;
    store.addContact(me, { ...contact, peerId });
    try { ctx.store?.addContact?.(me, contact.phone, peerId); } catch { /* optional */ }
    imported.push({ userId: peerId, clientId: contact.clientId });
    const user = ctx.store?.getUser?.(peerId);
    if (user) users.push(user);
  }
  return encodeImportedContacts(imported, users);
}

function readBlockPeer(r) {
  if (isReader(r)) {
    const flags = r.has(4) ? r.uint() : 0;
    if (flags & 1 && r.has(4)) r.uint(); // my_stories_from:true
    return readInputPeer(r);
  }
  return r?.id ?? r?.peer ?? r ?? {};
}

export function block(r, ctx) {
  const me = currentUserId(ctx);
  accountStoreOf(ctx).block(me, readBlockPeer(r));
  return boolTrue();
}

export function unblock(r, ctx) {
  const me = currentUserId(ctx);
  accountStoreOf(ctx).unblock(me, readBlockPeer(r));
  return boolTrue();
}

export function getBlocked(r, ctx) {
  if (isReader(r)) {
    const flags = r.has(4) ? r.uint() : 0;
    if (flags & 1 && r.has(4)) r.uint(); // my_stories_from:true
    if (r.has(4)) r.int(); // offset
    if (r.has(4)) r.int(); // limit
  }
  const me = currentUserId(ctx);
  const rows = accountStoreOf(ctx).listBlocked(me);
  const b = new TLBuffer();
  b.putUint(ID.contactsBlocked);
  b.putVector(rows, (row, bb) => bb
    .putUint(ID.peerBlocked)
    .putRaw(encodePeer({ type: row.peerType, id: row.peerId }))
    .putInt(toNumber(row.date)));
  b.putVector([], () => {}); // chats
  putUsers(b, rows.map((row) => (row.peerType === 'user' || row.peerType === 'self'
    ? ctx.store?.getUser?.(row.peerId) || null
    : null)).filter(Boolean));
  return b.buffer;
}

// ---- auth authorization tokens ----------------------------------------
export function exportAuthorization(r, ctx) {
  const me = currentUserId(ctx);
  const dcId = isReader(r) ? (r.has(4) ? r.int() : 1) : int(r, 'dcId', 1);
  const token = accountStoreOf(ctx).exportAuthorization(me, dcId);
  return encodeExportedAuthorization(me, token);
}

export function importAuthorization(r, ctx) {
  let id = 0;
  let token = '';
  if (isReader(r)) {
    if (r.has(8)) id = Number(r.long());
    if (r.has(1)) token = r.bytes().toString('utf8');
  } else {
    id = Number(long(r, 'id', 0n));
    token = bytes(r, 'bytes').toString('utf8');
  }
  const userId = accountStoreOf(ctx).importAuthorization(token) || id || currentUserId(ctx);
  const user = ctx.store?.getUser?.(userId) || { id: userId };
  return encodeAuthorization(user);
}

export default {
  updateProfile, updateUsername, setPrivacy, getPrivacy,
  getNotifySettings, updateNotifySettings, setStatus, updateStatus,
  getWallPapers, getThemes, addContact, deleteContacts, importContacts,
  block, unblock, getBlocked, exportAuthorization, importAuthorization,
};
