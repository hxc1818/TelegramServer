// Unit tests for the dedicated GroupStore and the group/channel TL handlers.
// Constructor ids here are written out explicitly (from schema/api.tl, layer
// 234) so the tests catch accidental changes to the wire format.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TLBuffer } from '../src/tl/buffer.js';
import { Store } from '../src/store/store.js';
import { GroupStore } from '../src/store/groups.js';
import * as groups from '../src/rpc/handlers/groups.js';

const ID = {
  boolTrue: 0x997275b5,
  vector: 0x1cb5c415,
  user: 0xb1b8cc83,
  peerUser: 0x59511722,
  peerChat: 0x36c6019a,
  chat: 0x41cbf256,
  channel: 0x7ad15240,
  chatFull: 0x2633421b,
  chatParticipant: 0x38e79fde,
  chatParticipantCreator: 0xe1f867b8,
  chatParticipants: 0x3cbc93f8,
  chatPhotoEmpty: 0x37c1011c,
  peerNotifySettings: 0x99622c0c,
  messageService: 0x7a800e0a,
  messagesChatFull: 0xe5d7d19c,
  chats: 0x64ff9fd5,
  updateNewMessage: 0x1f2b0afd,
  updateNewChannelMessage: 0x62ba04d9,
  updateChatParticipants: 0x07761198,
  updates: 0x74ae4240,
  invitedUsers: 0x7f5defa6,
  messageActionChatCreate: 0xbd47cbad,
};

