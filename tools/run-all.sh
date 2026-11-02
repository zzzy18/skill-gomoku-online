#!/usr/bin/env bash
# 依次跑全部测试，任何一个失败即退出
set -u
cd "$(dirname "$0")/.."

node server.js > /tmp/runall.log 2>&1 &
SRV=$!
sleep 3
if ! kill -0 $SRV 2>/dev/null; then
  echo "服务器启动失败："; cat /tmp/runall.log; exit 1
fi

FAIL=0
for t in test-v2.js test-wind.js test-shield.js test-log-chat.js test-hardening.js test-stealth-expiry.js; do
  echo ""
  echo "════════ $t ════════"
  node tools/$t || FAIL=1
done

kill $SRV 2>/dev/null
wait $SRV 2>/dev/null
echo ""
if [ $FAIL -eq 0 ]; then echo "✅ 全部测试套件通过"; else echo "❌ 有测试失败"; fi
exit $FAIL
