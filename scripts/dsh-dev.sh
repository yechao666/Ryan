#!/usr/bin/env bash
# 独立 DSH 开发环境：只给 Ryan 插件开发使用，不碰本机 desktop profile。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_HOME="${DSH_DEV_HOME:-$ROOT/.dsh-dev}"
if [[ ! -f "$DEV_HOME/profiles/web/package.json" ]]; then
  echo "初始化独立 DSH profile：$DEV_HOME"
  mkdir -p "$DEV_HOME/profiles"
  cp -R "$HOME/.dsh/profiles/web" "$DEV_HOME/profiles/web"
fi
DSH_HOME="$DEV_HOME" exec dsh --profile web --port "${DSH_DEV_PORT:-61600}" --no-open "$@"
