# 从零搭建与联调指南

## 0. 架构一览

```
[TDesktop（打过补丁）] --TCP 10443--> [Node.js MTProto 2.0 服务]
       只认我们的 DC 和 RSA 公钥            │
                                          ├─ node:sqlite 持久化 (/data)
                                          └─ TL schema + RPC router
```

- 服务端：Node.js >= 22.5，零 npm 依赖，`node:sqlite` 内置。
- 客户端：官方 TDesktop 源码打补丁（DC 列表 + RSA 公钥），Docker/centos_env 构建。
- CI：`server.yml` 构建并推镜像 → `deploy.yml` 在 VPS 上 `docker compose pull && up -d`
  → `tdesktop.yml` 手动触发构建客户端，产物走孤儿分支 + Release。

## 1. 服务端密钥与配置（一次性）

在 VPS 上生成 RSA 私钥（2048 位，PKCS#1）：

```bash
mkdir -p /opt/telegramserver/data
openssl genrsa -out /opt/telegramserver/data/rsa_private.pem 2048
openssl rsa -in /opt/telegramserver/data/rsa_private.pem -RSAPublicKey_out \
  -out /opt/telegramserver/data/rsa_public.pem
```

- **私钥**：粘贴到 VPS `.env` 的 `RSA_PRIVATE_KEY`（见 `.env.example`，注意多行引号格式）。
- **公钥**：把 `rsa_public.pem` 全文配置为 GitHub Secret `RSA_PUBLIC_KEY_PEM`。
  两者必须配对，否则客户端握手时会报“找不到匹配的公钥”。

准备 `.env`：

```bash
cd /opt/telegramserver
cp /path/to/TelegramServer/.env.example .env
# 修改 PUBLIC_IP / API_ID / API_HASH / AUTH_CODE / RSA_PRIVATE_KEY
```

关键字段：

| 字段 | 说明 |
| --- | --- |
| `PUBLIC_IP` | VPS 公网 IP，要和客户端补丁里的 `server_ip` 一致 |
| `SERVER_ID` | 逻辑 DC id，补丁客户端只连 DC 1，保持 `1` |
| `API_ID` / `API_HASH` | 必须和客户端 CMake 的 `TDESKTOP_API_ID` / `TDESKTOP_API_HASH` 一致 |
| `AUTH_CODE` | 模拟短信验证码（默认 `123456`） |
| `RSA_PRIVATE_KEY` | 上面生成的 PKCS#1 PEM 字符串 |
| `LOG_TL` | `1` 时打印解密后的 TL，联调时打开 |

> `127.0.0.1:7897` 之类的代理注释**只在你的本机有效**，绝不要写进 CI secrets 或 VPS `.env`。

## 2. 服务端镜像（CI 自动生成）

`server.yml` 在 push 到 `main` 或打 `v*` tag 时运行 `npm test`，
然后用 Buildx + GHA 缓存构建镜像并推送到 `ghcr.io/hxc1818/telegramserver`，
标签包含 semver、commit sha 和 `latest`。PR 只构建、不推送。

本地想直接跑（不依赖 CI 镜像）：

```bash
docker compose up --build -d
docker compose logs -f
nc -z 127.0.0.1 10443   # 应返回成功
```

零 npm 依赖，所以 Dockerfile 里的 `npm ci --omit=dev` 只是守卫，正常情况下会跳过。

## 3. 部署到 VPS

首次需要人工把 `docker-compose.yml` 和 `.env` 放到 VPS 的部署目录（默认 `/opt/telegramserver`），
之后 CI 只负责拉取与重启：

```bash
scp docker-compose.yml .env user@vps:/opt/telegramserver/
```

需要的 GitHub Secrets / Variables：

| 名称 | 用途 |
| --- | --- |
| `VPS_HOST` / `VPS_USER` / `SSH_KEY` / `VPS_SSH_PORT` | SSH 登录 VPS |
| `VPS_DEPLOY_DIR` | compose 文件所在目录，默认 `/opt/telegramserver` |
| `GHCR_TOKEN` | 仅在 GHCR 仓库为私有时需要 |
| Variables `HEALTH_PORT` | 健康检查端口，默认 `10443` |

触发方式：

