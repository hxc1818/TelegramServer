// Multi-DC RPC handlers for layer 234.
//
// Every constructor/method id below was grep-verified against the pinned
// schema/api.tl (and mtproto.tl for resPQ fingerprints). TL writers follow the
// exact declaration order in the schema; no existing handler is modified.
import { TLBuffer } from '../../tl/buffer.js';
import { DcRegistry } from '../../store/dc.js';
import { MediaStore } from '../../store/media.js';
import { isReader, int, long, str, bytes, readInputPeer } from './parsers.js';
import { authKeyIdOf } from './context.js';

export const ID = Object.freeze({
  vector: 0x1cb5c415,                     // vector#1cb5c415 (line 6)
  boolTrue: 0x997275b5,                   // boolTrue#997275b5 (line 2)
  boolFalse: 0xbc799737,                  // boolFalse#bc799737 (line 1)
  config: 0xcc1a241e,                     // config#cc1a241e (line 531)
  dcOption: 0x18b7a10d,                   // dcOption#18b7a10d (line 529)
  nearestDc: 0x8e1a1775,                  // nearestDc#8e1a1775 (line 533)
  cdnConfig: 0x5725e40a,                  // cdnConfig#5725e40a (line 1078)
  cdnPublicKey: 0xc982eaba,              // cdnPublicKey#c982eaba (line 1076)
  authExportedAuthorization: 0xb434e2b8, // auth.exportedAuthorization#b434e2b8 (line 249)
  authAuthorization: 0x2ea2c0d4,         // auth.authorization#2ea2c0d4 (line 246)
  uploadFile: 0x96a18d5,                 // upload.file#96a18d5 (line 526)
  fileUnknown: 0xaa963b05,               // storage.fileUnknown#aa963b05 (line 79)
  filePartial: 0x40bc6f52,               // storage.filePartial#40bc6f52 (line 80)
  fileJpeg: 0x007efe0e,                  // storage.fileJpeg#7efe0e (line 81)
  filePng: 0x0a4f63c0,                   // storage.filePng#a4f63c0 (line 82)
  filePdf: 0xae1e508d,                   // storage.filePdf#ae1e508d (line 83)
  fileMp3: 0x528a0677,                   // storage.fileMp3#528a0677 (line 84)
  fileMov: 0x4b09ebbc,                   // storage.fileMov#4b09ebbc (line 85)
  inputFileLocation: 0xdfdaabe1,         // inputFileLocation#dfdaabe1
  inputDocumentFileLocation: 0xbad07584,
  inputPhotoFileLocation: 0x40181ffe,
  inputSecureFileLocation: 0xcbc7ee28,
  inputPeerPhotoFileLocation: 0x37257e99,
});

export const METHOD_IDS = Object.freeze({
  'help.getConfig': 0xc4f9186b,            // line 2932
  'help.getNearestDc': 0x1fb33026,         // line 2933
  'help.getCdnConfig': 0x52029342,         // line 2938
  'auth.exportAuthorization': 0xe5bfffcd,  // line 2447
  'auth.importAuthorization': 0xa57a7dad,  // line 2448
  'upload.getFile': 0xbe5335be,            // line 2924
});

const i32 = (v) => Number(v) | 0;

// Defaults from codecs.js#DEFAULT_CONFIG (the values the other handlers use).
const CONFIG_NUMBERS = [
  'chatSizeMax', 'megagroupSizeMax', 'forwardedCountMax', 'onlineUpdatePeriodMs',
  'offlineBlurTimeoutMs', 'offlineIdleTimeoutMs', 'onlineCloudTimeoutMs',
  'notifyCloudDelayMs', 'notifyDefaultDelayMs', 'pushChatPeriodMs', 'pushChatLimit',
  'editTimeLimit', 'revokeTimeLimit', 'revokePmTimeLimit', 'ratingEDecay',
  'stickersRecentLimit', 'channelsReadMediaPeriod',
];
const CONFIG_CALL_NUMBERS = [
  'callReceiveTimeoutMs', 'callRingTimeoutMs', 'callConnectTimeoutMs', 'callPacketTimeoutMs',
];
const DEFAULT_CONFIG = {
  chatSizeMax: 200,
  megagroupSizeMax: 1000000,
  forwardedCountMax: 100,
  onlineUpdatePeriodMs: 120000,
  offlineBlurTimeoutMs: 5000,
  offlineIdleTimeoutMs: 30000,
  onlineCloudTimeoutMs: 300000,
  notifyCloudDelayMs: 30000,
  notifyDefaultDelayMs: 1500,
  pushChatPeriodMs: 60000,
  pushChatLimit: 2,
  editTimeLimit: 172800,
  revokeTimeLimit: 172800,
  revokePmTimeLimit: 172800,
  ratingEDecay: 2419200,
  stickersRecentLimit: 30,
  channelsReadMediaPeriod: 86400,
  callReceiveTimeoutMs: 20000,
  callRingTimeoutMs: 90000,
  callConnectTimeoutMs: 30000,
  callPacketTimeoutMs: 10000,
};

