# Hikoutei demo server — SQLite authority + Sheets sync + SSE metrics.
FROM node:22.13-alpine

WORKDIR /app

# Production deps only (tsx/typescript are dev-time; runtime uses node's
# built-in type stripping).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
# SQLite lives on a mounted volume so restarts keep the durable outbox.
ENV DEMO_DB_PATH=/data/demo.sqlite
VOLUME /data

EXPOSE 3101
CMD ["node", "--experimental-strip-types", "src/server.ts"]