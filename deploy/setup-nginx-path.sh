#!/usr/bin/env bash
#
# 把技能五子棋 v2（Docker，8080）挂到 nginx 的 /gomoku-v2/ 路径上。
#
# 为什么不直接用 8080：
#   服务器安全组只放行了 80/443，8080 会被拦。
#   走 nginx 路径反代，复用已放行的 80 端口，不需要改安全组。
#
set -euo pipefail

CONF=/etc/nginx/conf.d/gomoku-v2.conf
PATH_SEG="${1:-gomoku-v2}"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info() { printf "${CYAN}[信息]${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}[就绪]${NC} %s\n" "$*"; }
die()  { printf "\033[0;31m[失败]\033[0m %s\n" "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行"

# ── 前置检查 ──
if ! docker ps --format '{{.Names}}' | grep -qx skill-gomoku; then
  die "容器 skill-gomoku 未运行。先启动：docker start skill-gomoku"
fi
ok "容器在运行"

if ! curl -sf -o /dev/null --max-time 5 http://127.0.0.1:8080/; then
  die "8080 无响应，检查日志：docker logs skill-gomoku --tail 20"
fi
ok "容器服务正常"

# 端口 80 是否已被 nginx 占用为默认站点
if ! ss -ltn 2>/dev/null | grep -q ':80 '; then
  die "80 端口没有服务在监听，请先安装启动 nginx"
fi
ok "nginx 监听 80"

# ── 生成配置 ──
info "写入 nginx 配置（路径 /$PATH_SEG/）"
# 注意：conf.d 下的文件会被 include 到 http 块，因此必须写完整的 server，
# 不能只写 location —— 那样会报 "location directive is not allowed here"
#
# 这里不声明 default_server：v1 的 gomoku.conf 已经占用了它，
# 重复声明会导致 nginx 拒绝加载配置。
cat > "$CONF" <<EOF
# 技能五子棋 v2（Docker :8080）→ 反代到 /$PATH_SEG/
# 由 deploy/setup-nginx-path.sh 生成于 $(date '+%Y-%m-%d %H:%M:%S')

server {
    listen 80;
    listen [::]:80;
    server_name _;

    location /$PATH_SEG/ {
        proxy_pass http://127.0.0.1:8080/;
        proxy_http_version 1.1;

        # WebSocket 升级（socket.io 依赖这两行）
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # socket.io 的长轮询需要关缓冲
        proxy_buffering off;
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
    }
}
EOF

ok "已写入 $CONF"

# ── 校验并重载 ──
info "校验并重载 nginx"
VERIFY=$(nginx -t 2>&1)
echo "$VERIFY" | sed 's/^/      /'
# nginx 默认站点若也声明了 default_server 会冲突，这里显式检查
if echo "$VERIFY" | grep -qi 'conflicting server name\|duplicate default server'; then
  die "与已有 server 块冲突。若 /gomoku（v1）已占用 80，请先移除它的 default_server：
  sed -i 's/listen 80 default_server;/listen 80;/' /etc/nginx/conf.d/gomoku.conf
  然后重跑本脚本"
fi
if ! echo "$VERIFY" | grep -q 'test is successful'; then
  die "nginx 配置有误，未重载"
fi

systemctl reload nginx
ok "nginx 已重载"

sleep 1
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1/$PATH_SEG/")
if [ "$CODE" = "200" ]; then
  ok "经 nginx 访问正常（/$PATH_SEG/ → 200）"
else
  die "经 nginx 访问返回 $CODE"
fi

WS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  "http://127.0.0.1/$PATH_SEG/socket.io/?EIO=4&transport=polling" | head -c 3)
echo "  socket.io 握手前缀：$WS（应为 0 开头或 4）"

echo ""
ok "完成"
echo ""
echo "  访问地址： http://182.92.63.63/$PATH_SEG/"
echo ""
echo "  socket.io 会自动连接当前路径，无需额外配置。"