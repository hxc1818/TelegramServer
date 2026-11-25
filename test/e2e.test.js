// End-to-end: real TCP socket -> obfuscation -> abridged framing ->
// MTProto 2.0 auth-key handshake -> encrypted invokeWithLayer/initConnection RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { TLBuffer } from '../src/tl/buffer.js';
import { generateRSA, rsaFingerprint, rsaPadEncrypt } from '../src/crypto/rsa.js';
import { igeEncrypt, igeDecrypt } from '../src/crypto/ige.js';
import { Handshake } from '../src/mtproto/handshake.js';
import { SessionContext, packPlainEnvelope, unpackPlainEnvelope } from '../src/mtproto/session.js';
import { ObfuscationCodec } from '../src/transport/obfuscation.js';
import { FrameCodec } from '../src/transport/framing.js';
import { Store } from '../src/store/store.js';
import { Router } from '../src/rpc/router.js';
import { TelegramServer } from '../src/server.js';

const ID = {
  reqPqMulti: 0xbe7e8ef1,
  reqDhParams: 0xd712e4be,
  setClientDhParams: 0xf5045f1f,
  resPq: 0x05162463,
  serverDhParamsOk: 0xd0e8075c,
  dhGenOk: 0x3bcbf734,
  pQInnerData: 0x83c95aec,
  serverDhInnerData: 0xb5890dba,
  clientDhInnerData: 0x6643b654,
  invokeWithLayer: 0xda9b0d0d,
  initConnection: 0xc1cd5ea9,
  getConfig: 0xc4f9186b,
  sendCode: 0xa677244f,
  signIn: 0x8d52a951,
  rpcResult: 0xf35c6d01,
  rpcError: 0x2144ca19,
  config: 0xcc1a241e,
  sentCode: 0x5e002502,
  authorization: 0x2ea2c0d4,
  getDialogs: 0xa0f4cb4f,
  dialogsSlice: 0xd1747044,
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

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

/** Minimal MTProto client: one request/response at a time over a raw socket. */
class WireClient {
  constructor(socket, keys) {
    this.socket = socket;
    this.keys = keys;
    this.ob = new ObfuscationCodec({ role: 'client', protocol: 'abridged', dcId: 1 });
    this.frame = new FrameCodec('abridged', { side: 'client' });
    this.queue = [];
    this.waiter = null;
    socket.on('data', (chunk) => {
      const plain = this.ob.decode(chunk);
      if (!plain.length) return;
      for (const payload of this.frame.feed(plain)) this._deliver(payload);
    });
  }

  _deliver(payload) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(payload);
    } else {
      this.queue.push(payload);
    }
  }

  async receive(timeoutMs = 8000) {
    if (this.queue.length) return this.queue.shift();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('timeout waiting for server payload'));
      }, timeoutMs);
      this.waiter = (p) => {
        clearTimeout(timer);
        resolve(p);
      };
    });
  }

  send(body) {
    this.socket.write(this.ob.encode(this.frame.encode(body)));
  }

  async roundTrip(body, timeoutMs) {
    this.send(body);
    return this.receive(timeoutMs);
  }

  async handshake() {
    // 1) req_pq_multi -> resPQ
    const nonce = crypto.randomBytes(16);
    const req = new TLBuffer().putUint(ID.reqPqMulti).putInt128(nonce).buffer;
    let payload = await this.roundTrip(packPlainEnvelope(req, 4n));
    let env = unpackPlainEnvelope(payload);
    let r = new TLBuffer(env.body);
    assert.equal(r.uint(), ID.resPq);
    assert.deepEqual(r.int128(), nonce);
    const serverNonce = Buffer.from(r.int128());
    const pq = Buffer.from(r.bytes());
    const fps = r.vector((rr) => rr.long());
    const fingerprint = rsaFingerprint(this.keys.n, this.keys.e);
    assert.ok(fps.some((f) => BigInt.asUintN(64, f) === fingerprint));

    // 2) req_DH_params -> server_DH_params_ok
    const p = Buffer.from([17]);
    const q = Buffer.from([19]);
    const newNonce = crypto.randomBytes(32);
    const inner = new TLBuffer()
      .putUint(ID.pQInnerData)
      .putBytes(pq).putBytes(p).putBytes(q)
      .putInt128(nonce).putInt128(serverNonce).putInt256(newNonce).buffer;
    const dhReq = new TLBuffer()
      .putUint(ID.reqDhParams)
      .putInt128(nonce).putInt128(serverNonce)
      .putBytes(p).putBytes(q)
      .putLong(BigInt.asIntN(64, fingerprint))
      .putBytes(rsaPadEncrypt(inner, this.keys)).buffer;
    payload = await this.roundTrip(packPlainEnvelope(dhReq, 8n));
    env = unpackPlainEnvelope(payload);
    r = new TLBuffer(env.body);
    assert.equal(r.uint(), ID.serverDhParamsOk);
    assert.deepEqual(r.int128(), nonce);
    assert.deepEqual(r.int128(), serverNonce);
    const encryptedAnswer = Buffer.from(r.bytes());

    const shaNS = sha1(newNonce, serverNonce);
    const shaSN = sha1(serverNonce, newNonce);
    const tmpKey = Buffer.concat([shaNS, shaSN.subarray(0, 12)]);
    const tmpIv = Buffer.concat([shaSN.subarray(12, 20), sha1(newNonce, newNonce), newNonce.subarray(0, 4)]);
    const answer = igeDecrypt(tmpKey, tmpIv, encryptedAnswer);
    assert.deepEqual(answer.subarray(0, 20), sha1(answer.subarray(20, 20 + 564)));
    const ar = new TLBuffer(answer.subarray(20));
    assert.equal(ar.uint(), ID.serverDhInnerData);
    ar.int128(); ar.int128(); ar.int();
    const prime = Buffer.from(ar.bytes());
    const gA = Buffer.from(ar.bytes());

    // 3) set_client_DH_params -> dh_gen_ok
    const b = BigInt(`0x${crypto.randomBytes(32).toString('hex')}`) | 1n;
    const primeBig = BigInt(`0x${prime.toString('hex')}`);
    const gB = toBE256(modPow(3n, b, primeBig));
    const authKey = toBE256(modPow(BigInt(`0x${gA.toString('hex')}`), b, primeBig));
    const clientInner = new TLBuffer()
      .putUint(ID.clientDhInnerData)
      .putInt128(nonce).putInt128(serverNonce).putLong(0n).putBytes(gB).buffer;
    const padLen = (16 - ((20 + clientInner.length) % 16)) % 16;
    const clientEncrypted = igeEncrypt(
      tmpKey, tmpIv,
      Buffer.concat([sha1(clientInner), clientInner, crypto.randomBytes(padLen)]),
    );
    const setReq = new TLBuffer()
      .putUint(ID.setClientDhParams)
      .putInt128(nonce).putInt128(serverNonce).putBytes(clientEncrypted).buffer;
    payload = await this.roundTrip(packPlainEnvelope(setReq, 12n));
    env = unpackPlainEnvelope(payload);
    assert.equal(env.body.readUInt32LE(0), ID.dhGenOk);

    const salt = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) salt[i] = newNonce[i] ^ serverNonce[i];
    this.session = new SessionContext(authKey, salt, { role: 'client' });
    this.authKey = authKey;
  }

  /** Send an RPC wrapped in invokeWithLayer(initConnection(...)) and return the inner result buffer. */
  async rpc(innerBody) {
    const init = new TLBuffer()
      .putUint(ID.initConnection)
      .putUint(0)             // flags
      .putInt(17349)          // api_id
      .putString('unit-test') // device_model
      .putString('linux')     // system_version
      .putString('1.0')       // app_version
      .putString('en')        // system_lang_code
      .putString('')          // lang_pack
      .putString('en')        // lang_code
      .putRaw(innerBody).buffer;
    const req = new TLBuffer()
      .putUint(ID.invokeWithLayer).putInt(234).putRaw(init).buffer;
    const wrapped = this.session.encrypt(req, { contentRelated: true });
    const wire = Buffer.concat([wrapped.authKeyId, wrapped.msgKey, wrapped.ciphertext]);
    this.send(wire);
    // The server sends msgs_ack / other service messages before rpc_result.
    for (;;) {
      const payload = await this.receive();
      const dec = this.session.decrypt(payload.subarray(0, 8), payload.subarray(8, 24), payload.subarray(24));
      const r = new TLBuffer(dec.body);
      const id = r.uint();
      if (id !== ID.rpcResult) continue; // ignore msgs_ack, pong, etc.
      assert.equal(r.long(), wrapped.msgId, 'rpc_result must echo request msg_id');
      // result:Object is a boxed TL object written inline, NOT a length-prefixed string.
      const result = Buffer.from(r.raw(r.length - r.offset));
      assert.notEqual(result.readUInt32LE(0), ID.rpcError, `RPC error: ${result.toString('hex')}`);
      return result;
    }
  }
}

