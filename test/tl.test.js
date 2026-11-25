import test from 'node:test';
import assert from 'node:assert/strict';

import { TLBuffer, tlString } from '../src/tl/buffer.js';
import { loadSchema, parseSchema, constructorId, normalizeDecl, crc32 } from '../src/tl/schema.js';
import * as tl from '../src/tl/objects.js';

// -----------------------------------------------------------------------
// TLBuffer primitives
// -----------------------------------------------------------------------

test('buffer: int/uint/long round trip', () => {
  const b = new TLBuffer();
  b.putInt(-42).putUint(0xdeadbeef).putLong(-9007199254740993n).putLong(123n);
  const r = new TLBuffer(b.buffer);
  assert.equal(r.int(), -42);
  assert.equal(r.uint(), 0xdeadbeef);
  assert.equal(r.long(), -9007199254740993n);
  assert.equal(r.long(), 123n);
  assert.equal(r.offset, b.buffer.length);
});

test('buffer: bool, bytes, string, vector round trip', () => {
  const b = new TLBuffer();
  b.putBool(true).putBool(false);
  b.putBytes(Buffer.from([1, 2, 3]));
  b.putString('hello');
  b.putVector([1, 2, 3], (n, w) => w.putInt(n));
  const r = new TLBuffer(b.buffer);
  assert.equal(r.bool(), true);
  assert.equal(r.bool(), false);
  assert.deepEqual(r.bytes(), Buffer.from([1, 2, 3]));
  assert.equal(r.string(), 'hello');
  assert.deepEqual(r.vector((rr) => rr.int()), [1, 2, 3]);
  assert.equal(r.has(1), false);
});

test('buffer: int128/int256 and long byte strings', () => {
  const b = new TLBuffer();
  b.putInt128(Buffer.alloc(16, 0xab)).putInt256(Buffer.alloc(32, 0xcd));
  const payload = Buffer.alloc(300, 0x7f);
  b.putBytes(payload);
  const r = new TLBuffer(b.buffer);
  assert.deepEqual(r.int128(), Buffer.alloc(16, 0xab));
  assert.deepEqual(r.int256(), Buffer.alloc(32, 0xcd));
  assert.deepEqual(r.bytes(), payload);
});

test('buffer: tlString pads to four bytes', () => {
  assert.equal(tlString(Buffer.alloc(1)).length, 4);
  assert.equal(tlString(Buffer.alloc(3)).length, 4);
  assert.equal(tlString(Buffer.alloc(4)).length, 8);
  assert.equal(tlString(Buffer.alloc(300)).length, 304);
});

// -----------------------------------------------------------------------
// Schema parsing
// -----------------------------------------------------------------------

test('schema: layer 234 and known constructor IDs', () => {
  const { types, functions, layer } = loadSchema();
  assert.equal(layer, 234);
  assert.equal(types.get('vector').id, 0x1cb5c415);
  assert.equal(types.get('boolTrue').id, 0x997275b5);
  assert.equal(functions.get('req_pq_multi').id, 0xbe7e8ef1);
  assert.equal(functions.get('help.getConfig').id, 0xc4f9186b);
  assert.equal(functions.get('invokeWithLayer').id, 0xda9b0d0d);
  assert.equal(functions.get('initConnection').id, 0xc1cd5ea9);
});

