import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { TLBuffer } from '../src/tl/buffer.js';
import { generateRSA, rsaFingerprint, rsaPadEncrypt } from '../src/crypto/rsa.js';
import { igeEncrypt, igeDecrypt } from '../src/crypto/ige.js';
import { Handshake } from '../src/mtproto/handshake.js';
import { SessionContext, packMessage, unpackMessage, packPlainEnvelope, unpackPlainEnvelope } from '../src/mtproto/session.js';
import {
  msgsAck, readMsgsAck, pong, readPing, joinContainer, splitContainer,
  badServerSalt, readBadMsgNotification, newSessionCreated, readNewSessionCreated,
  futureSalts, readFutureSalts,
} from '../src/mtproto/service.js';
import { ObfuscationCodec } from '../src/transport/obfuscation.js';
import { FrameCodec } from '../src/transport/framing.js';

const ID = {
  reqPq: 0x60469778,
  reqPqMulti: 0xbe7e8ef1,
  reqDhParams: 0xd712e4be,
  setClientDhParams: 0xf5045f1f,
  resPq: 0x05162463,
  serverDhParamsOk: 0xd0e8075c,
  dhGenOk: 0x3bcbf734,
  pQInnerData: 0x83c95aec,
  serverDhInnerData: 0xb5890dba,
  clientDhInnerData: 0x6643b654,
};

function sha1(...parts) {
  return crypto.createHash('sha1').update(Buffer.concat(parts)).digest();
}