/** Resolve (and cache) the DcRegistry attached to a request context. */
export function dcRegistryOf(ctx = {}) {
  if (ctx.dcRegistry && typeof ctx.dcRegistry.listDcs === 'function') return ctx.dcRegistry;
  if (ctx.server?.dcRegistry && typeof ctx.server.dcRegistry.listDcs === 'function') return ctx.server.dcRegistry;
  if (ctx.store?.dcRegistry && typeof ctx.store.dcRegistry.listDcs === 'function') return ctx.store.dcRegistry;
  const dataDir = ctx.dataDir || ctx.store?.dataDir || ctx.config?.dataDir || './data';
  const config = ctx.config || {};
  ctx.dcRegistry = new DcRegistry(dataDir, {
    dcs: config.dcs,
    thisDc: config.serverId ?? config.thisDc,
    webfileDcId: config.webfileDcId,
  });
  return ctx.dcRegistry;
}

function mediaOf(ctx = {}) {
  if (ctx.mediaStore) return ctx.mediaStore;
  if (ctx.store && typeof ctx.store.getMedia === 'function') {
    ctx.__dcMediaAdapter ||= {
      getFileParts: (fileId) => ctx.store.getMedia(fileId)?.data || Buffer.alloc(0),
      getDocument: () => null,
      getPhoto: () => null,
    };
    return ctx.__dcMediaAdapter;
  }
  const dataDir = ctx.dataDir || ctx.store?.dataDir || ctx.config?.dataDir || './data';
  ctx.dcMediaStore = new MediaStore(dataDir);
  return ctx.dcMediaStore;
}

// ---- local TL encoders -------------------------------------------------

/** dcOption#18b7a10d flags:# ipv6:flags.0?true media_only:flags.1?true ... */
function encodeDcOption(option = {}, b) {
  const flags = Number(option.flags ?? 0) >>> 0;
  b.putUint(ID.dcOption).putUint(flags);
  for (const bit of [0, 1, 2, 3, 4, 5]) if (flags & (1 << bit)) b.putUint(ID.boolTrue);
  b.putInt(i32(option.id ?? option.dcId ?? option.dc_id ?? 1));
  b.putString(String(option.ipAddress ?? option.ip_address ?? option.host ?? option.ip ?? '127.0.0.1'));
  b.putInt(i32(option.port ?? 10443));
  if (flags & (1 << 10)) b.putBytes(Buffer.from(String(option.secret || ''), 'utf8'));
}

/** config#cc1a241e with flags=0 (all optional fields omitted). */
function encodeConfig(cfg = {}) {
  const b = new TLBuffer();
  b.putUint(ID.config)
    .putUint(0)
    .putInt(i32(cfg.date ?? 0))
    .putInt(i32(cfg.expires ?? 0))
    .putBool(false) // test_mode: boolFalse
    .putInt(i32(cfg.thisDc ?? cfg.this_dc ?? cfg.serverId ?? 1));
  b.putVector(cfg.dcOptions || [], encodeDcOption);
  b.putString(String(cfg.dcTxtDomainName ?? cfg.dc_txt_domain_name ?? ''));
  for (const key of CONFIG_NUMBERS) b.putInt(i32(cfg[key] ?? DEFAULT_CONFIG[key] ?? 0));
  for (const key of CONFIG_CALL_NUMBERS) b.putInt(i32(cfg[key] ?? DEFAULT_CONFIG[key] ?? 0));
  b.putString(String(cfg.meUrlPrefix ?? 'https://me.example'));
  b.putInt(i32(cfg.captionLengthMax ?? 4096))
    .putInt(i32(cfg.messageLengthMax ?? 4096))
    .putInt(i32(cfg.webfileDcId ?? cfg.webfile_dc_id ?? 1));
  return b.buffer;
}

function encodeCdnConfig(keys = []) {
  return new TLBuffer()
    .putUint(ID.cdnConfig)
    .putVector(keys, (key, b) => b
      .putUint(ID.cdnPublicKey)
      .putInt(i32(key.dcId ?? key.dc_id ?? 0))
      .putString(String(key.publicKey ?? key.public_key ?? '')))
    .buffer;
}