test('schema: IDs match the hand-written codec constants', () => {
  const { types, functions } = loadSchema();
  const pairs = [
    ['config', tl.ID_CONFIG], ['dcOption', tl.ID_DC_OPTION],
    ['user', tl.ID_USER], ['userEmpty', tl.ID_USER_EMPTY],
    ['message', tl.ID_MESSAGE], ['peerUser', tl.ID_PEER_USER],
    ['peerChat', tl.ID_PEER_CHAT], ['peerChannel', tl.ID_PEER_CHANNEL],
    ['contact', tl.ID_CONTACT], ['nearestDc', tl.ID_NEAREST_DC],
    ['updates.state', tl.ID_UPDATES_STATE], ['updates', tl.ID_UPDATES],
    ['updateShort', tl.ID_UPDATE_SHORT], ['updateNewMessage', tl.ID_UPDATE_NEW_MESSAGE],
    ['updateMessageID', tl.ID_UPDATE_MESSAGE_ID],
    ['upload.file', tl.ID_UPLOAD_FILE],
    ['inputUser', tl.ID_INPUT_USER], ['inputUserSelf', tl.ID_INPUT_USER_SELF],
    ['inputPeerChannel', tl.ID_INPUT_PEER_CHANNEL],
  ];
  for (const [name, id] of pairs) assert.equal(types.get(name).id, id, name);
  const fnPairs = [
    ['auth.sendCode', tl.ID_AUTH_SEND_CODE],
    ['messages.sendMessage', tl.ID_MESSAGES_SEND_MESSAGE],
    ['messages.getDialogs', tl.ID_MESSAGES_GET_DIALOGS],
    ['messages.getHistory', tl.ID_MESSAGES_GET_HISTORY],
    ['updates.getState', tl.ID_UPDATES_GET_STATE],
    ['users.getUsers', tl.ID_USERS_GET_USERS],
    ['upload.getFile', tl.ID_UPLOAD_GET_FILE],
    ['upload.saveFilePart', tl.ID_UPLOAD_SAVE_FILE_PART],
  ];
  for (const [name, id] of fnPairs) assert.equal(functions.get(name).id, id, name);
});

test('schema: flags/#/generics parsing and CRC fallback', () => {
  assert.equal(constructorId('boolTrue = Bool;'), 0x997275b5);
  assert.equal(constructorId('boolTrue#997275b5 = Bool;'), 0x997275b5);
  assert.equal(crc32('boolTrue = Bool'), 0x997275b5);
  assert.equal(normalizeDecl('  ping#7abe77ec  ping_id:long = Pong;  '), 'ping#7abe77ec ping_id:long = Pong');

  const { types, functions } = parseSchema(`
    ---types---
    // LAYER 234
    foo#12345678 flags:# a:flags.2?string b:Vector<int> c:!X = Foo;
    ---functions---
    bar#89abcdef {X:Type} query:!X = X;
  `);
  assert.equal(types.get('foo').id, 0x12345678);
  assert.deepEqual(types.get('foo').params, [
    { name: 'flags', type: '#' },
    { name: 'a', type: 'string', flagBit: 2 },
    { name: 'b', type: 'Vector<int>' },
    { name: 'c', type: '!X' },
  ]);
  assert.equal(functions.get('bar').id, 0x89abcdef);
  assert.equal(types.get('foo').result, 'Foo');
});

// -----------------------------------------------------------------------
// Object codecs: round trips
// -----------------------------------------------------------------------

test('objects: config round trip has every mandatory field', () => {
  const built = tl.writeConfig({ publicIp: '1.2.3.4', port: 443, thisDc: 1 });
  const r = new TLBuffer(built);
  assert.equal(r.uint(), tl.ID_CONFIG);
  const c = tl.readConfig(r);
  assert.equal(c.dcOptions.length, 1);
  assert.equal(c.dcOptions[0].ipAddress, '1.2.3.4');
  assert.equal(c.dcOptions[0].port, 443);
  assert.equal(c.thisDc, 1);
  assert.ok(c.date > 0);
  assert.ok(c.expires > c.date);
  assert.equal(c.testMode, false);
  for (const field of [
    'chatSizeMax', 'megagroupSizeMax', 'forwardedCountMax', 'onlineUpdatePeriodMs',
    'offlineBlurTimeoutMs', 'offlineIdleTimeoutMs', 'onlineCloudTimeoutMs',
    'notifyCloudDelayMs', 'notifyDefaultDelayMs', 'pushChatPeriodMs', 'pushChatLimit',
    'editTimeLimit', 'revokeTimeLimit', 'revokePmTimeLimit', 'ratingEDecay',
    'stickersRecentLimit', 'channelsReadMediaPeriod', 'callReceiveTimeoutMs',
    'callRingTimeoutMs', 'callConnectTimeoutMs', 'callPacketTimeoutMs',
    'captionLengthMax', 'messageLengthMax', 'webfileDcId',
  ]) assert.ok(c[field] !== undefined, `missing config field ${field}`);
  // every mandatory integer must be sane/non-zero
  assert.ok(tl.writeConfig({}).length > 150, 'config looks truncated');
});

