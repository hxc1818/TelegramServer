// Sticker RPC handlers. Every constructor/method id below was grep-verified
// against schema/api.tl (layer 234). Codecs are local so no shared handler
// module has to change. Every handler accepts a TLBuffer positioned after the
// request constructor id or a plain JS object.
import { TLBuffer } from '../../tl/buffer.js';
import { StickerStore } from '../../store/stickers.js';
import { isReader, readInputUser } from './parsers.js';

export const ID = Object.freeze({
  boolTrue: 0x997275b5,                        // boolTrue#997275b5
  vector: 0x1cb5c415,                          // vector#1cb5c415
  messagesStickers: 0x30a6ec7e,                // messages.stickers#30a6ec7e
  messagesStickersNotModified: 0xf1749a22,     // messages.stickersNotModified#f1749a22
  messagesFeaturedStickers: 0xbe382906,        // messages.featuredStickers#be382906
  messagesFeaturedStickersNotModified: 0xc6dc0c66,
  messagesStickerSet: 0x6e153f16,              // messages.stickerSet#6e153f16
  messagesStickerSetNotModified: 0xd3f924eb,
  messagesSavedGifs: 0x84a02a0d,               // messages.savedGifs#84a02a0d
  messagesSavedGifsNotModified: 0xe8025ca2,
  emojiList: 0x7a1e11d1,                       // emojiList#7a1e11d1
  emojiListNotModified: 0x481eadfa,
  stickerSet: 0x2dd14edc,                      // stickerSet#2dd14edc
  stickerSetNoCovered: 0x77b15d1c,             // stickerSetNoCovered#77b15d1c
  stickerPack: 0x12b299d4,                     // stickerPack#12b299d4
  stickerKeyword: 0xfcfeb29c,                  // stickerKeyword#fcfeb29c
  document: 0x8fd4c4d8,                        // document#8fd4c4d8
  documentAttributeSticker: 0x6319d612,        // documentAttributeSticker#6319d612
  documentAttributeFilename: 0x15590068,       // documentAttributeFilename#15590068
  documentAttributeImageSize: 0x6c37c15c,      // documentAttributeImageSize#6c37c15c
  inputDocument: 0x1abfb575,                   // inputDocument#1abfb575
  inputPhoto: 0x3bb3b94a,                      // inputPhoto#3bb3b94a
  inputStickerSetEmpty: 0xffb62b95,            // inputStickerSetEmpty#ffb62b95
  inputStickerSetID: 0x9de7a269,               // inputStickerSetID#9de7a269
  inputStickerSetShortName: 0x861cc8a0,        // inputStickerSetShortName#861cc8a0
  inputStickerSetItem: 0x32da9e9c,             // inputStickerSetItem#32da9e9c
  inputStickeredMediaPhoto: 0x4a992157,        // inputStickeredMediaPhoto#4a992157
  inputStickeredMediaDocument: 0x438865b,      // inputStickeredMediaDocument#438865b
});

export const METHOD_ID = Object.freeze({
  'messages.getStickers': 0xd5a5d3a1,
  'messages.getFeaturedStickers': 0x64780b14,
  'messages.getStickerSet': 0xc8a0ec74,
  'messages.getSavedGifs': 0x5cf09635,
  'messages.saveGif': 0x327a30cb,
  'messages.getAttachedStickers': 0xcc5b67cc,
  'stickers.createStickerSet': 0x9021ab67,
  'stickers.addStickerToSet': 0x8653febe,
  'stickers.removeStickerFromSet': 0xf7760f51,
});

const i32 = (v) => Number(v) | 0;

function toBig(value) {
  if (value === undefined || value === null) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  const text = String(value);
  return /^-?\d+$/.test(text) ? BigInt(text) : 0n;
}

function objectStr(value, key, fallback = '') {
  const v = value?.[key];
  return v === undefined || v === null ? fallback : String(v);
}

function objectLong(value, key, fallback = 0n) {
  const v = value?.[key];
  return v === undefined || v === null ? fallback : toBig(v);
}

