// Unit tests for the store and the RPC router (no network involved).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TLBuffer } from '../src/tl/buffer.js';
import { Store } from '../src/store/store.js';
import { Router, methodNameOf, METHOD_IDS } from '../src/rpc/router.js';
import { ID } from '../src/rpc/handlers/codecs.js';

function tempDir() {
  const dir = path.join(os.tmpdir(), `telegramserver-rpc-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeRouter(dir, config = {}) {
  const store = new Store(dir, { dbDriver: 'sqlite' });
  const router = new Router({ store, keys: {}, config: { authCode: '22222', publicIp: '127.0.0.1', listenPort: 10443, serverId: 1, ...config } });
  return { store, router };
}

test('store CRUD keeps users, codes, sessions, dialogs, messages, media and pts', () => {
  const dir = tempDir();
  const store = new Store(dir);
  try {
    const user = store.createUser({ phone: '+15550000000', firstName: 'Test', lastName: 'User' });
    assert.equal(user.phone, '+15550000000');
    assert.ok(user.accessHash > 0);
    assert.equal(store.getUser(user.id).firstName, 'Test');
    assert.equal(store.getUserByPhone('+15550000000').id, user.id);

    const hash = store.createCode('+15550000000', '22222', 'code-hash');
    assert.equal(hash, 'code-hash');
    assert.equal(store.checkCode('+15550000000', 'code-hash', '22222'), true);
    assert.equal(store.checkCode('+15550000000', 'code-hash', '22222'), false); // single use

    const session = store.createSession(user.id, '0102030405060708');
    assert.equal(store.getSession('0102030405060708').userId, user.id);
    assert.equal(session.serverSalt.length, 8);

    const dialog = store.createDialog(user.id, { type: 'user', id: 42 }, 'user');
    assert.equal(dialog.peerId, 42);
    assert.equal(store.listDialogs(user.id).length, 1);

    const msg = store.putMessage({ fromId: user.id, peerType: 'user', peerId: 42, text: 'hello', randomId: 7n });
    assert.equal(msg.text, 'hello');
    assert.equal(store.getMessage(msg.id).id, msg.id);
    assert.equal(store.listMessages('user', 42, 10)[0].id, msg.id);

    const before = store.getState(user.id).pts;
    assert.equal(store.nextPts(user.id, '0102030405060708'), before + 1);
    assert.equal(store.getState(user.id).pts, before + 1);

    assert.equal(store.saveMediaPart(99, 0, Buffer.from('ab')), true);
    assert.equal(store.saveMediaPart(99, 1, Buffer.from('cd')), true);
    assert.equal(store.getMedia(99).data.toString(), 'abcd');

    store.addContact(user.id, '+15551111111', 42);
    assert.equal(store.listContacts(user.id)[0].peerId, 42);

    assert.equal(store.markRead('user', 42, msg.id), 1);
    assert.equal(store.getMessage(msg.id).read, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store JSON fallback offers the same API', () => {
  const dir = tempDir();
  const store = new Store(dir, { dbDriver: 'json' });
  try {
    assert.equal(store.driverKind, 'json');
    const user = store.createUser({ phone: '+1', firstName: 'J' });
    assert.equal(store.getUser(user.id).phone, '+1');
    assert.equal(store.nextPts(user.id), 1);
    assert.equal(store.getState(user.id).pts, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('router unwraps invokeWithLayer/initConnection and returns Config#cc1a241e', () => {
  const dir = tempDir();
  const { store, router } = makeRouter(dir);
  try {
    const result = router.handle('help.getConfig', {});
    assert.equal(result.readUInt32LE(0), 0xcc1a241e);

    const byId = router.handle(METHOD_IDS['help.getConfig'], new TLBuffer(Buffer.alloc(0)), {});
    assert.equal(byId.readUInt32LE(0), 0xcc1a241e);
    assert.equal(methodNameOf(0xda9b0d0d), 'invokeWithLayer');
    assert.equal(router.supports('help.getConfig'), true);
    assert.equal(router.supports('does.notExist'), false);

    const b = new TLBuffer();
    b.putUint(0xda9b0d0d).putInt(234);
    b.putUint(0xc1cd5ea9).putUint(0).putInt(17349);
    for (const s of ['desktop', 'linux', '1.0', 'en', '', 'en']) b.putString(s);
    b.putUint(0xc4f9186b);
    const wrapped = router.handle('invokeWithLayer', new TLBuffer(b.buffer.subarray(4)), {});
    assert.equal(wrapped.readUInt32LE(0), 0xcc1a241e);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown RPC returns -501 NOT_IMPLEMENTED (never a 5xx)', () => {
  const dir = tempDir();
  const { store, router } = makeRouter(dir);
  try {
    const result = router.handle('totally.unknown', {});
    const r = new TLBuffer(result);
    assert.equal(r.uint(), ID.rpcError);
    assert.equal(r.int(), -501);
    assert.equal(r.string(), 'NOT_IMPLEMENTED');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auth.sendCode + auth.signIn produce auth.authorization with a session', () => {
  const dir = tempDir();
  const { store, router } = makeRouter(dir);
  const ctx = { session: { authKeyId: 'aabbccddeeff0011', userId: 0 } };
  try {
    const sent = router.handle('auth.sendCode', { phoneNumber: '+1555' }, ctx);
    const r = new TLBuffer(sent);
    assert.equal(r.uint(), ID.sentCode);
    r.uint(); r.uint(); r.int();
    const phoneCodeHash = r.string();
    assert.ok(phoneCodeHash.length > 0);

    const authz = router.handle('auth.signIn', {
      phoneNumber: '+1555', phoneCodeHash, phoneCode: '22222', flags: 1,
    }, ctx);
    const ar = new TLBuffer(authz);
    assert.equal(ar.uint(), ID.authorization);
    ar.uint(); // flags
    assert.equal(ar.uint(), ID.user);
    const flags = ar.uint();
    if (flags & (1 << 10)) assert.equal(ar.uint(), ID.boolTrue); // self:true
    ar.uint(); // flags2
    const id = ar.long();
    assert.ok(flags & (1 << 10)); // self flag set
    assert.ok(flags & 1); // access_hash present
    assert.ok(flags & (1 << 4)); // phone present
    assert.ok(id > 0n);
    assert.equal(ctx.session.userId, Number(id));
    assert.equal(store.getSession('aabbccddeeff0011').userId, Number(id));
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('messages.sendMessage increments pts and returns updateShortSentMessage', () => {
  const dir = tempDir();
  const { store, router } = makeRouter(dir);
  const ctx = { session: { authKeyId: '1122334455667788' } };
  try {
    store.createUser({ phone: '+1999', firstName: 'A' });
    const signed = router.handle('auth.signIn', {
      phoneNumber: '+1999', phoneCodeHash: 'h', phoneCode: '22222', flags: 1,
    }, ctx);
    // signIn needs a valid code; create one explicitly for this phone.
    assert.equal(signed.readUInt32LE(0), ID.rpcError);

    const hash = store.createCode('+1999', '22222', 'rpc-hash');
    const ok = router.handle('auth.signIn', {
      phoneNumber: '+1999', phoneCodeHash: 'rpc-hash', phoneCode: '22222', flags: 1,
    }, ctx);
    assert.equal(ok.readUInt32LE(0), ID.authorization);

    const before = store.getState(ctx.userId).pts;
    const result = router.handle('messages.sendMessage', {
      peer: { type: 'user', id: 42 }, message: 'ping', randomId: 123n,
    }, ctx);
    const r = new TLBuffer(result);
    assert.equal(r.uint(), ID.updateShortSentMessage);
    const flags = r.uint();
    assert.ok(flags & (1 << 1)); // out
    assert.equal(r.uint(), ID.boolTrue); // out:true
    const msgId = r.int();
    const pts = r.int();
    const ptsCount = r.int();
    assert.ok(msgId > 0);
    assert.equal(pts, before + 1);
    assert.equal(ptsCount, 1);
    assert.equal(store.getState(ctx.userId).pts, before + 1);
    assert.equal(store.listMessages('user', 42, 1)[0].text, 'ping');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