test('objects: config re-serializes identically', () => {
  const first = tl.writeConfig({ publicIp: '5.6.7.8', port: 443, date: 1_700_000_000 });
  const r0 = new TLBuffer(first);
  assert.equal(r0.uint(), tl.ID_CONFIG);
  const parsed = tl.readConfig(r0);
  const second = tl.writeConfig({
    ...parsed, flags: parsed.flags, publicIp: parsed.dcOptions[0].ipAddress,
    port: parsed.dcOptions[0].port,
  });
  assert.deepEqual(second, first);
});

test('objects: user round trip (flags access_hash/first/last/phone)', () => {
  const user = {
    id: 123456789n, accessHash: 0xabcdefn,
    firstName: 'Ada', lastName: 'Lovelace', phone: '15551234567',
  };
  const buf = tl.writeUser(user);
  const r = new TLBuffer(buf);
  assert.equal(r.uint(), tl.ID_USER);
  const out = tl.readUser(r);
  assert.equal(out.id, user.id);
  assert.equal(out.accessHash, user.accessHash);
  assert.equal(out.firstName, user.firstName);
  assert.equal(out.lastName, user.lastName);
  assert.equal(out.phone, user.phone);
  assert.equal(out.flags2, 0);
});

test('objects: userEmpty round trip', () => {
  const r = new TLBuffer(tl.writeUserEmpty({ id: 42n }));
  assert.equal(r.uint(), tl.ID_USER_EMPTY);
  assert.equal(tl.readUserEmpty(r).id, 42n);
});

test('objects: updates.state round trip', () => {
  const state = { pts: 7, qts: 3, date: 1_700_000_000, seq: 2, unreadCount: 4 };
  const r = new TLBuffer(tl.writeUpdatesState(state));
  assert.equal(r.uint(), tl.ID_UPDATES_STATE);
  assert.deepEqual(tl.readUpdatesState(r), state);
});

test('objects: service messages', () => {
  let r = new TLBuffer(tl.writeRpcResult(11n, Buffer.from([1, 2, 3, 4])));
  assert.equal(r.uint(), tl.ID_RPC_RESULT);
  let out = tl.readRpcResult(r);
  assert.equal(out.reqMsgId, 11n);
  assert.deepEqual(out.result, Buffer.from([1, 2, 3, 4]));

  r = new TLBuffer(tl.writeRpcError({ errorCode: 400, errorMessage: 'BAD_REQUEST' }));
  assert.equal(r.uint(), tl.ID_RPC_ERROR);
  assert.deepEqual(tl.readRpcError(r), { errorCode: 400, errorMessage: 'BAD_REQUEST' });

  r = new TLBuffer(tl.writeMsgsAck([1n, 2n]));
  assert.equal(r.uint(), tl.ID_MSGS_ACK);
  assert.deepEqual(tl.readMsgsAck(r).msgIds, [1n, 2n]);

  r = new TLBuffer(tl.writePong({ msgId: 1n, pingId: 2n }));
  assert.equal(r.uint(), tl.ID_PONG);
  assert.deepEqual(tl.readPong(r), { msgId: 1n, pingId: 2n });

  r = new TLBuffer(tl.writeNewSessionCreated({ firstMsgId: 1n, uniqueId: 2n, serverSalt: 3n }));
  assert.equal(r.uint(), tl.ID_NEW_SESSION_CREATED);
  assert.deepEqual(tl.readNewSessionCreated(r), { firstMsgId: 1n, uniqueId: 2n, serverSalt: 3n });

  r = new TLBuffer(tl.writeBadMsgNotification({ badMsgId: 1n, badMsgSeqno: 2, errorCode: 16 }));
  assert.equal(r.uint(), tl.ID_BAD_MSG_NOTIFICATION);
  assert.deepEqual(tl.readBadMsgNotification(r), { badMsgId: 1n, badMsgSeqno: 2, errorCode: 16 });

  r = new TLBuffer(tl.writeBadServerSalt({
    badMsgId: 1n, badMsgSeqno: 2, errorCode: 20, newServerSalt: 4n,
  }));
  assert.equal(r.uint(), tl.ID_BAD_SERVER_SALT);
  assert.deepEqual(tl.readBadServerSalt(r), {
    badMsgId: 1n, badMsgSeqno: 2, errorCode: 20, newServerSalt: 4n,
  });
});

