// Unit tests for the dedicated FolderStore and the folder/chatlist TL handlers.
// Constructor ids are written out explicitly (from schema/api.tl, layer 234)
// so the tests catch accidental changes to the wire format.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TLBuffer } from '../src/tl/buffer.js';
import { Store } from '../src/store/store.js';
import { FolderStore } from '../src/store/folders.js';
import * as folders from '../src/rpc/handlers/folders.js';

const ID = {
  boolTrue: 0x997275b5,
  vector: 0x1cb5c415,
  peerUser: 0x59511722,
  peerChat: 0x36c6019a,
  user: 0xb1b8cc83,
  message: 0x7600b9d3,
  dialog: 0xfc89f7f3,
  dialogFolder: 0x71bd134c,
  state: 0xa56c2a3e,
  updates: 0x74ae4240,
  peerDialogs: 0xa749f3e5,
  dialogsSlice: 0xd1747044,
  updateFolderPeers: 0x19360dc0,
  folderPeer: 0xe9baa668,
  folder: 0xff544e65,
  chatlistUpdates: 0x93bd878d,
  inputDialogPeer: 0xfcaafeb7,
  inputFolderPeer: 0xfbd2c296,
  inputPeerUser: 0xdde8a54c,
  inputChatlistDialogFilter: 0xf3e0da33,
};

const USER_BOOL_BITS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 23, 24, 25, 26, 27, 28, 29];

