// End-to-end secret-chat crypto tests: real DH, key fingerprint, AES-256-IGE
// envelope, DecryptedMessage parsing and tamper rejection.
// Specs: https://core.telegram.org/api/end-to-end , https://core.telegram.org/schema/end-to-end
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TLBuffer } from '../src/tl/buffer.js';
import { SecretStore } from '../src/store/secret.js';
import {
  DH_PRIME,
  DH_GENERATOR,
  bigintToBytes,
  deriveE2EKey,
  computeKeyFingerprint,
  computeSharedKeyFingerprint,
  computeSecretMsgKey,
  serializeSecretPlaintext,
  encryptSecretMessage,
  decryptSecretMessage,
} from '../src/crypto/secret.js';
import * as e2e from '../src/rpc/handlers/secret-e2e.js';

function tempDir() {
  const dir = path.join(os.tmpdir(), `telegramserver-e2e-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function randomExponent() {
  return BigInt(`0x${crypto.randomBytes(256).toString('hex')}`) | (1n << 2047n);
}

function ctorOf(buf) { return new TLBuffer(buf).uint() >>> 0; }
function vectorOf(r) {
  assert.equal(r.uint(), 0x1cb5c415);
  return r.int();
}

function decryptedMessageLayer(text, randomId = 12345n) {
  const inner = new TLBuffer()
    .putUint(0x204d3878) // decryptedMessage#204d3878 (layer 17)
    .putLong(randomId).putInt(0).putString(text)
    .putUint(0x89f5c4a) // decryptedMessageMediaEmpty
    .buffer;
  return new TLBuffer()
    .putUint(0x1be31789) // decryptedMessageLayer#1be31789
    .putBytes(Buffer.alloc(16)).putInt(46).putInt(0).putInt(1)
    .putRaw(inner).buffer;
}

test('DH constants: Telegram 2048-bit good prime and g=3', () => {
  assert.equal(DH_PRIME.toString(16).length, 512);
  assert.equal(DH_PRIME % 3n, 2n); // g=3 quadratic residue condition
  assert.equal(DH_GENERATOR, 3n);
  assert.equal(e2e.METHOD_IDS['messages.requestEncryption'], 0xf64daf43);
  assert.equal(e2e.METHOD_IDS['messages.acceptEncryption'], 0x3dbc0415);
  assert.equal(e2e.METHOD_IDS['messages.readEncryptedHistory'], 0x7f4b690a);
  assert.equal(e2e.METHOD_IDS['messages.sendEncrypted'], 0x44fa7a15);
  assert.equal(e2e.METHOD_IDS['messages.sendEncryptedFile'], 0x5559481d);
});

test('deriveE2EKey pads the shared secret to exactly 256 big-endian bytes', () => {
  const key = deriveE2EKey(bigintToBytes(0x1234n));
  assert.equal(key.length, 256);
  assert.equal(key[254], 0x12);
  assert.equal(key[255], 0x34);
  assert.equal(deriveE2EKey(0x1234n).toString('hex'), key.toString('hex'));
});

test('computeKeyFingerprint: spec SHA1(key) low64 and symmetric ordered variant', () => {
  const key = deriveE2EKey(BigInt(`0x${'ab'.repeat(32)}`));
  const digest = crypto.createHash('sha1').update(key).digest();
  assert.equal(computeSharedKeyFingerprint(key), digest.readBigInt64LE(12));
  assert.equal(computeKeyFingerprint(key), digest.readBigInt64LE(12));

  const a = Buffer.from('aa'.repeat(32), 'hex');
  const b = Buffer.from('bb'.repeat(32), 'hex');
  const canonical = crypto.createHash('sha1').update(Buffer.concat([a, b])).digest().readBigInt64LE(12);
  assert.equal(computeKeyFingerprint(a, b), canonical);
  assert.equal(computeKeyFingerprint(b, a), canonical); // order independent
  assert.notEqual(canonical, computeSharedKeyFingerprint(a));
});

test('IGE envelope round-trip: msg_key, fingerprint and padding rules', () => {
  const key = deriveE2EKey(crypto.randomBytes(256));
  const tl = decryptedMessageLayer('secret payload');
  for (const x of [0, 8]) {
    const plain = serializeSecretPlaintext(tl);
    const ct = encryptSecretMessage(key, tl, { x, plaintext: plain });
    assert.equal(ct.readBigInt64LE(0), computeSharedKeyFingerprint(key));
    assert.equal((ct.length - 24) % 16, 0); // envelope: 24 + multiple of 16
    assert.equal(computeSecretMsgKey(key, plain, x).toString('hex'), ct.subarray(8, 24).toString('hex'));
    const out = decryptSecretMessage(key, ct, { x, fingerprint: computeSharedKeyFingerprint(key) });
    assert.equal(out.tlData.toString('hex'), tl.toString('hex'));
    assert.ok(out.padding >= 12 && out.padding <= 1024);
    assert.equal(plain.length % 16, 0);
  }
});

test('tampered ciphertext and wrong key/fingerprint are rejected', () => {
  const key = deriveE2EKey(crypto.randomBytes(256));
  const ct = encryptSecretMessage(key, decryptedMessageLayer('do not tamper'));
  const bad = Buffer.from(ct);
  bad[30] ^= 0x01; // flip a ciphertext bit (msg_key stays unchanged)
  assert.throws(() => decryptSecretMessage(key, bad), /msg_key mismatch/);
  assert.throws(() => decryptSecretMessage(key, ct, { fingerprint: 123n }), /fingerprint mismatch/);
  const other = deriveE2EKey(crypto.randomBytes(256));
  assert.throws(() => decryptSecretMessage(other, ct), /msg_key mismatch/);
  assert.throws(() => decryptSecretMessage(key, ct.subarray(0, 20)), /too short/);
});

test('full flow: requestEncryption -> shared key -> sendEncrypted decrypts plaintext', () => {
  const dir = tempDir();
  const store = new SecretStore(dir);
  const ctx = { userId: 1, secretStore: store, secretUpdateQueue: [] };
  try {
    // 1. client A generates a and g_a
    const a = randomExponent();
    const gA = e2e.modPow(DH_GENERATOR, a, DH_PRIME);

    // 2. requestEncryption: server generates g_b and persists the chat
    const requested = e2e.requestEncryption({
      userId: 2, accessHash: 77, randomId: 11, gA: bigintToBytes(gA),
    }, ctx);
    assert.equal(ctorOf(requested), 0x48f1d94c); // encryptedChatRequested
    const rr = new TLBuffer(requested);
    rr.uint(); rr.uint();
    const chatId = rr.int();
    assert.equal(Number(rr.long()), 77);
    rr.int(); rr.long(); rr.long();
    const gBbytes = rr.bytes(); // server's g_b
    assert.ok(gBbytes.length >= 256);
    const gB = BigInt(`0x${gBbytes.toString('hex')}`);
    assert.equal(store.getChat(chatId).state, 'requested');
    assert.equal(store.getChat(chatId).gB.toString('hex'), gBbytes.toString('hex'));

    // 3. client A derives the SAME shared key and fingerprint
    const shared = e2e.modPow(gB, a, DH_PRIME);
    const key = deriveE2EKey(shared);
    const fp = computeSharedKeyFingerprint(key);
    assert.equal(store.getChat(chatId).keyFingerprint, fp);
    assert.ok(e2e.validPublic(gBbytes) || gBbytes.length > 256);

    // 4. acceptEncryption verifies the client-supplied fingerprint
    const accepted = e2e.acceptEncryption({
      peer: { chatId, accessHash: 77 }, gB: gBbytes, keyFingerprint: fp,
    }, ctx);
    assert.equal(ctorOf(accepted), 0x61f0d4c7); // encryptedChat
    const ar = new TLBuffer(accepted);
    ar.uint(); assert.equal(ar.int(), chatId);
    ar.long(); ar.int(); ar.long(); ar.long();
    assert.equal(ar.bytes().toString('hex'), gBbytes.toString('hex'));
    assert.equal(ar.long(), fp);
    assert.equal(store.getChat(chatId).state, 'accepted');
    assert.ok(ctx.secretUpdateQueue.some((u) => ctorOf(u) === 0xb4a2e88d));

    // 5. client encrypts a decryptedMessageLayer with x=0 (originator)
    const text = 'hello from the initiator';
    const tl = decryptedMessageLayer(text);
    const data = encryptSecretMessage(key, tl, { x: 0, fingerprint: fp });
    const beforeQts = store.getChat(chatId).qts;

    // 6. server decrypts it, stores plaintext, and re-encrypts for the peer
    const updates = e2e.sendEncrypted({ peer: { chatId }, randomId: 99n, data }, ctx);
    assert.equal(ctorOf(updates), 0x74ae4240); // updates
    const ur = new TLBuffer(updates);
    ur.uint();
    assert.equal(vectorOf(ur), 1);
    assert.equal(ur.uint(), 0x12bcbd9a); // updateNewEncryptedMessage
    assert.equal(ur.uint(), 0xed18c118); // encryptedMessage
    assert.equal(Number(ur.long()), 99);
    assert.equal(ur.int(), chatId);
    ur.int();
    const redelivered = ur.bytes();
    assert.equal(ur.uint(), 0xc21f497e); // encryptedFileEmpty
    assert.equal(ur.int(), beforeQts + 1);
    assert.notEqual(redelivered.toString('hex'), data.toString('hex'));
    assert.equal(store.listMessages(chatId)[0].text, text);
    const state = e2e.getE2EState(chatId, ctx);
    assert.equal(state.parsed.text, text);
    assert.equal(state.parsed.layer, 46);
    const peerOut = decryptSecretMessage(key, redelivered, { x: 8 });
    assert.equal(peerOut.tlData.toString('hex'), tl.toString('hex'));

    // 7. readEncryptedHistory records read state with the right update
    const read = e2e.readEncryptedHistory({ peer: { chatId }, maxDate: 4102444800 }, ctx);
    assert.equal(read.readUInt32LE(0), 0x997275b5);
    assert.ok(ctx.secretUpdateQueue.some((u) => ctorOf(u) === 0x38fe25b7));
    assert.equal(store.listMessages(chatId)[0].read, 1);
  } finally {
    store.close();
  }
});

test('sendEncrypted rejects tampered ciphertext and a mismatched fingerprint', () => {
  const dir = tempDir();
  const store = new SecretStore(dir);
  const ctx = { userId: 1, secretStore: store };
  try {
    const a = randomExponent();
    const gA = e2e.modPow(DH_GENERATOR, a, DH_PRIME);
    const requested = e2e.requestEncryption({ userId: 2, gA: bigintToBytes(gA) }, ctx);
    const rr = new TLBuffer(requested);
    rr.uint(); rr.uint();
    const chatId = rr.int();
    rr.long(); rr.int(); rr.long(); rr.long();
    const gB = rr.bytes();
    const key = deriveE2EKey(e2e.modPow(BigInt(`0x${gB.toString('hex')}`), a, DH_PRIME));
    const tl = decryptedMessageLayer('attack');
    const bad = encryptSecretMessage(key, tl);
    bad[28] ^= 0x02;
    assert.throws(() => e2e.sendEncrypted({ peer: { chatId }, randomId: 1n, data: bad }, ctx), /msg_key mismatch/);
    assert.equal(store.listMessages(chatId).length, 0);
    const wrongFp = encryptSecretMessage(key, tl, { fingerprint: 42n });
    assert.throws(() => e2e.sendEncrypted({ peer: { chatId }, randomId: 2n, data: wrongFp }, ctx), /fingerprint mismatch/);
  } finally {
    store.close();
  }
});

test('acceptEncryption rejects a wrong key_fingerprint', () => {
  const dir = tempDir();
  const store = new SecretStore(dir);
  const ctx = { userId: 1, secretStore: store };
  try {
    const a = randomExponent();
    const gA = e2e.modPow(DH_GENERATOR, a, DH_PRIME);
    const requested = e2e.requestEncryption({ userId: 2, gA: bigintToBytes(gA) }, ctx);
    const rr = new TLBuffer(requested);
    rr.uint(); rr.uint(); const chatId = rr.int();
    rr.long(); rr.int(); rr.long(); rr.long();
    const gB = rr.bytes();
    assert.throws(() => e2e.acceptEncryption({
      peer: { chatId }, gB, keyFingerprint: 123456789n,
    }, ctx), /key_fingerprint mismatch/);
  } finally {
    store.close();
  }
});
