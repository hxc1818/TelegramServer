// Signaling relay, group-call handlers and UDP media relay tests (layer 234).
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { TLBuffer } from '../src/tl/buffer.js';
import { loadSchema } from '../src/tl/schema.js';
import { CallRelay } from '../src/relay/call.js';
import {
  GROUP_ID,
  METHOD_IDS,
  relayOf,
  groupCallsOf,
  createGroupCall,
  joinGroupCall,
  leaveGroupCall,
  getGroupCall,
  getGroupParticipants,
  inviteToGroupCall,
  discardGroupCall,
  toggleGroupCallSettings,
  editGroupCallParticipant,
  editGroupCallTitle,
  getGroupCallJoinAs,
  sendSignalingData,
} from '../src/rpc/handlers/calls-extra.js';

function waitFor(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function udpClient() {
  const socket = dgram.createSocket('udp4');
  const messages = [];
  socket.on('message', (msg, rinfo) => messages.push({ msg, rinfo }));
  return new Promise((resolve) => {
    socket.bind(0, '127.0.0.1', () => {
      resolve({ socket, messages, port: socket.address().port });
    });
  });
}

const GC_TRUE_BITS = [1, 2, 6, 8, 9, 11, 12, 13, 14, 15, 17, 18, 19];

function readGroupCallHeader(r) {
  const ctor = r.uint();
  const flags = r.uint();
  for (const bit of GC_TRUE_BITS) {
    if (flags & (1 << bit)) assert.equal(r.uint(), GROUP_ID.boolTrue);
  }
  return { ctor, flags };
}

function makeCtx() {
  const users = new Map([
    [1, { id: 1, accessHash: 11n, firstName: 'Alice' }],
    [2, { id: 2, accessHash: 22n, firstName: 'Bob' }],
    [3, { id: 3, accessHash: 33n, firstName: 'Carol' }],
  ]);
  return { userId: 1, store: { getUser: (id) => users.get(Number(id)) || null } };
}

test('all group-call ids are grep-verified against schema/api.tl (layer 234)', () => {
  const schema = loadSchema();
  assert.equal(schema.layer, 234);

  for (const [name, id] of Object.entries(METHOD_IDS)) {
    const entry = schema.functions.get(name);
    assert.ok(entry, `schema is missing function ${name}`);
    assert.equal(entry.id, id, `${name} mismatch`);
  }
  assert.equal(Object.keys(METHOD_IDS).length, 12);

  const types = {
    boolTrue: 'boolTrue',
    vector: 'vector',
    peerUser: 'peerUser',
    peerChat: 'peerChat',
    peerChannel: 'peerChannel',
    user: 'user',
    inputPeerChat: 'inputPeerChat',
    inputPeerUser: 'inputPeerUser',
    inputPeerChannel: 'inputPeerChannel',
    inputUserSelf: 'inputUserSelf',
    inputUser: 'inputUser',
    dataJSON: 'dataJSON',
    inputPhoneCall: 'inputPhoneCall',
    updateGroupCallParticipants: 'updateGroupCallParticipants',
    updateGroupCall: 'updateGroupCall',
    updates: 'updates',
    groupCallDiscarded: 'groupCallDiscarded',
    groupCall: 'groupCall',
    inputGroupCall: 'inputGroupCall',
    inputGroupCallSlug: 'inputGroupCallSlug',
    inputGroupCallInviteMessage: 'inputGroupCallInviteMessage',
    groupCallParticipant: 'groupCallParticipant',
    phoneGroupCall: 'phone.groupCall',
    phoneGroupParticipants: 'phone.groupParticipants',
    phoneJoinAsPeers: 'phone.joinAsPeers',
  };
  for (const [key, name] of Object.entries(types)) {
    const entry = schema.types.get(name);
    assert.ok(entry, `schema is missing type ${name}`);
    assert.equal(entry.id, GROUP_ID[key], `${key} != ${name}`);
  }
  assert.equal(GROUP_ID.phoneGroupCall, 0x9e727aad);
  assert.equal(schema.functions.get('phone.getGroupCall').result, 'phone.GroupCall');
});

test('CallRelay signaling fan-out excludes the sender and respects registration', () => {
  const relay = new CallRelay();
  relay.registerCall(1001n, [1n, 2n, 3n]);
  assert.deepEqual(relay.relaySignaling(1001n, 1n, Buffer.from('hello')), [2n, 3n]);
  assert.deepEqual(relay.relaySignaling(1001n, 2n, Buffer.from('hello')), [1n, 3n]);
  assert.deepEqual(relay.relaySignaling(1001n, 99n, Buffer.from('hello')), [1n, 2n, 3n]);
  assert.deepEqual(relay.relaySignaling(9999n, 1n, Buffer.alloc(0)), []);

  relay.registerCall(1002n, [{ userId: 7 }, { userId: 8 }]);
  assert.deepEqual(relay.relaySignaling(1002n, 7, Buffer.alloc(0)), [8]);

  const fromStore = new CallRelay({ callStore: { getCall: () => ({ callerId: 7n, calleeId: 8n }) } });
  fromStore.registerCall(1003n);
  assert.deepEqual(fromStore.relaySignaling(1003n, 7n, Buffer.alloc(0)), [8n]);

  const stats = relay.getStats();
  assert.equal(stats.signalingMessages, 4);
  assert.equal(stats.signalingRecipients, 2 + 2 + 3 + 0 + 1);
  assert.equal(stats.running, false);

  assert.equal(relay.unregisterCall(1001n), true);
  assert.deepEqual(relay.relaySignaling(1001n, 1n, Buffer.alloc(0)), []);
  assert.equal(relay.unregisterCall(1001n), false);
  relay.close();
  fromStore.close();
});

test('sendSignalingData relays the opaque blob through ctx.callRelay', () => {
  const relay = new CallRelay();
  relay.registerCall(55n, [1, 2]);
  const ctx = { callRelay: relay, userId: 1 };
  assert.equal(relayOf(ctx), relay);
  assert.equal(relayOf({}), null);

  const out = sendSignalingData({ peer: { id: 55n, accessHash: 1n }, data: Buffer.from('sig') }, ctx);
  assert.equal(out.readUInt32LE(0), GROUP_ID.boolTrue);
  assert.equal(relay.getStats().signalingRecipients, 1);

  const wire = new TLBuffer();
  wire.putUint(METHOD_IDS['phone.sendSignalingData'])
    .putUint(GROUP_ID.inputPhoneCall).putLong(55n).putLong(1n)
    .putBytes(Buffer.from('sig2'));
  const r = new TLBuffer(wire.buffer);
  r.uint(); // method id consumed by the router
  assert.equal(sendSignalingData(r, ctx).readUInt32LE(0), GROUP_ID.boolTrue);
  assert.equal(relay.getStats().signalingRecipients, 2);

  // Without a relay the handler still acknowledges the request.
  assert.equal(sendSignalingData({ peer: { id: 55n }, data: Buffer.from('x') }, {}).readUInt32LE(0), GROUP_ID.boolTrue);
  relay.close();
});

test('createGroupCall reads wire flags and optional title/schedule fields correctly', () => {
  const ctx = makeCtx();
  const wire = new TLBuffer();
  wire.putUint(METHOD_IDS['phone.createGroupCall'])
    .putUint(0) // no optional flags
    .putUint(GROUP_ID.inputPeerChat).putLong(777n)
    .putInt(99); // random_id
  const r = new TLBuffer(wire.buffer);
  r.uint();
  assert.equal(createGroupCall(r, ctx).readUInt32LE(0), GROUP_ID.updates);
  const call = groupCallsOf(ctx).get(99n);
  assert.ok(call, 'call is keyed by random_id');
  assert.equal(call.title, '');
  assert.equal(call.scheduleDate, 0);
  assert.equal(Number(call.peer.id), 777);
});

test('group-call handlers produce verified result constructors and persist state on ctx', () => {
  const ctx = makeCtx();
  const created = createGroupCall({ peer: { type: 'chat', id: 500n }, randomId: 1234, title: 'Team' }, ctx);
  let r = new TLBuffer(created);
  assert.equal(r.uint(), GROUP_ID.updates);
  const updates = r.vector((rr) => {
    assert.equal(rr.uint(), GROUP_ID.updateGroupCall);
    assert.equal(rr.uint() & 2, 2); // peer present
    assert.equal(rr.uint(), GROUP_ID.peerChat);
    assert.equal(rr.long(), 500n);
    const { ctor, flags } = readGroupCallHeader(rr);
    assert.equal(ctor, GROUP_ID.groupCall);
    assert.equal(flags & (1 << 3), 1 << 3); // title
    assert.equal(flags & (1 << 15), 1 << 15); // creator
    const id = rr.long();
    const accessHash = rr.long();
    assert.equal(rr.int(), 0); // participants_count
    assert.equal(rr.string(), 'Team');
    assert.equal(rr.int(), 0); // unmuted_video_limit
    assert.ok(rr.int() > 0); // version
    return { id, accessHash };
  });
  assert.equal(updates.length, 1);
  const { id, accessHash } = updates[0];
  assert.equal(id, 1234n);
  const call = { id, accessHash };

  // getGroupCall -> phone.groupCall#9e727aad wrapping groupCall#efb2b617.
  r = new TLBuffer(getGroupCall({ call, limit: 10 }, ctx));
  assert.equal(r.uint(), GROUP_ID.phoneGroupCall);
  assert.equal(readGroupCallHeader(r).ctor, GROUP_ID.groupCall);
  assert.equal(r.long(), id);
  assert.equal(r.long(), accessHash);
  r.int(); // participants_count
  r.string(); // title
  r.int(); r.int(); // unmuted_video_limit, version
  assert.equal(r.vector((rr) => rr).length, 0); // participants
  assert.equal(r.string(), '');
  assert.equal(r.vector((rr) => rr).length, 0); // chats
  assert.equal(r.vector((rr) => rr).length, 1); // creator user

  // Wire-format joinGroupCall parameters (reader positioned after method id).
  const wire = new TLBuffer();
  wire.putUint(METHOD_IDS['phone.joinGroupCall'])
    .putUint(0) // flags
    .putUint(GROUP_ID.inputGroupCall).putLong(id).putLong(accessHash)
    .putUint(GROUP_ID.inputPeerUser).putLong(2n).putLong(22n)
    .putUint(GROUP_ID.dataJSON).putString('{"sdp":"opaque"}');
  const jr = new TLBuffer(wire.buffer);
  jr.uint();
  assert.equal(joinGroupCall(jr, ctx).readUInt32LE(0), GROUP_ID.updates);

  r = new TLBuffer(getGroupParticipants({ call, ids: [], sources: [], offset: '', limit: 10 }, ctx));
  assert.equal(r.uint(), GROUP_ID.phoneGroupParticipants);
  assert.equal(r.int(), 1);
  const participants = r.vector((rr) => {
    assert.equal(rr.uint(), GROUP_ID.groupCallParticipant);
    assert.equal(rr.uint(), 0); // flags: not muted/left/self, no volume
    assert.equal(rr.uint(), GROUP_ID.peerUser);
    assert.equal(rr.long(), 2n);
    assert.ok(rr.int() > 0); // date
    assert.equal(rr.int(), 0); // source
    return true;
  });
  assert.equal(participants.length, 1);

  assert.equal(inviteToGroupCall({ call, users: [{ id: 3n, accessHash: 33n }] }, ctx).readUInt32LE(0), GROUP_ID.updates);
  assert.equal(editGroupCallParticipant({ call, participant: { type: 'user', id: 3n }, muted: true, volume: 50 }, ctx).readUInt32LE(0), GROUP_ID.updates);
  assert.equal(editGroupCallTitle({ call, title: 'Renamed' }, ctx).readUInt32LE(0), GROUP_ID.updates);
  assert.equal(toggleGroupCallSettings({ call, joinMuted: true, messagesEnabled: true }, ctx).readUInt32LE(0), GROUP_ID.updates);
  assert.equal(leaveGroupCall({ call, userId: 2 }, ctx).readUInt32LE(0), GROUP_ID.updates);

  r = new TLBuffer(getGroupCall({ call, limit: 10 }, ctx));
  assert.equal(r.uint(), GROUP_ID.phoneGroupCall);
  const { ctor: finalCtor, flags: finalFlags } = readGroupCallHeader(r);
  assert.equal(finalCtor, GROUP_ID.groupCall);
  assert.equal(finalFlags & (1 << 1), 1 << 1); // join_muted
  assert.equal(finalFlags & (1 << 3), 1 << 3); // title
  r.long(); r.long(); r.int();
  assert.equal(r.string(), 'Renamed');
  r.int(); r.int(); // unmuted_video_limit, version
  assert.equal(r.vector((rr) => rr).length, 2); // joined+left user 2 and invited user 3

  r = new TLBuffer(getGroupCallJoinAs({ peer: { type: 'chat', id: 500n } }, ctx));
  assert.equal(r.uint(), GROUP_ID.phoneJoinAsPeers);
  assert.equal(r.vector((rr) => {
    assert.equal(rr.uint(), GROUP_ID.peerChat);
    assert.equal(rr.long(), 500n); // the requested chat
    return true;
  }).length, 1);

  assert.equal(discardGroupCall({ call }, ctx).readUInt32LE(0), GROUP_ID.updates);
  r = new TLBuffer(getGroupCall({ call, limit: 10 }, ctx));
  assert.equal(r.uint(), GROUP_ID.phoneGroupCall);
  assert.equal(r.uint(), GROUP_ID.groupCallDiscarded);
  assert.equal(r.long(), id);
  assert.equal(r.long(), accessHash);
  assert.ok(r.int() >= 0); // duration
});

test('UDP media relay forwards opaque RTP between peers and stops cleanly', async () => {
  const relay = new CallRelay();
  const a = await udpClient();
  const b = await udpClient();
  const callId = 4242n;
  relay.registerCall(callId, [
    { userId: 1, address: '127.0.0.1', port: a.port },
    { userId: 2, address: '127.0.0.1', port: b.port },
  ]);
  const address = await relay.startMediaRelay({ host: '127.0.0.1', port: 0 });
  assert.equal(address.host, '127.0.0.1');
  assert.ok(address.port > 0);
  assert.equal(relay.getStats().running, true);

  a.socket.send(Buffer.from('rtp-1'), address.port, address.host);
  await waitFor(() => b.messages.length > 0);
  assert.equal(b.messages[0].msg.toString(), 'rtp-1');
  assert.equal(a.messages.length, 0, 'sender must not receive its own datagram');
  assert.equal(relay.getStats().packetsReceived, 1);
  assert.equal(relay.getStats().packetsForwarded, 1);

  b.socket.send(Buffer.from('rtp-2'), address.port, address.host);
  await waitFor(() => a.messages.length > 0);
  assert.equal(a.messages[0].msg.toString(), 'rtp-2');
  assert.equal(relay.getStats().packetsForwarded, 2);

  assert.equal(relay.stop(), true);
  assert.equal(relay.socket, null);
  const dropped = relay.getStats().packetsDropped;
  assert.equal(relay.relayRtp(callId, { address: '127.0.0.1', port: a.port }, Buffer.from('after-stop')), 0);
  assert.equal(relay.getStats().packetsDropped, dropped + 1);
  relay.close();
  a.socket.close();
  b.socket.close();
});