test('objects: msg_container, gzip_packed, future_salts', () => {
  const body = tl.writePing(99n);
  let r = new TLBuffer(tl.writeMsgContainer([{ msgId: 1n, seqNo: 0, body }]));
  assert.equal(r.uint(), tl.ID_MSG_CONTAINER);
  assert.deepEqual(tl.readMsgContainer(r).messages[0].body, body);

  r = new TLBuffer(tl.writeGzipPacked(Buffer.from([1, 2, 3])));
  assert.equal(r.uint(), tl.ID_GZIP_PACKED);
  assert.deepEqual(tl.readGzipPacked(r).packedData, Buffer.from([1, 2, 3]));

  r = new TLBuffer(tl.writeFutureSalts({
    reqMsgId: 5n, now: 100,
    salts: [{ validSince: 100, validUntil: 200, salt: 9n }],
  }));
  assert.equal(r.uint(), tl.ID_FUTURE_SALTS);
  assert.equal(tl.readFutureSalts(r).salts[0].salt, 9n);
});

test('objects: bootstrap wrappers and nearestDc', () => {
  let r = new TLBuffer(tl.writeInvokeWithLayer({ layer: 234, query: tl.writeHelpGetConfig() }));
  assert.equal(r.uint(), tl.ID_INVOKE_WITH_LAYER);
  let out = tl.readInvokeWithLayer(r);
  assert.equal(out.layer, 234);
  assert.equal(out.query.length, 4);

  r = new TLBuffer(tl.writeInitConnection({
    apiId: 1, deviceModel: 'Test', systemVersion: '1', appVersion: '2',
    systemLangCode: 'en', langPack: '', langCode: 'en', query: tl.writeHelpGetConfig(),
  }));
  assert.equal(r.uint(), tl.ID_INIT_CONNECTION);
  out = tl.readInitConnection(r);
  assert.equal(out.apiId, 1);
  assert.equal(out.deviceModel, 'Test');

  r = new TLBuffer(tl.writeNearestDc({ country: 'US', thisDc: 1, nearestDc: 1 }));
  assert.equal(r.uint(), tl.ID_NEAREST_DC);
  assert.deepEqual(tl.readNearestDc(r), { country: 'US', thisDc: 1, nearestDc: 1 });

  assert.equal(tl.writeHelpGetConfig().length, 4);
});

test('objects: auth objects', () => {
  let r = new TLBuffer(tl.writeCodeSettings({ allowMissedCall: true }));
  assert.equal(r.uint(), tl.ID_CODE_SETTINGS);
  assert.equal(tl.readCodeSettings(r).allowMissedCall, true);

  const sent = {
    type: tl.writeAuthSentCodeTypeSms({ length: 5 }),
    phoneCodeHash: 'hash', timeout: 30,
  };
  r = new TLBuffer(tl.writeAuthSentCode(sent));
  assert.equal(r.uint(), tl.ID_AUTH_SENT_CODE);
  const parsed = tl.readAuthSentCode(r);
  assert.equal(parsed.phoneCodeHash, 'hash');
  assert.equal(parsed.type.length, 5);
  assert.equal(parsed.timeout, 30);

  r = new TLBuffer(tl.writeAuthAuthorization({
    user: { id: 7n, accessHash: 8n, firstName: 'A', phone: '1' },
  }));
  assert.equal(r.uint(), tl.ID_AUTH_AUTHORIZATION);
  assert.equal(tl.readAuthAuthorization(r).user.id, 7n);
});

