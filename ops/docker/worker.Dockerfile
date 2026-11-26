FROM python:3.12-slim-bookworm AS dependencies
COPY --from=ghcr.io/astral-sh/uv:0.9.11 /uv /bin/uv
WORKDIR /repo
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project --python /usr/local/bin/python

FROM python:3.12-slim-bookworm AS runtime
WORKDIR /repo
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY --from=dependencies /repo/.venv /repo/.venv
COPY workers/ /repo/workers/
COPY packages/contracts/ /repo/packages/contracts/
COPY infra/compose/worker_socket.py /repo/infra/compose/worker_socket.py
RUN install -d -m 0700 -o 10001 -g 10001 /run/fixture-worker \
    && touch /run/fixture-worker/.keep \
    && chown 10001:10001 /run/fixture-worker/.keep
USER 10001:10001
HEALTHCHECK --interval=10s --timeout=3s --retries=8 CMD test -S "$BS_WORKER_SOCKET"
CMD ["/repo/.venv/bin/python", "infra/compose/worker_socket.py"]
