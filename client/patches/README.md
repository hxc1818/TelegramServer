# TDesktop 客户端补丁说明

目标：让官方 Telegram Desktop 只连接**我们自己的 MTProto 服务器**，并用**我们自己的 RSA 公钥**完成握手。

## 目录

- `dc_options.patch` —— 文档化补丁 + 可直接运行的 Python 替换脚本
  （CI 内嵌了等价逻辑，不需要把本文件带进 CI）。
- `api_credentials.md` —— `TDESKTOP_API_ID` / `TDESKTOP_API_HASH` 与 `config.h` 的关系。

## 修改点一览（锁定 TDesktop SHA `2600e13c7f1cd7d6afdc4bc3d2b04810f3d57662`）

文件：`Telegram/SourceFiles/mtproto/mtproto_dc_options.cpp`

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| `kBuiltInDcs[]` | 6 条官方 IPv4 DC | 单条 `{ 1, "<SERVER_IP>", <SERVER_PORT> }` |
| `kBuiltInDcsTest[]` | 3 条官方测试 DC | 单条 `{ 1, "<SERVER_IP>", <SERVER_PORT> }` |
| `constructFromBuiltIn()` 的 IPv6 循环 | 加入官方 IPv6 节点 | 整段删除（防止绕过补丁） |
| `kPublicRSAKeys[]` | Telegram 生产公钥 | 自建服务端公钥（PKCS#1 PEM） |
| `kTestPublicRSAKeys[]` | Telegram 测试公钥 | 同一个自建公钥 |

详见 `dc_options.patch` 顶部注释里的完整前后对照。

## 标准流程（推荐，CI 自动完成）

1. 在 VPS 上生成服务端 RSA 私钥，并从中导出公钥：

   ```bash
   openssl genrsa -out data/rsa_private.pem 2048
   openssl rsa -in data/rsa_private.pem -RSAPublicKey_out -out data/rsa_public.pem
   ```

   把**私钥**写进 VPS 的 `.env`（`RSA_PRIVATE_KEY`），把**公钥**内容写进 GitHub Secret
   `RSA_PUBLIC_KEY_PEM`。两者必须配对，否则客户端会报 `could not find a public key`。

2. 在 GitHub → Actions → **Build patched TDesktop** → `Run workflow` 填写：
   - `server_ip`：VPS 公网 IP（纯 IP，不要带协议/端口）
   - `server_port`：默认 `10443`
   - `tdesktop_ref`：默认锁定 SHA；升级前先检查补丁上下文是否仍匹配
   - `build_target`：`linux`

3. 等待构建完成。产物会出现在两处：
   - 孤儿分支 `artifacts`（单提交、force-push，**不会撑大主分支历史**）
   - 本次 workflow 创建的 Release asset

4. 下载并运行，见仓库根目录 `docs/setup.md`。

## 本地兜底（通常不需要）

CI 已经做完所有事。只有离线 / 自定义目标时才用 `client/build.sh`：

```bash
chmod +x client/build.sh
./client/build.sh 1.2.3.4 10443 data/rsa_public.pem
```

脚本会克隆并补丁 TDesktop，再用 Docker 构建、打包到 `out/`。

## 升级 TDesktop 版本时

1. 改 `tdesktop_ref` 后先跑一次 workflow；补丁脚本找不到数组或 IPv6 循环时会**显式报错**。
2. 若上游改了变量名或结构，更新 `dc_options.patch` 与 workflow 内嵌脚本（两处保持一致）。
3. 不要提交二进制产物到仓库；只走 `artifacts` 孤儿分支 / Release。
