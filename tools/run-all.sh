#!/usr/bin/env bash
# 依次跑全部测试，任何一个失败即退出
set -u
cd "$(dirname "$0")/.."

node server.js > /tmp/runall.log 2>&1 &
SRV=$!

# 轮询等端口真正可连。固定 sleep 在这台机器上偶尔不够，
# 会让整套测试刚开始就报 websocket error。
READY=0
for i in $(seq 1 30); do
  if (exec 3<>/dev/tcp/127.0.0.1/8080) 2>/dev/null; then exec 3<&- 2>/dev/null; READY=1; break; fi
  sleep 0.4
done

if [ "$READY" -ne 1 ]; then
  echo "服务器启动失败："; cat /tmp/runall.log; kill $SRV 2>/dev/null; exit 1
fi

FAIL=0
for t in test-v2.js test-wind.js test-shield.js test-log-chat.js test-hardening.js test-stealth-expiry.js test-loadout.js test-newskills.js; do
  echo ""
  echo "════════ $t ════════"
  node tools/$t || FAIL=1
done

kill $SRV 2>/dev/null
wait $SRV 2>/dev/null
echo ""
if [ $FAIL -eq 0 ]; then echo "✅ 全部测试套件通过"; else echo "❌ 有测试失败"; fi
exit $FAIL
