# MTProto 2.0 协议备忘（本实现相关）

只记录与本项目联调强相关的点；完整规范见 <https://core.telegram.org/mtproto>。

## 传输层

- TCP 10443。客户端默认可能先发混淆头：`0xEE` + 随机 + 协议标签（abridged / intermediate / padded）；
  `src/transport/obfuscation.js` 透明解密后再交给 framing。
- 帧：`codec.feed()` 处理 quick-ack（0x7F 前缀）等；`encode()` 负责回包。

## 握手（未加密明文阶段）

1. `req_pq_multi#be7e8ef1`（或 `req_pq#60469778`）→ `resPQ`：nonce、server_nonce、pq、`public_key_fingerprints`。
   - **指纹必须是客户端已内置公钥的低 64 位 SHA1(TL(n)||TL(e))**，否则客户端立即报错。
   - 我们同时替换 `kPublicRSAKeys` 与 `kTestPublicRSAKeys`，让客户端认我们的指纹。
2. `req_DH_params` 里带 `data = RSA_PAD(inner TL)`、`p`、`q`、`fingerprint`。
   - RSA_PAD：`随机前缀(≥8 字节非零随机) || TL 数据 || SHA1(TL 数据)`，补齐到 256 字节后
     用服务端私钥解密（`rsaPadDecrypt`）。
3. 服务端回 `server_DH_params_ok`（`encrypted_answer` 是 **IGE 加密**的 TL）。
4. `set_client_DH_params` → `dh_gen_ok`，得到 `auth_key`。
5. `auth_key_id = SHA1(auth_key)` 的低 64 位。后续所有包都用 IGE + msg_key。

## IGE 与 msg_key

- `msg_key = SHA1(auth_key[8..40] || plaintext)` 的中间 16 字节。
- 解密 x=0：`key = SHA1(msg_key || auth_key[0..36])`，
  `iv = SHA1(auth_key[40..56] || msg_key)`。
- 加密 x=8：切片偏移整体 +8（`key = SHA1(msg_key || auth_key[8..44])` 等）。
- 明文布局：`salt(8) | session_id(8) | msg_id(8) | seq_no(4) | length(4) | body`。
- `msg_id` 单调递增、奇数；服务端回复用 mod 4 == 1；`seq_no` 客户端从 0 起，服务端回复为偶数。

## `help.getConfig` 的几个坑

| 字段 | 要求 |
| --- | --- |
| `test_mode` | 设 `false`。为 `true` 时 TDesktop 会切到 test DC / 走不同密钥集。 |
| `expires` | 未来时间戳（如 `now + 3600`）。过期会导致客户端反复拉配置。 |
| `dc_options` | **只放我们自己的 DC**：`{ id=1, ip=PUBLIC_IP, port=10443, flags=... }`。混入官方 IP 会绕过补丁。 |
| `chat_max_size` / `saved_photo_id` 等 | 给合理值，避免客户端除零或走媒体分支。 |
| `date` | 当前 unix 秒。 |

`config` 里返回的 `dc_options` 会更新客户端内存中的 DC 列表；即使二进制补丁正确，
一个包含官方 DC 的 `config` 也会把它们加回来。

## RSA 指纹怎么算

```js
// n: 256 字节 BE, e: 3 字节 BE (0x010001)
const fp = rsaFingerprint(n, e); // 低 64 位 SHA1(TL(string(n)) || TL(string(e)))
```

客户端 `resPQ.public_key_fingerprints` 里必须有这个值。
`openssl rsa -in key.pem -RSAPublicKey_out` 得到的是 PKCS#1 PEM，正是 TDesktop 解析器期待的格式。

## updates / pts

- `updates.state` 的 `pts / qts / date / seq / unread_count` 要自洽，
  `pts` 由 `store.nextPts()` 单调递增产生。
- 发送 `updateNewMessage` / `updateShort` 时携带的 `pts` 必须是应用该更新**之后**的值；
  客户端会拿本地 pts 比对，缺号就触发 `updates.getDifference`。
- `messages.getDialogs` 返回的 `chats` / `users` 向量要包含对话中引用的所有 peer，
  否则 TDesktop 会显示 `Unknown peer` / `deleted user`。
- `messages.saveDraft`、`messages.readHistory`、`messages.getHistory` 等要同步更新 `pts`/`date`。
