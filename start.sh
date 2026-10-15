#!/usr/bin/env bash
# 算力商城 启动脚本
# 端口 58880（PORT-STD-001 预留段 58000-59000，ufw 已整段放行）
set -euo pipefail
cd "$(dirname "$0")"

export PORT="${PORT:-58880}"
export HOST="${HOST:-0.0.0.0}"
export UPSTREAM="${UPSTREAM:-http://127.0.0.1:8282}"

mkdir -p logs
exec node server.js >> logs/market.log 2>&1