function tempDir() {
  const dir = path.join(os.tmpdir(), `telegramserver-folders-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function vectorCount(r) {
  assert.equal(r.uint(), ID.vector);
  return r.int();
}

function readPeer(r) {
  const ctor = r.uint();
  assert.ok([ID.peerUser, ID.peerChat].includes(ctor), `unexpected Peer ctor 0x${ctor.toString(16)}`);
  return { ctor, id: Number(r.long()) };
}

function readUser(r) {
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

function readMessage(r) {
  assert.equal(r.uint(), ID.message);
  const flags = r.uint();
  if (flags & (1 << 1)) assert.equal(r.uint(), ID.boolTrue);
  r.uint(); // flags2
  r.int(); // id
  if (flags & (1 << 8)) readPeer(r);
  readPeer(r);
  r.int(); // date
  r.string(); // message
}

function readDialogFolder(r) {
  assert.equal(r.uint(), ID.dialogFolder); // dialogFolder#71bd134c
  const flags = r.uint();
  if (flags & (1 << 2)) assert.equal(r.uint(), ID.boolTrue);
  assert.equal(r.uint(), ID.folder); // folder#ff544e65
  r.uint(); // folder flags
  const folderId = r.int();
  r.string(); // folder title
  const peer = readPeer(r);
  r.int(); // top_message
  r.int(); r.int(); r.int(); r.int(); // unread counters
  return { folderId, peer };
}

test('layer-234 ids used by the handlers are present in schema/api.tl', () => {
  const schema = fs.readFileSync(path.join(process.cwd(), 'schema', 'api.tl'), 'utf8');
  const declarations = [
    'boolTrue#997275b5',
    'folder#ff544e65',
    'dialogFolder#71bd134c',
    'messages.peerDialogs#a749f3e5',
    'messages.dialogsSlice#d1747044',
    'updates.state#a56c2a3e',
    'updates#74ae4240',
    'updateFolderPeers#19360dc0',
    'folderPeer#e9baa668',
    'inputFolderPeer#fbd2c296',
    'inputDialogPeer#fcaafeb7',
    'inputChatlistDialogFilter#f3e0da33',
    'chatlists.chatlistUpdates#93bd878d',
    'messages.getPinnedDialogs#d6b94df2',
    'messages.toggleDialogPin#a731e257',
    'folders.editPeerFolders#6847d0ab',
    'chatlists.getChatlistUpdates#89419521',
  ];
  for (const decl of declarations) assert.ok(schema.includes(decl), `missing ${decl} in schema/api.tl`);
});

test('FolderStore CRUD, peers, pins and folder assignment (sqlite)', () => {
  const dir = tempDir();
  const fsStore = new FolderStore(dir);
  try {
    assert.equal(fsStore.driverKind, 'sqlite');
    const work = fsStore.createFolder(1, { title: 'Work', color: 7, emoticon: '💼' });
    assert.equal(work.id, 1);
    assert.equal(work.title, 'Work');
    assert.equal(work.color, 7);
    assert.equal(work.emoticon, '💼');
    const news = fsStore.createFolder(1, { title: 'News' });
    assert.equal(news.id, 2);
    assert.equal(fsStore.getFolder(news.id).title, 'News');
    assert.equal(fsStore.listFolders(1).length, 2);
    assert.equal(fsStore.updateFolder(news.id, { title: 'Updates' }).title, 'Updates');

    assert.equal(fsStore.addPeerToFolder(work.id, { type: 'user', id: 2 }), true);
    assert.deepEqual(fsStore.listFolderPeers(work.id), ['user:2']);
    assert.equal(fsStore.removePeerFromFolder(work.id, 'user:2'), true);
    assert.equal(fsStore.listFolderPeers(work.id).length, 0);

    assert.equal(fsStore.pinDialog(1, 'user:2', true).pinned, true);
    assert.equal(fsStore.pinDialog(1, { type: 'chat', id: -1000001 }, true).pinned, true);
    assert.deepEqual(fsStore.listPinned(1), ['user:2', 'chat:-1000001']);
    assert.equal(fsStore.unpinAll(1), 2);
    assert.equal(fsStore.listPinned(1).length, 0);

    assert.equal(fsStore.markDialogFolder(1, 'user:2', work.id).folderId, work.id);
    assert.equal(fsStore.getDialogFolder(1, 'user:2'), work.id);
    assert.equal(fsStore.deleteFolder(work.id), true);
    assert.equal(fsStore.getFolder(work.id), null);
    assert.equal(fsStore.getDialogFolder(1, 'user:2'), 0, 'deleting a folder resets dialog assignment');
    assert.ok(fs.existsSync(path.join(dir, 'folders.sqlite')));
  } finally {
    fsStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FolderStore JSON fallback persists data', () => {
  const dir = tempDir();
  const fsStore = new FolderStore({ dataDir: dir, dbDriver: 'json' });
  try {
    assert.equal(fsStore.driverKind, 'json');
    fsStore.createFolder(3, { title: 'JSON' });
    assert.ok(fs.existsSync(path.join(dir, 'folders.json')));
    fsStore.pinDialog(3, 'user:9', true);
    fsStore.close();

    const reopened = new FolderStore({ dataDir: dir, dbDriver: 'json' });
    try {
      assert.equal(reopened.getFolder(1).title, 'JSON');
      assert.deepEqual(reopened.listPinned(3), ['user:9']);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getPinnedDialogs -> messages.peerDialogs#a749f3e5 with dialogFolder#71bd134c', () => {
  const dir = tempDir();
  const store = new Store(dir);
  const fsStore = new FolderStore(dir);
  try {
    const me = store.createUser({ phone: '1000', firstName: 'Me' });
    const folder = fsStore.createFolder(me.id, { title: 'Work' });
    store.createDialog(me.id, { type: 'user', id: 2 }, 'user');
    store.putMessage({ fromId: me.id, peerType: 'user', peerId: 2, text: 'hi' });
    fsStore.pinDialog(me.id, 'user:2', true);
    fsStore.markDialogFolder(me.id, 'user:2', folder.id);
    const ctx = { store, folderStore: fsStore, userId: me.id };

    const buf = folders.getPinnedDialogs({ folderId: folder.id }, ctx);
    const r = new TLBuffer(buf);
    assert.equal(r.uint(), ID.peerDialogs); // messages.peerDialogs#a749f3e5
    assert.equal(r.uint(), 0); // flags (topics absent)
    const dialogs = r.vector((rr) => readDialogFolder(rr));
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].folderId, folder.id);
    assert.equal(dialogs[0].peer.id, 2);
    assert.equal(vectorCount(r), 1); // messages
    readMessage(r);
    assert.equal(vectorCount(r), 0); // chats
    assert.ok(vectorCount(r) >= 1); // users
    readUser(r);
    assert.equal(r.uint(), ID.state); // updates.state#a56c2a3e
    for (let i = 0; i < 5; i++) r.int();
    assert.equal(r.offset, buf.length);

    // folder_id = 0 yields plain dialog#fc89f7f3 entries.
    const allBuf = folders.getPinnedDialogs({ folderId: 0 }, ctx);
    const ar = new TLBuffer(allBuf);
    assert.equal(ar.uint(), ID.peerDialogs);
    ar.uint();
    assert.equal(ar.vector((rr) => rr.uint())[0], ID.dialog);
  } finally {
    fsStore.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('toggleDialogPin and unpinAllDialogs return boolTrue#997275b5', () => {
  const dir = tempDir();
  const store = new Store(dir);
  const fsStore = new FolderStore(dir);
  try {
    const me = store.createUser({ phone: '1001', firstName: 'Pin' });
    const ctx = { store, folderStore: fsStore, userId: me.id };

    const buf = folders.toggleDialogPin({ pinned: true, peer: { type: 'user', id: 2 } }, ctx);
    assert.equal(new TLBuffer(buf).uint(), ID.boolTrue);
    assert.deepEqual(fsStore.listPinned(me.id), ['user:2']);

    // Reader form: flags | pinned:true | inputDialogPeer | inputPeerUser.
    const w = new TLBuffer()
      .putInt(1)
      .putUint(ID.boolTrue)
      .putUint(ID.inputDialogPeer)
      .putUint(ID.inputPeerUser)
      .putLong(3n)
      .putLong(0n);
    const r = new TLBuffer(w.buffer);
    const readerBuf = folders.toggleDialogPin(r, ctx);
    assert.equal(new TLBuffer(readerBuf).uint(), ID.boolTrue);
    assert.ok(fsStore.listPinned(me.id).includes('user:3'));

    const allBuf = folders.unpinAllDialogs({}, ctx);
    assert.equal(new TLBuffer(allBuf).uint(), ID.boolTrue);
    assert.equal(fsStore.listPinned(me.id).length, 0);
  } finally {
    fsStore.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('editPeerFolders -> updates#74ae4240 -> updateFolderPeers#19360dc0 -> folderPeer#e9baa668', () => {
  const dir = tempDir();
  const store = new Store(dir);
  const fsStore = new FolderStore(dir);
  try {
    const me = store.createUser({ phone: '1002', firstName: 'Edit' });
    const folder = fsStore.createFolder(me.id, { title: 'Work' });
    const ctx = { store, folderStore: fsStore, userId: me.id };

    const buf = folders.editPeerFolders({
      folder_peers: [{ peer: { type: 'user', id: 2 }, folder_id: folder.id }],
    }, ctx);
    const r = new TLBuffer(buf);
    assert.equal(r.uint(), ID.updates); // updates#74ae4240
    assert.equal(vectorCount(r), 1);
    assert.equal(r.uint(), ID.updateFolderPeers); // updateFolderPeers#19360dc0
    assert.equal(vectorCount(r), 1);
    assert.equal(r.uint(), ID.folderPeer); // folderPeer#e9baa668
    assert.equal(readPeer(r).id, 2);
    assert.equal(r.int(), folder.id);
    assert.ok(r.int() > 0); // pts
    assert.ok(r.int() > 0); // pts_count
    assert.equal(vectorCount(r), 0); // users
    assert.equal(vectorCount(r), 0); // chats
    r.int(); r.int(); // date, seq
    assert.equal(r.offset, buf.length);

    assert.equal(fsStore.getDialogFolder(me.id, 'user:2'), folder.id);
    assert.deepEqual(fsStore.listFolderPeers(folder.id), ['user:2']);

    // Reader form consumes a Vector<InputFolderPeer> after the constructor id.
    const w = new TLBuffer();
    w.putUint(ID.vector).putInt(1)
      .putUint(ID.inputFolderPeer)
      .putUint(ID.inputPeerUser)
      .putLong(4n).putLong(0n)
      .putInt(folder.id);
    const rr = new TLBuffer(w.buffer);
    const readerBuf = folders.editPeerFolders(rr, ctx);
    assert.equal(new TLBuffer(readerBuf).uint(), ID.updates);
    assert.deepEqual(fsStore.listFolderPeers(folder.id), ['user:2', 'user:4']);
  } finally {
    fsStore.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getChatlistUpdates -> chatlists.chatlistUpdates#93bd878d and getChatlist -> dialogsSlice', () => {
  const dir = tempDir();
  const store = new Store(dir);
  const fsStore = new FolderStore(dir);
  try {
    const me = store.createUser({ phone: '1003', firstName: 'List' });
    const folder = fsStore.createFolder(me.id, { title: 'Chatlist' });
    store.createDialog(me.id, { type: 'user', id: 5 }, 'user');
    fsStore.addPeerToFolder(folder.id, 'user:5'); // pending: dialog not yet in the folder
    const ctx = { store, folderStore: fsStore, userId: me.id };

    const buf = folders.getChatlistUpdates({ filterId: folder.id }, ctx);
    const r = new TLBuffer(buf);
    assert.equal(r.uint(), ID.chatlistUpdates); // chatlists.chatlistUpdates#93bd878d
    assert.equal(vectorCount(r), 1);
    assert.equal(readPeer(r).id, 5);
    assert.equal(vectorCount(r), 0); // chats
    assert.equal(vectorCount(r), 0); // users
    assert.equal(r.offset, buf.length);

    fsStore.markDialogFolder(me.id, 'user:5', folder.id);
    const emptyUpdates = new TLBuffer(folders.getChatlistUpdates({ filterId: folder.id }, ctx));
    assert.equal(emptyUpdates.uint(), ID.chatlistUpdates);
    assert.equal(vectorCount(emptyUpdates), 0);

    const w = new TLBuffer().putUint(ID.inputChatlistDialogFilter).putInt(folder.id);
    const listBuf = folders.getChatlist(new TLBuffer(w.buffer), ctx);
    const lr = new TLBuffer(listBuf);
    assert.equal(lr.uint(), ID.dialogsSlice); // messages.dialogsSlice#d1747044
    lr.uint(); // flags
    assert.equal(lr.int(), 1); // count
    assert.equal(vectorCount(lr), 0); // topics
    assert.equal(vectorCount(lr), 1); // dialogs
    assert.equal(lr.uint(), ID.dialog); // dialog#fc89f7f3
    assert.equal(lr.uint(), 1 << 4, 'folder_id flag is bit 4');
    readPeer(lr);
    for (let i = 0; i < 9; i++) lr.int(); // top_message, read ids, unread counters, notify_settings
    assert.equal(lr.int(), folder.id); // folder_id
  } finally {
    fsStore.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