/** Resolve (or lazily create) the dedicated sticker store. */
function stickerStoreOf(ctx = {}) {
  if (ctx.stickerStore) return ctx.stickerStore;
  if (ctx.store && typeof ctx.store.createStickerSet === 'function'
      && typeof ctx.store.listStickers === 'function') return ctx.store;
  const dataDir = ctx.dataDir || ctx.store?.dataDir || ctx.config?.dataDir || './data';
  ctx.stickerStore = new StickerStore(dataDir);
  return ctx.stickerStore;
}

function emptySet() {
  return { id: 0n, accessHash: 0n, title: '', shortName: '', count: 0, hash: 0, stickers: [] };
}

/** Key used to look a set up: prefer a non-zero id, otherwise the short name. */
function setRefKey(ref) {
  if (ref === undefined || ref === null) return 0;
  if (typeof ref !== 'object') return ref;
  const id = toBig(ref.id ?? ref.setId ?? ref.stickerset?.id);
  if (id !== 0n) return id;
  return ref.shortName ?? ref.short_name ?? ref.stickerset?.shortName ?? 0;
}

// ---- request readers ----------------------------------------------------

function readInputDocument(value) {
  if (!isReader(value)) {
    const doc = value?.document ?? value?.sticker ?? value ?? {};
    return {
      id: toBig(doc.id ?? doc.documentId),
      accessHash: toBig(doc.accessHash ?? doc.access_hash),
      fileReference: Buffer.isBuffer(doc.fileReference) ? doc.fileReference : Buffer.alloc(0),
    };
  }
  if (!value.has(4) || value.uint() >>> 0 !== ID.inputDocument) {
    return { id: 0n, accessHash: 0n, fileReference: Buffer.alloc(0) };
  }
  const id = value.has(8) ? value.long() : 0n;
  const accessHash = value.has(8) ? value.long() : 0n;
  const fileReference = value.has(1) ? value.bytes() : Buffer.alloc(0);
  return { id, accessHash, fileReference };
}

function readInputStickerSet(value) {
  if (!isReader(value)) {
    if (typeof value !== 'object' || value === null) return { id: 0n, accessHash: 0n, shortName: String(value || '') };
    const ref = value.stickerset ?? value.stickerSet ?? value;
    if (typeof ref !== 'object' || ref === null) return { id: 0n, accessHash: 0n, shortName: String(ref || '') };
    return {
      id: toBig(ref.id),
      accessHash: toBig(ref.accessHash ?? ref.access_hash),
      shortName: objectStr(ref, 'shortName', objectStr(ref, 'short_name', '')),
    };
  }
  if (!value.has(4)) return { id: 0n, accessHash: 0n, shortName: '' };
  const ctor = value.uint() >>> 0;
  if (ctor === ID.inputStickerSetID) {
    return {
      id: value.has(8) ? value.long() : 0n,
      accessHash: value.has(8) ? value.long() : 0n,
      shortName: '',
    };
  }
  if (ctor === ID.inputStickerSetShortName) {
    return { id: 0n, accessHash: 0n, shortName: value.has(1) ? value.string() : '' };
  }
  // inputStickerSetEmpty and the special built-in sets carry no fields here.
  return { id: 0n, accessHash: 0n, shortName: '' };
}

function readInputStickerSetItem(value) {
  if (!isReader(value)) {
    const item = value ?? {};
    const docSource = item.document ?? item.sticker ?? item;
    const doc = readInputDocument(docSource);
    return {
      ...(docSource && typeof docSource === 'object' ? docSource : {}),
      id: doc.id,
      accessHash: doc.accessHash,
      emoji: objectStr(item, 'emoji', objectStr(docSource, 'emoji', '')),
      mimeType: objectStr(docSource, 'mimeType', objectStr(docSource, 'mime_type', 'image/webp')),
    };
  }
  const flags = value.has(4) ? value.uint() : 0;
  const doc = readInputDocument(value);
  const emoji = value.has(1) ? value.string() : '';
  // maskCoords#aed6dbb2 n:int x:double y:double zoom:double
  if (flags & 1) {
    if (value.has(4)) value.uint();
    if (value.has(24)) value.raw(24);
  }
  if (flags & 2 && value.has(1)) value.string(); // keywords
  return { ...doc, emoji, mimeType: 'image/webp', size: 0 };
}

