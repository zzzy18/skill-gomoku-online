#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
node server.js > /tmp/stealth-test.log 2>&1 &
SRV=$!
sleep 3
kill -0 $SRV 2>/dev/null || { echo "启动失败："; cat /tmp/stealth-test.log; exit 1; }
node tools/test-stealth-expiry.js
RC=$?
kill $SRV 2>/dev/null
wait $SRV 2>/dev/null
exit $RC