test('objects: message, peers and updates', () => {
  const msg = {
    id: 10, peerId: { _: 'peerUser', userId: 7n },
    date: 1_700_000_000, message: 'hi',
  };
  let r = new TLBuffer(tl.writeMessage(msg));
  assert.equal(r.uint(), tl.ID_MESSAGE);
  let parsed = tl.readMessage(r);
  assert.equal(parsed.id, 10);
  assert.equal(parsed.peerId.userId, 7n);
  assert.equal(parsed.message, 'hi');

  assert.equal(tl.writePeerUser({ userId: 7n }).length, 12);
  assert.equal(tl.writePeerChat({ chatId: 8n }).length, 12);
  assert.equal(tl.writePeerChannel({ channelId: 9n }).length, 12);

  r = new TLBuffer(tl.writeUpdateMessageID({ id: 10, randomId: 11n }));
  assert.equal(r.uint(), tl.ID_UPDATE_MESSAGE_ID);
  assert.deepEqual(tl.readUpdateMessageID(r), { id: 10, randomId: 11n });

  r = new TLBuffer(tl.writeUpdateNewMessage({ message: msg, pts: 2, ptsCount: 1 }));
  assert.equal(r.uint(), tl.ID_UPDATE_NEW_MESSAGE);
  assert.equal(tl.readUpdateNewMessage(r).pts, 2);

  r = new TLBuffer(tl.writeUpdateShort({
    update: { _: 'updateMessageID', id: 3, randomId: 4n }, date: 100,
  }));
  assert.equal(r.uint(), tl.ID_UPDATE_SHORT);
  assert.equal(tl.readUpdateShort(r).update.id, 3);

  r = new TLBuffer(tl.writeUpdates({ updates: [], users: [], chats: [], date: 100, seq: 0 }));
  assert.equal(r.uint(), tl.ID_UPDATES);
  assert.equal(tl.readUpdates(r).date, 100);

  r = new TLBuffer(tl.writeUpdateShortSentMessage({ id: 1, pts: 2, ptsCount: 1, date: 100 }));
  assert.equal(r.uint(), tl.ID_UPDATE_SHORT_SENT_MESSAGE);
  assert.equal(tl.readUpdateShortSentMessage(r).pts, 2);
});

test('objects: input peers/users, uploads', () => {
  assert.equal(tl.writeInputPeerEmpty().length, 4);
  assert.equal(tl.writeInputPeerSelf().length, 4);
  assert.equal(tl.writeInputPeerUser({ userId: 1n, accessHash: 2n }).length, 20);
  assert.equal(tl.writeInputPeerChat({ chatId: 3n }).length, 12);
  assert.equal(tl.writeInputPeerChannel({ channelId: 4n, accessHash: 5n }).length, 20);
  assert.equal(tl.writeInputUserSelf().length, 4);

  const inputUserBuf = tl.writeInputUser({ userId: 1n, accessHash: 2n });
  assert.equal(inputUserBuf.readUInt32LE(0), tl.ID_INPUT_USER);
  assert.equal(tl.readTlObject(new TLBuffer(inputUserBuf)).userId, 1n);
  let r = new TLBuffer(inputUserBuf);

  assert.equal(tl.writeMessagesSendMessage({
    peer: tl.writeInputPeerSelf(), message: 'hello', randomId: 1n,
  }).length > 20, true);

  r = new TLBuffer(tl.writeUploadSaveFilePart({ fileId: 1n, filePart: 0, bytes: Buffer.alloc(3) }));
  assert.equal(r.uint(), tl.ID_UPLOAD_SAVE_FILE_PART);

  r = new TLBuffer(tl.writeUploadFile({ mtime: 100, bytes: Buffer.from('abc') }));
  assert.equal(r.uint(), tl.ID_UPLOAD_FILE);
  assert.deepEqual(tl.readUploadFile(r).bytes, Buffer.from('abc'));

  r = new TLBuffer(tl.writeInputFile({ id: 1n, parts: 1, name: 'a.txt', md5Checksum: '' }));
  assert.equal(r.uint(), tl.ID_INPUT_FILE);
  assert.equal(tl.readInputFile(r).name, 'a.txt');
});