// ---- TL encoders --------------------------------------------------------

/** FNV-1a 32-bit — same algorithm as StickerStore's content hashes. */
function hashOfStickers(stickers) {
  let h = 0x811c9dc5;
  for (const sticker of stickers || []) {
    const text = `${toBig(sticker.id).toString()}:${sticker.emoji || ''}\u0000`;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

function encodeStickerSet(set) {
  const stickers = Array.isArray(set.stickers) ? set.stickers : [];
  const count = set.count === undefined ? stickers.length : set.count;
  const hash = set.hash === undefined ? hashOfStickers(stickers) : set.hash;
  return new TLBuffer()
    .putUint(ID.stickerSet)
    .putUint(0) // no optional flags (archived/official/masks/... omitted)
    .putLong(toBig(set.id))
    .putLong(toBig(set.accessHash))
    .putString(set.title || '')
    .putString(set.shortName || '')
    .putInt(i32(count))
    .putInt(i32(hash))
    .buffer;
}

function encodeDocument(sticker, set) {
  const emoji = sticker.emoji || '';
  const setShortName = set?.shortName || sticker.setShortName || '';
  const setId = toBig(set?.id ?? sticker.setId ?? 0);
  const setAccessHash = toBig(set?.accessHash ?? 0);
  let stickerset;
  if (setId !== 0n && setAccessHash !== 0n) {
    stickerset = new TLBuffer().putUint(ID.inputStickerSetID).putLong(setId).putLong(setAccessHash).buffer;
  } else if (setShortName) {
    stickerset = new TLBuffer().putUint(ID.inputStickerSetShortName).putString(setShortName).buffer;
  } else {
    stickerset = new TLBuffer().putUint(ID.inputStickerSetEmpty).buffer;
  }

  const attributes = [new TLBuffer()
    .putUint(ID.documentAttributeSticker)
    .putUint(0)
    .putString(emoji)
    .putRaw(stickerset)
    .buffer];
  if (sticker.fileName) {
    attributes.push(new TLBuffer().putUint(ID.documentAttributeFilename).putString(sticker.fileName).buffer);
  }
  if (sticker.w && sticker.h) {
    attributes.push(new TLBuffer()
      .putUint(ID.documentAttributeImageSize).putInt(i32(sticker.w)).putInt(i32(sticker.h)).buffer);
  }

  return new TLBuffer()
    .putUint(ID.document)
    .putUint(0) // no thumbs / video thumbs
    .putLong(toBig(sticker.id))
    .putLong(toBig(sticker.accessHash))
    .putBytes(Buffer.alloc(0)) // file_reference
    .putInt(i32(sticker.mtime || 0))
    .putString(sticker.mimeType || 'image/webp')
    .putLong(toBig(sticker.size || 0))
    .putInt(1) // dc_id
    .putVector(attributes, (buf, b) => b.putRaw(buf))
    .buffer;
}

function encodeMessagesStickerSet(set) {
  const stickers = Array.isArray(set.stickers) ? set.stickers : [];
  const packs = new Map();
  for (const sticker of stickers) {
    const emoji = sticker.emoji || '';
    if (!packs.has(emoji)) packs.set(emoji, []);
    packs.get(emoji).push(toBig(sticker.id));
  }
  return new TLBuffer()
    .putUint(ID.messagesStickerSet)
    .putRaw(encodeStickerSet(set))
    .putVector([...packs], ([emoji, ids], b) => b
      .putUint(ID.stickerPack)
      .putString(emoji)
      .putVector(ids, (id, bb) => bb.putLong(id)))
    .putVector([], (_, b) => b) // keywords
    .putVector(stickers, (sticker, b) => b.putRaw(encodeDocument(sticker, set)))
    .buffer;
}

function encodeStickers(stickers, hash) {
  return new TLBuffer()
    .putUint(ID.messagesStickers)
    .putLong(toBig(hash))
    .putVector(stickers || [], (sticker, b) => b.putRaw(encodeDocument(sticker, null)))
    .buffer;
}

function encodeFeaturedStickers(sets, hash) {
  return new TLBuffer()
    .putUint(ID.messagesFeaturedStickers)
    .putUint(0) // flags: premium omitted
    .putLong(toBig(hash))
    .putInt(i32(sets.length))
    .putVector(sets, (set, b) => b.putUint(ID.stickerSetNoCovered).putRaw(encodeStickerSet(set)))
    .putVector([], (_, b) => b) // unread
    .buffer;
}

function encodeEmojiList(ids, hash) {
  return new TLBuffer()
    .putUint(ID.emojiList)
    .putLong(toBig(hash))
    .putVector((ids || []).map(toBig), (id, b) => b.putLong(id))
    .buffer;
}

function encodeSavedGifs(gifs, hash) {
  return new TLBuffer()
    .putUint(ID.messagesSavedGifs)
    .putLong(toBig(hash))
    .putVector(gifs || [], (gif, b) => b.putRaw(encodeDocument(gif, null)))
    .buffer;
}

function boolTrue() {
  return new TLBuffer().putUint(ID.boolTrue).buffer;
}

// ---- handlers -----------------------------------------------------------

export function getStickers(params, ctx = {}) {
  let emoticon = '';
  let hash = 0n;
  if (isReader(params)) {
    if (params.has(1)) emoticon = params.string();
    if (params.has(8)) hash = params.long();
  } else {
    emoticon = objectStr(params, 'emoticon', '');
    hash = objectLong(params, 'hash', 0n);
  }
  const stickers = stickerStoreOf(ctx).listStickers(emoticon ? { emoticon } : {});
  const current = hashOfStickers(stickers);
  if (current !== 0 && hash !== 0n && hash === BigInt(current)) {
    return new TLBuffer().putUint(ID.messagesStickersNotModified).buffer;
  }
  return encodeStickers(stickers, current);
}

export function getFeaturedStickers(params, ctx = {}) {
  let hash = 0n;
  if (isReader(params)) {
    if (params.has(8)) hash = params.long();
  } else {
    hash = objectLong(params, 'hash', 0n);
  }
  const sets = stickerStoreOf(ctx).getFeaturedStickers();
  const current = hashOfStickers(sets.flatMap((set) => set.stickers || []));
  return encodeFeaturedStickers(sets, current !== 0 && hash === BigInt(current) ? hash : current);
}

export function getStickerSet(params, ctx = {}) {
  let ref;
  if (isReader(params)) {
    ref = readInputStickerSet(params);
    if (params.has(4)) params.int(); // hash
  } else {
    ref = params?.stickerset ?? params?.stickerSet ?? params;
  }
  const set = stickerStoreOf(ctx).getStickerSet(setRefKey(ref)) || emptySet();
  return encodeMessagesStickerSet(set);
}

export function addStickerToSet(params, ctx = {}) {
  let ref;
  let item;
  if (isReader(params)) {
    ref = readInputStickerSet(params);
    item = readInputStickerSetItem(params);
  } else {
    ref = params?.stickerset ?? params?.stickerSet ?? params;
    item = params?.sticker ?? params?.item ?? params;
  }
  const set = stickerStoreOf(ctx).addSticker(setRefKey(ref), item) || emptySet();
  return encodeMessagesStickerSet(set);
}

export function createStickerSet(params, ctx = {}) {
  let title = '';
  let shortName = '';
  let stickers = [];
  let id;
  let accessHash;
  let featured = true;
  if (isReader(params)) {
    const flags = params.has(4) ? params.uint() : 0;
    for (const bit of [0, 5, 6]) if (flags & (1 << bit) && params.has(4)) params.uint(); // boxed true flags
    readInputUser(params);
    title = params.has(1) ? params.string() : '';
    shortName = params.has(1) ? params.string() : '';
    if (flags & (1 << 2)) readInputDocument(params); // thumb
    stickers = params.has(4) ? params.vector((item) => readInputStickerSetItem(item)) : [];
    if (flags & (1 << 3) && params.has(1)) params.string(); // software
  } else {
    title = objectStr(params, 'title', '');
    shortName = objectStr(params, 'shortName', objectStr(params, 'short_name', ''));
    const raw = Array.isArray(params?.stickers) ? params.stickers : [];
    stickers = raw.map((item) => readInputStickerSetItem(item));
    id = params?.id;
    accessHash = params?.accessHash ?? params?.access_hash;
    featured = params?.featured !== false;
  }
  const set = stickerStoreOf(ctx).createStickerSet({
    id,
    accessHash: accessHash || 0,
    title,
    shortName,
    stickers,
    featured,
  });
  return encodeMessagesStickerSet(set);
}

export function removeStickerFromSet(params, ctx = {}) {
  let doc;
  let ref;
  if (isReader(params)) {
    doc = readInputDocument(params);
  } else {
    doc = readInputDocument(params?.sticker ?? params?.id ?? params);
    if (params?.stickerset !== undefined || params?.stickerSet !== undefined) {
      ref = params.stickerset ?? params.stickerSet;
    }
  }
  const ms = stickerStoreOf(ctx);
  let set = null;
  if (ref !== undefined) {
    set = ms.removeSticker(setRefKey(ref), doc.id);
  } else {
    const owner = ms.findSetByDocument(doc.id);
    if (owner) set = ms.removeSticker(owner.id, doc.id);
  }
  return encodeMessagesStickerSet(set || emptySet());
}

export function getPopularEmoji(params, ctx = {}) {
  if (isReader(params) && params.has(8)) params.long(); // hash
  const pack = stickerStoreOf(ctx).getEmojiPack('popular');
  const ids = (pack?.documentIds || pack?.documents || pack?.ids || []).map(toBig);
  return encodeEmojiList(ids, pack?.hash ?? hashOfStickers(ids.map((id) => ({ id }))));
}

export function getSavedGifs(params, ctx = {}) {
  if (isReader(params)) {
    if (params.has(8)) params.long(); // hash
  }
  const gifs = stickerStoreOf(ctx).listSavedGifs();
  return encodeSavedGifs(gifs, hashOfStickers(gifs));
}

export function saveGif(params, ctx = {}) {
  let doc;
  let unsave = false;
  if (isReader(params)) {
    doc = readInputDocument(params);
    unsave = params.has(4) ? params.bool() : false;
  } else {
    doc = readInputDocument(params?.id ?? params?.document ?? params);
    unsave = Boolean(params?.unsave ?? false);
  }
  stickerStoreOf(ctx).saveGif({ ...doc, mimeType: 'image/gif' }, unsave);
  return boolTrue();
}

export function getAttachedStickers(params, ctx = {}) {
  if (isReader(params) && params.has(4)) {
    const ctor = params.uint() >>> 0;
    if (ctor === ID.inputStickeredMediaPhoto || ctor === ID.inputStickeredMediaDocument) {
      if (params.has(4)) params.uint(); // inner constructor id
      if (params.has(8)) params.long(); // id
      if (params.has(8)) params.long(); // access_hash
      if (params.has(1)) params.bytes(); // file_reference
    }
  }
  const stickers = stickerStoreOf(ctx).listStickers();
  return encodeStickers(stickers, hashOfStickers(stickers));
}

export default {
  ID,
  METHOD_ID,
  getStickers,
  getFeaturedStickers,
  getStickerSet,
  addStickerToSet,
  createStickerSet,
  removeStickerFromSet,
  getPopularEmoji,
  getSavedGifs,
  saveGif,
  getAttachedStickers,
};
