# syntax=docker/dockerfile:1
# 多阶段构建：零依赖项目不执行真正的 npm ci，但保留守卫以便日后加依赖时无需改 Dockerfile。
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# 目录必须始终存在，否则后续 COPY --from=deps 在无锁文件时会失败。
RUN mkdir -p /app/node_modules \
 && if [ -f package-lock.json ]; then \
      echo "lockfile found -> npm ci --omit=dev"; \
      npm ci --omit=dev; \
    else \
      echo "no lockfile -> skip npm ci (ZERO npm dependencies)"; \
    fi

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY src ./src
COPY schema ./schema

# 持久化数据目录，非 root 运行。
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
EXPOSE 10443 18080
USER node

CMD ["node", "src/server.js"]
