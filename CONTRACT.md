# Internal module contract (ESM, Node.js >= 22.5, zero npm dependencies)

All paths are relative to repo root. Modules must not import third-party packages.

## `src/tl/buffer.js` (already implemented — use as-is)

```js
import { TLBuffer, tlString } from './tl/buffer.js';

const b = new TLBuffer();            // writer
b.putInt(v)                          // int32
b.putUint(v)                         // uint32
b.putLong(v)                         // bigint | number -> int64 LE
b.putInt128(buf16) / b.putInt256(buf32)
b.putBool(bool)                      // boxed boolTrue/boolFalse constructor id
b.putBytes(buf) / b.putString(str)   // TL length-prefixed bytes (padded to 4)
b.putVector(items, (item, b) => ...) // vector#1cb5c415 + count + items
b.putRaw(buf)
b.buffer                             // Buffer of everything written
b.offset                             // bytes consumed (reader mode)

const r = new TLBuffer(buf);         // reader
r.int() / r.uint() / r.long() -> bigint / r.int128() -> Buffer / r.int256() -> Buffer
r.bool() -> boolean
r.bytes() -> Buffer / r.string() -> string
r.vector((r) => value)
r.raw(n) -> Buffer
r.has(n) -> boolean
tlString(buf) -> Buffer              // length-prefixed raw bytes
```

## `src/crypto/ige.js` (already implemented — use as-is)

```js
import { igeEncrypt, igeDecrypt, xor } from './crypto/ige.js';
igeEncrypt(key32, iv32, data) -> Buffer   // AES-256-IGE (data length % 16 === 0)
igeDecrypt(key32, iv32, data) -> Buffer
xor(a, b) -> Buffer                       // equal-length buffers
```

## `src/crypto/rsa.js` (already implemented — use as-is)

```js
import { generateRSA, rsaPadEncrypt, rsaPadDecrypt, rsaFingerprint, rawRSA } from './crypto/rsa.js';
const keys = generateRSA(); // { privatePem, publicPem, n: Buffer(256), e: Buffer(3), d: Buffer }
rsaFingerprint(n, e) -> bigint        // low64 SHA1(TL string n || TL string e)
rsaPadEncrypt(tlData, keys) -> Buffer // 256-byte ciphertext (for tests)
rsaPadDecrypt(ciphertext256, keys) -> Buffer // original TL data
rawRSA(m, exp, mod) -> Buffer
```

## `src/tl/schema.js` (agent A owns)

```js
import { parseSchema, constructorId, normalizeDecl } from './tl/schema.js';
parseSchema(text) -> {
  types: Map<string, { id:number, name:string, params:[{name,type,flagBit?}], result:string }>,
  functions: Map<...>,
  layer: number | null
}
constructorId(declString) -> number (uint32) // CRC32 of normalized decl, explicit #id wins
```

## `src/tl/objects.js` (agent A owns)

Hand-written TL object codecs for the RPCs we implement. Each exported function
`(object) => Buffer` and matching `readX(r) => object`, plus `TYPE_ID` constants.
At minimum: `config`, `dcOption`, `user`, `auth.sentCode`, `auth.authorization`,
`updates.state`, `messages.dialogsSlice`, `messages.messagesSlice`, `message`,
`peerUser`, `peerChat`, `peerChannel`, `chat`, `channel`, `updates`,
`updateShort`, `updateShortSentMessage`, `updateNewMessage`, `updateMessageID`,
`nearestDc`, `contacts.contacts`, `contact`, `inputPeer*`, `inputUser*`.

## `src/transport/obfuscation.js` (agent B owns)

```js
import { ObfuscatedSocket } from './transport/obfuscation.js';
new ObfuscatedSocket(socket)  // wraps net.Socket, transparently decrypts/encrypts
// emits 'data' with DEOBFUSCATED bytes; .write(buf) encrypts before sending
```

## `src/transport/framing.js` (agent B owns)

```js
import { FrameCodec } from './transport/framing.js';
new FrameCodec(transportId) // 'abridged' | 'intermediate' | 'padded'
codec.feed(chunk) -> yields payload Buffers (handles quick-ack)
codec.encode(payload) -> Buffer
codec.transportIdOf(prefixBytes) -> 'abridged'|'intermediate'|'padded'|null
```

## `src/mtproto/handshake.js` (agent B owns)

```js
import { Handshake } from './mtproto/handshake.js';
const hs = new Handshake({ rsaKeys, serverNonce?, pq?, dhPrimeHex? });
hs.processPlain(bodyBuffer) -> { response: Buffer, authKey?: Buffer, serverSalt?: Buffer }
// handles req_pq#60469778, req_pq_multi#be7e8ef1, req_DH_params, set_client_DH_params
// returns TL-serialized response body (resPQ / server_DH_params_ok / dh_gen_ok)
```

## `src/mtproto/session.js` (agent B owns)

```js
import { SessionContext } from './mtproto/session.js';
const s = new SessionContext(authKey, serverSalt);
s.decrypt(authKeyId8, msgKey16, ciphertext) -> plaintext Buffer | throws
s.encrypt(plaintext, { contentRelated }) -> { authKeyId, msgKey, ciphertext }
// plaintext inside = salt(8) | sessionId(8) | msgId(8) | seqNo(4) | length(4) | body
// derive keys with x=0 (decrypt) / x=8 (encrypt)
export function newServerMsgId() -> bigint  // odd, mod4==1
```

## `src/store/store.js` (agent C owns)

```js
import { Store } from './store/store.js';
const store = new Store(dataDir); // uses node:sqlite (built-in), no npm deps
store.createUser({ phone, firstName, lastName }) -> user object
store.getUser(id), store.getUserByPhone(phone)
store.createCode(phone, code, hash), store.checkCode(phone, hash, code)
store.createSession(userId, authKeyId), store.getSession(authKeyId)
store.createDialog(userId, peer, peerType), store.listDialogs(userId)
store.putMessage({ fromId, peerType, peerId, text, randomId }) -> message
store.listMessages(peerType, peerId, limit), store.getMessage(id)
store.markRead(peerType, peerId, maxId)
store.nextPts(userId) -> number
store.getState(userId) -> { pts, qts, date, seq, unread_count }
```

## `src/rpc/router.js` (agent C owns)

```js
import { Router } from './rpc/router.js';
const router = new Router({ store, keys, config });
router.handle(methodName, params, ctx) -> Buffer (TL-serialized inner result)
// ctx = { userId, session, server }
router.supports(methodName) -> boolean
// wrapped methods invokeWithLayer / initConnection MUST be unwrapped here
```

## `src/server.js` (agent C owns)

TCP server: obfuscation -> framing -> plain handshake or encrypted session -> RPC router.
Config from env: `LISTEN_HOST`, `LISTEN_PORT`, `DATA_DIR`, `PUBLIC_IP`, `SERVER_ID`,
`RSA_PRIVATE_KEY`, `API_ID`, `API_HASH`, `LOG_TL`.
Logs decrypted TL when LOG_TL=1.

## Tests

Each agent owns its own test files. Run `npm test`.
No native npm modules anywhere. `node:sqlite` is built into Node 22.