- 发布 `v*` tag 对应的 Release（发布事件）→ `deploy.yml` 执行
  `docker compose pull && docker compose up -d`，随后检查端口。
- Actions 页面手动 `Run workflow`。

> `tdesktop.yml` 也会创建 Release，但它的 tag 是 `tdesktop-patched-*`，
> `deploy.yml` 里的 `if` 条件会跳过，避免构建客户端时误部署服务端。

## 4. 构建patched 客户端

### 4.1 配置 Secrets

| Secret | 说明 |
| --- | --- |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | 与服务端一致；不填则用官方测试凭据 `17349` |
| `RSA_PUBLIC_KEY_PEM` | 第 1 步导出的 PKCS#1 公钥全文（**必填**） |

### 4.2 触发 workflow

Actions → **Build patched TDesktop** → `Run workflow`，填写：

- `server_ip`：VPS 公网 IP（纯 IP）
- `server_port`：默认 `10443`
- `tdesktop_ref`：默认锁定 SHA `2600e13c...`
- `build_target`：`linux`

工作流会：克隆锁定版本 + 子模块 → 内嵌 Python 打补丁 → Docker(centos_env) 构建
（关闭 autoupdate 和 crash reports）→ 打包 `Telegram` + `Updater` 为 tar.xz。

### 4.3 拉取产物（孤儿分支）

```bash
git clone --single-branch --branch artifacts --depth 1 \
  https://github.com/hxc1818/TelegramServer.git tdesktop-build
cd tdesktop-build
ls                       # tdesktop-linux-*.tar.xz
tar -xf tdesktop-linux-*.tar.xz
./Telegram -debug         # Windows: Telegram.exe -debug
```

`artifacts` 分支是**孤儿分支**：每次 force-push 一个无父提交的 commit，
不会把几百 MB 二进制带进主分支历史。也可以从对应 Release 下载 asset。

## 5. 运行与验证

1. 使用**全新的 tdata 目录**（旧 tdata 会缓存官方 DC，覆盖补丁）。
2. 启动：`./Telegram -debug`（Windows 用 `Telegram.exe -debug`）。
3. 输入手机号 → 验证码填 `AUTH_CODE`（默认 `123456`）。
4. 观察日志：`DebugLogs/mtp_*.txt`（Windows 在 `%APPDATA%\Telegram Desktop\DebugLogs`）。

常见日志检查：

```bash
# 确认连接的是自建 IP:端口
grep -E "1\.2\.3\.4|10443" DebugLogs/mtp_*.txt
# 确认没有官方 DC / IPv6 节点
grep -E "149\.154\.|2001:0b28|2001:067c" DebugLogs/mtp_*.txt
# 握手失败特征
grep -iE "public key|fingerprint|decrypt|auth key" DebugLogs/mtp_*.txt
```

服务端打开 `LOG_TL=1` 后，`docker compose logs -f` 能看到解密后的 TL，
便于对照 `docs/protocol-notes.md` 排查。

## 6. 排错速查

| 现象 | 可能原因 |
| --- | --- |
| 客户端连不上 | 安全组未放行 10443；`PUBLIC_IP` 与补丁 IP 不一致 |
| `could not find a public key` | `RSA_PUBLIC_KEY_PEM` 与服务端私钥不配对，或不是 PKCS#1 格式 |
| 登录后立刻掉线 / pts 错乱 | `help.getConfig` 的 `test_mode` 应为 `false`、`expires` 应在未来、dc_options 只含我们的 DC |
| 构建报 `#error You are required to provide API_ID and API_HASH` | 没有传 `-DTDESKTOP_API_ID` / `-DTDESKTOP_API_HASH` |
| 补丁脚本报找不到数组 | TDesktop 上游版本变了，请改 `tdesktop_ref` 或更新补丁（两处同步） |
| 鉴权被拒 | 客户端 `api_id` 与服务端 `API_ID` 不一致 |

## 7. 安全与合规

- 私钥、`.env`、`DebugLogs/` 已在 `.gitignore` 中，**永不提交**。
- 不要在公开仓库里放真实手机号、验证码或私钥。
- TDesktop 补丁派生自 GPLv3 项目，见根目录 `README.md` 的合规说明。
