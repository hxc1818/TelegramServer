// Unit tests for the dedicated SecretStore and the secret-chat TL handlers.
// Constructor ids are written out explicitly from schema/api.tl (layer 234);
// the schema line for each is recorded next to the METHOD_IDS assertion below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TLBuffer } from '../src/tl/buffer.js';
import { SecretStore } from '../src/store/secret.js';
import * as secret from '../src/rpc/handlers/secret.js';

const ID = {
  boolTrue: 0x997275b5,
  vector: 0x1cb5c415,
  inputUser: 0xf21158c6,
  inputEncryptedChat: 0xf141b5e1,
  inputEncryptedFile: 0x5a17b5e5,
  encryptedChatRequested: 0x48f1d94c,
  encryptedChat: 0x61f0d4c7,
  encryptedFileEmpty: 0xc21f497e,
  encryptedFile: 0xa8008cd8,
  encryptedMessage: 0xed18c118,
  sentEncryptedMessage: 0x560f8935,
  sentEncryptedFile: 0x9493ff32,
  updateNewEncryptedMessage: 0x12bcbd9a,
  updateEncryption: 0xb4a2e88d,
  updateEncryptedChatTyping: 0x1710f156,
  updateEncryptedMessagesRead: 0x38fe25b7,
  updates: 0x74ae4240,
  state: 0xa56c2a3e,
  difference: 0xb78fca40,
};