/** Minimal user#b1b8cc83 with flags=0 / flags2=0 (only id is mandatory). */
function encodeUser(user = {}) {
  const b = new TLBuffer();
  b.putUint(0xb1b8cc83).putUint(0).putUint(0);
  b.putLong(BigInt(user.id ?? 0));
  return b.buffer;
}

function encodeAuthorization(user = {}) {
  return new TLBuffer()
    .putUint(ID.authAuthorization)
    .putUint(0) // flags: no optional fields
    .putRaw(encodeUser(user))
    .buffer;
}

function encodeExportedAuthorization(id, tokenBytes) {
  return new TLBuffer()
    .putUint(ID.authExportedAuthorization)
    .putLong(BigInt(id))
    .putBytes(Buffer.isBuffer(tokenBytes) ? tokenBytes : Buffer.from(String(tokenBytes || ''), 'utf8'))
    .buffer;
}

function fileTypeOf(params = {}, data) {
  const given = params.type ?? params.fileType ?? params.file_type;
  if (given !== undefined && given !== null) {
    const text = String(given).toLowerCase();
    const TABLE = {
      unknown: ID.fileUnknown, partial: ID.filePartial, jpeg: ID.fileJpeg, jpg: ID.fileJpeg,
      png: ID.filePng, pdf: ID.filePdf, mp3: ID.fileMp3, audio: ID.fileMp3,
      mov: ID.fileMov, mp4: ID.fileMov,
    };
    if (TABLE[text]) return TABLE[text];
    if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16) >>> 0;
    return Number(given) >>> 0 || ID.fileUnknown;
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return ID.fileJpeg;
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x1a]))) return ID.filePng;
  return ID.filePartial;
}

// ---- handlers ----------------------------------------------------------

export function getConfig(params, ctx = {}) {
  const registry = dcRegistryOf(ctx);
  const dcConfig = registry.getDataCenterConfig(false);
  return encodeConfig({
    ...dcConfig,
    date: i32(int(params, 'date', dcConfig.date)),
    expires: i32(int(params, 'expires', dcConfig.expires)),
    meUrlPrefix: ctx.config?.meUrlPrefix,
  });
}

export function getCdnConfig(params, ctx = {}) {
  const registry = dcRegistryOf(ctx);
  return encodeCdnConfig(registry.getCdnConfig().publicKeys);
}

export function getNearestDc(params, ctx = {}) {
  const registry = dcRegistryOf(ctx);
  const country = str(params, 'country', 'US');
  const thisDc = Number(int(params, 'thisDc', registry.thisDc)) | 0;
  const nearest = Number(int(params, 'nearestDc', registry.getDc(thisDc) ? thisDc : (registry.listDcs()[0]?.id ?? thisDc))) | 0;
  return new TLBuffer()
    .putUint(ID.nearestDc)
    .putString(country)
    .putInt(i32(thisDc))
    .putInt(i32(nearest))
    .buffer;
}

export function exportAuthorization(params, ctx = {}) {
  const registry = dcRegistryOf(ctx);
  const dcId = Number(int(params, 'dcId', int(params, 'dc_id', 1))) | 0;
  const authKeyId = authKeyIdOf(ctx);
  const exported = registry.exportAuthorizationForDc(dcId, authKeyId, ctx.userId || 0);
  const id = ctx.userId || exported.id;
  return encodeExportedAuthorization(id, exported.bytes);
}

export function importAuthorization(params, ctx = {}) {
  let id = 0;
  let tokenBytes = Buffer.alloc(0);
  if (isReader(params)) {
    if (params.has(8)) id = Number(params.long());
    if (params.has(1)) tokenBytes = params.bytes();
  } else {
    id = Number(long(params, 'id', 0n));
    const raw = bytes(params, 'bytes', Buffer.alloc(0));
    tokenBytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''), 'utf8');
  }
  const token = tokenBytes.toString('utf8');
  const registry = dcRegistryOf(ctx);
  const record = registry.getToken(token);
  const dcId = Number(int(params, 'dcId', int(params, 'dc_id', record?.dcId ?? 0))) | 0;
  const authKeyId = authKeyIdOf(ctx) || record?.authKeyId || '';
  if (dcId && authKeyId) registry.importAuthorization(dcId, authKeyId);
  const userId = id || record?.userId || 0;
  const user = ctx.store?.getUser?.(userId) || ctx.user || { id: userId };
  return encodeAuthorization(user);
}

