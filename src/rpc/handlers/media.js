// Media RPC handlers. Codecs and constructor ids are declared locally so no
// other handler module needs to change. Every id below was verified against
// schema/api.tl (layer 234).
import { TLBuffer } from '../../tl/buffer.js';
import { MediaStore } from '../../store/media.js';
import { isReader, int, long, str, readInputPeer, skipInputReplyTo } from './parsers.js';
import { authKeyIdOf, currentUser } from './context.js';

export const ID = Object.freeze({
  boolTrue: 0x997275b5,
  boolFalse: 0xbc799737,
  uploadFile: 0x96a18d5,                 // upload.file#96a18d5
  fileUnknown: 0xaa963b05,               // storage.fileUnknown#aa963b05
  filePartial: 0x40bc6f52,               // storage.filePartial#40bc6f52
  fileJpeg: 0x007efe0e,                  // storage.fileJpeg#7efe0e
  filePng: 0x0a4f63c0,                   // storage.filePng#a4f63c0
  filePdf: 0xae1e508d,                   // storage.filePdf#ae1e508d
  fileMp3: 0x528a0677,                   // storage.fileMp3#528a0677
  fileMov: 0x4b09ebbc,                   // storage.fileMov#4b09ebbc
  updateShortSentMessage: 0x9015e101,    // updateShortSentMessage#9015e101
  messageMediaDocument: 0x52d8ccd9,      // messageMediaDocument#52d8ccd9
  messageMediaPhoto: 0xe216eb63,         // messageMediaPhoto#e216eb63
  document: 0x8fd4c4d8,                  // document#8fd4c4d8
  documentEmpty: 0x36f8c871,             // documentEmpty#36f8c871
  photo: 0xfb197a65,                     // photo#fb197a65
  photoSizeEmpty: 0xe17e23c,             // photoSizeEmpty#e17e23c
  documentAttributeFilename: 0x15590068, // documentAttributeFilename#15590068
  documentAttributeImageSize: 0x6c37c15c,
  documentAttributeAnimated: 0x11b58939,
  documentAttributeSticker: 0x6319d612,
  documentAttributeVideo: 0x43c57c48,
  documentAttributeAudio: 0x9852f9c6,
  documentAttributeHasStickers: 0x9801d2f7,
  documentAttributeCustomEmoji: 0xfd149899,
  inputStickerSetEmpty: 0xffb62b95,
  inputStickerSetID: 0x9de7a269,
  inputStickerSetShortName: 0x861cc8a0,
  inputMediaUploadedPhoto: 0x7d8375da,   // inputMediaUploadedPhoto#7d8375da
  inputMediaUploadedDocument: 0x37c9330, // inputMediaUploadedDocument#37c9330
  inputMediaDocument: 0xa8763ab5,        // inputMediaDocument#a8763ab5
  inputMediaPhoto: 0xe3af4434,           // inputMediaPhoto#e3af4434
  inputFile: 0xf52ff27f,                 // inputFile#f52ff27f
  inputFileBig: 0xfa4f0bb5,              // inputFileBig#fa4f0bb5
  inputDocument: 0x1abfb575,             // inputDocument#1abfb575
  inputPhoto: 0x3bb3b94a,                // inputPhoto#3bb3b94a
  webPageEmpty: 0x211a1788,              // webPageEmpty#211a1788
  inputFileLocation: 0xdfdaabe1,
  inputDocumentFileLocation: 0xbad07584,
  inputSecureFileLocation: 0xcbc7ee28,
  inputPhotoFileLocation: 0x40181ffe,
  inputPeerPhotoFileLocation: 0x37257e99,
});

const u32 = (v) => Number(v) >>> 0;
const i32 = (v) => Number(v) | 0;

function boolTrue() {
  return new TLBuffer().putUint(ID.boolTrue).buffer;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.alloc(0);
}

function bytesOf(r, key, fallback = Buffer.alloc(0)) {
  if (isReader(r)) return r.has(1) ? r.bytes() : fallback;
  const v = r?.[key] ?? r?.data;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return toBuffer(v);
  return fallback;
}