function tempDir() {
  const dir = path.join(os.tmpdir(), `telegramserver-secret-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function vectorCount(r) {
  assert.equal(r.uint(), ID.vector);
  return r.int();
}

function ctorOf(buf) {
  return new TLBuffer(buf).uint();
}

test('SecretStore CRUD: chats, messages, read state and discard', () => {
  const dir = tempDir();
  const s = new SecretStore(dir);
  try {
    assert.equal(s.driverKind, 'sqlite');
    assert.ok(fs.existsSync(path.join(dir, 'secret.sqlite')));

    const chat = s.createChat({
      userId: 1, otherUserId: 2, accessHash: 77n, keyFingerprint: 0xdeadbeefn,
      state: 'requested', gA: Buffer.from('ga'), randomId: 11,
    });
    assert.equal(chat.id, 1);
    assert.equal(chat.userId, 1);
    assert.equal(chat.otherUserId, 2);
    assert.equal(Number(chat.accessHash), 77);
    assert.equal(Number(chat.keyFingerprint), 0xdeadbeef);
    assert.equal(chat.state, 'requested');
    assert.equal(chat.gA.toString(), 'ga');
    assert.equal(s.getChat(1).randomId, 11);
    assert.equal(s.getChat(999), null);
    assert.equal(s.listChats(2).length, 1);
    assert.equal(s.listChats(3).length, 0);

    assert.equal(s.acceptChat(1).state, 'accepted');
    s.updateState(1, { qts: 3, seq: 4, date: 123 });
    let state = s.getState(1);
    assert.equal(state.state, 'accepted');
    assert.equal(state.qts, 3);
    assert.equal(state.seq, 4);
    assert.equal(state.date, 123);
    s.updateState(1, 'active', 5, 6);
    state = s.getState(1);
    assert.equal(state.state, 'active');
    assert.equal(state.qts, 5);
    assert.equal(state.seq, 6);

    const m1 = s.putMessage({ chatId: 1, randomId: 21n, text: 'hello', date: 100 });
    const m2 = s.putMessage({ chatId: 1, randomId: 22n, text: 'world', date: 101 });
    assert.equal(m1.id, 1);
    assert.equal(m2.id, 2);
    assert.deepEqual(s.listMessages(1).map((m) => m.text), ['hello', 'world']);
    assert.equal(s.getState(1).unreadCount, 2);
    assert.equal(s.markRead(1, 1), 1);
    assert.equal(s.listMessages(1)[0].read, 1);
    assert.equal(s.getState(1).unreadCount, 1);

    assert.equal(s.discardChat(1).state, 'discarded');
    assert.equal(s.clearMessages(1), 2);
    assert.equal(s.listMessages(1).length, 0);
  } finally {
    s.close();
  }
});

test('SecretStore persists across instances and supports the JSON fallback', () => {
  const dir = tempDir();
  const a = new SecretStore(dir);
  a.createChat({ userId: 4, otherUserId: 5, state: 'requested' });
  a.close();
  const b = new SecretStore(dir);
  assert.equal(b.getChat(1).otherUserId, 5);
  b.close();

  const j = new SecretStore(dir, { dbDriver: 'json' });
  try {
    assert.equal(j.driverKind, 'json');
    const chat = j.createChat({ userId: 9, otherUserId: 10, accessHash: 3, state: 'requested' });
    j.acceptChat(chat.id);
    assert.equal(j.getChat(chat.id).state, 'accepted');
    j.putMessage({ chatId: chat.id, randomId: 8, text: 'json' });
    assert.equal(j.listMessages(chat.id).length, 1);
  } finally {
    j.close();
  }
  assert.ok(fs.existsSync(path.join(dir, 'secret.json')));
});

test('METHOD_IDS match the layer-234 schema exactly', () => {
  assert.equal(secret.METHOD_IDS['messages.requestEncryption'], 0xf64daf43); // api.tl:2664
  assert.equal(secret.METHOD_IDS['messages.acceptEncryption'], 0x3dbc0415); // api.tl:2665
  assert.equal(secret.METHOD_IDS['messages.discardEncryption'], 0xf393aea0); // api.tl:2666
  assert.equal(secret.METHOD_IDS['messages.setEncryptedTyping'], 0x791451ed); // api.tl:2667
  assert.equal(secret.METHOD_IDS['messages.readEncryptedHistory'], 0x7f4b690a); // api.tl:2668
  assert.equal(secret.METHOD_IDS['messages.sendEncrypted'], 0x44fa7a15); // api.tl:2669
  assert.equal(secret.METHOD_IDS['messages.sendEncryptedFile'], 0x5559481d); // api.tl:2670
  assert.equal(secret.METHOD_IDS['messages.sendEncryptedService'], 0x32d439a4); // api.tl:2671
  assert.equal(secret.METHOD_IDS['messages.reportEncryptedSpam'], 0x4b0c8c0f); // api.tl:2673
  assert.equal(secret.METHOD_IDS['messages.uploadEncryptedFile'], 0x5057c497); // api.tl:2731
  // Not in layer 234: no ids may be fabricated for these names.
  for (const name of [
    'messages.getEncryptedChats', 'messages.getEncryptedHistory',
    'messages.getEncryptedUpdates', 'updates.getSecretChatDifferences',
  ]) assert.equal(Object.hasOwn(secret.METHOD_IDS, name), false);
});

test('requestEncryption returns encryptedChatRequested with the client g_a (object and reader forms)', () => {
  const dir = tempDir();
  const s = new SecretStore(dir);
  const ctx = { userId: 1, secretStore: s };
  try {
    const buf = secret.requestEncryption({
      userId: 2, accessHash: 77, randomId: 11, gA: Buffer.from('ga-plain'),
    }, ctx);
    const r = new TLBuffer(buf);
    assert.equal(r.uint(), ID.encryptedChatRequested);
    assert.equal(r.uint(), 0); // flags
    assert.equal(r.int(), 1); // chat id
    assert.equal(Number(r.long()), 77); // access_hash
    assert.ok(r.int() > 0); // date
    assert.equal(Number(r.long()), 1); // admin_id (requester)
    assert.equal(Number(r.long()), 2); // participant_id
    assert.equal(r.bytes().toString(), 'ga-plain');
    assert.equal(s.getChat(1).state, 'requested');
    assert.equal(s.getChat(1).randomId, 11);

    const wire = new TLBuffer()
      .putUint(secret.METHOD_IDS['messages.requestEncryption'])
      .putUint(ID.inputUser).putLong(3n).putLong(88n)
      .putInt(12).putBytes(Buffer.from('ga-wire')).buffer;
    const afterId = new TLBuffer(wire);
    afterId.uint(); // skip the method constructor id
    const wireBuf = secret.requestEncryption(afterId, ctx);
    const wr = new TLBuffer(wireBuf);
    assert.equal(wr.uint(), ID.encryptedChatRequested);
    wr.uint();
    assert.equal(wr.int(), 2);
    assert.equal(Number(wr.long()), 88);
    wr.int(); wr.long(); wr.long();
    assert.equal(wr.bytes().toString(), 'ga-wire');

    const updateCtx = { userId: 1, secretStore: s };
    const updates = secret.requestEncryption({ userId: 2, accessHash: 9 }, {
      ...updateCtx, secretUpdates: true,
    });
    assert.equal(ctorOf(updates), ID.updates);
    const ur = new TLBuffer(updates);
    ur.uint();
    assert.equal(vectorCount(ur), 1);
    assert.equal(ur.uint(), ID.updateEncryption);
  } finally {
    s.close();
  }
});

test('acceptEncryption returns encryptedChat and records g_b / fingerprint', () => {
  const dir = tempDir();
  const s = new SecretStore(dir);
  const ctx = { userId: 2, secretStore: s, secretUpdateQueue: [] };
  try {
    s.createChat({ userId: 1, otherUserId: 2, accessHash: 77, gA: Buffer.from('ga'), state: 'requested' });
    const buf = secret.acceptEncryption({
      peer: { chatId: 1, accessHash: 77 }, gB: Buffer.from('gb'), keyFingerprint: 999n,
    }, ctx);
    const r = new TLBuffer(buf);
    assert.equal(r.uint(), ID.encryptedChat);
    assert.equal(r.int(), 1);
    assert.equal(Number(r.long()), 77);
    r.int(); r.long(); r.long();
    assert.equal(r.bytes().toString(), 'gb');
    assert.equal(Number(r.long()), 999);
    assert.equal(s.getChat(1).state, 'accepted');
    assert.equal(s.getChat(1).gB.toString(), 'gb');
    assert.ok(ctx.secretUpdateQueue.some((u) => ctorOf(u) === ID.updateEncryption));

    const wire = new TLBuffer()
      .putUint(secret.METHOD_IDS['messages.acceptEncryption'])
      .putUint(ID.inputEncryptedChat).putInt(1).putLong(77n)
      .putBytes(Buffer.from('gb2')).putLong(1000n).buffer;
    const afterId = new TLBuffer(wire);
    afterId.uint();
    const wr = new TLBuffer(secret.acceptEncryption(afterId, ctx));
    assert.equal(wr.uint(), ID.encryptedChat);
    wr.int(); wr.long(); wr.int(); wr.long(); wr.long();
    assert.equal(wr.bytes().toString(), 'gb2');
    assert.equal(Number(wr.long()), 1000);
  } finally {
    s.close();
  }
});

test('discardEncryption returns boolTrue and marks the chat discarded', () => {
  const dir = tempDir();
  const s = new SecretStore(dir);
  try {
    s.createChat({ userId: 1, otherUserId: 2, state: 'accepted' });
    s.putMessage({ chatId: 1, text: 'x' });
    assert.equal(secret.discardEncryption({ deleteHistory: true, chatId: 1 }, { secretStore: s }).readUInt32LE(0), ID.boolTrue);
    assert.equal(s.getChat(1).state, 'discarded');
    assert.equal(s.listMessages(1).length, 0);

    const wire = new TLBuffer()
      .putUint(secret.METHOD_IDS['messages.discardEncryption'])
      .putUint(1).putUint(ID.boolTrue).putInt(1).buffer;
    const afterId = new TLBuffer(wire);
    afterId.uint();
    assert.equal(secret.discardEncryption(afterId, { secretStore: s }).readUInt32LE(0), ID.boolTrue);
  } finally {
    s.close();
  }
});

test('sendEncrypted returns updates with updateNewEncryptedMessage, or the schema result', () => {
  const dir = tempDir();
  const s = new SecretStore(dir);
  const ctx = { userId: 1, secretStore: s, secretUpdateQueue: [] };
  try {
    s.createChat({ userId: 1, otherUserId: 2, accessHash: 77, state: 'accepted' });
    const before = s.getState(1).qts;
    const buf = secret.sendEncrypted({
      peer: { chatId: 1, accessHash: 77 }, randomId: 5n, data: Buffer.from('cipher'), date: 12345,
    }, ctx);
    const r = new TLBuffer(buf);
    assert.equal(r.uint(), ID.updates);
    assert.equal(vectorCount(r), 1);
    assert.equal(r.uint(), ID.updateNewEncryptedMessage);
    assert.equal(r.uint(), ID.encryptedMessage);
    assert.equal(Number(r.long()), 5);
    assert.equal(r.int(), 1);
    assert.equal(r.int(), 12345);
    assert.equal(r.bytes().toString(), 'cipher'); // opaque bytes, never decrypted
    assert.equal(r.uint(), ID.encryptedFileEmpty);
    assert.equal(r.int(), before + 1); // qts
    assert.equal(vectorCount(r), 0); // users
    assert.equal(vectorCount(r), 0); // chats
    assert.equal(r.int(), 12345); // date
    assert.equal(r.int(), 0); // seq
    assert.equal(ctx.secretUpdateQueue.length, 1);
    assert.equal(s.listMessages(1).length, 1);
    assert.equal(s.listMessages(1)[0].text, Buffer.from('cipher').toString('base64'));

    const schema = secret.sendEncrypted({
      peer: { chatId: 1 }, randomId: 6n, data: Buffer.from('x'), date: 12346,
    }, { secretStore: s, secretSchemaResult: true });
    assert.equal(ctorOf(schema), ID.sentEncryptedMessage);
    const sr = new TLBuffer(schema);
    sr.uint();
    assert.equal(sr.int(), 12346);
  } finally {
    s.close();
  }
});

test('sendEncryptedFile includes encryptedFile in the encrypted message', () => {
  const dir = tempDir();
  const s = new SecretStore(dir);
  try {
    s.createChat({ userId: 1, otherUserId: 2, state: 'accepted' });
    const buf = secret.sendEncryptedFile({
      peer: { chatId: 1 }, randomId: 7n, data: Buffer.from('f'), date: 200,
      file: { id: 900, accessHash: 10, dcId: 2, keyFingerprint: 3 },
    }, { secretStore: s });
    const r = new TLBuffer(buf);
    assert.equal(r.uint(), ID.updates);
    assert.equal(vectorCount(r), 1);
    assert.equal(r.uint(), ID.updateNewEncryptedMessage);
    assert.equal(r.uint(), ID.encryptedMessage);
    assert.equal(Number(r.long()), 7);
    assert.equal(r.int(), 1);
    assert.equal(r.int(), 200);
    assert.equal(r.bytes().toString(), 'f');
    assert.equal(r.uint(), ID.encryptedFile);
    assert.equal(Number(r.long()), 900);
    assert.equal(Number(r.long()), 10);
    assert.equal(Number(r.long()), 0); // size
    assert.equal(r.int(), 2); // dc_id
    assert.equal(r.int(), 3); // key_fingerprint

    const schema = secret.sendEncryptedFile({
      peer: { chatId: 1 }, randomId: 8n, data: Buffer.from('g'), date: 201,
      file: { id: 901 },
    }, { secretStore: s, secretSchemaResult: true });
    assert.equal(ctorOf(schema), ID.sentEncryptedFile);

    const wire = new TLBuffer()
      .putUint(secret.METHOD_IDS['messages.sendEncryptedFile'])
      .putUint(0) // flags
      .putUint(ID.inputEncryptedChat).putInt(1).putLong(0n)
      .putLong(9n).putBytes(Buffer.from('wire'))
      .putUint(ID.inputEncryptedFile).putLong(902n).putLong(11n).buffer;
    const afterId = new TLBuffer(wire);
    afterId.uint();
    const wr = new TLBuffer(secret.sendEncryptedFile(afterId, { secretStore: s }));
    assert.equal(wr.uint(), ID.updates);
    wr.uint(); // updates vector header
    wr.int();
    assert.equal(wr.uint(), ID.updateNewEncryptedMessage);
    assert.equal(wr.uint(), ID.encryptedMessage);
    wr.long(); wr.int(); wr.int();
    assert.equal(wr.bytes().toString(), 'wire');
    assert.equal(wr.uint(), ID.encryptedFile);
    assert.equal(Number(wr.long()), 902);
  } finally {
    s.close();
  }
});

test('setEncryptedTyping, readEncryptedHistory and local helpers', () => {
  const dir = tempDir();
  const s = new SecretStore(dir);
  const ctx = { secretStore: s, secretUpdateQueue: [] };
  try {
    s.createChat({ userId: 1, otherUserId: 2, state: 'accepted' });
    s.putMessage({ chatId: 1, text: 'a', date: 10 });
    assert.equal(secret.setEncryptedTyping({ peer: { chatId: 1 }, typing: true }, ctx).readUInt32LE(0), ID.boolTrue);
    assert.ok(ctx.secretUpdateQueue.some((u) => ctorOf(u) === ID.updateEncryptedChatTyping));
    assert.equal(secret.readEncryptedHistory({ peer: { chatId: 1 }, maxDate: 999 }, ctx).readUInt32LE(0), ID.boolTrue);
    assert.ok(ctx.secretUpdateQueue.some((u) => ctorOf(u) === ID.updateEncryptedMessagesRead));
    assert.equal(s.listMessages(1)[0].read, 1);
    assert.equal(secret.reportEncryptedSpam({ peer: { chatId: 1 } }, ctx).readUInt32LE(0), ID.boolTrue);
    assert.equal(ctorOf(secret.uploadEncryptedFile({ peer: { chatId: 1 }, file: { id: 42 } }, ctx)), ID.encryptedFile);

    assert.equal(ctorOf(secret.getEncryptedHistory({ chatId: 1 }, ctx)), ID.updates);
    assert.equal(ctorOf(secret.getEncryptedUpdates({ chatId: 1 }, ctx)), ID.updates);
    assert.equal(ctorOf(secret.getSecretChatDifferences({ chatId: 1 }, ctx)), ID.difference);
  } finally {
    s.close();
  }
});