function modPow(base, exp, mod) {
  let r = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

function toBE256(v) {
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const raw = Buffer.from(hex, 'hex');
  assert.ok(raw.length <= 256);
  return Buffer.concat([Buffer.alloc(256 - raw.length), raw]);
}

function hashPad(data) {
  const pad = (16 - ((20 + data.length) % 16)) % 16;
  return crypto.randomBytes(pad);
}

test('full client handshake: req_pq_multi -> dh_gen_ok, matching auth key', () => {
  const keys = generateRSA();
  const hs = new Handshake({ rsaKeys: keys });
  const fingerprint = rsaFingerprint(keys.n, keys.e);

  // 1) req_pq_multi -> resPQ
  const nonce = crypto.randomBytes(16);
  const reqPq = new TLBuffer();
  reqPq.putUint(ID.reqPqMulti);
  reqPq.putInt128(nonce);
  const resPQ = hs.processPlain(reqPq.buffer).response;
  const r = new TLBuffer(resPQ);
  assert.equal(r.uint(), ID.resPq);
  assert.deepEqual(r.int128(), nonce);
  const serverNonce = Buffer.from(r.int128());
  assert.equal(serverNonce.length, 16);
  const pq = Buffer.from(r.bytes());
  const fps = r.vector((rr) => rr.long());
  assert.deepEqual(fps.map((f) => BigInt.asUintN(64, f)), [fingerprint]);
  assert.deepEqual(pq, Buffer.from([0x01, 0x43])); // 17 * 19 = 323

  // 2) req_DH_params -> server_DH_params_ok
  const p = Buffer.from([17]);
  const q = Buffer.from([19]);
  const newNonce = crypto.randomBytes(32);
  const inner = new TLBuffer();
  inner.putUint(ID.pQInnerData);
  inner.putBytes(pq);
  inner.putBytes(p);
  inner.putBytes(q);
  inner.putInt128(nonce);
  inner.putInt128(serverNonce);
  inner.putInt256(newNonce);
  const encryptedData = rsaPadEncrypt(inner.buffer, keys);

  const reqDh = new TLBuffer();
  reqDh.putUint(ID.reqDhParams);
  reqDh.putInt128(nonce);
  reqDh.putInt128(serverNonce);
  reqDh.putBytes(p);
  reqDh.putBytes(q);
  reqDh.putLong(BigInt.asIntN(64, fingerprint));
  reqDh.putBytes(encryptedData);
  const dhOk = hs.processPlain(reqDh.buffer).response;
  const dr = new TLBuffer(dhOk);
  assert.equal(dr.uint(), ID.serverDhParamsOk);
  assert.deepEqual(dr.int128(), nonce);
  assert.deepEqual(dr.int128(), serverNonce);
  const encryptedAnswer = Buffer.from(dr.bytes());

  // Client derives the same tmp_aes_key / tmp_aes_iv.
  const shaNewServer = sha1(newNonce, serverNonce);
  const shaServerNew = sha1(serverNonce, newNonce);
  const shaNewNew = sha1(newNonce, newNonce);
  const tmpKey = Buffer.concat([shaNewServer, shaServerNew.subarray(0, 12)]);
  const tmpIv = Buffer.concat([shaServerNew.subarray(12, 20), shaNewNew, newNonce.subarray(0, 4)]);
  const answerWithHash = igeDecrypt(tmpKey, tmpIv, encryptedAnswer);
  // server_DH_inner_data: 4 + 16 + 16 + 4 + (1+256+3) + (1+256+3) + 4 = 564 bytes.
  assert.deepEqual(answerWithHash.subarray(0, 20), sha1(answerWithHash.subarray(20, 20 + 564)));
  assert.equal(answerWithHash.length % 16, 0);

  const ar = new TLBuffer(answerWithHash.subarray(20));
  assert.equal(ar.uint(), ID.serverDhInnerData);
  assert.deepEqual(ar.int128(), nonce);
  assert.deepEqual(ar.int128(), serverNonce);
  assert.equal(ar.int(), 3);
  const dhPrime = Buffer.from(ar.bytes());
  const gA = Buffer.from(ar.bytes());
  assert.equal(dhPrime.length, 256);
  assert.equal(gA.length, 256);
  assert.ok(ar.int() > 0); // server_time

  // 3) set_client_DH_params -> dh_gen_ok
  const b = BigInt(`0x${crypto.randomBytes(32).toString('hex')}`) | 1n;
  const prime = BigInt(`0x${dhPrime.toString('hex')}`);
  const gABig = BigInt(`0x${gA.toString('hex')}`);
  const gB = toBE256(modPow(3n, b, prime));
  const authKeyClient = toBE256(modPow(gABig, b, prime));

  const clientInner = new TLBuffer();
  clientInner.putUint(ID.clientDhInnerData);
  clientInner.putInt128(nonce);
  clientInner.putInt128(serverNonce);
  clientInner.putLong(0n);
  clientInner.putBytes(gB);
  const clientDataWithHash = Buffer.concat([
    sha1(clientInner.buffer),
    clientInner.buffer,
    hashPad(clientInner.buffer),
  ]);
  const encryptedClientDh = igeEncrypt(tmpKey, tmpIv, clientDataWithHash);

  const setReq = new TLBuffer();
  setReq.putUint(ID.setClientDhParams);
  setReq.putInt128(nonce);
  setReq.putInt128(serverNonce);
  setReq.putBytes(encryptedClientDh);
  const final = hs.processPlain(setReq.buffer);
  assert.equal(final.response.readUInt32LE(0), ID.dhGenOk);
  assert.deepEqual(final.authKey, authKeyClient);
  assert.equal(final.authKey.length, 256);

  const fr = new TLBuffer(final.response);
  assert.equal(fr.uint(), ID.dhGenOk);
  assert.deepEqual(fr.int128(), nonce);
  assert.deepEqual(fr.int128(), serverNonce);
  const newNonceHash1 = Buffer.from(fr.int128());
  const authHash = sha1(authKeyClient);
  const expectedHash1 = sha1(newNonce, Buffer.from([1]), authHash.subarray(0, 8)).subarray(4, 20);
  assert.deepEqual(newNonceHash1, expectedHash1);

  const expectedSalt = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) expectedSalt[i] = newNonce[i] ^ serverNonce[i];
  assert.deepEqual(final.serverSalt, expectedSalt);
  assert.deepEqual(hs.serverNonce, serverNonce);
  assert.deepEqual(hs.newNonce, newNonce);

  // 4) Encrypted session round trips (client -> server, server -> client).
  const sessionId = crypto.randomBytes(8);
  const clientSession = new SessionContext(authKeyClient, expectedSalt, { sessionId, role: 'client' });
  const serverSession = new SessionContext(authKeyClient, expectedSalt, { sessionId, role: 'server' });

  const pingInner = new TLBuffer();
  pingInner.putUint(0x7abe77ec);
  pingInner.putLong(12345n);
  const enc1 = clientSession.encrypt(pingInner.buffer, { contentRelated: true });
  const dec1 = serverSession.decrypt(enc1.authKeyId, enc1.msgKey, enc1.ciphertext);
  assert.deepEqual(dec1.body, pingInner.buffer);
  assert.equal(dec1.seqNo & 1, 1);
  assert.deepEqual(dec1.sessionId, sessionId);
  assert.deepEqual(dec1.salt, expectedSalt);

  const pongInner = new TLBuffer();
  pongInner.putUint(0x347773c5);
  pongInner.putLong(enc1.msgId);
  pongInner.putLong(12345n);
  const enc2 = serverSession.encrypt(pongInner.buffer, { contentRelated: false });
  const dec2 = clientSession.decrypt(enc2.authKeyId, enc2.msgKey, enc2.ciphertext);
  assert.deepEqual(dec2.body, pongInner.buffer);
  assert.equal(dec2.seqNo & 1, 0);
});