/** Resolve the media store, reusing one already supplied by the caller. */
function mediaOf(ctx = {}) {
  if (ctx.mediaStore) return ctx.mediaStore;
  if (ctx.store && typeof ctx.store.saveMediaPart === 'function' && typeof ctx.store.getMedia === 'function') {
    ctx.__mediaAdapter ||= {
      saveFilePart: (id, part, data) => ctx.store.saveMediaPart(id, part, data),
      saveBigFilePart: (id, part, total, data) => ctx.store.saveMediaPart(id, part, data),
      getFileParts: (id) => ctx.store.getMedia(id)?.data || Buffer.alloc(0),
      getDocument: () => null,
      getPhoto: () => null,
      putDocument: () => null,
      putPhoto: () => null,
    };
    return ctx.__mediaAdapter;
  }
  const dataDir = ctx.dataDir || ctx.store?.dataDir || ctx.config?.dataDir || './data';
  ctx.mediaStore = new MediaStore(dataDir);
  return ctx.mediaStore;
}

// ---- upload.saveFilePart / upload.saveBigFilePart ----------------------

export function saveFilePart(params, ctx = {}) {
  const fileId = isReader(params) ? params.long() : long(params, 'fileId', long(params, 'file_id', 0n));
  const part = isReader(params) ? params.int() : int(params, 'filePart', int(params, 'file_part', 0));
  const data = bytesOf(params, 'bytes');
  mediaOf(ctx).saveFilePart(fileId, part, data);
  return boolTrue();
}

export function saveBigFilePart(params, ctx = {}) {
  const fileId = isReader(params) ? params.long() : long(params, 'fileId', long(params, 'file_id', 0n));
  const part = isReader(params) ? params.int() : int(params, 'filePart', int(params, 'file_part', 0));
  const total = isReader(params) ? params.int() : int(params, 'fileTotalParts', int(params, 'file_total_parts', 0));
  const data = bytesOf(params, 'bytes');
  mediaOf(ctx).saveBigFilePart(fileId, part, total, data);
  return boolTrue();
}

// ---- upload.getFile ----------------------------------------------------

function readFileLocation(r) {
  if (!isReader(r)) {
    const loc = r?.location ?? r ?? {};
    return {
      fileId: loc.fileId ?? loc.file_id ?? loc.id ?? loc.volumeId ?? loc.volume_id ?? 0n,
      mimeType: loc.mimeType ?? r?.mimeType ?? r?.mime_type,
      fileName: loc.fileName ?? r?.fileName ?? r?.file_name,
    };
  }
  const id = r.uint();
  switch (id >>> 0) {
    case ID.inputFileLocation: {
      const fileId = r.long();
      r.int(); // local_id
      r.long(); // secret
      r.bytes(); // file_reference
      return { fileId };
    }
    case ID.inputDocumentFileLocation:
    case ID.inputPhotoFileLocation: {
      const fileId = r.long();
      r.long(); // access_hash
      r.bytes(); // file_reference
      r.string(); // thumb_size
      return { fileId };
    }
    case ID.inputSecureFileLocation: {
      const fileId = r.long();
      r.long(); // access_hash
      return { fileId };
    }
    case ID.inputPeerPhotoFileLocation: {
      const flags = r.uint();
      if (flags & 1 && r.has(4)) r.uint(); // big:true
      readInputPeer(r);
      return { fileId: r.long() };
    }
    default:
      return { fileId: 0n };
  }
}

