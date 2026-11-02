#!/usr/bin/env bash
#
# 部署技能五子棋 v2 到远程服务器
#
# 用法：bash deploy.sh [user@host]
#
# 为什么源码要放在 ~/skill-gomoku-online 而不是 /tmp：
#   /tmp 有 30 天自动清理策略（systemd-tmpfiles），
#   源码放那儿过一个月就没了，下次没法重建镜像。
#
set -euo pipefail

TARGET="${1:-root@182.92.63.63}"
REMOTE_DIR="~/skill-gomoku-online"
CONTAINER="skill-gomoku"
IMAGE="skill-gomoku-online"
ROOT="$(cd "$(dirname "$0")" && pwd)"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; RED='\033[0;31m'; NC='\033[0m'
info() { printf "${CYAN}[信息]${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}[就绪]${NC} %s\n" "$*"; }
die()  { printf "${RED}[失败]${NC} %s\n" "$*" >&2; exit 1; }

# ── 本地预检 ──
[ -f "$ROOT/server.js" ] || die "找不到 server.js"
[ -f "$ROOT/public/index.html" ] || die "找不到 public/index.html"

node --check "$ROOT/server.js" || die "server.js 语法错误"

# 前端内联 JS 也校验一遍。
#
# 用 new Function() 在内存里做语法检查，不落临时文件 —— 因为：
#   1. node --check 要求 .js 后缀，mktemp 默认没有；
#   2. 这里的沙箱会拦截 rm 删除临时文件（SAFE_DELETE_INVALID_PATH）；
#   3. 必须 cd 进目录用相对路径，Git Bash 的 /c/Users/... 直接传给 node
#      会变成 C:\c\Users\... 这种非法路径。
# new Function 只解析不执行，能捕获语法错误，正好够用。
( cd "$ROOT" && node -e "
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到内联脚本'); process.exit(1); }
try {
  new Function(m[1]);
} catch (e) {
  console.error('语法错误: ' + e.message);
  process.exit(1);
}
" ) || die "前端 JS 语法错误"
ok "本地语法检查通过"

# ── 上传 ──
info "上传到 $TARGET:$REMOTE_DIR"
ssh "$TARGET" "mkdir -p $REMOTE_DIR/public"
scp -q "$ROOT/server.js" "$TARGET:$REMOTE_DIR/server.js"
# 首次部署时补齐构建文件
scp -q "$ROOT/package.json" "$TARGET:$REMOTE_DIR/package.json" 2>/dev/null || true
scp -q "$ROOT/Dockerfile" "$TARGET:$REMOTE_DIR/Dockerfile" 2>/dev/null || true
scp -q "$ROOT/.dockerignore" "$TARGET:$REMOTE_DIR/.dockerignore" 2>/dev/null || true

# public 整个目录走 tar 管道：scp 不支持排除规则，
# 而 *.bak 这类编辑备份不该传到服务器。
# 顺便清理已被 WebP 取代的旧 PNG（board-wood.png）。
(
  cd "$ROOT/public" && tar -czf - --exclude='*.bak' .
) | ssh "$TARGET" "
  cd $REMOTE_DIR/public || exit 1
  tar -xzf -
  rm -f board-wood.png   # 已改用 board-wood.webp
"
ok "已上传"

# ── 构建并重启 ──
info "构建镜像并重启容器"
ssh "$TARGET" "
set -e
cd $REMOTE_DIR
docker build -t $IMAGE . > /tmp/build.log 2>&1 || { tail -20 /tmp/build.log; exit 1; }
docker rm -f $CONTAINER > /dev/null 2>&1 || true
docker run -d --name $CONTAINER -p 8080:8080 --restart always $IMAGE > /dev/null
sleep 5
"
ok "容器已启动"

# ── 自检 ──
info "自检"
RESULT=$(ssh "$TARGET" "
printf 'STATUS=%s\n' \"\$(docker ps --filter name=$CONTAINER --format '{{.Status}}')\"
printf 'HTTP=%s\n' \"\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8080/)\"
printf 'FILES=%s\n' \"\$(ls $REMOTE_DIR | tr '\n' ' ')\"
")
echo "$RESULT" | sed 's/^/      /'

STATUS=$(echo "$RESULT" | grep '^STATUS=' | cut -d= -f2-)
HTTP=$(echo "$RESULT" | grep '^HTTP=' | cut -d= -f2)

case "$STATUS" in
  *healthy*) ok "容器健康" ;;
  *Up*)      ok "容器运行中（健康检查尚未完成）" ;;
  *)         die "容器状态异常：$STATUS" ;;
esac

[ "$HTTP" = "200" ] && ok "HTTP 200" || die "HTTP 返回 $HTTP"

# ── 公网验证（可选） ──
HOST=$(echo "$TARGET" | cut -d@ -f2)
if command -v node >/dev/null && [ -f "$ROOT/tools/browser-sim.js" ]; then
  info "公网浏览器模拟"
  if node "$ROOT/tools/browser-sim.js" "http://$HOST/gomoku-v2/" 2>&1 | tail -3 | grep -q "全部通过"; then
    ok "公网访问正常"
  else
    printf "${CYAN}[注意]${NC} 公网验证未全部通过，请手动检查\n"
  fi
fi

echo ""
ok "部署完成"
echo ""
echo "  访问地址： http://$HOST/gomoku-v2/"
echo "  源码位置： $TARGET:$REMOTE_DIR"
echo ""