function tempDir() {
  const dir = path.join(os.tmpdir(), `telegramserver-groups-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const USER_BOOL_BITS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 23, 24, 25, 26, 27, 28, 29];

function readUserId(r) {
  assert.equal(r.uint(), ID.user);
  const flags = r.uint();
  for (const bit of USER_BOOL_BITS) if (flags & (1 << bit)) assert.equal(r.uint(), ID.boolTrue);
  r.uint(); // flags2
  const id = Number(r.long());
  if (flags & 1) r.long();
  if (flags & (1 << 1)) r.string();
  if (flags & (1 << 2)) r.string();
  if (flags & (1 << 3)) r.string();
  if (flags & (1 << 4)) r.string();
  return id;
}

function vectorCount(r) {
  assert.equal(r.uint(), ID.vector);
  return r.int();
}

// Consumes a messageService up to (but not including) its MessageAction.
function readServiceMessageHeader(r) {
  assert.equal(r.uint(), ID.messageService);
  const flags = r.uint();
  if (flags & (1 << 1)) assert.equal(r.uint(), ID.boolTrue); // out:true
  const id = r.int();
  if (flags & (1 << 8)) {
    assert.equal(r.uint(), ID.peerUser);
    r.long();
  }
  const peerCtor = r.uint();
  const peerId = Number(r.long());
  const date = r.int();
  return { id, peerCtor, peerId, date };
}

function readChat(r) {
  const ctor = r.uint();
  if (ctor === ID.channel) {
    const flags = r.uint();
    for (const bit of [0, 2, 5, 7, 8, 9, 11, 12, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]) {
      if (flags & (1 << bit)) assert.equal(r.uint(), ID.boolTrue);
    }
    r.uint(); // flags2
    const id = Number(r.long());
    const title = r.string();
    assert.equal(r.uint(), ID.chatPhotoEmpty);
    r.int(); // date
    return { ctor, id, title, flags };
  }
  assert.equal(ctor, ID.chat);
  const flags = r.uint();
  for (const bit of [0, 2, 5, 23, 24, 25]) if (flags & (1 << bit)) assert.equal(r.uint(), ID.boolTrue);
  const id = Number(r.long());
  const title = r.string();
  assert.equal(r.uint(), ID.chatPhotoEmpty);
  const participants = r.int();
  r.int(); // date
  r.int(); // version
  return { ctor, id, title, flags, participants };
}

test('GroupStore CRUD keeps chats, channels, members, messages and state', () => {
  const dir = tempDir();
  const gs = new GroupStore(dir);
  try {
    const chat = gs.createChat({ title: 'Group', creatorId: 1, members: [2, 3] });
    assert.ok(chat.id < 0, 'chat ids are negative int64');
    assert.equal(chat.id, -1000001);
    assert.equal(chat.title, 'Group');
    assert.equal(chat.megagroup, false);
    assert.deepEqual(chat.members.slice().sort((a, b) => a - b), [1, 2, 3]);
    assert.equal(chat.participantsCount, 3);
    assert.equal(gs.getChat(chat.id).title, 'Group');
    assert.equal(gs.listChatsForUser(2).some((c) => c.id === chat.id), true);

    assert.equal(gs.addMember(chat.id, 4), true);
    assert.equal(gs.getChat(chat.id).members.includes(4), true);
    assert.equal(gs.removeMember(chat.id, 4), true);
    assert.equal(gs.getChat(chat.id).members.includes(4), false);

    const channel = gs.createChannel({ title: 'Channel', creatorId: 1, broadcast: true, about: 'hi' });
    assert.ok(channel.id < -1000000000000, 'channel ids use a separate negative range');
    assert.equal(channel.id, -1000000000001);
    assert.equal(channel.broadcast, true);
    assert.equal(gs.getChannel(channel.id).about, 'hi');
    assert.equal(gs.listChatsForUser(1).some((c) => c.id === channel.id), true);

    const msg = gs.putMessage({ peerType: 'chat', peerId: chat.id, fromId: 2, text: 'hello', randomId: 9 });
    assert.equal(gs.listMessages('chat', chat.id, 10)[0].id, msg.id);
    const channelMsg = gs.putMessage({ peerType: 'channel', peerId: channel.id, fromId: 1, text: 'broadcast' });
    assert.equal(gs.listMessages('channel', channel.id)[0].id, channelMsg.id);
    assert.equal(gs.listMessages('chat', chat.id).length, 1, 'messages are scoped to a peer');

    assert.equal(gs.nextPts(), 1);
    assert.equal(gs.nextPts(), 2);
    assert.equal(gs.getState().pts, 2);
    if (gs.driverKind === 'sqlite') {
      assert.ok(fs.existsSync(path.join(dir, 'groups.sqlite')));
    }
  } finally {
    gs.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GroupStore accepts plain objects and has a JSON fallback', () => {
  const dir = tempDir();
  const gs = new GroupStore({ dataDir: dir, dbDriver: 'json' });
  try {
    assert.equal(gs.driverKind, 'json');
    const chat = gs.createChat({ title: 'J', creatorId: 5 });
    assert.ok(fs.existsSync(path.join(dir, 'groups.json')));
    assert.equal(gs.getChat(chat.id).title, 'J');
    assert.equal(gs.addMember({ chatId: chat.id, userId: 6 }), true);
    assert.equal(gs.removeMember({ chatId: chat.id, userId: 6 }), true);
    assert.equal(gs.addMember(chat.id, 6), true);
    assert.equal(gs.listChatsForUser(6)[0].id, chat.id);
  } finally {
    gs.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('messages.createChat -> invitedUsers -> updates -> chat#41cbf256', () => {
  const dir = tempDir();
  const store = new Store(dir);
  const groupStore = new GroupStore(dir);
  try {
    const ctx = { store, groupStore, userId: 7 };
    const buf = groups.createChat({ users: [{ id: 8 }], title: 'Team' }, ctx);
    const r = new TLBuffer(buf);
    assert.equal(r.uint(), ID.invitedUsers); // messages.invitedUsers#7f5defa6

    // A fully boxed Updates is returned rather than a bare Chat, so TDesktop
    // can parse the declared messages.createChat result type.
    assert.equal(r.uint(), ID.updates); // updates#74ae4240
    assert.equal(vectorCount(r), 1); // updates vector

    assert.equal(r.uint(), ID.updateNewMessage); // updateNewMessage#1f2b0afd
    const msg = readServiceMessageHeader(r);
    assert.equal(msg.peerCtor, ID.peerChat);
    const peerId = msg.peerId;
    assert.equal(r.uint(), ID.messageActionChatCreate); // #bd47cbad
    assert.equal(r.string(), 'Team');
    assert.deepEqual(r.vector((x) => Number(x.long())), [8]);
    assert.ok(r.int() > 0); // pts
    assert.equal(r.int(), 1); // pts_count

    assert.equal(vectorCount(r), 2); // users vector
    assert.deepEqual([readUserId(r), readUserId(r)].sort((a, b) => a - b), [7, 8]);

    assert.equal(vectorCount(r), 1); // chats vector
    const chat = readChat(r);
    assert.equal(chat.ctor, ID.chat); // chat#41cbf256
    assert.equal(chat.flags & 1, 1, 'creator flag set for the current user');
    assert.equal(chat.title, 'Team');
    assert.equal(chat.participants, 2);
    assert.equal(chat.id, peerId);
    assert.ok(chat.id < 0);

    r.int(); // date
    r.int(); // seq
    assert.equal(vectorCount(r), 0); // missing_invitees
    assert.equal(r.offset, buf.length);

    assert.equal(groupStore.getChat(chat.id).title, 'Team');
    assert.equal(groupStore.getChat(chat.id).members.includes(8), true);
  } finally {
    groupStore.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('messages.addChatUser -> updateChatParticipants -> chatParticipants#3cbc93f8', () => {
  const dir = tempDir();
  const store = new Store(dir);
  const groupStore = new GroupStore(dir);
  try {
    const chat = groupStore.createChat({ title: 'Group', creatorId: 1, members: [1] });
    const ctx = { store, groupStore, userId: 1 };
    const buf = groups.addChatUser({ chatId: chat.id, user_id: { id: 2 }, fwd_limit: 10 }, ctx);
    const r = new TLBuffer(buf);
    assert.equal(r.uint(), ID.invitedUsers);
    assert.equal(r.uint(), ID.updates);
    assert.equal(vectorCount(r), 1);
    assert.equal(r.uint(), ID.updateChatParticipants); // updateChatParticipants#7761198
    assert.equal(r.uint(), ID.chatParticipants); // chatParticipants#3cbc93f8
    assert.equal(Number(r.long()), chat.id);
    const members = r.vector((p) => {
      const ctor = p.uint();
      if (ctor === ID.chatParticipantCreator) {
        p.uint(); // flags
        return Number(p.long());
      }
      assert.equal(ctor, ID.chatParticipant); // chatParticipant#38e79fde
      p.uint(); // flags
      const id = Number(p.long());
      p.long(); // inviter_id
      p.int(); // date
      return id;
    });
    assert.deepEqual(members.slice().sort((a, b) => a - b), [1, 2]);
    r.int(); // version

    assert.equal(vectorCount(r), 1); // users
    readUserId(r);
    assert.equal(vectorCount(r), 1); // chats
    assert.equal(readChat(r).ctor, ID.chat);
    r.int(); // date
    r.int(); // seq
    assert.equal(vectorCount(r), 0); // missing_invitees
    assert.equal(r.offset, buf.length);

    assert.equal(groupStore.getChat(chat.id).members.includes(2), true);
  } finally {
    groupStore.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('channels.createChannel emits channel#7ad15240; getFullChat uses messages.chatFull#e5d7d19c', () => {
  const dir = tempDir();
  const store = new Store(dir);
  const groupStore = new GroupStore(dir);
  try {
    const ctx = { store, groupStore, userId: 1 };
    const buf = groups.createChannel({ title: 'Mega', about: 'a', megagroup: true }, ctx);
    const r = new TLBuffer(buf);
    assert.equal(r.uint(), ID.updates); // channels.createChannel returns Updates directly
    assert.equal(vectorCount(r), 1);
    assert.equal(r.uint(), ID.updateNewChannelMessage); // updateNewChannelMessage#62ba04d9
    const msg = readServiceMessageHeader(r);
    assert.equal(msg.peerCtor, 0xa2a5371e); // peerChannel#a2a5371e
    assert.equal(r.uint(), ID.messageActionChatCreate); // megagroup uses chat create
    assert.equal(r.string(), 'Mega');
    r.vector((x) => Number(x.long()));
    r.int(); r.int(); // pts, pts_count

    assert.equal(vectorCount(r), 1); // users
    readUserId(r);
    assert.equal(vectorCount(r), 1); // chats
    const channel = readChat(r);
    assert.equal(channel.ctor, ID.channel); // channel#7ad15240
    assert.equal(channel.flags & (1 << 8), 1 << 8, 'megagroup bit 8 set');
    assert.equal(channel.flags & (1 << 5), 0, 'broadcast bit 5 clear');
    assert.equal(channel.title, 'Mega');
    r.int(); r.int(); // date, seq
    assert.equal(r.offset, buf.length);
    assert.equal(groupStore.getChannel(channel.id).megagroup, true);

    const chatsBuf = groups.getChats({ id: [channel.id] }, ctx);
    const cr = new TLBuffer(chatsBuf);
    assert.equal(cr.uint(), ID.chats); // messages.chats#64ff9fd5
    assert.equal(cr.vector((x) => x.uint())[0], ID.channel);

    const chat = groupStore.createChat({ title: 'Full', creatorId: 1, members: [1, 2] });
    const fullBuf = groups.getFullChat({ chatId: chat.id }, ctx);
    const fr = new TLBuffer(fullBuf);
    assert.equal(fr.uint(), ID.messagesChatFull); // messages.chatFull#e5d7d19c
    assert.equal(fr.uint(), ID.chatFull); // chatFull#2633421b
    fr.uint(); // flags
    assert.equal(Number(fr.long()), chat.id);
    assert.equal(fr.string(), '');
    assert.equal(fr.uint(), ID.chatParticipants); // chatParticipants#3cbc93f8
    assert.equal(Number(fr.long()), chat.id);
    assert.equal(fr.vector((p) => {
      const ctor = p.uint();
      if (ctor === ID.chatParticipantCreator) {
        p.uint();
        return Number(p.long());
      }
      assert.equal(ctor, ID.chatParticipant);
      p.uint(); const uid = Number(p.long()); p.long(); p.int();
      return uid;
    }).length, 2);
    fr.int(); // participants version
    assert.equal(fr.uint(), ID.peerNotifySettings);
    fr.uint(); // notify_settings flags
    assert.equal(fr.vector(readChat)[0].ctor, ID.chat); // chats vector
    assert.equal(fr.vector(readUserId).length, 2); // users vector
    assert.equal(fr.offset, fullBuf.length);
  } finally {
    groupStore.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
