#!/usr/bin/env bash
# 起服务 → 跑测试 → 关服务，避免后台进程被回收
set -u
cd "$(dirname "$0")/.."
node server.js > /tmp/hardening-test.log 2>&1 &
SRV=$!
sleep 3
if ! kill -0 $SRV 2>/dev/null; then
  echo "服务器启动失败："; cat /tmp/hardening-test.log; exit 1
fi
node tools/test-hardening.js
RC=$?
kill $SRV 2>/dev/null
wait $SRV 2>/dev/null
exit $RC
