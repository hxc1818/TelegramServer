# TelegramServer

从零实现的 **Node.js MTProto 2.0 服务端**，配套打过补丁的 Telegram Desktop 客户端。
零 npm 依赖（Node.js >= 22.5，`node:sqlite` 为内置模块），目标是“让 patched TDesktop
完成握手、登录、查看会话并收发文本消息”，**不是** Telegram 云端服务的完整克隆。

## 架构

```
                     ┌──────────────────────┐
  patched TDesktop ──►│  TCP :10443          │
  (只认我们的 DC+公钥) │  obfuscation         │
                     │  framing / quick-ack │
                     │  handshake (RSA/DH)  │
                     │  session (IGE)       │
                     │  RPC router          │
                     └──────────┬───────────┘
                                ▼
                      node:sqlite (/data)
```

- `src/tl/`：TL 序列化、schema 解析、已实现 RPC 的编解码
- `src/crypto/`：AES-256-IGE、RSA、指纹
- `src/transport/`：混淆层与帧
- `src/mtproto/`：握手与加密会话
- `src/store/`：node:sqlite 持久化
- `src/rpc/`：方法路由；`src/server.js`：TCP 入口
- `schema/`：官方 `api.tl` / `mtproto.tl`

模块契约见 `CONTRACT.md`。功能覆盖情况见 `docs/feature-matrix.md`（诚实标注）。

## 快速开始

```bash
# 1) 生成服务端 RSA 私钥并导出公钥
openssl genrsa -out data/rsa_private.pem 2048
openssl rsa -in data/rsa_private.pem -RSAPublicKey_out -out data/rsa_public.pem

# 2) 配置
cp .env.example .env      # 填 PUBLIC_IP / API_ID / API_HASH / AUTH_CODE / RSA_PRIVATE_KEY

# 3) 启动（本地）
docker compose up --build -d
docker compose logs -f
```

客户端构建、部署、联调详见：

- `docs/setup.md` —— 完整搭建指南（含 workflow_dispatch、孤儿分支、`-debug` 日志）
- `docs/protocol-notes.md` —— MTProto 握手、IGE、RSA_PAD、getConfig 坑位
- `docs/feature-matrix.md` —— 功能对照（已实现 / 计划 / 范围外）
- `client/patches/README.md` —— TDesktop 补丁步骤
- `client/patches/api_credentials.md` —— api_id/api_hash 与 `config.h`

## CI 说明

| 工作流 | 触发 | 作用 |
| --- | --- | --- |
| `.github/workflows/server.yml` | push 到 main / `v*` tag / PR | Node 22 跑 `npm test`；Buildx + GHA 缓存构建镜像；非 PR 登录 GHCR 并推送 semver / sha / latest 标签。零依赖，无需 `npm install`。 |
| `.github/workflows/tdesktop.yml` | `workflow_dispatch` | 克隆锁定 SHA 的 TDesktop + 子模块 → 内嵌 Python 打补丁（DC + RSA）→ Docker/centos_env 构建（关闭 autoupdate/crash reports）→ tar.xz → force-push 到**孤儿分支 `artifacts`** + Release asset。 |
| `.github/workflows/deploy.yml` | Release published / `workflow_dispatch` | SSH 到 VPS 执行 `docker compose pull && docker compose up -d`，并做端口健康检查。`tdesktop-patched-*` 的 Release 会被跳过。 |

⚠️ **二进制膨胀**：客户端产物（80–200 MB）只进孤儿分支 / Release，
绝不提交进主分支历史。见 `tdesktop.yml` 顶部注释。

需要的 Secrets：`TELEGRAM_API_ID`、`TELEGRAM_API_HASH`、`RSA_PUBLIC_KEY_PEM`、
`VPS_HOST`、`VPS_USER`、`SSH_KEY`（详见 `docs/setup.md`）。
`127.0.0.1:7897` 仅是本机代理示例，**不得写入 CI**。

## 范围声明（诚实版）

- ✅ 已实现：传输层、握手、加密会话、`help.getConfig`、手机号验证码登录、
  会话列表、文本消息收发（以 `router.supports()` 为准）。
- 🚧 迭代中：`updates.getDifference`、已读回执、群聊/频道的部分 RPC。
- ⛔ 范围外：媒体上传/CDN、搜索、2FA、秘密聊天、通话、机器人、完整跨设备同步、
  生产级鉴权/限流。

完整 Telegram 兼容性需要官方服务端或成熟开源服务端；本项目主要用于学习和受控环境联调。

## 许可与合规

- 本仓库自身代码：按仓库实际许可（未声明时请视为私有/待定），不授予任何 Telegram 商标使用权。
- `client/patches/**` 修改的是 **Telegram Desktop** 源码，属于 GPLv3 项目；
  分发修改后的二进制时请遵守 GPLv3（提供对应源码/修改说明）。
- “Telegram” 及相关标识是 Telegram FZ-LLC 的商标。本项目为非官方、实验性实现，
  与 Telegram 官方无任何关联，请勿用于冒充官方服务或违反 Telegram 条款的场景。
- `schema/*.tl` 来自公开的 Telegram 协议定义，版权归原作者所有。
