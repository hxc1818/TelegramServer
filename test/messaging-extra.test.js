// Unit tests for messaging extras: store CRUD + layer-234 TL handler results.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TLBuffer } from '../src/tl/buffer.js';
import { Store } from '../src/store/store.js';
import { MessagingExtraStore } from '../src/store/messaging-extra.js';
import * as M from '../src/rpc/handlers/messaging-extra.js';

function tempDir() {
  const dir = path.join(os.tmpdir(), `telegramserver-extra-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCtx(dir) {
  const store = new Store(dir);
  const extra = new MessagingExtraStore(dir);
  const user = store.createUser({ phone: '+15551234567', firstName: 'Extra', lastName: 'Test' });
  store.createSession(user.id, 'aabbccddeeff0011');
  const ctx = {
    store, extra, userId: user.id,
    session: { authKeyId: 'aabbccddeeff0011', userId: user.id },
  };
  return { store, extra, ctx, user };
}

// Reads a full tlMessage() payload, returning its flags.
function readTlMessage(r) {
  assert.equal(r.uint(), M.EXTRA_ID.message);
  const flags = r.uint();
  r.uint(); // flags2
  r.int(); // id
  if (flags & (1 << 8)) {
    assert.equal(r.uint(), M.EXTRA_ID.peerUser);
    r.long();
  }
  const peerId = r.uint();
  assert.ok([M.EXTRA_ID.peerUser, M.EXTRA_ID.peerChat, M.EXTRA_ID.peerChannel].includes(peerId));
  r.long();
  if (flags & (1 << 2)) {
    assert.equal(r.uint(), M.EXTRA_ID.messageFwdHeader);
    const fwdFlags = r.uint();
    if (fwdFlags & 1) {
      assert.ok([M.EXTRA_ID.peerUser, M.EXTRA_ID.peerChat, M.EXTRA_ID.peerChannel].includes(r.uint()));
      r.long();
    }
    r.int(); // fwd date
  }
  r.int(); // date
  r.string(); // text
  if (flags & (1 << 15)) r.int(); // edit_date
  return flags;
}

test('MessagingExtraStore CRUD: edits, deletes, forwards, replies, drafts and reactions', () => {
  const dir = tempDir();
  const extra = new MessagingExtraStore(dir);
  try {
    const first = extra.editMessage(7, 'hello', 1000);
    assert.equal(first.msgId, 7);
    assert.equal(first.text, 'hello');
    assert.equal(first.editDate, 1000);
    assert.equal(first.editCount, 1);

    const second = extra.editMessage(7, 'edited', 2000);
    assert.equal(second.text, 'edited');
    assert.equal(second.editCount, 2);
    const history = extra.getEditHistory(7);
    assert.equal(history.length, 2);
    assert.equal(history[0].oldText, '');
    assert.equal(history[1].newText, 'edited');
    assert.equal(history[1].editDate, 2000);

    assert.equal(extra.markDeleted([7, 8]), 2);
    assert.equal(extra.isDeleted(7), true);
    assert.equal(extra.getMeta(8).deleted, true);

    const fwd = extra.addForward(7, { type: 'channel', id: 99 }, 55);
    assert.equal(fwd.fwdFromPeer, 'channel:99');
    assert.equal(fwd.fwdFromId, 55);
    assert.ok(fwd.fwdDate > 0);

    const reply = extra.setReply(7, 4, { type: 'user', id: 3 });
    assert.equal(reply.replyToId, 4);
    assert.equal(reply.replyToPeer, 'user:3');
    assert.equal(extra.getMeta(7).replyToId, 4);

    const draft = extra.setDraft('user:42', 'draft text', [{ id: 1, offset: 0, length: 5 }]);
    assert.equal(draft.text, 'draft text');
    assert.equal(draft.entities.length, 1);
    assert.equal(extra.getDraft({ type: 'user', id: 42 }).text, 'draft text');
    assert.equal(extra.listDrafts().length, 1);
    assert.equal(extra.clearDraft('user:42'), true);
    assert.equal(extra.getDraft('user:42'), null);

    assert.equal(extra.addReaction(7, '👍'), true);
    assert.equal(extra.addReaction(7, '🔥'), true);
    assert.deepEqual(extra.getReactions(7).slice().sort(), ['👍', '🔥'].sort());
    assert.equal(extra.removeReaction(7, '🔥'), true);
    assert.deepEqual(extra.getReactions(7), ['👍']);

    extra.close();
    const reopened = new MessagingExtraStore(dir);
    try {
      assert.equal(reopened.getMeta(7).text, 'edited');
      assert.equal(reopened.isDeleted(7), true);
      assert.equal(reopened.getEditHistory(7).length, 2);
      assert.equal(reopened.getReply(7).replyToId, 4);
      assert.deepEqual(reopened.getReactions(7), ['👍']);
    } finally {
      reopened.close();
    }
  } finally {
    extra.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('messages.editMessage handler returns updates with updateEditMessage and edit_date flag', () => {
  const dir = tempDir();
  const { store, extra, ctx, user } = makeCtx(dir);
  try {
    const msg = store.putMessage({ fromId: user.id, peerType: 'user', peerId: 42, text: 'old', randomId: 1 });
    const result = M.editMessage({
      peer: { type: 'user', id: 42 }, id: msg.id, message: 'new', editDate: 2000,
    }, ctx);
    const r = new TLBuffer(result);
    assert.equal(r.uint(), 0x74ae4240); // updates#74ae4240
    const updates = r.vector((rr) => {
      assert.equal(rr.uint(), 0xe40370a3); // updateEditMessage#e40370a3
      const flags = readTlMessage(rr);
      assert.ok(flags & (1 << 15)); // edit_date present
      assert.ok(rr.int() > 0); // pts
      assert.equal(rr.int(), 1); // pts_count
      return true;
    });
    assert.equal(updates.length, 1);
    assert.equal(store.getMessage(msg.id).text, 'new');
    assert.equal(extra.getMeta(msg.id).editDate, 2000);
  } finally {
    store.close(); extra.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('messages.deleteMessages handler returns affectedMessages and marks ids deleted', () => {
  const dir = tempDir();
  const { store, extra, ctx, user } = makeCtx(dir);
  try {
    const one = store.putMessage({ fromId: user.id, peerType: 'user', peerId: 42, text: 'a' });
    const two = store.putMessage({ fromId: user.id, peerType: 'user', peerId: 42, text: 'b' });
    const result = M.deleteMessages({ id: [one.id, two.id] }, ctx);
    const r = new TLBuffer(result);
    assert.equal(r.uint(), 0x84d19185); // messages.affectedMessages#84d19185
    assert.ok(r.int() > 0); // pts
    assert.equal(r.int(), 1); // pts_count
    assert.equal(extra.isDeleted(one.id), true);
    assert.equal(extra.isDeleted(two.id), true);
  } finally {
    store.close(); extra.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('messages.saveDraft returns boolTrue and getAllDrafts returns updateDraftMessage', () => {
  const dir = tempDir();
  const { store, extra, ctx } = makeCtx(dir);
  try {
    const saved = M.saveDraft({ peer: { type: 'user', id: 42 }, message: 'hi' }, ctx);
    assert.equal(saved.readUInt32LE(0), 0x997275b5); // boolTrue
    assert.equal(extra.getDraft('user:42').text, 'hi');

    const result = M.getAllDrafts({}, ctx);
    const r = new TLBuffer(result);
    assert.equal(r.uint(), 0x74ae4240); // updates
    const updates = r.vector((rr) => {
      assert.equal(rr.uint(), 0xedfc111e); // updateDraftMessage#edfc111e
      rr.uint(); // flags (0)
      assert.equal(rr.uint(), 0x59511722); // peerUser
      rr.long();
      assert.equal(rr.uint(), 0x9cb1d4fa); // draftMessage#9cb1d4fa
      rr.uint(); // draft flags
      assert.equal(rr.string(), 'hi');
      assert.ok(rr.int() > 0); // date
      return true;
    });
    assert.equal(updates.length, 1);
  } finally {
    store.close(); extra.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveDraft accepts a TLBuffer reader with the entities flag set', () => {
  const dir = tempDir();
  const { store, extra, ctx } = makeCtx(dir);
  try {
    const b = new TLBuffer();
    b.putUint(1 << 3); // flags.3?entities
    b.putUint(0xdde8a54c).putLong(42n).putLong(0n); // inputPeerUser
    b.putString('reader draft');
    b.putUint(0x1cb5c415).putInt(1); // vector<MessageEntity>
    b.putUint(0xdc7b1140).putInt(0).putInt(3).putLong(9n); // messageEntityMentionName
    const result = M.saveDraft(new TLBuffer(b.buffer), ctx);
    assert.equal(result.readUInt32LE(0), 0x997275b5);
    assert.equal(extra.getDraft('user:42').text, 'reader draft');
    assert.equal(extra.getDraft('user:42').entities[0].userId, 9);
  } finally {
    store.close(); extra.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('messages.search handler filters by text and returns messagesSlice#5f206716', () => {
  const dir = tempDir();
  const { store, extra, ctx, user } = makeCtx(dir);
  try {
    store.putMessage({ fromId: user.id, peerType: 'user', peerId: 7, text: 'find me' });
    store.putMessage({ fromId: user.id, peerType: 'user', peerId: 7, text: 'other text' });
    const result = M.search({ peer: { type: 'user', id: 7 }, q: 'find', limit: 10 }, ctx);
    const r = new TLBuffer(result);
    assert.equal(r.uint(), 0x5f206716); // messages.messagesSlice
    assert.equal(r.uint(), 0); // flags
    assert.equal(r.int(), 1); // count
    const messages = r.vector((rr) => {
      const flags = readTlMessage(rr);
      assert.ok(flags & (1 << 8)); // from_id present
      return true;
    });
    assert.equal(messages.length, 1);
  } finally {
    store.close(); extra.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('messages.forwardMessages handler returns updates with a forwarded message', () => {
  const dir = tempDir();
  const { store, extra, ctx, user } = makeCtx(dir);
  try {
    const src = store.putMessage({ fromId: user.id, peerType: 'user', peerId: 9, text: 'forwarded body' });
    const result = M.forwardMessages({
      fromPeer: { type: 'user', id: 9 }, id: [src.id], randomId: [10n],
      toPeer: { type: 'user', id: 77 },
    }, ctx);
    const r = new TLBuffer(result);
    assert.equal(r.uint(), 0x74ae4240); // updates
    const updates = r.vector((rr) => {
      assert.equal(rr.uint(), 0x1f2b0afd); // updateNewMessage#1f2b0afd
      const flags = readTlMessage(rr);
      assert.ok(flags & (1 << 2)); // fwd_from present
      assert.ok(rr.int() > 0); // pts
      assert.equal(rr.int(), 1);
      return true;
    });
    assert.equal(updates.length, 1);
    const copied = store.listMessages('user', 77, 1)[0];
    assert.equal(copied.text, 'forwarded body');
    assert.equal(extra.getMeta(copied.id).fwdFromPeer, 'user:9');
    assert.equal(extra.getMeta(copied.id).fwdFromId, src.id);
  } finally {
    store.close(); extra.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('messages.sendReaction returns updateMessageReactions with reactionEmoji', () => {
  const dir = tempDir();
  const { store, extra, ctx, user } = makeCtx(dir);
  try {
    const msg = store.putMessage({ fromId: user.id, peerType: 'user', peerId: 5, text: 'react' });
    const result = M.sendReaction({
      peer: { type: 'user', id: 5 }, id: msg.id, reaction: ['👍'],
    }, ctx);
    const r = new TLBuffer(result);
    assert.equal(r.uint(), 0x74ae4240); // updates
    const updates = r.vector((rr) => {
      assert.equal(rr.uint(), 0x1e297bfa); // updateMessageReactions#1e297bfa
      rr.uint(); // flags
      assert.equal(rr.uint(), 0x59511722); // peerUser
      rr.long();
      assert.equal(rr.int(), msg.id);
      assert.equal(rr.uint(), 0xa339f0b); // messageReactions#a339f0b
      rr.uint(); // flags
      const counts = rr.vector((cr) => {
        assert.equal(cr.uint(), 0xa3d1cb80); // reactionCount
        cr.uint(); // flags
        assert.equal(cr.uint(), 0x1b2286b8); // reactionEmoji
        const emoji = cr.string();
        const count = cr.int();
        return [emoji, count];
      });
      assert.deepEqual(counts, [['👍', 1]]);
      return true;
    });
    assert.equal(updates.length, 1);
    assert.deepEqual(extra.getReactions(msg.id), ['👍']);
  } finally {
    store.close(); extra.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updates.getChannelDifference returns channelDifferenceEmpty#3e11affb with verified pts', () => {
  const dir = tempDir();
  const { store, extra, ctx } = makeCtx(dir);
  try {
    const result = M.getChannelDifference({ pts: 5 }, ctx);
    const r = new TLBuffer(result);
    assert.equal(r.uint(), 0x3e11affb); // updates.channelDifferenceEmpty#3e11affb
    assert.equal(r.uint(), 0); // flags: no final / timeout
    assert.equal(r.int(), 5); // pts
    assert.equal(result.length, 12); // no optional timeout field

    const req = new TLBuffer();
    req.putUint(0).putLong(123n).putLong(456n)
      .putUint(0x94d42ee7) // channelMessagesFilterEmpty
      .putInt(7).putInt(100);
    const fromReader = M.getChannelDifference(new TLBuffer(req.buffer), ctx);
    assert.equal(fromReader.readUInt32LE(0), 0x3e11affb);
    const rr = new TLBuffer(fromReader);
    rr.uint(); // constructor
    rr.uint(); // flags
    assert.equal(rr.int(), 7);
  } finally {
    store.close(); extra.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RPC id table matches the pinned layer-234 schema', () => {
  assert.equal(M.METHOD_IDS['messages.editMessage'], 0xb106e66c);
  assert.equal(M.METHOD_IDS['messages.deleteMessages'], 0xe58e95d2);
  assert.equal(M.METHOD_IDS['messages.forwardMessages'], 0x13704a7c);
  assert.equal(M.METHOD_IDS['messages.search'], 0x29ee847a);
  assert.equal(M.METHOD_IDS['messages.searchGlobal'], 0x6126a43c);
  assert.equal(M.METHOD_IDS['messages.saveDraft'], 0xad0fa15c);
  assert.equal(M.METHOD_IDS['messages.getAllDrafts'], 0x6a3f8d65);
  assert.equal(M.METHOD_IDS['messages.readMentions'], 0x36e5bf4d);
  assert.equal(M.METHOD_IDS['messages.readReactions'], 0x9ec44f93);
  assert.equal(M.METHOD_IDS['messages.sendReaction'], 0xd30d78d4);
  assert.equal(M.METHOD_IDS['messages.sendScreenshotNotification'], 0xa1405817);
  assert.equal(M.METHOD_IDS['updates.getChannelDifference'], 0x3173d78);
});
