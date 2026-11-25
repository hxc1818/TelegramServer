// Unit tests for StoryStore and the stories / device-push handlers.
// Constructor ids are written out explicitly (from schema/api.tl, layer 234)
// so the tests catch accidental wire-format changes.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TLBuffer } from '../src/tl/buffer.js';
import { Store } from '../src/store/store.js';
import { StoryStore } from '../src/store/stories.js';
import * as stories from '../src/rpc/handlers/stories.js';

const ID = {
  boolTrue: 0x997275b5,
  boolFalse: 0xbc799737,
  vector: 0x1cb5c415,
  user: 0xb1b8cc83,
  peerUser: 0x59511722,
  updates: 0x74ae4240,
  messageMediaEmpty: 0x3ded6320,
  peerNotifySettings: 0x99622c0c,
  storyViews: 0x8d595cd6,
  storyItem: 0x16a4b93c,
  storiesStories: 0x63c3dd0a,
  storyView: 0xb0bdeac5,
  storiesStoryViewsList: 0x59d78fc5,
  storiesStoryViews: 0xde9eed1d,
  peerStories: 0x9a35e999,
  storiesPeerStories: 0xcae68768,
};

const USER_BOOL_BITS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 23, 24, 25, 26, 27, 28, 29];

function tempDir() {
  const dir = path.join(os.tmpdir(), `telegramserver-stories-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeContext(dir) {
  const store = new Store(dir);
  const storyStore = new StoryStore(dir);
  const user = store.createUser({ phone: '+15551110000', firstName: 'Story', lastName: 'Owner' });
  return { ctx: { store, storyStore, userId: user.id }, store, storyStore, user };
}

function readPeer(r) {
  const ctor = r.uint();
  assert.equal(ctor, ID.peerUser);
  return { id: Number(r.long()) };
}

function readUser(r) {
  assert.equal(r.uint(), ID.user);
  const flags = r.uint();
  for (const bit of USER_BOOL_BITS) if (flags & (1 << bit)) assert.equal(r.uint(), ID.boolTrue);
  r.uint(); // flags2
  const id = Number(r.long());
  if (flags & 1) r.long(); // access_hash
  if (flags & 2) r.string(); // first_name
  if (flags & 4) r.string(); // last_name
  if (flags & 8) r.string(); // username
  if (flags & 0x10) r.string(); // phone
  return { id };
}

function readUpdates(buf) {
  const r = new TLBuffer(buf);
  assert.equal(r.uint(), ID.updates);
  r.vector(() => {}); // updates (empty)
  const users = r.vector((rr) => readUser(rr));
  r.vector(() => {}); // chats
  r.int(); // date
  r.int(); // seq
  assert.equal(r.offset, r.length);
  return users;
}

function readStoryItem(r) {
  assert.equal(r.uint(), ID.storyItem);
  const flags = r.uint();
  const id = r.int();
  const date = r.int();
  const from = flags & (1 << 18) ? readPeer(r) : null;
  const expires = r.int();
  const caption = flags & 1 ? r.string() : '';
  assert.equal(r.uint(), ID.messageMediaEmpty);
  if (flags & 8) {
    assert.equal(r.uint(), ID.storyViews);
    r.uint(); // flags
    r.int(); // views_count
  }
  return { id, date, from, expires, caption };
}

function readStoriesResult(buf) {
  const r = new TLBuffer(buf);
  assert.equal(r.uint(), ID.storiesStories);
  assert.equal(r.uint(), 0); // flags
  const count = r.int();
  const items = r.vector((rr) => readStoryItem(rr));
  r.vector(() => {}); // pinned_to_top
  r.vector(() => {}); // chats
  const users = r.vector((rr) => readUser(rr));
  assert.equal(r.offset, r.length);
  return { count, items, users };
}

function readPeerStoriesResult(buf) {
  const r = new TLBuffer(buf);
  assert.equal(r.uint(), ID.storiesPeerStories);
  assert.equal(r.uint(), ID.peerStories);
  assert.equal(r.uint(), 0); // flags (no max_read_id)
  const peer = readPeer(r);
  const items = r.vector((rr) => readStoryItem(rr));
  r.vector(() => {}); // chats
  r.vector((rr) => readUser(rr)); // users
  assert.equal(r.offset, r.length);
  return { peer, items };
}

function readIntVector(buf) {
  const r = new TLBuffer(buf);
  assert.equal(r.uint(), ID.vector);
  const count = r.int();
  const values = [];
  for (let i = 0; i < count; i++) values.push(r.int());
  assert.equal(r.offset, r.length);
  return values;
}

function readerAfterId(...fields) {
  const b = new TLBuffer();
  for (const [kind, value] of fields) {
    if (kind === 'uint') b.putUint(value);
    else if (kind === 'int') b.putInt(value);
    else if (kind === 'long') b.putLong(BigInt(value));
    else if (kind === 'string') b.putString(value);
  }
  return new TLBuffer(b.buffer);
}

// ---- store ---------------------------------------------------------------
test('StoryStore (sqlite) supports story CRUD, views, devices and push settings', () => {
  const dir = tempDir();
  const store = new StoryStore(dir);
  try {
    assert.equal(store.driverKind, 'sqlite');
    assert.ok(fs.existsSync(path.join(dir, 'stories.sqlite')));
    assert.equal(store.getStory(1), null);

    const media = { type: 'photo', fileId: 42 };
    const future = Math.floor(Date.now() / 1000) + 3600;
    const created = store.createStory({
      id: 11, ownerId: 1, media, text: 'hello stories', date: 1700000000, expires: future,
    });
    assert.equal(created.id, 11);
    assert.equal(created.ownerId, 1);
    assert.deepEqual(created.media, media);
    assert.equal(created.text, 'hello stories');
    assert.equal(created.date, 1700000000);
    assert.equal(created.expires, future);

    const loaded = store.getStory(11);
    assert.deepEqual(loaded, created);
    assert.equal(store.listStories(1).length, 1);
    assert.equal(store.listStories(2).length, 0);

    const other = store.createStory({ ownerId: 2, text: 'second', expires: 0 });
    assert.equal(other.id, 12);
    assert.equal(store.listFeed(1).length, 2); // own stories are included
    assert.equal(store.listFeed(1, { includeOwn: false }).length, 1);
    assert.equal(store.listFeed(1, { limit: 1 }).length, 1);
    const expired = store.createStory({ ownerId: 3, expires: 1, date: 1 });
    assert.equal(store.listFeed(0).some((s) => s.id === expired.id), false);
    assert.equal(store.listFeed(0, { includeExpired: true }).some((s) => s.id === expired.id), true);

    assert.equal(store.viewStory(999, 7), null); // unknown story
    const view = store.viewStory(11, 7);
    assert.equal(view.storyId, 11);
    assert.equal(view.userId, 7);
    assert.ok(view.date > 0);
    store.viewStory(11, 7); // idempotent
    store.viewStory(11, 8);
    assert.equal(store.listViews(11).length, 2);
    assert.deepEqual(store.listViews(11).map((v) => v.userId).sort(), [7, 8]);

    const device = store.addDevice({ userId: 1, token: 'apns-token', type: 2 });
    assert.deepEqual(device, { token: 'apns-token', userId: 1, type: 2 });
    store.addDevice({ userId: 2, token: 'fcm-token', type: 'fcm' });
    assert.equal(store.listDevices(1).length, 1);
    assert.equal(store.listDevices(2)[0].type, 'fcm');
    assert.equal(store.removeDevice('apns-token'), true);
    assert.equal(store.removeDevice('apns-token'), false);
    assert.equal(store.listDevices(1).length, 0);

    assert.equal(store.getPushSettings('user:1'), null);
    store.setPushSettings('user:1', { silent: true, muteUntil: 99 });
    assert.deepEqual(store.getPushSettings('user:1'), { silent: true, muteUntil: 99 });
    store.setPushSettings('user:1', { showPreviews: false });
    assert.deepEqual(store.getPushSettings('user:1'), { showPreviews: false });

    assert.equal(store.deleteStory(11), true);
    assert.equal(store.deleteStory(11), false);
    assert.equal(store.getStory(11), null);
    assert.equal(store.listViews(11).length, 0); // cascade
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StoryStore JSON fallback persists the same data', () => {
  const dir = tempDir();
  const store = new StoryStore(dir, { dbDriver: 'json' });
  try {
    assert.equal(store.driverKind, 'json');
    assert.ok(fs.existsSync(path.join(dir, 'stories.json')));
    store.createStory({ id: 31, ownerId: 4, text: 'json story', media: Buffer.from('abc') });
    store.addDevice({ userId: 4, token: 'json-token', type: 1 });
    store.setPushSettings('chats', { silent: false });
    store.close();

    const reopened = new StoryStore(dir, { dbDriver: 'json' });
    try {
      assert.equal(reopened.getStory(31).text, 'json story');
      assert.deepEqual(reopened.getStory(31).media, Buffer.from('abc'));
      assert.equal(reopened.listDevices(4)[0].token, 'json-token');
      assert.deepEqual(reopened.getPushSettings('chats'), { silent: false });
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- ids -----------------------------------------------------------------
test('exported method ids match schema/api.tl (layer 234)', () => {
  const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema', 'api.tl'), 'utf8');
  for (const [name, id] of Object.entries(stories.METHOD_IDS)) {
    assert.match(name, /^(stories|account)\./);
    assert.match(schema, new RegExp(`#${(id >>> 0).toString(16)}\\b`, 'i'), `missing id for ${name}`);
  }
  for (const id of Object.values(stories.LEGACY_METHOD_IDS)) {
    assert.match(schema, new RegExp(`#${(id >>> 0).toString(16)}\\b`, 'i'));
  }

  assert.equal(stories.METHOD_IDS['stories.sendStory'], 0x8f9e6898);
  assert.equal(stories.METHOD_IDS['stories.getStoriesByID'], 0x5774ca74);
  assert.equal(stories.METHOD_IDS['stories.getPeerStories'], 0x2c4ada50);
  assert.equal(stories.METHOD_IDS['stories.readStories'], 0xa556dac8);
  assert.equal(stories.METHOD_IDS['stories.deleteStories'], 0xae59db5f);
  assert.equal(stories.METHOD_IDS['stories.getStoryViewsList'], 0x7ed23c57);
  assert.equal(stories.METHOD_IDS['stories.getStoriesViews'], 0x28e16cc8);
  assert.equal(stories.METHOD_IDS['account.registerDevice'], 0xec86017a);
  assert.equal(stories.METHOD_IDS['account.unregisterDevice'], 0x6a0d3206);

  // No method id exists for these legacy names in the pinned layer.
  for (const name of ['stories.getStories', 'stories.deleteStory',
    'account.getPushSettings', 'account.updatePushSettings',
    'account.getContactSignupNotification', 'account.setContactSignupNotification']) {
    assert.equal(Object.hasOwn(stories.METHOD_IDS, name), false);
    assert.equal(typeof stories.default[name], 'function');
  }
});

