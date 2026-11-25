# 客户端 API 凭据（api_id / api_hash）

## 它们是什么

TDesktop 把 `api_id` / `api_hash` 写进 `initConnection#c1cd5ea9` 请求里。
自建服务端从 `initConnection` 读出 `api_id`，与 `.env` 里的 `API_ID` 对照；
不一致时应当拒绝请求（或至少客户端的会话会被当成另一个应用）。
所以：**客户端 CMake 里的 `TDESKTOP_API_ID` 必须等于服务端的 `API_ID`，
`TDESKTOP_API_HASH` 必须等于服务端的 `API_HASH`。**

本次工作流默认使用 Telegram 官方公开测试凭据：

```
TDESKTOP_API_ID   = 17349
TDESKTOP_API_HASH = 344583e45741c457fe1862106095a5eb
```

生产环境请换成自己的凭据：GitHub Secrets `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`，
以及 VPS `.env` 里的 `API_ID` / `API_HASH`，三处保持一致。

## CMake 参数如何生效

构建时把这些作为 CMake 定义传入：

```bash
./Telegram/build/docker/centos_env/build.sh \
  -DTDESKTOP_API_ID=17349 \
  -DTDESKTOP_API_HASH=344583e45741c457fe1862106095a5eb \
  -D DESKTOP_APP_DISABLE_AUTOUPDATE=ON \
  -D DESKTOP_APP_DISABLE_CRASH_REPORTS=ON
```

`Telegram/configure.py` → `cmake/run_cmake.py` 把 `-D` 参数转给 CMake，
CMake 再把它们变成编译期的宏定义。锁定版本的
`Telegram/SourceFiles/config.h` 里有如下分支：

```cpp
#if defined TDESKTOP_API_ID && defined TDESKTOP_API_HASH
constexpr auto ApiId = TDESKTOP_API_ID;
constexpr auto ApiHash = QT_STRINGIFY(TDESKTOP_API_HASH);
#else
#error You are required to provide API_ID and API_HASH.
constexpr auto ApiId = 17349;
constexpr auto ApiHash = "344583e45741c457fe1862106095a5eb";
#endif
```

也就是说 `config.h` 本身**不需要手工编辑**：缺参数时编译直接 `#error`。
如果想确认产物里用的是哪个值：

```bash
grep -R "TDESKTOP_API_ID\|TDESKTOP_API_HASH" tdesktop/out/Release/CMakeCache.txt
grep -n "ApiId\|ApiHash" tdesktop/Telegram/SourceFiles/config.h
```

> 注意：`DesktopPrivate/custom_api_id.h` 只在官方 target 构建（如 `build/target`
> 文件非空）时由 `configure.py` 自动读取；我们的 patched 构建走 `-D` 参数路径，
> 不需要这个文件。

## 常见坑

- `api_hash` 是 32 位十六进制字符串，**不要加引号**（CMake `-D` 传值时用引号包住
  整个 shell 参数即可，例如 `-DTDESKTOP_API_HASH=abc...`）。
- 端口 / IP 补丁和凭据补丁是两回事：前者决定“连到谁”，后者决定“以谁的身份握手”。
- 同一台机器上如果之前登录过官方 Telegram，`tdata` 里的 DC 选项会被缓存覆盖补丁。
  请换一个全新的 `tdata` 目录（或用 `-debug` 启动并观察 mtp 日志）再验证。