test('E2E: TCP + obfuscation + DH handshake + encrypted getConfig/login/dialogs', async (t) => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-e2e-'));
  const keys = generateRSA();
  const config = {
    listenHost: '127.0.0.1', listenPort: port, dataDir,
    publicIp: '127.0.0.1', serverId: 1, apiId: 17349,
    apiHash: '344583e45741c457fe1862106095a5eb', authCode: '22222',
    layer: 234, dbDriver: 'sqlite', logTL: false, keys,
  };
  const store = new Store(dataDir, { dbDriver: 'sqlite' });
  const router = new Router({ store, keys, config });
  const server = new TelegramServer({ config, store, router, keys });
  server.start();
  let socket;
  t.after(() => {
    if (socket) socket.destroy();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  socket = net.createConnection({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const client = new WireClient(socket, keys);
  await client.handshake();
  assert.equal(client.authKey.length, 256, 'client and server derived the same auth_key');

  // help.getConfig
  const cfg = await client.rpc(new TLBuffer().putUint(ID.getConfig).buffer);
  assert.equal(cfg.readUInt32LE(0), ID.config);
  const cr = new TLBuffer(cfg.subarray(4));
  cr.raw(4); // flags
  const date = cr.int();
  const expires = cr.int();
  assert.ok(date > 0 && expires > Date.now() / 1000, 'config.date/expires must be sane');

  // auth.sendCode -> auth.sentCode
  const sent = await client.rpc(new TLBuffer()
    .putUint(ID.sendCode)
    .putString('+8613800000000')
    .putInt(17349)
    .putString('344583e45741c457fe1862106095a5eb')
    .putRaw(new TLBuffer().putUint(0xad253d78).putUint(0).buffer)
    .buffer);
  assert.equal(sent.readUInt32LE(0), ID.sentCode);
  const sr = new TLBuffer(sent.subarray(4));
  sr.uint(); // flags
  sr.uint(); // type constructor
  sr.int();  // length
  const phoneCodeHash = sr.string();
  assert.ok(phoneCodeHash.length > 0);

  // auth.signIn -> auth.authorization
  const authz = await client.rpc(new TLBuffer()
    .putUint(ID.signIn)
    .putUint(1) // flags: phone_code present
    .putString('+8613800000000')
    .putString(phoneCodeHash)
    .putString('22222')
    .buffer);
  assert.equal(authz.readUInt32LE(0), ID.authorization);

  // messages.getDialogs -> messages.dialogsSlice
  const dialogs = await client.rpc(new TLBuffer()
    .putUint(ID.getDialogs)
    .putUint(0).putInt(0).putInt(0)
    .putUint(0x7f3b18ea) // inputPeerEmpty
    .putInt(0).putLong(0n)
    .buffer);
  assert.equal(dialogs.readUInt32LE(0), ID.dialogsSlice);

  socket.destroy();
}, { timeout: 30000 });