function sniffType(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return ID.fileJpeg;
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ID.filePng;
  if (data.subarray(0, 4).toString('latin1') === '%PDF') return ID.filePdf;
  if (data.subarray(0, 3).toString('latin1') === 'ID3' || (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return ID.fileMp3;
  if (data.length >= 8 && data.subarray(4, 8).toString('latin1') === 'ftyp') return ID.fileMov;
  return 0;
}

function fileTypeOf({ type, mimeType, fileName, data, isPhoto } = {}) {
  if (type !== undefined && type !== null) {
    const t = String(type).toLowerCase();
    if (t === 'partial') return ID.filePartial;
    if (t === 'jpeg' || t === 'jpg') return ID.fileJpeg;
    if (t === 'png') return ID.filePng;
    if (t === 'pdf') return ID.filePdf;
    if (t === 'mov' || t === 'mp4') return ID.fileMov;
    if (t === 'mp3' || t === 'audio') return ID.fileMp3;
    if (t === 'unknown') return ID.fileUnknown;
    if (/^0x[0-9a-f]+$/i.test(t)) return u32(Number.parseInt(t, 16));
    return u32(Number(t)) || ID.fileUnknown;
  }
  if (isPhoto) return ID.fileJpeg;
  const mime = String(mimeType || '').toLowerCase();
  const name = String(fileName || '').toLowerCase();
  if (mime.includes('jpeg')) return ID.fileJpeg;
  if (mime.includes('png')) return ID.filePng;
  if (mime.includes('pdf')) return ID.filePdf;
  if (mime.includes('mpeg') || mime.includes('mp3')) return ID.fileMp3;
  if (mime.includes('quicktime') || mime.includes('mp4') || mime.includes('mov')) return ID.fileMov;
  if (/\.jpe?g$/.test(name)) return ID.fileJpeg;
  if (/\.png$/.test(name)) return ID.filePng;
  if (/\.pdf$/.test(name)) return ID.filePdf;
  if (/\.mp3$/.test(name)) return ID.fileMp3;
  if (/\.(mov|mp4)$/.test(name)) return ID.fileMov;
  return sniffType(data) || ID.filePartial;
}

export function getFile(params, ctx = {}) {
  let flags = 0;
  let offset = 0;
  let limit = -1;
  let typeHint;
  let mimeType;
  let fileName;
  let mtimeHint = 0;
  let loc;
  if (isReader(params)) {
    flags = params.has(4) ? params.uint() : 0;
    if (flags & 1 && params.has(4)) params.uint(); // precise:true
    if (flags & 2 && params.has(4)) params.uint(); // cdn_supported:true
    loc = readFileLocation(params);
    offset = params.has(8) ? Number(params.long()) : 0;
    limit = params.has(4) ? params.int() : -1;
  } else {
    flags = int(params, 'flags', 0);
    loc = readFileLocation(params);
    offset = Number(long(params, 'offset', 0n));
    limit = int(params, 'limit', -1);
    typeHint = params.type ?? params.fileType;
    mimeType = params.mimeType ?? params.mime_type ?? loc.mimeType;
    fileName = params.fileName ?? params.file_name ?? loc.fileName;
    mtimeHint = int(params, 'mtime', 0);
  }

  const ms = mediaOf(ctx);
  const fileId = loc.fileId;
  const doc = ms.getDocument?.(fileId);
  const photo = ms.getPhoto?.(fileId);
  let all = toBuffer(ms.getFileParts(fileId));
  if (!all.length && doc?.data?.length) all = toBuffer(doc.data);
  if (!all.length && photo?.data?.length) all = toBuffer(photo.data);

  const start = Math.max(0, Math.min(offset, all.length));
  const end = limit < 0 ? all.length : Math.min(all.length, start + Math.max(0, limit));
  const data = all.subarray(start, end);
  const type = fileTypeOf({
    type: typeHint,
    mimeType: mimeType ?? doc?.mimeType,
    fileName: fileName ?? doc?.fileName,
    data,
    isPhoto: !!photo,
  });
  const mtime = doc?.mtime || photo?.mtime || mtimeHint || 0;

  return new TLBuffer()
    .putUint(ID.uploadFile)
    .putUint(type)
    .putInt(i32(mtime))
    .putBytes(data)
    .buffer;
}

// ---- messages.sendMedia ------------------------------------------------

function readInputFile(r) {
  if (!isReader(r)) {
    const f = r?.file ?? r ?? {};
    return {
      id: f.id ?? f.fileId ?? 0n,
      parts: Number(f.parts ?? 0) || 0,
      name: String(f.name ?? f.fileName ?? ''),
    };
  }
  const constructor = r.uint();
  const id = r.long();
  const parts = r.int();
  const name = r.string();
  if (constructor >>> 0 === ID.inputFile && r.has(1)) r.string(); // md5_checksum
  return { id, parts, name };
}

function readInputDocument(r) {
  if (!isReader(r)) {
    const d = r?.id ?? r ?? {};
    return { id: d.id ?? 0n, accessHash: d.accessHash ?? d.access_hash ?? 0n };
  }
  const constructor = r.uint();
  if (constructor >>> 0 === ID.inputDocument) {
    return { id: r.long(), accessHash: r.long(), fileReference: r.has(1) ? r.bytes() : Buffer.alloc(0) };
  }
  return { id: 0n, accessHash: 0n };
}

function readInputPhoto(r) {
  if (!isReader(r)) {
    const p = r?.id ?? r ?? {};
    return { id: p.id ?? 0n, accessHash: p.accessHash ?? p.access_hash ?? 0n };
  }
  const constructor = r.uint();
  if (constructor >>> 0 === ID.inputPhoto) {
    return { id: r.long(), accessHash: r.long(), fileReference: r.has(1) ? r.bytes() : Buffer.alloc(0) };
  }
  return { id: 0n, accessHash: 0n };
}

function skipInputStickerSet(r) {
  if (!r.has(4)) return;
  const id = r.uint();
  switch (id >>> 0) {
    case ID.inputStickerSetID:
      if (r.has(8)) r.long();
      if (r.has(8)) r.long();
      return;
    case ID.inputStickerSetShortName:
      if (r.has(1)) r.string();
      return;
    default:
      return; // inputStickerSetEmpty
  }
}

function readDocumentAttributes(r) {
  if (!isReader(r)) return Array.isArray(r?.attributes) ? r.attributes : [];
  if (!r.has(4)) return [];
  const out = [];
  r.vector((rr) => {
    if (!rr.has(4)) return;
    const id = rr.uint();
    switch (id >>> 0) {
      case ID.documentAttributeFilename:
        out.push({ type: 'filename', fileName: rr.has(1) ? rr.string() : '' });
        return;
      case ID.documentAttributeImageSize:
        if (rr.has(4)) rr.int();
        if (rr.has(4)) rr.int();
        return;
      case ID.documentAttributeAnimated:
      case ID.documentAttributeHasStickers:
        return;
      case ID.documentAttributeVideo: {
        if (!rr.has(4)) return;
        const flags = rr.uint();
        for (const bit of [0, 1, 3]) if (flags & (1 << bit) && rr.has(4)) rr.uint();
        if (rr.has(8)) rr.raw(8); // duration:double
        if (rr.has(4)) rr.int(); // w
        if (rr.has(4)) rr.int(); // h
        if (flags & 4 && rr.has(4)) rr.int();
        if (flags & 16 && rr.has(8)) rr.raw(8);
        if (flags & 32 && rr.has(1)) rr.string();
        return;
      }
      case ID.documentAttributeAudio: {
        if (!rr.has(4)) return;
        const flags = rr.uint();
        if (flags & (1 << 10) && rr.has(4)) rr.uint();
        if (rr.has(4)) rr.int(); // duration
        if (flags & 1 && rr.has(1)) rr.string();
        if (flags & 2 && rr.has(1)) rr.string();
        if (flags & 4 && rr.has(1)) rr.bytes();
        return;
      }
      case ID.documentAttributeSticker:
      case ID.documentAttributeCustomEmoji: {
        if (!rr.has(4)) return;
        const flags = rr.uint();
        if (flags & 2 && rr.has(4)) rr.uint();
        if (rr.has(1)) rr.string(); // alt
        skipInputStickerSet(rr);
        return;
      }
      default:
        return;
    }
  });
  return out;
}

function skipInputDocuments(r) {
  if (!r.has(4)) return;
  const n = r.int();
  for (let i = 0; i < n && r.has(8); i++) {
    r.long();
    r.long();
    if (r.has(1)) r.bytes();
  }
}

function readInputMedia(r) {
  if (!isReader(r)) {
    const m = r ?? {};
    const kind = String(m.type ?? m.mediaType ?? m.kind ?? '').toLowerCase();
    const file = m.file ?? {};
    const isPhoto = Boolean(m.uploadedPhoto || m.isPhoto || kind.includes('photo'));
    return {
      kind: isPhoto ? 'photo' : 'document',
      file: {
        id: file.id ?? file.fileId ?? m.fileId ?? 0n,
        parts: Number(file.parts ?? 0) || 0,
        name: String(file.name ?? m.fileName ?? m.file_name ?? ''),
      },
      id: m.id ?? 0n,
      accessHash: m.accessHash ?? m.access_hash ?? 0n,
      mimeType: m.mimeType ?? m.mime_type ?? 'application/octet-stream',
      fileName: m.fileName ?? m.file_name ?? file.name ?? '',
      attributes: Array.isArray(m.attributes) ? m.attributes : [],
      data: m.data,
    };
  }

  const constructor = r.uint();
  switch (constructor >>> 0) {
    case ID.inputMediaUploadedDocument: {
      if (!r.has(4)) return { kind: 'document', file: { id: 0n, parts: 0, name: '' } };
      const flags = r.uint();
      for (const bit of [3, 4, 5]) if (flags & (1 << bit) && r.has(4)) r.uint();
      const file = readInputFile(r);
      if (flags & (1 << 2)) readInputFile(r); // thumb
      const mimeType = r.has(1) ? r.string() : '';
      const attributes = readDocumentAttributes(r);
      if (flags & 1) skipInputDocuments(r);
      if (flags & (1 << 6)) readInputPhoto(r);
      if (flags & (1 << 7) && r.has(4)) r.int();
      if (flags & (1 << 1) && r.has(4)) r.int();
      const fileName = attributes.find((a) => a?.type === 'filename')?.fileName || file.name;
      return { kind: 'document', file, mimeType, fileName, attributes };
    }
    case ID.inputMediaUploadedPhoto: {
      if (!r.has(4)) return { kind: 'photo', file: { id: 0n, parts: 0, name: '' } };
      const flags = r.uint();
      for (const bit of [2, 3]) if (flags & (1 << bit) && r.has(4)) r.uint();
      const file = readInputFile(r);
      if (flags & 1) skipInputDocuments(r);
      if (flags & (1 << 1) && r.has(4)) r.int();
      if (flags & (1 << 3)) readInputDocument(r);
      return { kind: 'photo', file };
    }
    case ID.inputMediaDocument: {
      if (!r.has(4)) return { kind: 'document', file: { id: 0n, parts: 0, name: '' } };
      const flags = r.uint();
      if (flags & 4 && r.has(4)) r.uint(); // spoiler:true
      const doc = readInputDocument(r);
      if (flags & 8) readInputPhoto(r);
      if (flags & 16 && r.has(4)) r.int();
      if (flags & 1 && r.has(4)) r.int();
      if (flags & 2 && r.has(1)) r.string();
      return { kind: 'document', id: doc.id, accessHash: doc.accessHash, file: { id: 0n, parts: 0, name: '' } };
    }
    case ID.inputMediaPhoto: {
      if (!r.has(4)) return { kind: 'photo', file: { id: 0n, parts: 0, name: '' } };
      const flags = r.uint();
      for (const bit of [1, 2]) if (flags & (1 << bit) && r.has(4)) r.uint();
      const photo = readInputPhoto(r);
      if (flags & 1 && r.has(4)) r.int();
      if (flags & 4) readInputDocument(r);
      return { kind: 'photo', id: photo.id, accessHash: photo.accessHash, file: { id: 0n, parts: 0, name: '' } };
    }
    default:
      return { kind: 'document', file: { id: 0n, parts: 0, name: '' }, mimeType: 'application/octet-stream' };
  }
}

function encodeDocument(ms, media) {
  let id = media.id ?? 0n;
  let accessHash = media.accessHash ?? 0n;
  let fileName = String(media.fileName || '');
  let mimeType = String(media.mimeType || 'application/octet-stream');
  let data = Buffer.alloc(0);
  if (media.file?.id) {
    data = toBuffer(ms.getFileParts(media.file.id));
    id = id || media.file.id;
    fileName = fileName || String(media.file.name || '');
  }
  if (!data.length && media.data) data = toBuffer(media.data);
  const stored = ms.putDocument?.({ id, accessHash, fileName, mimeType, size: data.length, data });
  const doc = stored || { id, accessHash, fileName, mimeType, size: data.length, mtime: 0 };
  const attributes = doc.fileName
    ? [new TLBuffer().putUint(ID.documentAttributeFilename).putString(doc.fileName).buffer]
    : [];
  return new TLBuffer()
    .putUint(ID.document)
    .putUint(0) // flags: no thumbs / video thumbs
    .putLong(doc.id)
    .putLong(doc.accessHash)
    .putBytes(Buffer.alloc(0)) // file_reference
    .putInt(i32(doc.mtime || 0))
    .putString(doc.mimeType || mimeType)
    .putLong(BigInt(doc.size ?? data.length))
    .putInt(1) // dc_id
    .putVector(attributes, (buf, b) => b.putRaw(buf))
    .buffer;
}

function encodePhoto(ms, media) {
  let id = media.id ?? 0n;
  let accessHash = media.accessHash ?? 0n;
  let data = Buffer.alloc(0);
  if (media.file?.id) {
    data = toBuffer(ms.getFileParts(media.file.id));
    id = id || media.file.id;
  }
  if (!data.length && media.data) data = toBuffer(media.data);
  const stored = ms.putPhoto?.({ id, accessHash, data });
  const photo = stored || { id, accessHash, mtime: 0 };
  const sizes = [new TLBuffer().putUint(ID.photoSizeEmpty).putString('s').buffer];
  return new TLBuffer()
    .putUint(ID.photo)
    .putUint(0) // flags
    .putLong(photo.id)
    .putLong(photo.accessHash)
    .putBytes(Buffer.alloc(0)) // file_reference
    .putInt(i32(photo.mtime || 0))
    .putVector(sizes, (buf, b) => b.putRaw(buf))
    .putInt(1) // dc_id
    .buffer;
}

function encodeMessageMedia(kind, inner) {
  return kind === 'photo'
    ? new TLBuffer().putUint(ID.messageMediaPhoto).putUint(1).putRaw(inner).buffer
    : new TLBuffer().putUint(ID.messageMediaDocument).putUint(1).putRaw(inner).buffer;
}

export function sendMedia(params, ctx = {}) {
  let flags = 0;
  let peer;
  let mediaInput;
  let text = '';
  let randomId = 0n;
  if (isReader(params)) {
    flags = params.has(4) ? params.uint() : 0;
    for (const bit of [5, 6, 7, 14, 15, 16, 19]) if (flags & (1 << bit) && params.has(4)) params.uint();
    peer = readInputPeer(params);
    if (flags & 1) skipInputReplyTo(params);
    mediaInput = readInputMedia(params);
    text = params.has(1) ? params.string() : '';
    randomId = params.has(8) ? params.long() : 0n;
  } else {
    flags = int(params, 'flags', 0);
    peer = readInputPeer(params, 'peer');
    mediaInput = readInputMedia(params.media ?? params);
    text = str(params, 'message', '');
    randomId = long(params, 'randomId', long(params, 'random_id', 0n));
  }

  const ms = mediaOf(ctx);
  const mediaBuf = encodeMessageMedia(
    mediaInput.kind,
    mediaInput.kind === 'photo' ? encodePhoto(ms, mediaInput) : encodeDocument(ms, mediaInput),
  );

  const store = ctx.store;
  const user = store ? currentUser(store, ctx) : null;
  const peerType = peer.type === 'self' ? 'user' : (peer.type || 'user');
  const peerId = peer.type === 'self' ? (user?.id || 0) : (peer.id || 0);
  let msg = null;
  let pts = 0;
  let date = 0;
  if (store && typeof store.putMessage === 'function') {
    msg = store.putMessage({
      fromId: user?.id || 0,
      peerType,
      peerId,
      text,
      randomId: Number(randomId),
    });
    pts = Number(store.nextPts(user?.id || 0, authKeyIdOf(ctx)));
    date = msg.date;
  }

  // updateShortSentMessage#9015e101 flags:# out:flags.1?true id:int
  //   pts:int pts_count:int date:int media:flags.9?MessageMedia ...
  const outFlags = (1 << 1) | (1 << 9);
  return new TLBuffer()
    .putUint(ID.updateShortSentMessage)
    .putUint(outFlags)
    .putUint(ID.boolTrue) // out:true
    .putInt(i32(msg?.id || 1))
    .putInt(i32(pts || 1))
    .putInt(1)
    .putInt(i32(date || 0))
    .putRaw(mediaBuf) // media is an object, not a boxed true flag
    .buffer;
}

// ---- simple stubs ------------------------------------------------------

export function getDocumentByHash(params, ctx = {}) {
  if (isReader(params)) {
    if (params.has(1)) params.bytes();
    if (params.has(8)) params.long();
    if (params.has(1)) params.string();
  }
  return new TLBuffer().putUint(ID.documentEmpty).putLong(0n).buffer;
}

export function getWebPage(params, ctx = {}) {
  if (isReader(params)) {
    if (params.has(1)) params.string();
    if (params.has(4)) params.int();
  }
  return new TLBuffer().putUint(ID.webPageEmpty).putUint(0).putLong(0n).buffer;
}

export default {
  saveFilePart,
  saveBigFilePart,
  getFile,
  sendMedia,
  getDocumentByHash,
  getWebPage,
};