// ---- handlers ------------------------------------------------------------
test('stories.sendStory returns updates#74ae4240 and persists the story', () => {
  const dir = tempDir();
  const { ctx, storyStore, user } = makeContext(dir);
  try {
    const buf = stories.sendStory({
      peer: { type: 'self' }, media: null, caption: 'my first story', randomId: 101n, expires: 0,
    }, ctx);
    assert.equal(new TLBuffer(buf).uint(), ID.updates);
    assert.deepEqual(readUpdates(buf).map((u) => u.id), [user.id]);
    const story = storyStore.getStory(101);
    assert.equal(story.text, 'my first story');
    assert.equal(story.ownerId, user.id);
  } finally {
    storyStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stories.getStories / getStoriesByID return stories.stories#63c3dd0a', () => {
  const dir = tempDir();
  const { ctx, storyStore, user } = makeContext(dir);
  try {
    storyStore.createStory({ id: 201, ownerId: user.id, text: 'one', date: 100, expires: 0 });
    storyStore.createStory({ id: 202, ownerId: user.id, text: 'two', date: 200, expires: 0 });

    const result = stories.getStories({ peer: { type: 'self' }, id: [201, 202] }, ctx);
    const parsed = readStoriesResult(result);
    assert.equal(parsed.count, 2);
    assert.deepEqual(parsed.items.map((s) => s.id), [201, 202]);
    assert.equal(parsed.items[0].caption, 'one');
    assert.equal(parsed.items[0].from.id, user.id);

    const byId = stories.getStoriesByID({ peer: { type: 'self' }, id: [202] }, ctx);
    assert.deepEqual(readStoriesResult(byId).items.map((s) => s.id), [202]);
  } finally {
    storyStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stories.getPeerStories returns stories.peerStories#cae68768 and readStories returns Vector<int>', () => {
  const dir = tempDir();
  const { ctx, storyStore, user } = makeContext(dir);
  try {
    storyStore.createStory({ id: 301, ownerId: user.id, text: 'peer story', date: 300, expires: 0 });
    const peerStories = stories.getPeerStories({ peer: { type: 'self' } }, ctx);
    const parsed = readPeerStoriesResult(peerStories);
    assert.equal(parsed.peer.id, user.id);
    assert.deepEqual(parsed.items.map((s) => s.id), [301]);

    const read = stories.readStories({ peer: { type: 'self' }, maxId: 301 }, ctx);
    assert.deepEqual(readIntVector(read), [301]);
    assert.equal(storyStore.listViews(301).length, 1);
    assert.equal(new TLBuffer(stories.readStoriesUpdates({ peer: { type: 'self' } }, ctx)).uint(), ID.updates);
  } finally {
    storyStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteStory / deleteStories and story views handlers use verified constructors', () => {
  const dir = tempDir();
  const { ctx, storyStore, user } = makeContext(dir);
  try {
    ctx.store.createUser({ phone: '+15550000002', firstName: 'Viewer' });
    storyStore.createStory({ id: 401, ownerId: user.id, text: 'viewed', date: 400, expires: 0 });
    storyStore.viewStory(401, 2);

    const list = stories.getStoryViewsList({ peer: { type: 'self' }, id: 401, offset: '', limit: 10 }, ctx);
    const lr = new TLBuffer(list);
    assert.equal(lr.uint(), ID.storiesStoryViewsList);
    assert.equal(lr.uint(), 0); // flags
    assert.equal(lr.int(), 1); // count
    assert.equal(lr.int(), 1); // views_count
    assert.equal(lr.int(), 0); // forwards_count
    assert.equal(lr.int(), 0); // reactions_count
    const views = lr.vector((rr) => {
      assert.equal(rr.uint(), ID.storyView);
      assert.equal(rr.uint(), 0);
      return { userId: Number(rr.long()), date: rr.int() };
    });
    assert.equal(views[0].userId, 2);

    const summed = stories.getStoriesViews({ peer: { type: 'self' }, id: [401] }, ctx);
    const sr = new TLBuffer(summed);
    assert.equal(sr.uint(), ID.storiesStoryViews);
    const counts = sr.vector((rr) => {
      assert.equal(rr.uint(), ID.storyViews);
      rr.uint();
      return rr.int();
    });
    assert.deepEqual(counts, [1]);
    assert.equal(new TLBuffer(stories.getStoriesViewsUpdates({ peer: { type: 'self' }, id: [401] }, ctx)).uint(), ID.updates);

    assert.equal(new TLBuffer(stories.incrementStoryViews({ peer: { type: 'self' }, id: [401] }, ctx)).uint(), ID.boolTrue);
    assert.equal(storyStore.listViews(401).length, 2);

    assert.equal(new TLBuffer(stories.deleteStory({ peer: { type: 'self' }, id: 401 }, ctx)).uint(), ID.updates);
    storyStore.createStory({ id: 402, ownerId: user.id, text: 'bulk', expires: 0 });
    assert.deepEqual(readIntVector(stories.deleteStories({ peer: { type: 'self' }, id: [402] }, ctx)), [402]);
    assert.equal(storyStore.getStory(401), null);
    assert.equal(storyStore.getStory(402), null);
    assert.equal(new TLBuffer(stories.deleteStoryBool({ id: 999 }, ctx)).uint(), ID.boolFalse);
  } finally {
    storyStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('device registration handlers persist tokens and return boolTrue (no APNs/FCM delivery)', () => {
  const dir = tempDir();
  const { ctx, storyStore, user } = makeContext(dir);
  try {
    assert.equal(new TLBuffer(stories.registerDevice({ token: 'device-1', type: 3 }, ctx)).uint(), ID.boolTrue);
    assert.equal(storyStore.listDevices(user.id).length, 1);
    assert.equal(storyStore.listDevices(user.id)[0].token, 'device-1');
    assert.equal(new TLBuffer(stories.unregisterDevice({ token: 'device-1' }, ctx)).uint(), ID.boolTrue);
    assert.equal(storyStore.listDevices(user.id).length, 0);
  } finally {
    storyStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('push settings and contact-signup handlers use peerNotifySettings / bool', () => {
  const dir = tempDir();
  const { ctx, storyStore } = makeContext(dir);
  try {
    assert.equal(new TLBuffer(stories.updatePushSettings({
      peerKey: 'user:1', settings: { showPreviews: false, silent: true, muteUntil: 12345 },
    }, ctx)).uint(), ID.boolTrue);
    const buf = stories.getPushSettings({ peerKey: 'user:1' }, ctx);
    const r = new TLBuffer(buf);
    assert.equal(r.uint(), ID.peerNotifySettings);
    assert.equal(r.uint(), 0x1 | 0x2 | 0x4);
    assert.equal(r.bool(), false);
    assert.equal(r.bool(), true);
    assert.equal(r.int(), 12345);
    assert.equal(r.offset, r.length);
    assert.deepEqual(storyStore.getPushSettings('user:1'), { showPreviews: false, silent: true, muteUntil: 12345 });

    assert.equal(new TLBuffer(stories.getContactSignupNotification({}, ctx)).uint(), ID.boolTrue);
    assert.equal(new TLBuffer(stories.setContactSignupNotification({ silent: true }, ctx)).uint(), ID.boolTrue);
    assert.equal(new TLBuffer(stories.getContactSignupNotification({}, ctx)).uint(), ID.boolFalse);
  } finally {
    storyStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handlers accept TLBuffer readers positioned after the method id', () => {
  const dir = tempDir();
  const { ctx, storyStore, user } = makeContext(dir);
  try {
    storyStore.createStory({ id: 501, ownerId: user.id, text: 'wire', date: 500, expires: 0 });

    const selfPeer = () => ['uint', 0x7da07ec9]; // inputPeerSelf
    const peerStories = stories.getPeerStories(readerAfterId(selfPeer()), ctx);
    assert.deepEqual(readPeerStoriesResult(peerStories).items.map((s) => s.id), [501]);

    assert.deepEqual(readIntVector(stories.readStories(readerAfterId(selfPeer(), ['int', 501]), ctx)), [501]);

    const deviceReader = readerAfterId(
      ['uint', 0], ['int', 7], ['string', 'wire-token'], ['uint', ID.boolFalse],
      ['string', ''], ['uint', ID.vector], ['int', 0],
    );
    assert.equal(new TLBuffer(stories.registerDevice(deviceReader, ctx)).uint(), ID.boolTrue);
    assert.equal(storyStore.listDevices(user.id)[0].token, 'wire-token');

    const viewsReader = readerAfterId(selfPeer(), ['uint', ID.vector], ['int', 1], ['int', 501]);
    assert.equal(new TLBuffer(stories.incrementStoryViews(viewsReader, ctx)).uint(), ID.boolTrue);
  } finally {
    storyStore.close();
    ctx.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