test('fake req_pq probe is answered with resPQ and retransmits are cached', () => {
  const keys = generateRSA();
  const hs = new Handshake({ rsaKeys: keys });

  const probe = new TLBuffer();
  probe.putUint(ID.reqPq);
  probe.putInt128(Buffer.alloc(16, 0x5a));
  const first = hs.processPlain(probe.buffer);
  const second = hs.processPlain(probe.buffer);
  assert.deepEqual(second.response, first.response);
  assert.equal(first.response.readUInt32LE(0), ID.resPq);

  // The probe's nonce is echoed and a fresh server_nonce was produced.
  const r = new TLBuffer(first.response);
  r.uint();
  assert.deepEqual(r.int128(), Buffer.alloc(16, 0x5a));
  assert.notDeepEqual(r.int128(), Buffer.alloc(16));
});

test('packMessage / unpackMessage round trip', () => {
  const salt = crypto.randomBytes(8);
  const sessionId = crypto.randomBytes(8);
  const body = Buffer.from('hello mtproto');
  const msg = packMessage({
    salt,
    sessionId,
    msgId: 0x123456789n,
    seqNo: 5,
    body,
  });
  assert.equal(msg.length % 16, 0);
  const out = unpackMessage(msg);
  assert.deepEqual(out.salt, salt);
  assert.deepEqual(out.sessionId, sessionId);
  assert.equal(out.msgId, 0x123456789n);
  assert.equal(out.seqNo, 5);
  assert.deepEqual(out.body, body);
  assert.ok(out.padding.length >= 12 && out.padding.length <= 1024);
});

test('plaintext envelope and service message codecs', () => {
  const body = Buffer.from([1, 2, 3, 4]);
  const env = packPlainEnvelope(body);
  assert.equal(env.readBigUInt64LE(0), 0n);
  assert.equal(env.readBigInt64LE(8) & 3n, 1n);
  const parsed = unpackPlainEnvelope(env);
  assert.deepEqual(parsed.body, body);

  assert.deepEqual(readMsgsAck(msgsAck([11n, 22n])).map(String), ['11', '22']);
  const ping = new TLBuffer();
  ping.putUint(0x7abe77ec);
  ping.putLong(42n);
  assert.equal(readPing(ping.buffer).pingId, 42n);
  assert.equal(pong(1n, 42n).readUInt32LE(0), 0x347773c5);
  const container = joinContainer([
    { msgId: 1n, seqNo: 1, body: Buffer.alloc(4, 0xaa) },
    { msgId: 2n, seqNo: 3, body: Buffer.alloc(8, 0xbb) },
  ]);
  assert.deepEqual(splitContainer(container).map((m) => m.body.length), [4, 8]);
  assert.deepEqual(
    readBadMsgNotification(badServerSalt(7n, 2, 20, 5n)).newServerSalt,
    5n,
  );
  assert.equal(readNewSessionCreated(newSessionCreated(1n, 2n, 3n)).serverSalt, 3n);
  const salts = readFutureSalts(futureSalts(9n, 100, [{ validSince: 10, validUntil: 20, salt: 6n }]));
  assert.equal(salts.salts[0].salt, 6n);
});

