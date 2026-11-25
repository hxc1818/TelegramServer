// MTProto 2.0 TCP server: obfuscation -> framing -> handshake / encrypted
// session -> RPC router. Plain ESM, zero npm dependencies.
import net from 'node:net';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TLBuffer } from './tl/buffer.js';
import { loadConfig } from './config.js';
import { Store } from './store/store.js';
import { Router, methodNameOf } from './rpc/router.js';
import * as C from './rpc/handlers/codecs.js';
import { ObfuscatedSocket } from './transport/obfuscation.js';
import { FrameCodec } from './transport/framing.js';
import { Handshake } from './mtproto/handshake.js';
import {
  SessionContext, newServerMsgId, deriveAesKeys, computeMsgKey, unpackMessage,
} from './mtproto/session.js';
import { igeDecrypt } from './crypto/ige.js';

const SERVICE_IDS = new Set([
  0x62d6b459, // msgs_ack
  0xa7eff811, // bad_msg_notification
  0xedab447b, // bad_server_salt
  0xda69fb52, // msgs_state_req
  0x8cc0d131, // msgs_all_info
  0x7d861a08, // msg_resend_req
  0x58e4a740, // rpc_drop_answer
  0xe7512126, // destroy_session
  0xb921bd04, // get_future_salts
]);

function idBuffer(value) {
  const b = Buffer.alloc(8);
  if (typeof value === 'bigint') b.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
  else if (Buffer.isBuffer(value)) value.copy(b, 0, 0, 8);
  else if (typeof value === 'number') b.writeBigUInt64LE(BigInt(value) & 0xffffffffffffffffn, 0);
  return b;
}

function toBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value;
  if (Buffer.isBuffer(value)) return value.length === 8 ? value.readBigUInt64LE(0) : BigInt(`0x${value.toString('hex') || '0'}`);
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string') {
    const s = value.replace(/^0x/, '');
    if (/^[0-9a-f]+$/i.test(s) && s.length <= 16) {
      const b = Buffer.alloc(8);
      Buffer.from(s.padStart(16, '0'), 'hex').copy(b);
      return b.readBigUInt64LE(0);
    }
  }
  return fallback;
}

function gunzip(data) {
  try {
    return zlib.gunzipSync(data);
  } catch {
    return zlib.inflateSync(data);
  }
}

export class TelegramServer {
  constructor({ config, store, router, keys } = {}) {
    this.config = config || loadConfig();
    this.keys = keys || this.config.keys;
    this.store = store || new Store(this.config.dataDir, { dbDriver: this.config.dbDriver });
    this.router = router || new Router({ store: this.store, keys: this.keys, config: this.config });
    this.authKeys = new Map(); // authKeyId (hex) -> authKey Buffer
    this.salts = new Map(); // authKeyId (hex) -> bigint salt
    this.server = null;
  }

  /** Start listening. Returns the underlying net.Server. */
  start() {
    if (this.server) return this.server;
    this.server = net.createServer((socket) => this.onConnection(socket));
    this.server.on('error', (err) => console.error('[server] net error', err));
    this.server.listen(this.config.listenPort, this.config.listenHost, () => {
      console.log(`[server] listening on ${this.config.listenHost}:${this.config.listenPort}`);
    });
    return this.server;
  }

  close() {
    if (this.server) this.server.close();
    this.server = null;
    this.store.close();
  }

  onConnection(socket) {
    const transport = new ObfuscatedSocket(socket);
    let codec = null;
    let pending = Buffer.alloc(0);
    const state = {
      transport,
      socket,
      handshake: null,
      session: null,
      authKeyId: '',
      authKey: null,
      salt: 0n,
      sessionId: crypto.randomBytes(8).readBigUInt64LE(0),
      seq: { content: 1, service: 0 },
      currentSaltOverride: null,
    };

    socket.on('error', (err) => console.error('[server] socket error', err.message));
    transport.on('error', (err) => console.error('[server] transport error', err.message));

    // ObfuscatedSocket strips the 64-byte prefix; the protocol id lives there,
    // so the framing codec is selected when that prefix is accepted.
    transport.on('obfuscationReady', (obCodec) => {
      const id = obCodec?.protocol ?? 0xefefefef;
      const transportId = id === 0xeeeeeeee ? 'intermediate'
        : id === 0xdddddddd ? 'padded' : 'abridged';
      codec = new FrameCodec(transportId);
      if (pending.length) {
        const data = pending;
        pending = Buffer.alloc(0);
        for (const payload of codec.feed(data)) {
          try {
            this.handlePayload(payload, state, codec);
          } catch (err) {
            console.error('[server] payload error', err);
          }
        }
      }
    });

    transport.on('data', (chunk) => {
      if (!codec) {
        pending = Buffer.concat([pending, chunk]);
        return;
      }
      const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      pending = Buffer.alloc(0);
      let payloads;
      try {
        payloads = codec.feed(data) || [];
      } catch (err) {
        console.error('[server] framing error', err);
        return;
      }
      for (const payload of payloads) {
        try {
          this.handlePayload(payload, state, codec);
        } catch (err) {
          console.error('[server] payload error', err);
        }
      }
    });
  }

