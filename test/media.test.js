// Media store / media RPC handler tests (no network involved).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TLBuffer } from '../src/tl/buffer.js';
import { loadSchema } from '../src/tl/schema.js';
import { MediaStore } from '../src/store/media.js';
import {
  ID,
  saveFilePart,
  saveBigFilePart,
  getFile,
  sendMedia,
  getDocumentByHash,
  getWebPage,
} from '../src/rpc/handlers/media.js';

function tempDir() {
  const dir = path.join(os.tmpdir(), `telegramserver-media-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('every media constructor id matches schema/api.tl (layer 234)', () => {
  const schema = loadSchema();
  assert.equal(schema.layer, 234);
  const map = {
    uploadFile: 'upload.file',
    fileUnknown: 'storage.fileUnknown',
    filePartial: 'storage.filePartial',
    fileJpeg: 'storage.fileJpeg',
    filePng: 'storage.filePng',
    filePdf: 'storage.filePdf',
    fileMp3: 'storage.fileMp3',
    fileMov: 'storage.fileMov',
    updateShortSentMessage: 'updateShortSentMessage',
    messageMediaDocument: 'messageMediaDocument',
    messageMediaPhoto: 'messageMediaPhoto',
    document: 'document',
    documentEmpty: 'documentEmpty',
    photo: 'photo',
    photoSizeEmpty: 'photoSizeEmpty',
    documentAttributeFilename: 'documentAttributeFilename',
    inputMediaUploadedDocument: 'inputMediaUploadedDocument',
    inputMediaUploadedPhoto: 'inputMediaUploadedPhoto',
    inputFile: 'inputFile',
    inputFileBig: 'inputFileBig',
    inputDocument: 'inputDocument',
    inputPhoto: 'inputPhoto',
    webPageEmpty: 'webPageEmpty',
  };
  for (const [key, name] of Object.entries(map)) {
    const entry = schema.types.get(name);
    assert.ok(entry, `schema missing ${name}`);
    assert.equal(ID[key], entry.id, `${key} != ${name}`);
  }
  assert.equal(schema.functions.get('messages.sendMedia').id, 0x330e77f);
  assert.equal(schema.functions.get('upload.saveFilePart').id, 0xb304a621);
  assert.equal(schema.functions.get('upload.saveBigFilePart').id, 0xde7b673d);
  assert.equal(schema.functions.get('upload.getFile').id, 0xbe5335be);
});

test('saveFilePart -> getFile -> upload.file round trip (object and wire mode)', () => {
  const dir = tempDir();
  const store = new MediaStore(dir);
  const ctx = { mediaStore: store };
  try {
    const fileId = 424242n;
    const part0 = Buffer.from('hello ');
    const part1 = Buffer.from('world');

    assert.equal(saveFilePart({ fileId, filePart: 0, bytes: part0 }, ctx).readUInt32LE(0), ID.boolTrue);
    assert.equal(saveFilePart({ fileId, filePart: 1, bytes: part1 }, ctx).readUInt32LE(0), ID.boolTrue);
    assert.equal(store.getFileParts(fileId).toString(), 'hello world');

    const file = getFile({ location: { fileId }, offset: 0, limit: 1024 }, ctx);
    const r = new TLBuffer(file);
    assert.equal(r.uint(), ID.uploadFile);
    const type = r.uint();
    assert.ok(
      [ID.fileUnknown, ID.filePartial, ID.fileJpeg, ID.filePng, ID.filePdf, ID.fileMov, ID.fileMp3].includes(type),
      `unexpected storage.FileType 0x${type.toString(16)}`,
    );
    assert.equal(r.int(), 0); // mtime
    assert.equal(r.bytes().toString(), 'hello world');

    // Wire form: upload.saveFilePart / upload.getFile after the constructor id.
    const otherId = 777n;
    const bytes = Buffer.from('wire-bytes');
    const saveReq = new TLBuffer().putLong(otherId).putInt(0).putBytes(bytes).buffer;
    assert.equal(saveFilePart(new TLBuffer(saveReq), ctx).readUInt32LE(0), ID.boolTrue);
    const loc = new TLBuffer()
      .putUint(ID.inputFileLocation).putLong(otherId).putInt(0).putLong(0n).putBytes(Buffer.alloc(0)).buffer;
    const getReq = new TLBuffer().putUint(0).putRaw(loc).putLong(0n).putInt(1024).buffer;
    const gr = new TLBuffer(getFile(new TLBuffer(getReq), ctx));
    assert.equal(gr.uint(), ID.uploadFile);
    gr.uint(); gr.int();
    assert.equal(gr.bytes().toString(), 'wire-bytes');

    // offset/limit slicing
    const sliced = new TLBuffer(getFile({ fileId, offset: 6, limit: 5 }, ctx));
    assert.equal(sliced.uint(), ID.uploadFile);
    sliced.uint(); sliced.int();
    assert.equal(sliced.bytes().toString(), 'world');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveBigFilePart assembles parts in numeric order', () => {
  const dir = tempDir();
  const store = new MediaStore(dir);
  const ctx = { mediaStore: store };
  try {
    const fileId = 999999n;
    assert.equal(saveBigFilePart({ fileId, filePart: 2, fileTotalParts: 3, bytes: Buffer.from('ef') }, ctx).readUInt32LE(0), ID.boolTrue);
    assert.equal(saveBigFilePart({ fileId, filePart: 0, fileTotalParts: 3, bytes: Buffer.from('ab') }, ctx).readUInt32LE(0), ID.boolTrue);
    assert.equal(saveBigFilePart({ fileId, filePart: 1, fileTotalParts: 3, bytes: Buffer.from('cd') }, ctx).readUInt32LE(0), ID.boolTrue);
    assert.equal(store.getFileParts(fileId).toString(), 'abcdef');

    const r = new TLBuffer(getFile({ fileId, offset: 0, limit: 1024 }, ctx));
    assert.equal(r.uint(), ID.uploadFile);
    r.uint(); r.int();
    assert.equal(r.bytes().toString(), 'abcdef');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MediaStore keeps documents and photos with access hashes and data', () => {
  const dir = tempDir();
  const store = new MediaStore(dir);
  try {
    const doc = store.putDocument({
      id: 55n,
      accessHash: 66n,
      fileName: 'file.txt',
      mimeType: 'text/plain',
      size: 3,
      data: Buffer.from('xyz'),
    });
    assert.equal(doc.id, 55);
    assert.equal(doc.accessHash, 66);
    assert.equal(store.getDocument(55n).data.toString(), 'xyz');
    assert.equal(store.getDocument(55n).mimeType, 'text/plain');
    assert.equal(store.getDocument(1234), null);

    store.putPhoto({ id: 88n, accessHash: 99n, data: Buffer.from([0xff, 0xd8, 0xff]) });
    const photo = store.getPhoto(88n);
    assert.equal(photo.accessHash, 99);
    assert.equal(photo.data.toString('hex'), 'ffd8ff');
    assert.equal(store.getPhoto(4321), null);

    // getFile can serve a stored document directly.
    const r = new TLBuffer(getFile({ fileId: 55n, offset: 0, limit: 10 }, { mediaStore: store }));
    assert.equal(r.uint(), ID.uploadFile);
    r.uint(); r.int();
    assert.equal(r.bytes().toString(), 'xyz');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sendMedia returns a parseable updateShortSentMessage with messageMediaDocument', () => {
  const dir = tempDir();
  const store = new MediaStore(dir);
  const ctx = { mediaStore: store };
  try {
    const result = sendMedia({
      peer: { type: 'user', id: 42 },
      media: {
        type: 'document',
        fileName: 'note.txt',
        mimeType: 'text/plain',
        data: Buffer.from('abc'),
      },
      message: 'caption',
      randomId: 123n,
    }, ctx);
    const r = new TLBuffer(result);
    assert.equal(r.uint(), ID.updateShortSentMessage);
    const flags = r.uint();
    assert.ok(flags & (1 << 1), 'out flag');
    assert.ok(flags & (1 << 9), 'media flag');
    assert.equal(r.uint(), ID.boolTrue); // out:true
    assert.ok(r.int() > 0); // id
    assert.equal(r.int(), 1); // pts
    assert.equal(r.int(), 1); // pts_count
    r.int(); // date

    assert.equal(r.uint(), ID.messageMediaDocument);
    assert.equal(r.uint() & 1, 1); // document:flags.0?Document
    assert.equal(r.uint(), ID.document);
    r.uint(); // document flags
    r.long(); r.long(); r.bytes(); r.int();
    assert.equal(r.string(), 'text/plain');
    assert.equal(r.long(), 3n);
    assert.equal(r.int(), 1); // dc_id
    const attrs = r.vector((rr) => {
      assert.equal(rr.uint(), ID.documentAttributeFilename);
      return rr.string();
    });
    assert.deepEqual(attrs, ['note.txt']);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sendMedia with a photo returns messageMediaPhoto with a Photo object', () => {
  const dir = tempDir();
  const store = new MediaStore(dir);
  try {
    const result = sendMedia({
      peer: { type: 'user', id: 7 },
      media: { type: 'photo', file: { id: 4242n }, data: Buffer.from([0xff, 0xd8, 0xff]) },
      message: '',
      randomId: 456n,
    }, { mediaStore: store });
    const r = new TLBuffer(result);
    assert.equal(r.uint(), ID.updateShortSentMessage);
    const flags = r.uint();
    assert.ok(flags & (1 << 9));
    r.uint(); // out:true
    r.int(); r.int(); r.int(); r.int();
    assert.equal(r.uint(), ID.messageMediaPhoto);
    assert.equal(r.uint() & 1, 1); // photo:flags.0?Photo
    assert.equal(r.uint(), ID.photo);
    r.uint(); // photo flags
    assert.equal(r.long(), 4242n);
    r.long(); r.bytes(); r.int();
    const sizes = r.vector((rr) => {
      assert.equal(rr.uint(), ID.photoSizeEmpty);
      return rr.string();
    });
    assert.equal(sizes.length, 1);
    assert.equal(r.int(), 1); // dc_id
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getDocumentByHash / getWebPage stubs return boxed empty objects', () => {
  const byHash = new TLBuffer(getDocumentByHash({ sha256: Buffer.alloc(32), size: 0n, mimeType: '' }));
  assert.equal(byHash.uint(), ID.documentEmpty);
  assert.equal(byHash.long(), 0n);

  const webPage = new TLBuffer(getWebPage({ url: '', hash: 0 }));
  assert.equal(webPage.uint(), ID.webPageEmpty);
  assert.equal(webPage.uint(), 0);
  assert.equal(webPage.long(), 0n);
});