test('obfuscation encode/decode round trip in both directions', () => {
  const client = new ObfuscationCodec({ protocol: 'abridged', dcId: 1 });
  const payload = Buffer.from('client payload, long enough to span blocks');
  const wire = client.encode(payload);
  assert.ok(wire.length >= 64 + payload.length);

  const prefix = wire.subarray(0, 64);
  // Bytes 56..63 are encrypted with the client's send CTR stream; decrypt them
  // to check that the protocol id and dc id were placed correctly.
  const check = crypto.createCipheriv('aes-256-ctr', prefix.subarray(8, 40), prefix.subarray(40, 56));
  check.update(prefix.subarray(0, 56));
  const initTail = check.update(prefix.subarray(56, 64));
  assert.equal(initTail.readUInt32LE(0), 0xefefefef);
  assert.equal(initTail.readInt16LE(4), 1);

  const server = ObfuscationCodec.fromPrefix(prefix);
  assert.deepEqual(server.decode(wire.subarray(64)), payload);

  const reply = Buffer.from('server reply payload');
  const replyWire = server.encode(reply);
  assert.deepEqual(client.decode(replyWire), reply);

  // Feeding byte-by-byte must give the same result.
  const client2 = new ObfuscationCodec();
  const wire2 = client2.encode(payload);
  const server2 = new ObfuscationCodec({ role: 'server' });
  let out = Buffer.alloc(0);
  for (const byte of wire2) out = Buffer.concat([out, server2.feed(Buffer.from([byte]))]);
  assert.deepEqual(out, payload);
});

test('framing round trip and partial-frame buffering', () => {
  for (const transport of ['abridged', 'intermediate', 'padded']) {
    const codec = new FrameCodec(transport);
    const payload = Buffer.alloc(44, 0xa5);
    const frame = codec.encode(payload);
    const recv = new FrameCodec(transport);
    const frames = recv.feed(frame);
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0].subarray(0, payload.length), payload);

    const recv2 = new FrameCodec(transport);
    let pieces = [];
    for (let i = 0; i < frame.length; i++) {
      pieces = pieces.concat(recv2.feed(frame.subarray(i, i + 1)));
    }
    assert.equal(pieces.length, 1);
    assert.deepEqual(pieces[0].subarray(0, payload.length), payload);
  }

  // Two frames arriving in a single chunk.
  const codec = new FrameCodec('intermediate');
  const a = Buffer.alloc(16, 1);
  const b = Buffer.alloc(20, 2);
  const both = Buffer.concat([codec.encode(a), codec.encode(b)]);
  assert.deepEqual(new FrameCodec('intermediate').feed(both), [a, b]);

  // transport id recognition from the obfuscation prefix.
  const probe = new FrameCodec('abridged');
  assert.equal(probe.transportIdOf(Buffer.from([0xef, 0xef, 0xef, 0xef])), 'abridged');
  assert.equal(probe.transportIdOf(Buffer.from([0xee, 0xee, 0xee, 0xee])), 'intermediate');
  assert.equal(probe.transportIdOf(Buffer.from([0xdd, 0xdd, 0xdd, 0xdd])), 'padded');
  assert.equal(probe.transportIdOf(Buffer.from([0x01, 0x02, 0x03, 0x04])), null);
});
