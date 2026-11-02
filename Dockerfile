FROM node:22-alpine
WORKDIR /app

# 先装依赖，利用 Docker 层缓存
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8080

# 用非 root 用户运行
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1

CMD ["node", "server.js"]