  writeEnvelope(envelope, state, codec) {
    if (this.config.logTL) console.log('[TL] out', envelope.toString('hex'));
    state.transport.write(codec.encode(envelope));
  }

  nextSeq(contentRelated, state) {
    const kind = contentRelated ? 'content' : 'service';
    const value = state.seq[kind];
    state.seq[kind] += 2;
    return value;
  }

  // ---- plaintext handshake ---------------------------------------------
  handlePlain(payload, state, codec) {
    if (!state.handshake) {
      const HandshakeCtor = Handshake.default || Handshake;
      state.handshake = new HandshakeCtor({ rsaKeys: this.keys });
    }
    const hs = state.handshake;

    // Fake req_pq probe: short packet (4 zero bytes + random nonce), no TL
    // envelope. Feed the handshake a synthetic req_pq so it can answer resPQ.
    const isProbe = payload.length < 20 || (payload.length >= 20 && payload.readUInt32LE(16) < 4);
    if (isProbe) {
      const nonce = Buffer.alloc(16);
      payload.subarray(4, 16).copy(nonce, 0);
      const probeBody = new TLBuffer().putUint(0x60469778).putInt128(nonce).buffer;
      try {
        const probe = typeof hs.handleProbe === 'function'
          ? hs.handleProbe(probeBody)
          : hs.processPlain(probeBody);
        if (probe && probe.response) this.sendPlain(probe.response, state, codec);
      } catch (err) {
        console.error('[server] probe error', err.message);
      }
      return;
    }

    const length = payload.length >= 20 ? payload.readUInt32LE(16) : 0;
    const body = payload.subarray(20, 20 + Math.min(length, Math.max(0, payload.length - 20)));
    let result;
    try {
      result = hs.processPlain(body);
    } catch (err) {
      console.error('[server] handshake error', err.message);
      return;
    }
    if (!result) return;
    if (result.response) this.sendPlain(result.response, state, codec);

    const authKey = result.authKey || hs.authKey || hs.auth_key || hs.getAuthKey?.();
    if (authKey) {
      const hash = crypto.createHash('sha1').update(authKey).digest();
      const id = hash.subarray(12).toString('hex');
      const salt = toBigInt(result.serverSalt ?? hs.serverSalt, crypto.randomBytes(8).readBigUInt64LE(0));
      this.keysByAuthKeyId(id, authKey, salt, state);
    }
  }

  keysByAuthKeyId(id, authKey, salt, state) {
    this.authKeys.set(id, authKey);
    this.salts.set(id, salt);
    state.authKeyId = id;
    state.authKey = authKey;
    state.salt = salt;
    state.session = new SessionContext(authKey, Buffer.from(idBuffer(salt)));
    try {
      this.store.createSession(0, id);
    } catch {
      // A session row is optional until sign-in binds a user to it.
    }
  }

  sendPlain(body, state, codec) {
    const b = new TLBuffer()
      .putLong(0n)
      .putLong(newServerMsgId())
      .putInt(body.length)
      .putRaw(body);
    this.writeEnvelope(b.buffer, state, codec);
  }

  // ---- encrypted messages ----------------------------------------------
  handleEncrypted(payload, state, codec) {
    if (payload.length < 24) return;
    const idHex = payload.subarray(0, 8).toString('hex');
    const msgKey = payload.subarray(8, 24);
    const ciphertext = payload.subarray(24);
    const authKey = this.authKeys.get(idHex) || state.authKey;
    if (!authKey) return;

    let salt = this.salts.get(idHex) ?? state.salt ?? 0n;
    let session = state.session && state.authKeyId === idHex
      ? state.session
      : new SessionContext(authKey, idBuffer(salt));
    if (!state.session || state.authKeyId !== idHex) {
      state.authKeyId = idHex;
      state.authKey = authKey;
      state.session = session;
      state.salt = salt;
    }

    let decoded = null;
    let usedSalt = salt;
    const manualDecrypt = (key) => {
      const { aesKey, aesIv } = deriveAesKeys(authKey, msgKey, 0);
      const plaintext = igeDecrypt(aesKey, aesIv, ciphertext);
      if (!computeMsgKey(authKey, plaintext, 0).equals(msgKey)) throw new Error('msg_key mismatch');
      return unpackMessage(plaintext);
    };
    try {
      decoded = session.decrypt(idBuffer(idHex), msgKey, ciphertext);
    } catch {
      // SessionContext enforces its own msg_id parity rule; real clients may
      // use odd ids, so verify the msg_key directly as a fallback.
      try {
        decoded = manualDecrypt(authKey);
      } catch {
        // Try other known salts; a mismatch means we owe the client bad_server_salt.
        for (const [keyId, candidate] of this.salts) {
          if (keyId !== idHex) continue;
          try {
            const alt = new SessionContext(authKey, idBuffer(candidate));
            decoded = alt.decrypt(idBuffer(idHex), msgKey, ciphertext) || manualDecrypt(authKey);
            usedSalt = candidate;
            session = alt;
            state.session = alt;
            break;
          } catch {
            // keep trying
          }
        }
      }
      if (!decoded) return;
    }

    const { salt: decryptedSalt, sessionId, msgId: requestMsgId, seqNo, body } = decoded;

    if (usedSalt !== salt) {
      this.salts.set(idHex, usedSalt);
      state.salt = usedSalt;
      this.sendEncrypted(C.badServerSalt({
        badMsgId: requestMsgId,
        badMsgSeqno: seqNo,
        errorCode: 32,
        newServerSalt: usedSalt,
      }), { contentRelated: false, msgId: newServerMsgId(), seqNo: this.nextSeq(false, state) }, state, codec);
      return;
    }

    state.sessionId = sessionId;
    if (this.config.logTL) console.log('[TL] in', body.toString('hex'));

    const acks = [];
    this.processMessageBody(body, requestMsgId, seqNo, state, codec, acks);
    if (acks.length) {
      this.sendEncrypted(C.msgsAck(acks), {
        contentRelated: false,
        msgId: newServerMsgId(),
        seqNo: this.nextSeq(false, state),
      }, state, codec);
    }
  }

