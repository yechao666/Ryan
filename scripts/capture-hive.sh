#!/usr/bin/env bash
# Hive 截图：Playwright + 系统 Chrome（CDP 直连在本机网络受限，Playwright 正常）。
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${1:-http://127.0.0.1:4400}"
OUT="${2:-docs/screenshots}"
python3 scripts/shot-pw.py "$BASE" "$OUT"
