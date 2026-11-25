FROM node:24.4.1-bookworm
COPY --from=ghcr.io/astral-sh/uv:0.9.11 /uv /bin/uv
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 UV_PYTHON_PREFERENCE=only-managed
WORKDIR /repo
RUN corepack enable
COPY . .
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install --no-frozen-lockfile; fi
RUN if [ -f uv.lock ]; then uv sync --locked; else uv sync; fi
CMD ["sh", "-ec", "pnpm format:check && pnpm lint && pnpm typecheck && pnpm schema-check && pnpm test"]
