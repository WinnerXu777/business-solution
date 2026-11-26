FROM node:24.4.1-bookworm-slim AS dependencies
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile --prod

FROM node:24.4.1-bookworm-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=dependencies --chown=10001:10001 /repo /repo
COPY --chmod=0555 infra/compose/worker-client.mjs /repo/infra/compose/worker-client.mjs
RUN install -d -m 0700 -o 10001 -g 10001 /run/fixture-worker \
    && touch /run/fixture-worker/.keep \
    && chown 10001:10001 /run/fixture-worker/.keep
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=8 CMD ["node", "/repo/ops/docker/api-health.mjs"]
CMD ["node", "apps/api/src/ops/deployment.ts"]
