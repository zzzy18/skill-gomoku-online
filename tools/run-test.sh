#!/usr/bin/env bash
# 启动服务器 → 跑测试 → 关服务器，避免进程被回收导致连接失败
set -u
cd "$(dirname "$0")/.."

node server.js > /tmp/v2-test.log 2>&1 &
SRV=$!
sleep 3

if ! kill -0 $SRV 2>/dev/null; then
  echo "服务器启动失败："
  cat /tmp/v2-test.log
  exit 1
fi

node tools/test-v2.js
RC=$?

kill $SRV 2>/dev/null
wait $SRV 2>/dev/null
exit $RC
