#!/usr/bin/env bash
# 本地兜底构建脚本 —— 通常【不需要】：CI (.github/workflows/tdesktop.yml) 会自动完成
# 克隆 → 补丁 → Docker 构建 → 打包 → 发布孤儿分支/Release。
# 只有在离线、自定义目标或调试补丁时才用本脚本。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
TD="$ROOT/tdesktop"
PATCHER="$SCRIPT_DIR/patches/dc_options.patch"

SERVER_IP="${1:-${SERVER_IP:-}}"
SERVER_PORT="${2:-${SERVER_PORT:-10443}}"
PEM_FILE="${3:-${RSA_PUBLIC_KEY_PEM_FILE:-}}"
TD_REF="${TDESKTOP_REF:-2600e13c7f1cd7d6afdc4bc3d2b04810f3d57662}"
API_ID="${TELEGRAM_API_ID:-17349}"
API_HASH="${TELEGRAM_API_HASH:-344583e45741c457fe1862106095a5eb}"
IMAGE="${TDESKTOP_DOCKER_IMAGE:-ghcr.io/telegramdesktop/tdesktop/centos_env:latest}"

usage() {
  cat <<'EOF'
用法: ./client/build.sh <SERVER_IP> [SERVER_PORT] <RSA_PUBLIC_KEY_PEM_FILE>
例如: ./client/build.sh 1.2.3.4 10443 ./data/rsa_public.pem

可选环境变量:
  TDESKTOP_REF, TELEGRAM_API_ID, TELEGRAM_API_HASH,
  RSA_PUBLIC_KEY_PEM_FILE, SERVER_IP, SERVER_PORT, TDESKTOP_DOCKER_IMAGE
EOF
}

if [ -z "$SERVER_IP" ] || [ -z "$PEM_FILE" ]; then
  usage >&2
  exit 2
fi
if [ ! -f "$PEM_FILE" ]; then
  echo "找不到公钥文件: $PEM_FILE" >&2
  exit 2
fi
command -v docker >/dev/null || { echo "需要 docker" >&2; exit 2; }
command -v python3 >/dev/null || { echo "需要 python3" >&2; exit 2; }

echo "== 1/4 获取 TDesktop @ $TD_REF =="
if [ ! -d "$TD/.git" ]; then
  git clone --recurse-submodules https://github.com/telegramdesktop/tdesktop.git "$TD"
fi
(
  cd "$TD"
  git checkout --detach "$TD_REF"
  git submodule update --init --recursive
)

echo "== 2/4 打补丁 =="
python3 "$PATCHER" \
  --source "$TD/Telegram/SourceFiles/mtproto/mtproto_dc_options.cpp" \
  --ip "$SERVER_IP" \
  --port "$SERVER_PORT" \
  --pem "$PEM_FILE"

echo "== 3/4 Docker 构建 =="
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker pull "$IMAGE" || {
    echo "拉取失败，回退到 Telegram/build/prepare/linux.sh"
    if ! command -v poetry >/dev/null 2>&1; then
      python3 -m pip install --user poetry
      export PATH="$HOME/.local/bin:$PATH"
    fi
    (cd "$TD" && ./Telegram/build/prepare/linux.sh)
    IMAGE="tdesktop:centos_env"
  }
fi
docker run --rm \
  -v "$TD:/src" \
  -w /src \
  -e TDESKTOP_API_ID="$API_ID" \
  -e TDESKTOP_API_HASH="$API_HASH" \
  "$IMAGE" \
  ./Telegram/build/docker/centos_env/build.sh \
    -DTDESKTOP_API_ID="$API_ID" \
    -DTDESKTOP_API_HASH="$API_HASH" \
    -D DESKTOP_APP_DISABLE_AUTOUPDATE=ON \
    -D DESKTOP_APP_DISABLE_CRASH_REPORTS=ON

echo "== 4/4 打包 =="
OUT="$TD/out/Release"
[ -x "$OUT/Telegram" ] || { echo "没有找到 $OUT/Telegram" >&2; exit 1; }
files="Telegram"
[ -e "$OUT/Updater" ] && files="$files Updater"
NAME="tdesktop-local-${SERVER_PORT}.tar.xz"
mkdir -p "$ROOT/out"
tar -cJf "$ROOT/out/$NAME" -C "$OUT" $files
echo "完成: $ROOT/out/$NAME"
echo "⚠️ 请勿把二进制产物提交进 git（.gitignore 已忽略 out/ 与 *.tar.xz）。"