function readFileLocation(r) {
  const ctor = r.has(4) ? r.uint() : 0;
  switch (ctor >>> 0) {
    case ID.inputFileLocation: {
      const fileId = r.has(8) ? r.long() : 0n;
      if (r.has(4)) r.int(); // local_id
      if (r.has(8)) r.long(); // secret
      if (r.has(1)) r.bytes(); // file_reference
      return { fileId };
    }
    case ID.inputDocumentFileLocation:
    case ID.inputPhotoFileLocation: {
      const fileId = r.has(8) ? r.long() : 0n;
      if (r.has(8)) r.long(); // access_hash
      if (r.has(1)) r.bytes(); // file_reference
      if (r.has(1)) r.string(); // thumb_size
      return { fileId };
    }
    case ID.inputSecureFileLocation: {
      const fileId = r.has(8) ? r.long() : 0n;
      if (r.has(8)) r.long(); // access_hash
      return { fileId };
    }
    case ID.inputPeerPhotoFileLocation: {
      const flags = r.has(4) ? r.uint() : 0;
      if ((flags & 1) && r.has(4)) r.uint(); // big:true
      readInputPeer(r);
      return { fileId: r.has(8) ? r.long() : 0n };
    }
    default:
      return { fileId: 0n, constructor: ctor >>> 0 };
  }
}

/**
 * upload.getFile#be5335be with file_dc_id routing. A location may carry a
 * dc_id; when present it must name a registered DC. The chosen DC is exposed
 * on ctx.fileDcId / ctx.lastFileDcId so callers can verify the routing.
 */
export function getFile(params, ctx = {}) {
  const registry = dcRegistryOf(ctx);
  let fileId = 0n;
  let explicitDcId = null;
  let mediaOnly = false;
  let offset = 0;
  let limit = -1;
  let typeHint;
  let mtime = 0;
  let inlineData = null;

  if (isReader(params)) {
    const flags = params.has(4) ? params.uint() : 0;
    if ((flags & 1) && params.has(4)) params.uint(); // precise:true
    if ((flags & 2) && params.has(4)) params.uint(); // cdn_supported:true
    const location = readFileLocation(params);
    fileId = location.fileId;
    explicitDcId = location.dcId ?? null;
    offset = params.has(8) ? Number(params.long()) : 0;
    limit = params.has(4) ? params.int() : -1;
  } else {
    const location = params?.location ?? params ?? {};
    fileId = location.fileId ?? location.file_id ?? location.id
      ?? location.volumeId ?? location.volume_id ?? params?.fileId ?? 0n;
    explicitDcId = params?.fileDcId ?? params?.file_dc_id
      ?? location.dcId ?? location.dc_id ?? null;
    mediaOnly = Boolean(params?.mediaOnly ?? params?.media_only ?? location.mediaOnly);
    offset = Number(long(params, 'offset', 0n));
    limit = int(params, 'limit', -1);
    typeHint = params?.type ?? params?.fileType ?? params?.file_type ?? location.type;
    mtime = int(params, 'mtime', int(location, 'mtime', 0));
    if (Buffer.isBuffer(params?.data)) inlineData = params.data;
  }

  const requestedDc = explicitDcId === null || explicitDcId === undefined
    ? null : (Number(explicitDcId) | 0);
  const dc = (requestedDc && registry.getDc(requestedDc)) || registry.nextFileDc(mediaOnly);
  ctx.fileDcId = dc.id;
  ctx.lastFileDcId = dc.id;

  const ms = mediaOf(ctx);
  let all = inlineData || toBuffer(ms.getFileParts?.(fileId));
  if (!all.length) {
    const doc = ms.getDocument?.(fileId);
    const photo = ms.getPhoto?.(fileId);
    all = toBuffer(doc?.data || photo?.data);
  }
  const start = Math.max(0, Math.min(offset, all.length));
  const end = limit < 0 ? all.length : Math.min(all.length, start + Math.max(0, limit));
  const data = all.subarray(start, end);
  const type = fileTypeOf({ type: typeHint, fileType: typeHint }, data);

  return new TLBuffer()
    .putUint(ID.uploadFile)
    .putUint(type)
    .putInt(i32(mtime))
    .putBytes(data)
    .buffer;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.alloc(0);
}

export default {
  getConfig, getCdnConfig, getNearestDc,
  exportAuthorization, importAuthorization, getFile,
  dcRegistryOf, ID, METHOD_IDS,
};
