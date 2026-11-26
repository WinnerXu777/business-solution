FROM node:24.4.1-bookworm-slim AS build
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 VITE_API_BASE_URL= VITE_FIXTURE_LOGIN=0
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile && pnpm --filter @bs/web build

FROM caddy:2.10.2-alpine AS runtime
RUN mkdir -p /data/caddy /config/caddy && chown -R 10002:10002 /data /config \
    && cp /usr/bin/caddy /tmp/caddy && mv /tmp/caddy /usr/bin/caddy
COPY --from=build /repo/apps/web/dist/ /srv/
COPY ops/docker/Caddyfile /etc/caddy/Caddyfile
USER 10002:10002
HEALTHCHECK --interval=10s --timeout=3s --retries=8 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8081/health"]
