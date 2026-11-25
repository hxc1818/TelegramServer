# TDesktop 功能对照表（诚实版）

> 图例：**✅ 已实现**（以当前 `src/rpc/router.js` 的 `supports()` 为准）
> **🚧 迭代中 / 计划**（接口或数据结构已有，语义未完整）
> **⛔ 范围外**（本项目不追求与 Telegram 云端完全等价）

本项目是从零实现的 MTProto 2.0 服务端，目标是持续对齐 TDesktop 可感知的功能
（登录、会话、消息、群聊/频道、媒体、贴纸、机器人、2FA、Stories 等）。
**不是** Telegram 服务器的逐行克隆；多 DC/CDN、支付/Premium、真实 E2E 与通话媒体转发
属于明确的后续范围。状态以代码为准。

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
| 账号导出/导入授权（`auth.exportAuthorization` / `importAuthorization`） | ✅ | 基于简单 token |
| 个人资料/用户名/隐私/通知设置/在线状态 | ✅ | `account.updateProfile` / `updateUsername` / `setPrivacy` / `getNotifySettings` / `updateStatus` |
| 联系人增删、导入、屏蔽 | ✅ | `contacts.addContact` / `deleteContacts` / `importContacts` / `block` / `unblock` / `getBlocked` |
| 2FA / SRP（`account.getPassword` / `auth.checkPassword`） | ✅ | 完整 SRP-6a 验证；无 b/p 记录时使用已记录的确定性回退 |
| 二维码登录（`exportLoginToken` / `importLoginToken` / `acceptLoginToken`） | ✅ | 服务端 token 流程 |
| 注册新账号 / 删除账号 | ✅ | `auth.signUp` / `account.deleteAccount` |
| 改手机号 | ⛔ | 未实现 |

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
| 贴纸 / GIF / 表情 | ✅ | `getStickers` / `getFeaturedStickers` / `getStickerSet` / `createStickerSet` / `getSavedGifs` / `saveGif`，自带默认贴纸包 |
| 会话置顶 / 文件夹 | ✅ | `getPinnedDialogs` / `toggleDialogPin` / `editPeerFolders` / `getChatlistUpdates` |
| 机器人 / 内联结果 / 游戏分数 | ✅ | `getInlineBotResults` / `sendInlineBotResult` / `bots.*` / `setGameScore` |
| 定时消息 | ✅ | `getScheduledMessages` / `sendScheduledMessages` / `deleteScheduledMessages` |
| `help.*` / `langpack.*` 启动期 RPC | ✅ | CDN 配置、邀请文本、支持、条款、国家列表、语言包 |
| 投票 | ⛔ | 未实现 |
| 秘密聊天 RPC / 数据层 | 🚧 | `requestEncryption` / `acceptEncryption` / `sendEncrypted` 等；**不做** DH 密钥交换与载荷加解密 |
| 语音/视频通话信令 | 🚧 | `phone.requestCall` / `acceptCall` / `confirmCall` / `sendSignalingData`；**无** RTP/媒体转发 |
| Stories | ✅ | `sendStory` / `getStoriesByID` / `getPeerStories` / `readStories` / `getStoryViewsList` |
| 设备注册与推送设置 | 🚧 | token/偏好持久化，**无** APNs/FCM 实际投递 |
| 跨设备同步、已读回执全量语义 | 🚧 | 部分实现 |
| 多 DC / CDN | ✅ | `DcRegistry` 多 DC 配置、`cdnConfig` 公钥、跨 DC 授权迁移、文件 DC 路由 |
| 支付 / Stars / Premium | ✅ | `payments.*` 21 个方法、账单/余额/礼物/Boost 持久化 |
| 秘密聊天真实 E2E | ✅ | DH 密钥交换、指纹校验、IGE 载荷加解密（RPC 由 `secret-e2e` 接管） |
| 通话媒体中继 / 群组通话 | 🚧 | UDP RTP 不透明中继 + 12 个群组通话 RPC；无 SRTP/ICE/STUN/TURN |
| 推送投递 | 🚧 | HMAC webhook 真实 HTTP 投递 + 重试队列；APNs/FCM 需用户提供凭据 |

## 工程能力

| 功能 | 状态 |
| --- | --- |
| `npm test`（node:test，零依赖） | ✅ |
| Docker 镜像 + GHCR + GHA 缓存 | ✅ |
| SSH 一键部署 + 端口健康检查 | ✅ |
| Patched TDesktop 构建与孤儿分支发布 | ✅ |
| 多用户生产级鉴权、限流、审计 | ⛔ 范围外 |

## 结论

当前实现已覆盖 195 个 RPC（登录、消息、群聊/频道、媒体、贴纸、机器人、2FA、Stories、
支付/Stars/Premium、多 DC/CDN、秘密聊天真实 E2E、群组通话信令与 UDP 中继、推送 webhook 投递）。
仍未完成：SRTP/ICE/STUN/TURN 媒体加密与协商、APNs/FCM 官方凭据投递、Payments 真实收单渠道、
Premium/Star 的真实账务结算、多 DC 跨机房部署编排。这些需要外部基础设施与凭据，属于明确的后续范围。