  processMessageBody(body, msgId, seqNo, state, codec, acks) {
    if (!body.length) return;
    const id = body.readUInt32LE(0);

    if (id === C.ID.msgContainer) {
      const r = new TLBuffer(body.subarray(4));
      try {
        const messages = r.vector((rr) => {
          const innerMsgId = rr.long();
          const innerSeqNo = rr.int();
          const length = rr.int();
          const inner = rr.raw(length);
          return { msgId: innerMsgId, seqNo: innerSeqNo, body: inner };
        });
        for (const m of messages) this.processMessageBody(m.body, m.msgId, m.seqNo, state, codec, acks);
      } catch (err) {
        console.error('[server] bad msg_container', err.message);
      }
      return;
    }

    if (id === C.ID.gzipPacked) {
      try {
        const packed = new TLBuffer(body.subarray(4)).bytes();
        this.processMessageBody(gunzip(packed), msgId, seqNo, state, codec, acks);
      } catch (err) {
        console.error('[server] bad gzip_packed', err.message);
      }
      return;
    }

    if (id === 0x7abe77ec || id === 0xf3427b8c) { // ping / ping_delay_disconnect
      const r = new TLBuffer(body.subarray(4));
      const pingId = r.has(8) ? r.long() : 0n;
      this.sendEncrypted(C.pong({ msgId, pingId }), {
        contentRelated: false,
        msgId: newServerMsgId(),
        seqNo: this.nextSeq(false, state),
      }, state, codec);
      return;
    }

    if (id === 0x62d6b459 || SERVICE_IDS.has(id)) {
      if (seqNo % 2 === 1) acks.push(msgId);
      return;
    }

    // Content-related RPC call.
    if (seqNo % 2 === 1) acks.push(msgId);
    const name = methodNameOf(id) || `0x${(id >>> 0).toString(16)}`;
    const stored = this.store.getSession(state.authKeyId);
    const ctx = {
      userId: stored?.userId || undefined,
      session: stored || undefined,
      authKeyId: state.authKeyId,
      msgId,
      server: this,
      config: this.config,
    };
    const result = this.router.handle(name, new TLBuffer(body.subarray(4)), ctx);
    const rpcResult = C.rpcResult(msgId, result);
    this.sendEncrypted(rpcResult, {
      contentRelated: true,
      msgId: newServerMsgId(),
      seqNo: this.nextSeq(true, state),
    }, state, codec);
  }

  sendEncrypted(body, opts, state, codec) {
    if (!state.session) return;
    // SessionContext.encrypt builds the 32-byte inner header, padding and keys.
    const wrapped = state.session.encrypt(body, {
      contentRelated: !!opts.contentRelated,
      msgId: opts.msgId ?? newServerMsgId(),
      seqNo: opts.seqNo ?? 0,
    });
    const envelope = Buffer.concat([
      idBuffer(wrapped.authKeyId ?? state.authKeyId),
      Buffer.from(wrapped.msgKey),
      Buffer.from(wrapped.ciphertext),
    ]);
    this.writeEnvelope(envelope, state, codec);
  }

  handlePayload(payload, state, codec) {
    if (payload.length < 8) return;
    const authKeyId = payload.readBigUInt64LE(0);
    if (authKeyId === 0n) this.handlePlain(payload, state, codec);
    else this.handleEncrypted(payload, state, codec);
  }
}

export function createServer(options) {
  const server = new TelegramServer(options);
  server.start();
  return server;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const instance = createServer();
  const shutdown = () => {
    console.log('[server] shutting down');
    instance.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
