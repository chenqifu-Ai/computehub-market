#!/usr/bin/env bash
# 算力商城 · AI 模型聚合网关 启动脚本
# 端口 58881（PORT-STD-001 预留段 58000-59000，ufw 已整段放行）
set -euo pipefail
cd "$(dirname "$0")"

export PORT="${PORT:-58881}"
export HOST="${HOST:-0.0.0.0}"
export DB_PATH="${DB_PATH:-$PWD/api.db}"
export UPSTREAM_TIMEOUT_MS="${UPSTREAM_TIMEOUT_MS:-300000}"

mkdir -p logs
exec node server.js >> logs/api.log 2>&1
