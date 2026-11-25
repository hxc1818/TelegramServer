# TDesktop 功能对照表（诚实版）

> 图例：**✅ 已实现**（以当前 `src/rpc/router.js` 的 `supports()` 为准）
> **🚧 迭代中 / 计划**（接口或数据结构已有，语义未完整）
> **⛔ 范围外**（本项目不追求与 Telegram 云端完全等价）

本项目是从零实现的 MTProto 2.0 服务端，目标是持续对齐 TDesktop 可感知的功能
（登录、会话、消息、群聊/频道、媒体、消息操作）。**不是** Telegram 服务器的逐行克隆；
秘密聊天、通话、推送、多 DC/CDN、机器人与支付等仍属后续迭代范围。状态以代码为准。

## 连接与会话

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| TCP + 混淆层（abridged / intermediate / padded） | ✅ | 见 `src/transport/` |
| `req_pq` / `req_pq_multi` / DH 握手 | ✅ | 见 `src/mtproto/handshake.js` |
| IGE 加密会话、server salt、msg_id/seq_no | ✅ | 见 `src/mtproto/session.js` |
| 多 DC / CDN / 媒体集群 | ⛔ | 只有一个自建 DC（DC 1） |
| WebSocket / HTTP 传输 | ⛔ | 仅 TCP |

## 登录与账号

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 手机号 + 固定验证码登录（`auth.sendCode` / `auth.signIn`） | ✅ | `AUTH_CODE` |
| `auth.exportAuthorization` / 二维码登录 / 2FA（SRP） | ⛔ | 未实现 |
| 注册新账号、改手机号、删除账号 | ⛔ | 未实现 |

## 消息与会话

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| `help.getConfig` | ✅ | 只返回我们的 DC |
| `contacts.getContacts` / `messages.getDialogs` | ✅ | 基于 node:sqlite |
| `messages.getHistory` / `messages.sendMessage` | ✅ | 文本消息 |
| `updates.state` / `updates.getDifference` / `updates.getChannelDifference` | ✅ | pts 单调递增；`differenceEmpty` / `channelDifferenceEmpty` |
| 已读回执 / `messages.readHistory` / `readMentions` / `readReactions` | ✅ | pts/未读计数更新 |
| 编辑 / 删除 / 转发 / 草稿 / 反应 | ✅ | `editMessage` / `deleteMessages` / `forwardMessages` / `saveDraft` / `getAllDrafts` / `sendReaction` |
| 群聊、频道、成员管理 | ✅ | `createChat` / `createChannel` / `addChatUser` / `inviteToChannel` / `getChats` / `getFullChat` / `getFullChannel` / `editTitle` |
| 搜索 `messages.search` / `searchGlobal` | ✅ | 基于消息文本的本地检索 |
| 媒体上传、图片/文件下载 | ✅ | `saveFilePart` / `saveBigFilePart` / `getFile` / `sendMedia`（document/photo） |
| 贴纸 / GIF / 表情 / 投票 / 内联机器人 | 🚧 | 空结果占位，未实现语义 |
| 秘密聊天（E2E）、语音/视频通话 | ⛔ | 范围外 |
| 跨设备同步、已读回执全量语义、通知推送 | ⛔ | 范围外 |

## 工程能力

| 功能 | 状态 |
| --- | --- |
| `npm test`（node:test，零依赖） | ✅ |
| Docker 镜像 + GHCR + GHA 缓存 | ✅ |
| SSH 一键部署 + 端口健康检查 | ✅ |
| Patched TDesktop 构建与孤儿分支发布 | ✅ |
| 多用户生产级鉴权、限流、审计 | ⛔ 范围外 |

## 结论

“能登录并发文本消息” ≠ “Telegram 全功能可用”。
如果你需要完整的群聊、媒体、搜索、2FA、通话等能力，应当使用官方服务端实现或成熟开源服务端；
本项目的价值在于**从零理解 MTProto 2.0 与 TDesktop 的对接过程**。
