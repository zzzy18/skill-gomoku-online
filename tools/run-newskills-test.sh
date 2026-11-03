#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
node server.js > /tmp/newskills-test.log 2>&1 &
SRV=$!

# 轮询等端口真正可连，固定 sleep 在某些机器上不够
READY=0
for i in $(seq 1 30); do
  if (exec 3<>/dev/tcp/127.0.0.1/8080) 2>/dev/null; then exec 3<&- 2>/dev/null; READY=1; break; fi
  sleep 0.4
done

if [ "$READY" -ne 1 ]; then
  echo "服务器未就绪，日志："
  cat /tmp/newskills-test.log
  kill $SRV 2>/dev/null
  exit 1
fi

node tools/test-newskills.js
RC=$?
kill $SRV 2>/dev/null
wait $SRV 2>/dev/null
exit $RC
