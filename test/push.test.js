// Unit tests for the push store, webhook dispatcher and provider adapters.
// All HTTP is stubbed: no real network calls are made.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PushStore } from '../src/store/push.js';
import { PushDispatcher, createAPNsAdapter, createFCMAdapter } from '../src/push/dispatcher.js';

function tempDir() {
  const dir = path.join(os.tmpdir(), `telegramserver-push-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fetchStub(statuses) {
  const queue = [...statuses];
  const calls = [];
  const fetchImpl = async (url, init) => {
    const status = queue.length ? queue.shift() : 200;
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { status, ok: status >= 200 && status < 300 };
  };
  return { fetchImpl, calls };
}

test('PushStore (sqlite) devices, settings and notification queue', () => {
  const dir = tempDir();
  const store = new PushStore(dir);
  try {
    assert.equal(store.driverKind, 'sqlite');
    assert.ok(fs.existsSync(path.join(dir, 'push.sqlite')));
    assert.deepEqual(store.listDevices(1), []);
    assert.equal(store.getPushSettings('user:1'), null);

    const d1 = store.registerDevice({ userId: 1, token: 'tok1', type: 'apns', appId: 'app.ios' });
    assert.deepEqual(d1, { token: 'tok1', userId: 1, type: 'apns', appId: 'app.ios', createdAt: d1.createdAt });
    store.registerDevice({ userId: 2, token: 'tok2', type: 'fcm', appId: 'app.android' });
    store.registerDevice({ userId: 1, token: 'tok3', type: 3, appId: 'app.ios' });

    assert.deepEqual(store.listDevices(1).map((d) => d.token), ['tok1', 'tok3']);
    assert.equal(store.listDevices(1)[1].type, 3); // numeric token types survive round-trip
    assert.equal(store.getDevicesForUsers([2, 1]).length, 3);
    assert.deepEqual(store.getDevicesForUsers([2]).map((d) => d.token), ['tok2']);
    assert.deepEqual(store.listDeviceUserIds(), [1, 2]);

    assert.equal(store.unregisterDevice('tok3'), true);
    assert.equal(store.unregisterDevice('tok3'), false);
    assert.deepEqual(store.listDevices(1).map((d) => d.token), ['tok1']);

    const settings = store.setPushSettings('user:1', { silent: true, includeText: false });
    assert.equal(settings.silent, true);
    assert.equal(settings.includeText, false);
    assert.equal(settings.showPreviews, true);
    assert.deepEqual(store.getPushSettings('user:1'), settings);
    store.setPushSettings('user:1', { showPreviews: false });
    assert.equal(store.getPushSettings('user:1').includeText, false); // partial update preserved
    assert.equal(store.getPushSettings('user:1').showPreviews, false);

    const n1 = store.enqueueNotification({ userId: 1, peerKey: 'user:2', text: 'hello', date: 1000 });
    const n2 = store.enqueueNotification({ userId: 2, peerKey: 'user:1', text: 'world', date: 1001 });
    assert.ok(n1.id < n2.id);
    assert.equal(n1.delivered, false);
    assert.deepEqual(store.listPending(1).map((n) => n.id), [n1.id]);
    assert.deepEqual(store.listUndelivered().map((n) => n.id), [n1.id, n2.id]);
    assert.deepEqual(store.listUndelivered(1).map((n) => n.id), [n1.id]);

    assert.equal(store.markDelivered(n1.id), true);
    assert.equal(store.markDelivered(n1.id), true);
    assert.deepEqual(store.listPending(1), []);
    assert.deepEqual(store.listPending(1, { includeDelivered: true }).map((n) => n.delivered), [true]);
    assert.deepEqual(store.listUndelivered().map((n) => n.id), [n2.id]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PushStore JSON fallback persists across reopen', () => {
  const dir = tempDir();
  let store = new PushStore(dir, { dbDriver: 'json' });
  try {
    assert.equal(store.driverKind, 'json');
    assert.ok(fs.existsSync(path.join(dir, 'push.json')));
    store.registerDevice({ userId: 7, token: 'j1', type: 'fcm', appId: 'app' });
    store.setPushSettings('chats', { silent: true });
    store.enqueueNotification({ userId: 7, peerKey: 'chats', text: 'x', date: 9 });
    store.close();

    store = new PushStore(dir, { dbDriver: 'json' });
    assert.deepEqual(store.listDevices(7).map((d) => d.token), ['j1']);
    assert.equal(store.getPushSettings('chats').silent, true);
    assert.equal(store.listUndelivered()[0].text, 'x');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatch signs payload with HMAC-SHA256 and succeeds on 200', async () => {
  const dir = tempDir();
  const store = new PushStore(dir);
  const sleeps = [];
  const { fetchImpl, calls } = fetchStub([200]);
  const dispatcher = new PushDispatcher({
    store,
    endpoint: 'https://example.test/push',
    hmacSecret: 'top-secret',
    fetchImpl,
    sleep: async (ms) => sleeps.push(ms),
  });
  try {
    store.registerDevice({ userId: 1, token: 'tok1', type: 'apns', appId: 'app.ios' });
    store.registerDevice({ userId: 1, token: 'tok2', type: 'fcm', appId: 'app.android' });

    const result = await dispatcher.dispatch(1, { peerKey: 'user:2', text: 'hi', date: 1234 });
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.attempts, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.test/push');

    const body = calls[0].body;
    assert.deepEqual(Object.keys(body).sort(), ['date', 'devices', 'hmac', 'peer_key', 'text', 'user_id']);
    assert.equal(body.user_id, 1);
    assert.equal(body.peer_key, 'user:2');
    assert.equal(body.text, 'hi');
    assert.equal(body.date, 1234);
    assert.deepEqual(body.devices, [
      { token: 'tok1', type: 'apns', app_id: 'app.ios' },
      { token: 'tok2', type: 'fcm', app_id: 'app.android' },
    ]);
    const { hmac, ...unsigned } = body;
    const expected = crypto.createHmac('sha256', 'top-secret').update(JSON.stringify(unsigned)).digest('hex');
    assert.equal(hmac, expected);
    assert.equal(calls[0].init.headers['x-hub-signature-256'], `sha256=${expected}`);
    assert.equal(calls[0].init.method, 'POST');
  } finally {
    dispatcher.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatch retries 5xx with exponential backoff, and fails after 3 attempts', async () => {
  const sleeps = [];
  const make = (statuses) => {
    const { fetchImpl, calls } = fetchStub(statuses);
    return {
      calls,
      dispatcher: new PushDispatcher({
        endpoint: 'https://example.test/push',
        hmacSecret: 's',
        fetchImpl,
        sleep: async (ms) => sleeps.push(ms),
      }),
    };
  };

  const recover = make([500, 503, 200]);
  try {
    const result = await recover.dispatcher.dispatch(1, { peerKey: 'user:2', text: 'retry', date: 5 });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3);
    assert.equal(recover.calls.length, 3);
    assert.deepEqual(sleeps, [100, 200]);
    // Every attempt carries the same HMAC.
    assert.equal(recover.calls[0].body.hmac, recover.calls[2].body.hmac);
  } finally {
    recover.dispatcher.close();
  }

  const giveUp = make([500, 500, 500]);
  try {
    const result = await giveUp.dispatcher.dispatch(1, { text: 'nope' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
    assert.equal(result.attempts, 3);
    assert.match(result.error, /500/);
    assert.equal(giveUp.calls.length, 3);
    assert.deepEqual(sleeps, [100, 200, 100, 200]);
  } finally {
    giveUp.dispatcher.close();
  }
});

test('onNewMessage selects recipient devices and flushPending drains only 2xx', async () => {
  const dir = tempDir();
  const store = new PushStore(dir);
  const sleeps = [];
  // First message: 200. Then queued n1 exhausts 3 failures; n2 succeeds.
  const { fetchImpl, calls } = fetchStub([200, 500, 500, 500, 200]);
  const dispatcher = new PushDispatcher({
    store,
    endpoint: 'https://example.test/push',
    hmacSecret: 'k',
    fetchImpl,
    sleep: async (ms) => sleeps.push(ms),
  });
  try {
    store.registerDevice({ userId: 1, token: 'sender', type: 'fcm', appId: 'app' });
    store.registerDevice({ userId: 2, token: 'dev2', type: 'apns', appId: 'app' });
    store.registerDevice({ userId: 3, token: 'dev3', type: 'fcm', appId: 'app' });

    const results = await dispatcher.onNewMessage({ fromId: 1, peerKey: 'user:2', text: 'hello', date: 111 });
    assert.equal(results.length, 1);
    assert.equal(results[0].userId, 2);
    assert.equal(results[0].ok, true);
    assert.deepEqual(results[0].payload.devices.map((d) => d.token), ['dev2']);
    assert.equal(store.listPending(2).length, 0); // successful delivery marked delivered

    const n1 = store.enqueueNotification({ userId: 2, peerKey: 'user:2', text: 'a', date: 1 });
    const n2 = store.enqueueNotification({ userId: 3, peerKey: 'user:3', text: 'b', date: 2 });
    const stats = await dispatcher.flushPending();
    assert.deepEqual(stats, { total: 2, delivered: 1, failed: 1 });
    assert.deepEqual(store.listUndelivered().map((n) => n.id), [n1.id]);
    assert.equal(store.listPending(3).length, 0);
    assert.equal(calls[1].body.text, 'a');
    assert.equal(calls[4].body.text, 'b');
    assert.deepEqual(calls[4].body.devices.map((d) => d.token), ['dev3']);
  } finally {
    dispatcher.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('APNs and FCM adapters format provider payloads and gate on credentials', async () => {
  const apns = createAPNsAdapter({ teamId: 'TEAM', keyId: 'KEY', privateKey: 'P8', topic: 'com.example.app' });
  assert.equal(apns.configured, true);
  const apnsBody = apns.format({ text: 'ping', devices: [{ token: 'apns-token' }] });
  assert.ok(apnsBody.aps);
  assert.equal(apnsBody.aps.alert.body, 'ping');
  assert.equal(apnsBody.aps.sound, 'default');
  assert.deepEqual(apnsBody.device_tokens, ['apns-token']);

  const fcm = createFCMAdapter({ serverKey: 'server-key' });
  assert.equal(fcm.configured, true);
  const fcmBody = fcm.format({ text: 'ping', devices: [{ token: 'a' }, { token: 'b' }] });
  assert.ok(fcmBody.notification);
  assert.equal(fcmBody.notification.body, 'ping');
  assert.deepEqual(fcmBody.registration_ids, ['a', 'b']);
  assert.equal(fcmBody.priority, 'high');

  // Without user-supplied credentials provider delivery is blocked.
  await assert.rejects(() => createAPNsAdapter().send({}, ['token']), /blocked/);
  await assert.rejects(() => createFCMAdapter().send({}, ['token']), /blocked/);
});
