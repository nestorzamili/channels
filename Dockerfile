# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM oven/bun:1.4.3-alpine AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production \
    && rm -rf node_modules/typescript node_modules/.bin/tsc node_modules/.bin/tsserver

COPY src ./src
RUN bun run build

FROM oven/bun:1.4.3-alpine AS runtime

LABEL org.opencontainers.image.title="Channels"
LABEL org.opencontainers.image.source="https://github.com/nestorzamili/channels"
LABEL org.opencontainers.image.description="Multi-channel messaging platform."

ENV NODE_ENV=production
ENV TZ=Asia/Jakarta

WORKDIR /app

RUN mkdir -p /app/.zaileys && chown -R bun:bun /app

COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist

VOLUME ["/app/.zaileys"]

USER bun


CMD ["bun", "dist/index.js"]
