// Sticker store and sticker RPC handler tests (no network involved).
// Constructor ids are checked against the pinned schema/api.tl (layer 234).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TLBuffer } from '../src/tl/buffer.js';
import { loadSchema } from '../src/tl/schema.js';
import { StickerStore } from '../src/store/stickers.js';
import * as stickers from '../src/rpc/handlers/stickers.js';

const { ID, METHOD_ID } = stickers;

function tempDir() {
  const dir = path.join(os.tmpdir(), `telegramserver-stickers-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('every sticker constructor/method id matches schema/api.tl (layer 234)', () => {
  const schema = loadSchema();
  assert.equal(schema.layer, 234);
  const types = {
    boolTrue: 'boolTrue',
    messagesStickers: 'messages.stickers',
    messagesStickersNotModified: 'messages.stickersNotModified',
    messagesFeaturedStickers: 'messages.featuredStickers',
    messagesFeaturedStickersNotModified: 'messages.featuredStickersNotModified',
    messagesStickerSet: 'messages.stickerSet',
    messagesStickerSetNotModified: 'messages.stickerSetNotModified',
    messagesSavedGifs: 'messages.savedGifs',
    messagesSavedGifsNotModified: 'messages.savedGifsNotModified',
    emojiList: 'emojiList',
    emojiListNotModified: 'emojiListNotModified',
    stickerSet: 'stickerSet',
    stickerSetNoCovered: 'stickerSetNoCovered',
    stickerPack: 'stickerPack',
    stickerKeyword: 'stickerKeyword',
    document: 'document',
    documentAttributeSticker: 'documentAttributeSticker',
    documentAttributeFilename: 'documentAttributeFilename',
    documentAttributeImageSize: 'documentAttributeImageSize',
    inputDocument: 'inputDocument',
    inputPhoto: 'inputPhoto',
    inputStickerSetEmpty: 'inputStickerSetEmpty',
    inputStickerSetID: 'inputStickerSetID',
    inputStickerSetShortName: 'inputStickerSetShortName',
    inputStickerSetItem: 'inputStickerSetItem',
    inputStickeredMediaPhoto: 'inputStickeredMediaPhoto',
    inputStickeredMediaDocument: 'inputStickeredMediaDocument',
  };
  for (const [key, name] of Object.entries(types)) {
    const entry = schema.types.get(name);
    assert.ok(entry, `schema missing type ${name}`);
    assert.equal(ID[key], entry.id, `${key} != ${name}`);
  }
  for (const [name, id] of Object.entries(METHOD_ID)) {
    const entry = schema.functions.get(name);
    assert.ok(entry, `schema missing function ${name}`);
    assert.equal(id, entry.id, `${name} id mismatch`);
  }
});

test('StickerStore seeds a default set and supports set/document CRUD', () => {
  const dir = tempDir();
  const store = new StickerStore(dir);
  try {
    if (store.driverKind === 'sqlite') assert.ok(fs.existsSync(path.join(dir, 'stickers.sqlite')));

    const seeded = store.getStickerSet('telegramserver_welcome');
    assert.ok(seeded, 'default set exists');
    assert.equal(seeded.title, 'Welcome');
    assert.equal(seeded.stickers.length, 3);
    assert.ok(seeded.stickers.every((s) => s.emoji && s.mimeType === 'image/webp'));
    assert.equal(store.getFeaturedStickers().some((s) => s.id === seeded.id), true);

    const set = store.createStickerSet({
      id: 12345n,
      accessHash: 678n,
      title: 'Test Pack',
      shortName: 'test_pack',
      stickers: [
        { id: 100n, accessHash: 1n, emoji: '😀' },
        { id: 101n, accessHash: 1n, emoji: '😀' },
      ],
    });
    assert.equal(set.title, 'Test Pack');
    assert.equal(set.stickers.length, 2);
    assert.equal(store.getStickerSet(12345n).shortName, 'test_pack');
    assert.equal(store.getStickerSet('test_pack').accessHash, 678);
    assert.equal(store.getStickerSet(999999n), null);

    const added = store.addSticker(12345n, { id: 102n, accessHash: 1n, emoji: '🎉' });
    assert.equal(added.stickers.length, 3);
    assert.equal(store.findSetByDocument(102n).shortName, 'test_pack');
    assert.equal(store.listStickers({ emoticon: '🎉' }).length, 1);

    const removed = store.removeSticker('test_pack', 102n);
    assert.equal(removed.stickers.length, 2);
    assert.equal(store.findSetByDocument(102n), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StickerStore tracks recent stickers, emoji packs and saved GIFs', () => {
  const dir = tempDir();
  const store = new StickerStore(dir);
  try {
    store.saveRecent(7, 100n);
    store.saveRecent(7, 101n);
    store.saveRecent(7, 100n); // touching keeps the most recent position
    assert.deepEqual(store.listRecent(7).map((s) => Number(s.id)), [100, 101]);
    assert.equal(store.listRecent(8).length, 0);

    const pack = store.createEmojiPack({ name: 'popular', documentIds: [1n, 2n, 3n] });
    assert.equal(pack.name, 'popular');
    assert.deepEqual(store.getEmojiPack('popular').documentIds.map(Number), [1, 2, 3]);
    assert.equal(store.getEmojiPack('missing'), null);

    assert.equal(store.saveGif({ id: 55n, accessHash: 9n }), true);
    assert.equal(store.listSavedGifs().length, 1);
    assert.equal(Number(store.listSavedGifs()[0].id), 55);
    store.saveGif(55n, true);
    assert.equal(store.listSavedGifs().length, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StickerStore has a JSON fallback driver', () => {
  const dir = tempDir();
  const store = new StickerStore({ dataDir: dir, driver: 'json' });
  try {
    assert.equal(store.driverKind, 'json');
    assert.ok(fs.existsSync(path.join(dir, 'stickers.json')));
    assert.equal(store.getStickerSet('telegramserver_welcome').stickers.length, 3);
    store.createStickerSet({ id: 42n, title: 'J', shortName: 'j' });
    assert.equal(store.getStickerSet(42n).title, 'J');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function readStickersResult(buf, ctor) {
  const r = new TLBuffer(buf);
  assert.equal(r.uint(), ctor);
  const hash = r.long();
  assert.equal(r.uint(), ID.vector);
  const count = r.int();
  assert.ok(count >= 0);
  return { r, hash, count };
}

test('messages.getStickers returns stickers/stickersNotModified with verified ids', () => {
  const dir = tempDir();
  const store = new StickerStore(dir);
  try {
    const ctx = { stickerStore: store };
    const buf = stickers.getStickers({ emoticon: '', hash: 0n }, ctx);
    const { r, hash, count } = readStickersResult(buf, ID.messagesStickers);
    assert.ok(count >= 3);
    assert.equal(r.uint(), ID.document);
    assert.ok(hash >= 0n); // the TL hash field is a long

    const cached = stickers.getStickers({ emoticon: '', hash }, ctx);
    assert.equal(new TLBuffer(cached).uint(), ID.messagesStickersNotModified);

    // Wire form: messages.getStickers#d5a5d3a1 emoticon:string hash:long
    const req = new TLBuffer().putString('').putLong(0n).buffer;
    const wire = stickers.getStickers(new TLBuffer(req), ctx);
    assert.equal(new TLBuffer(wire).uint(), ID.messagesStickers);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('messages.getFeaturedStickers -> featuredStickers with stickerSetNoCovered', () => {
  const dir = tempDir();
  const store = new StickerStore(dir);
  try {
    const buf = stickers.getFeaturedStickers({ hash: 0n }, { stickerStore: store });
    const r = new TLBuffer(buf);
    assert.equal(r.uint(), ID.messagesFeaturedStickers);
    assert.equal(r.uint(), 0); // flags
    r.long(); // hash
    assert.ok(r.int() >= 1); // count
    assert.equal(r.uint(), ID.vector);
    assert.ok(r.int() >= 1);
    assert.equal(r.uint(), ID.stickerSetNoCovered);
    assert.equal(r.uint(), ID.stickerSet);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stickers.getStickerSet / create / add / remove return messages.stickerSet', () => {
  const dir = tempDir();
  const store = new StickerStore(dir);
  try {
    const ctx = { stickerStore: store };

    const setBuf = stickers.getStickerSet({ stickerset: { shortName: 'telegramserver_welcome' }, hash: 0 }, ctx);
    const sr = new TLBuffer(setBuf);
    assert.equal(sr.uint(), ID.messagesStickerSet);
    assert.equal(sr.uint(), ID.stickerSet);
    sr.uint(); // flags
    sr.long(); sr.long(); // id, access_hash
    assert.equal(sr.string(), 'Welcome');
    assert.equal(sr.string(), 'telegramserver_welcome');

    const created = stickers.createStickerSet({
      title: 'Wire Pack',
      shortName: 'wire_pack',
      stickers: [{ id: 500n, accessHash: 1n, emoji: '👍' }],
    }, ctx);
    assert.equal(new TLBuffer(created).uint(), ID.messagesStickerSet);
    assert.equal(store.getStickerSet('wire_pack').stickers.length, 1);

    const added = stickers.addStickerToSet({
      stickerset: { shortName: 'wire_pack' },
      sticker: { id: 501n, accessHash: 1n, emoji: '👎' },
    }, ctx);
    assert.equal(new TLBuffer(added).uint(), ID.messagesStickerSet);
    assert.equal(store.getStickerSet('wire_pack').stickers.length, 2);

    const removed = stickers.removeStickerFromSet({ sticker: { id: 501n } }, ctx);
    assert.equal(new TLBuffer(removed).uint(), ID.messagesStickerSet);
    assert.equal(store.getStickerSet('wire_pack').stickers.length, 1);

    // Wire form: createStickerSet with an inputUserSelf and one sticker item.
    const req = new TLBuffer()
      .putUint(0) // flags
      .putUint(0xf7c1b13f) // inputUserSelf
      .putString('TLPack').putString('tl_pack')
      .putUint(ID.vector).putInt(1)
      .putUint(0) // inputStickerSetItem flags (vector elements are bare)
      .putUint(ID.inputDocument).putLong(700n).putLong(701n).putBytes(Buffer.alloc(0))
      .putString('🐱')
      .buffer;
    const wire = stickers.createStickerSet(new TLBuffer(req), ctx);
    assert.equal(new TLBuffer(wire).uint(), ID.messagesStickerSet);
    assert.equal(store.getStickerSet('tl_pack').stickers.length, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getPopularEmoji / getSavedGifs / saveGif / getAttachedStickers ids', () => {
  const dir = tempDir();
  const store = new StickerStore(dir);
  try {
    const ctx = { stickerStore: store };
    store.createEmojiPack({ name: 'popular', documentIds: [11n, 12n] });
    const emoji = new TLBuffer(stickers.getPopularEmoji({ hash: 0n }, ctx));
    assert.equal(emoji.uint(), ID.emojiList);
    emoji.long();
    assert.equal(emoji.uint(), ID.vector);
    assert.equal(emoji.int(), 2);

    assert.equal(stickers.saveGif({ id: 99n, unsave: false }, ctx).readUInt32LE(0), ID.boolTrue);
    const gifs = new TLBuffer(stickers.getSavedGifs({ hash: 0n }, ctx));
    assert.equal(gifs.uint(), ID.messagesSavedGifs);
    gifs.long();
    assert.equal(gifs.uint(), ID.vector);
    assert.equal(gifs.int(), 1);
    assert.equal(gifs.uint(), ID.document);

    assert.equal(stickers.saveGif({ id: 99n, unsave: true }, ctx).readUInt32LE(0), ID.boolTrue);
    assert.equal(store.listSavedGifs().length, 0);

    const attached = stickers.getAttachedStickers({
      media: { _: ID.inputStickeredMediaDocument, id: 1n, accessHash: 2n },
    }, ctx);
    assert.equal(new TLBuffer(attached).uint(), ID.messagesStickers);

    // Wire form: saveGif#327a30cb id:InputDocument unsave:Bool
    const req = new TLBuffer()
      .putUint(ID.inputDocument).putLong(123n).putLong(456n).putBytes(Buffer.alloc(0))
      .putBool(false) // unsave:false
      .buffer;
    assert.equal(stickers.saveGif(new TLBuffer(req), ctx).readUInt32LE(0), ID.boolTrue);
    assert.equal(store.listSavedGifs().length, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
