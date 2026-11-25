// Call signaling store + layer-234 phone-call RPC handler tests (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TLBuffer } from '../src/tl/buffer.js';
import { loadSchema } from '../src/tl/schema.js';
import { CallStore } from '../src/store/calls.js';
import {
  CALL_ID,
  METHOD_IDS,
  CALL_CONFIG_TYPE_ID,
  getCallConfig,
  requestCall,
  acceptCall,
  confirmCall,
  receivedCall,
  discardCall,
  setCallRating,
  saveCallDebug,
  sendSignalingData,
  saveCallLog,
  checkCall,
  getCalls,
  declineCall,
  sendCallData,
  receivedCallData,
  uploadCallLog,
} from '../src/rpc/handlers/calls.js';

function tempDir() {
  const dir = path.join(os.tmpdir(), `telegramserver-calls-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCtx(store, userId = 1) {
  const users = new Map([
    [1, { id: 1, accessHash: 11n, firstName: 'Alice', phone: '1001' }],
    [2, { id: 2, accessHash: 22n, firstName: 'Bob', phone: '1002' }],
  ]);
  return {
    callStore: store,
    userId,
    store: { getUser: (id) => users.get(Number(id)) || null },
  };
}

test('all call ids are grep-verified against schema/api.tl (layer 234)', () => {
  const schema = loadSchema();
  assert.equal(schema.layer, 234);

  // Every RPC method id exported by the handler module must be the schema id.
  for (const [name, id] of Object.entries(METHOD_IDS)) {
    const entry = schema.functions.get(name);
    assert.ok(entry, `schema is missing function ${name}`);
    assert.equal(entry.id, id, `${name} mismatch`);
  }
  assert.equal(Object.keys(METHOD_IDS).length, 10);

  const types = {
    boolTrue: 'boolTrue',
    boolFalse: 'boolFalse',
    vector: 'vector',
    dataJSON: 'dataJSON',
    inputUser: 'inputUser',
    inputUserSelf: 'inputUserSelf',
    inputUserEmpty: 'inputUserEmpty',
    inputPhoneCall: 'inputPhoneCall',
    phoneCallEmpty: 'phoneCallEmpty',
    phoneCallWaiting: 'phoneCallWaiting',
    phoneCallRequested: 'phoneCallRequested',
    phoneCallAccepted: 'phoneCallAccepted',
    phoneCall: 'phoneCall',
    phoneCallDiscarded: 'phoneCallDiscarded',
    phoneCallProtocol: 'phoneCallProtocol',
    phonePhoneCall: 'phone.phoneCall',
    updatePhoneCall: 'updatePhoneCall',
    updates: 'updates',
    discardMissed: 'phoneCallDiscardReasonMissed',
    discardDisconnect: 'phoneCallDiscardReasonDisconnect',
    discardHangup: 'phoneCallDiscardReasonHangup',
    discardBusy: 'phoneCallDiscardReasonBusy',
    discardMigrate: 'phoneCallDiscardReasonMigrateConferenceCall',
  };
  for (const [key, schemaName] of Object.entries(types)) {
    const entry = schema.types.get(schemaName);
    assert.ok(entry, `schema is missing type ${schemaName}`);
    assert.equal(entry.id, CALL_ID[key], `${key} != ${schemaName}`);
  }

  // The task's suggested phone.CallConfig does not exist in this layer:
  // phone.getCallConfig returns DataJSON, which is what we encode.
  assert.equal(schema.types.has('phone.CallConfig'), false);
  assert.equal(schema.functions.get('phone.getCallConfig').result, 'DataJSON');
  assert.equal(CALL_CONFIG_TYPE_ID, schema.types.get('dataJSON').id);

  // These older/task-named methods are not in layer 234, so they are not ids.
  for (const name of ['phone.getCalls', 'phone.checkCall', 'phone.declineCall',
    'phone.sendCallData', 'phone.receivedCallData', 'phone.uploadCallLog']) {
    assert.equal(schema.functions.has(name), false, `${name} should be absent from layer 234`);
    assert.equal(METHOD_IDS[name], undefined);
  }
});

test('CallStore CRUD, status transitions, candidates and ratings (sqlite + JSON fallback)', () => {
  const dir = tempDir();
  for (const dbDriver of ['sqlite', 'json']) {
    const store = new CallStore(path.join(dir, dbDriver), { dbDriver });
    try {
      assert.equal(store.driverKind, dbDriver);
      assert.equal(fs.existsSync(path.join(dir, dbDriver, dbDriver === 'sqlite' ? 'calls.sqlite' : 'calls.json')), true);

      const created = store.createCall({
        id: 12345n, accessHash: 999n, callerId: 1n, calleeId: 2n, video: true, date: 1700000000,
      });
      assert.equal(created.id, 12345n);
      assert.equal(created.accessHash, 999n);
      assert.equal(created.callerId, 1n);
      assert.equal(created.calleeId, 2n);
      assert.equal(created.video, true);
      assert.equal(created.date, 1700000000);
      assert.equal(created.status, 'requested');
      assert.deepEqual(store.getCall(99999n), null);

      assert.equal(store.updateCall(12345n, { status: 'active', rating: 5 }).status, 'active');
      assert.equal(store.getCall(12345n).rating, 5);
      assert.equal(store.acceptCall(12345n).status, 'accepted');
      assert.ok(store.getCall(12345n).acceptedDate > 0);
      assert.equal(store.declineCall(12345n).status, 'declined');
      const discarded = store.discardCall(12345n, { reason: 'busy', duration: 7 });
      assert.equal(discarded.status, 'discarded');
      assert.equal(discarded.reason, 'busy');
      assert.equal(discarded.duration, 7);
      assert.equal(store.setRating(12345n, 4).rating, 4);
      assert.equal(store.updateCall(99999n, { status: 'active' }), null);

      // listCalls matches either participant, not unrelated users.
      store.createCall({ id: 222n, callerId: 3n, calleeId: 4n, date: 1700000001 });
      assert.deepEqual(store.listCalls(1n).map((c) => Number(c.id)), [12345]);
      assert.deepEqual(store.listCalls(2n).map((c) => Number(c.id)), [12345]);
      assert.deepEqual(store.listCalls(3n).map((c) => Number(c.id)), [222]);

      // ICE candidates are signaling metadata only, ordered by candidate id.
      store.putCandidate(12345n, { id: 2, sdp: 'candidate:2' });
      store.putCandidate(12345n, { id: 0, sdp: 'candidate:0' });
      store.putCandidate(12345n, { id: 0, sdp: 'candidate:0-updated' });
      assert.deepEqual(store.listCandidates(12345n), [
        { id: 0, sdp: 'candidate:0-updated' },
        { id: 2, sdp: 'candidate:2' },
      ]);
      assert.deepEqual(store.listCandidates(222n), []);
    } finally {
      store.close();
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getCallConfig returns DataJSON with the media-relay limitation flagged', () => {
  const buf = getCallConfig({});
  const r = new TLBuffer(buf);
  assert.equal(r.uint(), CALL_ID.dataJSON);
  const parsed = JSON.parse(r.string());
  assert.equal(parsed.signaling_only, true);
  assert.equal(parsed.media_relay, false);
});

test('requestCall / acceptCall / confirmCall drive signaling state and typed results', () => {
  const dir = tempDir();
  const store = new CallStore(dir);
  const ctx = makeCtx(store);
  try {
    const requested = requestCall({
      video: true,
      userId: { id: 2n, accessHash: 22n },
      randomId: 42,
      gAHash: Buffer.from('gahash'),
    }, ctx);
    let r = new TLBuffer(requested);
    assert.equal(r.uint(), CALL_ID.phonePhoneCall);
    assert.equal(r.uint(), CALL_ID.phoneCallRequested);
    const flags = r.uint();
    assert.equal(flags & (1 << 6), 1 << 6, 'video flag');
    assert.equal(r.long(), 42n);
    assert.equal(r.long(), store.getCall(42n).accessHash);
    assert.equal(r.int(), store.getCall(42n).date);
    assert.equal(r.long(), 1n); // admin_id (caller)
    assert.equal(r.long(), 2n); // participant_id (callee)
    assert.equal(r.bytes().toString(), 'gahash');
    assert.equal(r.uint(), CALL_ID.phoneCallProtocol);

    const peer = { id: 42n, accessHash: store.getCall(42n).accessHash };
    const accepted = acceptCall({ peer, gB: Buffer.from('gb') }, ctx);
    r = new TLBuffer(accepted);
    assert.equal(r.uint(), CALL_ID.phonePhoneCall);
    assert.equal(r.uint(), CALL_ID.phoneCallAccepted);
    assert.equal(store.getCall(42n).status, 'accepted');
    assert.equal(Buffer.from(store.getCall(42n).gB, 'base64').toString(), 'gb');

    const confirmed = confirmCall({ peer, gA: Buffer.from('ga'), keyFingerprint: 123n }, ctx);
    r = new TLBuffer(confirmed);
    assert.equal(r.uint(), CALL_ID.phonePhoneCall);
    assert.equal(r.uint(), CALL_ID.phoneCall);
    assert.equal(r.uint() & (1 << 5), 1 << 5); // p2p_allowed
    assert.equal(store.getCall(42n).status, 'active');
    assert.equal(store.getCall(42n).keyFingerprint, 123n);

    assert.equal(checkCall({ peer }, ctx).readUInt32LE(0), CALL_ID.phonePhoneCall);
    const calls = new TLBuffer(getCalls({}, ctx));
    assert.equal(calls.uint(), CALL_ID.vector);
    assert.equal(calls.int(), 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discardCall / rating / debug / signaling / log handlers return verified result ids', () => {
  const dir = tempDir();
  const store = new CallStore(dir);
  const ctx = makeCtx(store);
  const call = store.createCall({ id: 77n, accessHash: 88n, callerId: 1n, calleeId: 2n, video: false, date: 5 });
  const peer = { id: call.id, accessHash: call.accessHash };
  try {
    // discardCall -> Updates[updatePhoneCall[phoneCallDiscarded]]
    const buf = discardCall({ peer, duration: 9, reason: 'busy' }, ctx);
    let r = new TLBuffer(buf);
    assert.equal(r.uint(), CALL_ID.updates);
    const updates = r.vector((rr) => {
      assert.equal(rr.uint(), CALL_ID.updatePhoneCall);
      const ctor = rr.uint();
      assert.equal(ctor, CALL_ID.phoneCallDiscarded);
      const flags = rr.uint();
      assert.equal(flags & 1, 1, 'reason flag');
      assert.equal(flags & 2, 2, 'duration flag');
      assert.equal(rr.long(), 77n);
      assert.equal(rr.uint(), CALL_ID.discardBusy);
      assert.equal(rr.int(), 9);
      return ctor;
    });
    assert.equal(updates.length, 1);
    assert.equal(store.getCall(77n).status, 'discarded');
    assert.equal(store.getCall(77n).reason, 'busy');

    assert.equal(setCallRating({ peer, rating: 5, comment: 'good' }, ctx).readUInt32LE(0), CALL_ID.updates);
    assert.equal(store.getCall(77n).rating, 5);
    assert.equal(saveCallDebug({ peer, debug: { key: 'value' } }, ctx).readUInt32LE(0), CALL_ID.boolTrue);
    assert.equal(sendSignalingData({ peer, data: Buffer.from('opaque') }, ctx).readUInt32LE(0), CALL_ID.boolTrue);
    assert.equal(saveCallLog({ peer, file: {} }, ctx).readUInt32LE(0), CALL_ID.boolTrue);
    assert.equal(receivedCall({ peer }, ctx).readUInt32LE(0), CALL_ID.boolTrue);

    // Task-named aliases (no verifiable layer-234 method id) still behave.
    assert.equal(declineCall({ peer }, ctx).readUInt32LE(0), CALL_ID.phoneCallDiscarded);
    assert.equal(sendCallData, sendSignalingData);
    assert.equal(receivedCallData, receivedCall);
    assert.equal(uploadCallLog, saveCallLog);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handlers also read wire-format parameters positioned after the method id', () => {
  const dir = tempDir();
  const store = new CallStore(dir);
  const ctx = makeCtx(store, 1);
  try {
    const wire = new TLBuffer();
    wire.putUint(METHOD_IDS['phone.requestCall']) // method id (the router consumes it)
      .putUint(1) // flags: video
      .putUint(CALL_ID.boolTrue)
      .putUint(CALL_ID.inputUser).putLong(7n).putLong(99n)
      .putInt(777) // random_id
      .putBytes(Buffer.from('gahash'))
      .putUint(CALL_ID.phoneCallProtocol).putUint(0).putInt(65).putInt(234)
      .putVector([], (_, b) => b);
    const reader = new TLBuffer(wire.buffer);
    reader.uint(); // method id already consumed by the router
    const out = requestCall(reader, ctx);
    assert.equal(out.readUInt32LE(0), CALL_ID.phonePhoneCall);
    const call = store.getCall(777n);
    assert.ok(call, 'call keyed by random_id');
    assert.equal(call.calleeId, 7n);
    assert.equal(call.callerId, 1n);
    assert.equal(call.video, true);
    assert.equal(call.protocol.maxLayer, 234);

    const discard = new TLBuffer();
    discard.putUint(METHOD_IDS['phone.discardCall']) // method id
      .putUint(0)
      .putUint(CALL_ID.inputPhoneCall).putLong(777n).putLong(BigInt(call.accessHash))
      .putInt(3)
      .putUint(CALL_ID.discardHangup)
      .putLong(0n); // connection_id
    const dr = new TLBuffer(discard.buffer);
    dr.uint();
    assert.equal(discardCall(dr, ctx).readUInt32LE(0), CALL_ID.updates);
    assert.equal(store.getCall(777n).status, 'discarded');
    assert.equal(store.getCall(777n).reason, 'hangup');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
