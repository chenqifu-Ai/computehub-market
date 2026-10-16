#!/bin/bash
# 推送 web/market 到 GitHub（github.com:443 在 ECS 上间歇性可达，故带重试）
# 用法: bash push-market.sh [提交信息]   不给信息则只推已有提交
set -u
cd /home/computehub/web/market || exit 1
TOKEN=$(git -C /home/computehub/ComputeHub remote get-url endzhi-gh | sed -E 's|https://[^:]+:([^@]+)@.*|\1|')
[ -n "$TOKEN" ] || { echo "❌ 取不到 token"; exit 1; }
B64=$(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)

if [ $# -ge 1 ]; then
  git add -A api/ README.md .gitignore package.json public/ server.js start.sh 2>/dev/null
  if git diff --cached --quiet; then echo "无改动可提交"; else
    git -c user.name=小智 -c user.email=xiaozhi@computehub.local commit -q -m "$1" && echo "✅ 已提交 $(git log -1 --format=%h)"
  fi
fi

for i in 1 2 3 4 5 6; do
  out=$(git -c http.extraHeader="Authorization: Basic $B64" \
        -c http.postBuffer=524288000 -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=120 \
        -c http.version=HTTP/1.1 \
        push "https://github.com/chenqifu-Ai/computehub-market.git" master:master 2>&1)
  if echo "$out" | grep -qE "master -> master|Everything up-to-date|new branch"; then
    echo "🎉 推送成功（第 $i 次尝试）"; exit 0
  fi
  echo "第 $i 次失败: $(echo "$out" | tail -1)"; sleep 5
done
echo "❌ 6 次均失败，检查网络"; exit 1
