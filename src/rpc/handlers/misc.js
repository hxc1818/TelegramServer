import * as C from './codecs.js';
import { int, long, str, bytes, isReader, readInputPeer } from './parsers.js';

const INPUT_FILE_LOCATION = 0xdfdaabe1;
const INPUT_PEER_PHOTO_FILE_LOCATION = 0x37257e99;

function readLocation(r) {
  if (!isReader(r)) {
    const l = r?.location ?? r ?? {};
    return { fileId: l.fileId ?? l.volumeId ?? l.volume_id ?? l.photoId ?? 0 };
  }
  const id = r.uint();
  if (id >>> 0 === INPUT_FILE_LOCATION) {
    const fileId = r.long();
    r.int(); // local_id
    r.long(); // secret
    r.bytes(); // file_reference
    return { fileId };
  }
  if (id >>> 0 === INPUT_PEER_PHOTO_FILE_LOCATION) {
    const flags = r.uint();
    if (flags & 1) r.uint(); // big:true
    readInputPeer(r); // peer
    const fileId = r.long();
    return { fileId };
  }
  return { fileId: 0n };
}

export function saveFilePart(r, ctx) {
  const fileId = isReader(r) ? r.long() : long(r, 'fileId', 0n);
  const part = isReader(r) ? r.int() : int(r, 'filePart', 0);
  const data = isReader(r) ? r.bytes() : bytes(r, 'bytes');
  ctx.store.saveMediaPart(fileId, part, data);
  return C.boolTrue();
}

export function getFile(r, ctx) {
  let flags = 0;
  if (isReader(r)) {
    flags = r.int();
    if (flags & 1) r.uint(); // precise:true
    if (flags & 2) r.uint(); // cdn_supported:true
  } else {
    flags = int(r, 'flags', 0);
  }
  const { fileId } = readLocation(r);
  const offset = isReader(r) ? Number(r.long()) : Number(long(r, 'offset', 0n));
  const limit = isReader(r) ? r.int() : int(r, 'limit', 0);
  const media = ctx.store.getMedia(fileId);
  const data = media ? media.data.subarray(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit)) : Buffer.alloc(0);
  return C.uploadFile({ data, mtime: 0, partial: true });
}

export function updateStatus(r) {
  if (isReader(r)) r.bool();
  return C.boolTrue();
}

export function getLangPack(r) {
  str(r, 'langPack', '');
  str(r, 'langCode', '');
  return C.langPackDifference({ langCode: 'en', fromVersion: 0, version: 1 });
}

export function getStickers(r) {
  str(r, 'emoticon', '');
  const hash = isReader(r) ? r.long() : long(r, 'hash', 0n);
  return C.stickers({ hash: Number(hash) });
}

export function ping(r, ctx) {
  const pingId = isReader(r) ? r.long() : long(r, 'pingId', 0n);
  return C.pong({ msgId: BigInt(ctx.msgId || 0), pingId });
}

export function pingDelayDisconnect(r, ctx) {
  const pingId = isReader(r) ? r.long() : long(r, 'pingId', 0n);
  if (isReader(r) && r.has(4)) r.int();
  return C.pong({ msgId: BigInt(ctx.msgId || 0), pingId });
}

export default { saveFilePart, getFile, updateStatus, getLangPack, getStickers, ping, pingDelayDisconnect };
