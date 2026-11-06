#!/usr/bin/env bash
# 本地安装并启动 Aiwo DSH 实例代理。
#
# 用法：
#   bash scripts/install-local.sh --base http://127.0.0.1:4500 --token aiwo_ins_xxx --workspace /srv/aiwo-workspace
#   bash scripts/install-local.sh            # 只安装依赖并打印用法
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "缺少 node（需要 Node.js >= 20）" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "当前 Node.js $(node -v)，需要 >= 20" >&2
  exit 1
fi

echo "[aiwo-instance] 安装依赖（${DIR}）"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

chmod +x agent.mjs scripts/install-local.sh

if [ "$#" -eq 0 ]; then
  echo "[aiwo-instance] 依赖已安装。启动示例："
  echo "  node agent.mjs --base http://127.0.0.1:4500 --token aiwo_ins_xxx --workspace /srv/aiwo-workspace"
  exit 0
fi

echo "[aiwo-instance] 启动代理"
exec node agent.mjs "$@"
