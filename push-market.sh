#!/bin/bash
# 推送 web/market 到 GitHub（github.com:443 在 ECS 上间歇性可达，故带重试）
# 用法: bash push-market.sh [提交信息]   不给信息则只推已有提交
set -u
cd /home/computehub/web/market || exit 1
TOKEN=$(git -C /home/computehub/ComputeHub remote get-url endzhi-gh | sed -E 's|https://[^:]+:([^@]+)@.*|\1|')
[ -n "$TOKEN" ] || { echo "❌ 取不到 token"; exit 1; }
B64=$(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)

if [ $# -ge 1 ]; then
  # ⚠️ 逐个 add，不存在的路径会整体失败（exit 128）
  for p in api public README.md .gitignore package.json server.js start.sh push-market.sh; do
    [ -e "$p" ] && git add -A "$p"
  done
  if git diff --cached --quiet; then echo "无改动可提交"; else
    git -c user.name=小智 -c user.email=xiaozhi@computehub.local commit -q -m "$1" && echo "✅ 已提交 $(git log -1 --format=%h)"
  fi
fi

for i in 1 2 3 4 5 6; do
  out=$(git -c http.extraHeader="Authorization: Basic $B64" \
        -c http.postBuffer=524288000 -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=120 \
        -c http.version=HTTP/1.1 \
        push "https://github.com/chenqifu-Ai/computehub-market.git" master:master 2>&1)
  # ⚠️ 只有「真正推送成功」才算成功；Everything up-to-date 不算（可能远端落后却误报）
  if echo "$out" | grep -qE "master -> master|\* \[new branch\]"; then
    # 双保险：核验远端 ref 与本地 HEAD 一致
    remote=$(git ls-remote "https://github.com/chenqifu-Ai/computehub-market.git" master 2>/dev/null | cut -f1)
    local=$(git rev-parse HEAD)
    if [ "$remote" = "$local" ]; then
      echo "🎉 推送成功并核验一致（第 $i 次尝试）: ${local:0:7}"; exit 0
    fi
    echo "⚠️ push 报成功但远端(${remote:0:7}) ≠ 本地(${local:0:7})，重试…"
  else
    echo "第 $i 次失败: $(echo "$out" | tail -1)"
  fi
  sleep 5
done
echo "❌ 6 次均失败，检查网络"; exit 1
