// Unit tests for the dedicated AccountStore and the account/contacts/auth
// handlers. Constructor ids are written out explicitly (from schema/api.tl,
// layer 234) so the tests catch accidental wire-format changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TLBuffer } from '../src/tl/buffer.js';
import { Store } from '../src/store/store.js';
import { AccountStore } from '../src/store/account.js';
import * as account from '../src/rpc/handlers/account.js';

const ID = {
  boolTrue: 0x997275b5,
  vector: 0x1cb5c415,
  user: 0xb1b8cc83,
  peerUser: 0x59511722,
  peerBlocked: 0xe8fd8014,
  peerNotifySettings: 0x99622c0c,
  privacyRules: 0x50a04e45,
  privacyValueAllowAll: 0x65427b82,
  contactsBlocked: 0xade1591,
  importedContact: 0xc13e3c50,
  importedContacts: 0x77d01c3b,
  wallPapers: 0xcdc3858c,
  themes: 0x9a3d8c6d,
  updates: 0x74ae4240,
  exportedAuthorization: 0xb434e2b8,
  authorization: 0x2ea2c0d4,
};

const USER_BOOL_BITS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 23, 24, 25, 26, 27, 28, 29];

function tempDir() {
  const dir = path.join(os.tmpdir(), `telegramserver-account-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function afterId(hex) {
  const b = new TLBuffer();
  b.putUint(hex);
  return { b, reader: () => new TLBuffer(b.buffer.subarray(4)) };
}

function readUser(r) {
  assert.equal(r.uint(), ID.user);
  const flags = r.uint();
  for (const bit of USER_BOOL_BITS) if (flags & (1 << bit)) assert.equal(r.uint(), ID.boolTrue);
  r.uint(); // flags2
  const id = Number(r.long());
  if (flags & 1) r.long(); // access_hash
  const firstName = flags & 2 ? r.string() : '';
  const lastName = flags & 4 ? r.string() : '';
  const username = flags & 8 ? r.string() : '';
  const phone = flags & 16 ? r.string() : '';
  return { id, flags, firstName, lastName, username, phone };
}

function vectorCount(r) {
  assert.equal(r.uint(), ID.vector);
  return r.int();
}

test('AccountStore (sqlite) profiles, usernames and status', () => {
  const dir = tempDir();
  const store = new AccountStore(dir);
  try {
    assert.equal(store.driverKind, 'sqlite');
    assert.ok(fs.existsSync(path.join(dir, 'account.sqlite')));

    let p = store.setProfile(1, { firstName: 'Ada', lastName: 'Lovelace', about: 'mathematician', username: '@Ada' });
    assert.deepEqual(p, { userId: 1, firstName: 'Ada', lastName: 'Lovelace', about: 'mathematician', username: 'ada', online: false });
    assert.equal(store.getProfile(1).firstName, 'Ada');

    p = store.setProfile(1, { firstName: 'Augusta' });
    assert.equal(p.firstName, 'Augusta');
    assert.equal(p.lastName, 'Lovelace'); // partial update keeps the old value

    assert.equal(store.setUsername(2, 'ada').username, 'ada');
    assert.equal(store.getProfile(1).username, ''); // usernames are unique
    assert.equal(store.resolveUsername('@ADA').userId, 2);
    assert.equal(store.resolveUsername('nobody'), null);

    store.setStatus(2, true);
    assert.equal(store.getProfile(2).online, true);
    store.setStatus(2, false);
    assert.equal(store.getProfile(2).online, false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AccountStore (sqlite) contacts, notify, blocked, privacy and tokens', () => {
  const dir = tempDir();
  const store = new AccountStore(dir);
  try {
    store.addContact(1, { phone: '+15550000001', firstName: 'Bob', lastName: 'B', peerId: 2 });
    store.addContact(1, { phone: '+15550000002', firstName: 'Carol', peerId: 3 });
    assert.equal(store.listContacts(1).length, 2);
    assert.equal(store.listContacts(1)[0].firstName, 'Bob');
    store.addContact(1, { phone: '+15550000001', firstName: 'Bobby', peerId: 2 });
    assert.equal(store.listContacts(1).length, 2); // upsert, not duplicate
    assert.equal(store.listContacts(1).find((c) => c.peerId === 2).firstName, 'Bobby');
    assert.equal(store.removeContact(1, '+15550000001'), true);
    assert.equal(store.listContacts(1).length, 1);

    assert.deepEqual(store.setNotifySettings('user:2', { silent: true, muteUntil: 100 }), { silent: true, muteUntil: 100 });
    assert.deepEqual(store.getNotifySettings('user:2'), { silent: true, muteUntil: 100 });
    assert.equal(store.getNotifySettings('users'), null);

    assert.equal(store.block(1, { type: 'user', id: 2 }), true);
    assert.equal(store.block(1, { type: 'channel', id: -100 }), true);
    assert.equal(store.listBlocked(1).length, 2);
    assert.deepEqual(new Set(store.listBlocked(1).map((b) => b.peerKey)), new Set(['user:2', 'channel:-100']));
    assert.equal(store.unblock(1, 'user:2'), true);
    assert.equal(store.listBlocked(1).length, 1);

    assert.deepEqual(store.setPrivacy('statusTimestamp', [{ type: 'allowAll' }]), [{ type: 'allowAll' }]);
    assert.deepEqual(store.getPrivacy('statusTimestamp'), [{ type: 'allowAll' }]);
    assert.equal(store.getPrivacy('forwards'), null);

    const token = store.exportAuthorization(1, 2);
    assert.ok(token.startsWith('auth:'));
    assert.equal(store.exportAuthorization(1, 2), token); // stable map entry
    assert.equal(store.importAuthorization(token), 1);
    assert.equal(store.importAuthorization('auth:wrong'), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AccountStore JSON fallback exposes the same API', () => {
  const dir = tempDir();
  const store = new AccountStore(dir, { dbDriver: 'json' });
  try {
    assert.equal(store.driverKind, 'json');
    assert.ok(fs.existsSync(path.join(dir, 'account.json')));
    store.setProfile(5, { firstName: 'Grace' });
    assert.equal(store.getProfile(5).firstName, 'Grace');
    store.addContact(5, { phone: '+1', peerId: 6 });
    assert.equal(store.listContacts(5)[0].peerId, 6);
    store.setPrivacy('about', [{ type: 'allowContacts' }]);
    assert.deepEqual(store.getPrivacy('about'), [{ type: 'allowContacts' }]);
    const token = store.exportAuthorization(5);
    assert.equal(store.importAuthorization(token), 5);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeContext(dir) {
  const store = new Store(dir);
  const accountStore = new AccountStore(dir);
  const user = store.createUser({ phone: '+15551110000', firstName: 'Me', lastName: 'User' });
  const other = store.createUser({ phone: '+15552220000', firstName: 'Bob', lastName: 'B' });
  return { ctx: { store, accountStore, userId: user.id }, user, other, accountStore };
}

test('updateProfile / updateUsername return User#b1b8cc83 and persist profile fields', () => {
  const dir = tempDir();
  const { ctx, user, accountStore } = makeContext(dir);
  try {
    const { b, reader } = afterId(0x78515775);
    b.putUint(0b111).putString('Ada').putString('Lovelace').putString('about me');
    const result = account.updateProfile(reader(), ctx);
    const parsed = readUser(new TLBuffer(result));
    assert.equal(parsed.id, user.id);
    assert.equal(parsed.firstName, 'Ada');
    assert.equal(parsed.lastName, 'Lovelace');
    assert.equal(accountStore.getProfile(user.id).about, 'about me');

    const { b: b2, reader: reader2 } = afterId(0x3e0bdd7c);
    b2.putString('@Ada_Lovelace');
    const result2 = account.updateUsername(reader2(), ctx);
    assert.equal(readUser(new TLBuffer(result2)).username, 'ada_lovelace');
    assert.equal(accountStore.resolveUsername('ada_lovelace').userId, user.id);
  } finally {
    ctx.accountStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setPrivacy / getPrivacy return account.privacyRules#50a04e45 with privacyValueAllowAll', () => {
  const dir = tempDir();
  const { ctx, accountStore } = makeContext(dir);
  try {
    const { b, reader } = afterId(0xc9f81ce8);
    b.putUint(0x4f96cb18); // inputPrivacyKeyStatusTimestamp#4f96cb18
    b.putVector([0x184b35ce], (ctor, bb) => bb.putUint(ctor)); // inputPrivacyValueAllowAll
    const result = account.setPrivacy(reader(), ctx);
    const r = new TLBuffer(result);
    assert.equal(r.uint(), ID.privacyRules);
    assert.equal(vectorCount(r), 1);
    assert.equal(r.uint(), ID.privacyValueAllowAll);
    assert.equal(vectorCount(r), 0); // chats
    assert.equal(vectorCount(r), 0); // users
    assert.deepEqual(accountStore.getPrivacy('statusTimestamp'), [{ type: 'allowAll' }]);

    const { b: b2, reader: reader2 } = afterId(0xdadbc950);
    b2.putUint(0x4f96cb18);
    assert.equal(new TLBuffer(account.getPrivacy(reader2(), ctx)).uint(), ID.privacyRules);
  } finally {
    ctx.accountStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('notify settings return peerNotifySettings#99622c0c; updates return boolTrue', () => {
  const dir = tempDir();
  const { ctx } = makeContext(dir);
  try {
    const { b, reader } = afterId(0x84be5b93);
    b.putUint(0xb8bc5b0c); // inputNotifyPeer#b8bc5b0c
    b.putUint(0x7da07ec9); // inputPeerSelf#7da07ec9
    b.putUint(0xcacb6ae2); // inputPeerNotifySettings#cacb6ae2
    b.putUint(0b111).putBool(true).putBool(false).putInt(123);
    assert.equal(account.updateNotifySettings(reader(), ctx).readUInt32LE(0), ID.boolTrue);

    const { b: b2, reader: reader2 } = afterId(0x12b3ad31);
    b2.putUint(0xb8bc5b0c).putUint(0x7da07ec9);
    const r = new TLBuffer(account.getNotifySettings(reader2(), ctx));
    assert.equal(r.uint(), ID.peerNotifySettings);
    assert.equal(r.uint(), 0b111);
    assert.equal(r.bool(), true);
    assert.equal(r.bool(), false);
    assert.equal(r.int(), 123);

    const { b: b3, reader: reader3 } = afterId(0x6628562c);
    b3.putBool(true);
    assert.equal(account.setStatus(reader3(), ctx).readUInt32LE(0), ID.boolTrue);
    assert.equal(ctx.accountStore.getProfile(ctx.userId).online, true);
  } finally {
    ctx.accountStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getWallPapers / getThemes return account.wallPapers / account.themes', () => {
  const dir = tempDir();
  const { ctx } = makeContext(dir);
  try {
    const wall = new TLBuffer(account.getWallPapers({ hash: 42n }, ctx));
    assert.equal(wall.uint(), ID.wallPapers);
    assert.equal(wall.long(), 42n);
    assert.equal(vectorCount(wall), 0);

    const themes = new TLBuffer(account.getThemes({ format: 'classic', hash: 7n }, ctx));
    assert.equal(themes.uint(), ID.themes);
    assert.equal(themes.long(), 7n);
    assert.equal(vectorCount(themes), 0);
  } finally {
    ctx.accountStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('contacts handlers return updates / importedContacts / blocked constructors', () => {
  const dir = tempDir();
  const { ctx, other, accountStore } = makeContext(dir);
  try {
    const { b, reader } = afterId(0xd9ba2e54);
    b.putUint(0); // flags
    b.putUint(0xf21158c6).putLong(BigInt(other.id)).putLong(1n); // inputUser
    b.putString('Bob').putString('Builder').putString('+15552220000');
    const added = account.addContact(reader(), ctx);
    assert.equal(new TLBuffer(added).uint(), ID.updates);
    assert.equal(accountStore.listContacts(ctx.userId).length, 1);
    assert.equal(ctx.store.listContacts(ctx.userId)[0].peerId, other.id);

    const { b: b2, reader: reader2 } = afterId(0x2c800be5);
    b2.putVector([1], (_, bb) => bb
      .putUint(0x6a1dc4be) // inputPhoneContact#6a1dc4be
      .putUint(0).putLong(99n)
      .putString('+15553330000').putString('Carol').putString('C'));
    const importedBuf = account.importContacts(reader2(), ctx);
    const imported = new TLBuffer(importedBuf);
    assert.equal(imported.uint(), ID.importedContacts);
    assert.equal(vectorCount(imported), 1);
    assert.equal(imported.uint(), ID.importedContact);
    assert.equal(imported.long(), 0n); // unknown phone resolves to user 0
    assert.equal(imported.long(), 99n); // client_id
    assert.equal(vectorCount(imported), 0); // popular_invites
    assert.equal(vectorCount(imported), 0); // retry_contacts
    assert.equal(vectorCount(imported), 0); // users

    const { b: b3, reader: reader3 } = afterId(0x2e2e8734);
    b3.putUint(0); // flags
    b3.putUint(0xdde8a54c).putLong(BigInt(other.id)).putLong(1n); // inputPeerUser
    assert.equal(account.block(reader3(), ctx).readUInt32LE(0), ID.boolTrue);

    const blockedBuf = account.getBlocked({ offset: 0, limit: 10 }, ctx);
    const blocked = new TLBuffer(blockedBuf);
    assert.equal(blocked.uint(), ID.contactsBlocked);
    assert.equal(vectorCount(blocked), 1);
    assert.equal(blocked.uint(), ID.peerBlocked);
    assert.equal(blocked.uint(), ID.peerUser);
    assert.equal(Number(blocked.long()), other.id);
    blocked.int(); // date
    assert.equal(vectorCount(blocked), 0); // chats
    assert.equal(vectorCount(blocked), 1); // users
  } finally {
    ctx.accountStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auth authorization tokens round-trip through exported/authorization constructors', () => {
  const dir = tempDir();
  const { ctx, user } = makeContext(dir);
  try {
    const exported = new TLBuffer(account.exportAuthorization({ dcId: 2 }, ctx));
    assert.equal(exported.uint(), ID.exportedAuthorization);
    assert.equal(Number(exported.long()), user.id);
    const token = exported.string();

    const { b, reader } = afterId(0xa57a7dad);
    b.putLong(BigInt(user.id)).putString(token);
    const result = new TLBuffer(account.importAuthorization(reader(), ctx));
    assert.equal(result.uint(), ID.authorization);
    assert.equal(result.uint(), 0); // flags
    assert.equal(readUser(result).id, user.id);
  } finally {
    ctx.accountStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exported method ids match the layer-234 schema', () => {
  assert.equal(account.METHOD_IDS['account.updateProfile'], 0x78515775);
  assert.equal(account.METHOD_IDS['account.updateUsername'], 0x3e0bdd7c);
  assert.equal(account.METHOD_IDS['account.setPrivacy'], 0xc9f81ce8);
  assert.equal(account.METHOD_IDS['account.getPrivacy'], 0xdadbc950);
  assert.equal(account.METHOD_IDS['account.updateNotifySettings'], 0x84be5b93);
  assert.equal(account.METHOD_IDS['account.getNotifySettings'], 0x12b3ad31);
  assert.equal(account.METHOD_IDS['account.updateStatus'], 0x6628562c);
  assert.equal(account.METHOD_IDS['account.getWallPapers'], 0x7967d36);
  assert.equal(account.METHOD_IDS['account.getThemes'], 0x7206e458);
  assert.equal(account.METHOD_IDS['contacts.addContact'], 0xd9ba2e54);
  assert.equal(account.METHOD_IDS['contacts.importContacts'], 0x2c800be5);
  assert.equal(account.METHOD_IDS['contacts.getBlocked'], 0x9a868f80);
  assert.equal(account.METHOD_IDS['auth.exportAuthorization'], 0xe5bfffcd);
  assert.equal(account.METHOD_IDS['auth.importAuthorization'], 0xa57a7dad);
});
