#!/usr/bin/env bash
# Source from deployment scripts after processing --dry-run.
deploy_root=${RIVETQUAY_ROOT:-/etc/rivetquay}
docker_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

require_root() {
  if [[ $(id -u) != 0 || ! $deploy_root =~ ^/[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*$ ]]; then
    echo 'Run as root with an absolute RIVETQUAY_ROOT outside the checkout.' >&2
    exit 2
  fi
}

lock_deployment() {
  exec 9>"$deploy_root/operation.lock"
  flock -x 9
}

release_file() {
  [[ $1 =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$ ]] || return 2
  printf '%s/releases/%s.env\n' "$deploy_root" "$1"
}

compose() {
  local release=$1
  shift
  # Compose inherits the shell environment ahead of --env-file values.
  env -u API_IMAGE -u WEB_IMAGE -u WORKER_IMAGE -u BS_DEMO_HOST -u BS_OWNER_CIDR \
    -u BS_MAILPIT -u COMPOSE_PROFILES -u COMPOSE_PROJECT_NAME BS_DEPLOY_ROOT="$deploy_root" \
    docker compose --project-name rivetquay --env-file "$deploy_root/site.env" --env-file "$release" \
      -f "$docker_dir/compose.prod.yaml" "$@"
}

s3() {
  local flags=(--region ca-central-1 --no-cli-pager)
  if [[ -n ${S3_ENDPOINT_URL:-} ]]; then
    [[ $S3_ENDPOINT_URL == https://* ]] || return 2
    flags+=(--endpoint-url "$S3_ENDPOINT_URL")
  fi
  aws "${flags[@]}" s3 "$@"
}
