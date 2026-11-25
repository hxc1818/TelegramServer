// Multi-DC registry / handler tests. Constructor and method ids are checked
// against the pinned schema/api.tl (layer 234) and schema/mtproto.tl.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TLBuffer } from '../src/tl/buffer.js';
import { loadSchema } from '../src/tl/schema.js';
import { DcRegistry } from '../src/store/dc.js';
import { MediaStore } from '../src/store/media.js';
import * as DC from '../src/rpc/handlers/dc.js';

function tempDir(tag = 'dc') {
  const dir = path.join(os.tmpdir(), `telegramserver-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function firstId(buf) {
  assert.ok(Buffer.isBuffer(buf), 'handler must return a Buffer');
  return new TLBuffer(buf).uint();
}

function makeCtx(dir, dcRegistry, extra = {}) {
  return {
    dataDir: dir,
    config: { dataDir: dir },
    dcRegistry,
    authKeyId: '0102030405060708',
    userId: 42,
    ...extra,
  };
}

const TWO_DCS = [
  { id: 1, host: '127.0.0.1', port: 10443 },
  { id: 2, host: '127.0.0.2', port: 20443, mediaOnly: true, cdn: true },
];

test('dc constructor and method ids match schema/api.tl (layer 234)', () => {
  const schema = loadSchema();
  assert.equal(schema.layer, 234);
  const types = {
    config: 'config',
    dcOption: 'dcOption',
    nearestDc: 'nearestDc',
    cdnConfig: 'cdnConfig',
    cdnPublicKey: 'cdnPublicKey',
    authExportedAuthorization: 'auth.exportedAuthorization',
    authAuthorization: 'auth.authorization',
    uploadFile: 'upload.file',
    fileUnknown: 'storage.fileUnknown',
    filePartial: 'storage.filePartial',
  };
  for (const [key, name] of Object.entries(types)) {
    const entry = schema.types.get(name);
    assert.ok(entry, `schema missing type ${name}`);
    assert.equal(DC.ID[key], entry.id, `${key} != ${name}`);
  }
  for (const [name, id] of Object.entries(DC.METHOD_IDS)) {
    const entry = schema.functions.get(name);
    assert.ok(entry, `schema missing function ${name}`);
    assert.equal(id, entry.id, `${name} id mismatch`);
  }
});

test('DcRegistry persists two DCs with distinct ports and per-DC RSA fingerprints', () => {
  const dir = tempDir('dc-store');
  const registry = new DcRegistry(dir, { dcs: TWO_DCS });
  try {
    const dcs = registry.listDcs();
    assert.equal(dcs.length, 2);
    assert.deepEqual(dcs.map((d) => d.id), [1, 2]);
    assert.equal(registry.getDc(1).port, 10443);
    assert.equal(registry.getDc(2).port, 20443);
    assert.equal(registry.getDc(2).host, '127.0.0.2');
    assert.equal(registry.getDc(2).mediaOnly, true);

    const keys = registry.getDcKeys();
    assert.equal(Object.keys(keys).length, 2);
    assert.notEqual(keys[1].fingerprint, keys[2].fingerprint, 'each DC needs its own resPQ fingerprint');
    assert.match(keys[1].publicPem, /BEGIN RSA PUBLIC KEY/);
    assert.equal(keys[1].n.length, 256);
    assert.equal(keys[1].e.length, 3);

    // Reopen from disk: addresses and fingerprints survive a restart.
    const reopened = new DcRegistry(dir);
    assert.equal(reopened.getDc(2).port, 20443);
    assert.equal(reopened.getDcKeys()[2].fingerprint.toString(), keys[2].fingerprint.toString());
    if (reopened.driverKind === 'sqlite') assert.ok(fs.existsSync(path.join(dir, 'dc.sqlite')));
    else assert.ok(fs.existsSync(path.join(dir, 'dc.json')));

    const dcConfig = registry.getDataCenterConfig(false);
    assert.equal(dcConfig.dcOptions.length, 2);
    assert.equal(dcConfig.testMode, false);
    assert.deepEqual(dcConfig.dcOptions.map((o) => o.port), [10443, 20443]);
  } finally {
    registry.close();
  }
});

test('help.getConfig encodes both dcOptions with exact TL writer order', () => {
  const dir = tempDir('dc-config');
  const registry = new DcRegistry(dir, { dcs: TWO_DCS });
  try {
    const buf = DC.getConfig({}, makeCtx(dir, registry));
    assert.equal(firstId(buf), DC.ID.config);
    const r = new TLBuffer(buf.subarray(4));
    assert.equal(r.uint(), 0); // flags
    assert.ok(r.int() > 0); // date
    assert.ok(r.int() > 0); // expires
    assert.equal(r.bool(), false); // test_mode = boolFalse
    assert.equal(r.int(), 1); // this_dc
    const options = r.vector((rr) => {
      assert.equal(rr.uint(), DC.ID.dcOption);
      const flags = rr.uint();
      for (const bit of [0, 1, 2, 3, 4, 5]) if (flags & (1 << bit)) assert.equal(rr.uint(), DC.ID.boolTrue);
      const id = rr.int();
      const ip = rr.string();
      const port = rr.int();
      return { flags, id, ip, port };
    });
    assert.equal(options.length, 2);
    assert.deepEqual(options.map((o) => o.id), [1, 2]);
    assert.deepEqual(options.map((o) => o.port), [10443, 20443]);
    assert.equal(options[1].flags & (1 << 1), 2, 'media_only bit');
    assert.equal(options[1].flags & (1 << 3), 8, 'cdn bit');
    r.string(); // dc_txt_domain_name
    for (let i = 0; i < 17; i++) r.int(); // sizes / timeouts
    for (let i = 0; i < 4; i++) r.int(); // call timeouts
    r.string(); // me_url_prefix
    r.int(); // caption_length_max
    r.int(); // message_length_max
    assert.equal(r.int(), 2, 'webfile_dc_id must come from the CDN DC');
    assert.equal(r.has(4), false, 'config has no trailing fields when flags = 0');
  } finally {
    registry.close();
  }
});

test('help.getCdnConfig serves keys from the registry', () => {
  const dir = tempDir('dc-cdn');
  const registry = new DcRegistry(dir, { dcs: TWO_DCS });
  try {
    const ctx = makeCtx(dir, registry);
    const defaults = DC.getCdnConfig({}, ctx);
    assert.equal(firstId(defaults), DC.ID.cdnConfig);
    const dr = new TLBuffer(defaults.subarray(4));
    const defaultKeys = dr.vector((rr) => {
      assert.equal(rr.uint(), DC.ID.cdnPublicKey);
      return { dcId: rr.int(), publicKey: rr.string() };
    });
    assert.deepEqual(defaultKeys.map((k) => k.dcId), [1, 2]);
    assert.match(defaultKeys[0].publicKey, /BEGIN RSA PUBLIC KEY/);

    registry.setCdnConfig({ publicKeys: [{ dcId: 2, publicKey: 'pkey-dc2' }] });
    assert.deepEqual(registry.getCdnConfig().publicKeys.map((k) => k.dcId), [2]);
    const buf = DC.getCdnConfig({}, ctx);
    assert.equal(firstId(buf), DC.ID.cdnConfig);
    const r = new TLBuffer(buf.subarray(4));
    const keys = r.vector((rr) => {
      assert.equal(rr.uint(), DC.ID.cdnPublicKey);
      return { dcId: rr.int(), publicKey: rr.string() };
    });
    assert.equal(keys.length, 1);
    assert.equal(keys[0].dcId, 2);
    assert.equal(keys[0].publicKey, 'pkey-dc2');
  } finally {
    registry.close();
  }
});

test('auth key migration: exportAuthorization -> importAuthorization rebinds the DC', () => {
  const dir = tempDir('dc-auth');
  const registry = new DcRegistry(dir, { dcs: TWO_DCS });
  try {
    const authKeyId = '0102030405060708';
    assert.equal(registry.bindAuthKey(1, authKeyId).dcId, 1);
    assert.equal(registry.findDcByAuthKey(authKeyId).id, 1);
    assert.equal(registry.getAuthKeyForDc(1, authKeyId).dcId, 1);
    assert.equal(registry.getAuthKeyForDc(2, authKeyId), null);

    const ctx = makeCtx(dir, registry);
    const exported = registry.exportAuthorizationForDc(2, authKeyId, 42);
    assert.equal(exported.dcId, 2);
    assert.ok(exported.token.startsWith('dcauth:'));

    const exportBuf = DC.exportAuthorization({ dcId: 2 }, ctx);
    assert.equal(firstId(exportBuf), DC.ID.authExportedAuthorization);
    const er = new TLBuffer(exportBuf.subarray(4));
    const id = er.long();
    const token = er.bytes().toString('utf8');
    assert.ok(token.startsWith('dcauth:'));
    assert.equal(registry.findDcByAuthKey(authKeyId).id, 1, 'export alone must not move the binding');

    const importBuf = DC.importAuthorization({ id, bytes: Buffer.from(token, 'utf8') }, ctx);
    assert.equal(firstId(importBuf), DC.ID.authAuthorization);
    assert.equal(registry.findDcByAuthKey(authKeyId).id, 2);
    assert.equal(registry.getAuthKeyForDc(2, authKeyId).dcId, 2);
    assert.equal(registry.getAuthKeyForDc(1, authKeyId), null);

    const ar = new TLBuffer(importBuf.subarray(4));
    assert.equal(ar.uint(), 0); // auth.authorization flags
    assert.equal(ar.uint(), 0xb1b8cc83); // user
    assert.equal(ar.uint(), 0); // user flags
    assert.equal(ar.uint(), 0); // user flags2
    assert.equal(ar.long(), 42n);
  } finally {
    registry.close();
  }
});

test('file DC selection and upload.getFile routing', () => {
  const dir = tempDir('dc-file');
  const registry = new DcRegistry(dir, { dcs: TWO_DCS });
  try {
    assert.ok([1, 2].includes(registry.nextFileDc(false).id));
    assert.equal(registry.nextFileDc(true).id, 2, 'media_only file DC');

    const media = new MediaStore(dir);
    media.saveFilePart(999n, 0, Buffer.from('hello-dc2'));
    const ctx = makeCtx(dir, registry, { mediaStore: media });
    const buf = DC.getFile({ location: { fileId: 999n, dcId: 2 }, offset: 0, limit: -1 }, ctx);
    assert.equal(firstId(buf), DC.ID.uploadFile);
    assert.equal(ctx.fileDcId, 2);
    assert.equal(ctx.lastFileDcId, 2);
    const r = new TLBuffer(buf.subarray(4));
    r.uint(); // storage.FileType
    r.int(); // mtime
    assert.equal(r.bytes().toString('utf8'), 'hello-dc2');

    // An unknown dc_id falls back to a registered DC instead of failing.
    const ctx2 = makeCtx(dir, registry, { mediaStore: media });
    DC.getFile({ location: { fileId: 999n, dcId: 99 } }, ctx2);
    assert.ok([1, 2].includes(ctx2.fileDcId));
  } finally {
    registry.close();
  }
});

test('all six DC handlers return their declared constructor', () => {
  const dir = tempDir('dc-handlers');
  const registry = new DcRegistry(dir, { dcs: TWO_DCS });
  try {
    const ctx = makeCtx(dir, registry);
    const checks = [
      [DC.getConfig, {}, DC.ID.config],
      [DC.getCdnConfig, {}, DC.ID.cdnConfig],
      [DC.getNearestDc, {}, DC.ID.nearestDc],
      [DC.exportAuthorization, { dcId: 2 }, DC.ID.authExportedAuthorization],
      [DC.importAuthorization, { id: 42, bytes: Buffer.from('dcauth:test') }, DC.ID.authAuthorization],
      [DC.getFile, { location: { fileId: 1, dcId: 1 } }, DC.ID.uploadFile],
    ];
    assert.ok(checks.length >= 4);
    for (const [handler, params, expected] of checks) {
      assert.equal(firstId(handler(params, ctx)), expected, handler.name);
    }
  } finally {
    registry.close();
  }
});
