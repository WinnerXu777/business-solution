#!/usr/bin/env bash
set -euo pipefail
umask 077

case "${1:-}" in
  --dry-run)
    echo 'Create root-owned site directories and generate a Postgres password, vault master key, two reserved session keys and scoped fixture bearer tokens.'
    exit 0 ;;
  --apply) ;;
  *) echo 'Usage: bash ops/docker/init-secrets.sh (--dry-run | --apply)' >&2; exit 2 ;;
esac
[[ $# == 1 ]]
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_root
install -d -m 0700 "$deploy_root" "$deploy_root/releases"
install -d -m 0755 "$deploy_root/switch"
lock_deployment
if [[ -e $deploy_root/secrets ]]; then echo 'Secrets already exist.' >&2; exit 1; fi
staging=$(mktemp -d "$deploy_root/.secrets.XXXXXXXX")
trap 'rm -f -- "$staging/api.env" "$staging/postgres.env" "$staging/session.env"; rmdir -- "$staging" 2>/dev/null || true' EXIT
password=$(openssl rand -hex 32)
vault=$(openssl rand -base64 32)
session_signing=$(openssl rand -hex 32)
session_encryption=$(openssl rand -hex 32)
admin=$(openssl rand -hex 32)
operator=$(openssl rand -hex 32)
approver=$(openssl rand -hex 32)
reader=$(openssl rand -hex 32)
isolation=$(openssl rand -hex 32)
{
  printf 'POSTGRES_USER=demo\nPOSTGRES_DB=demo\nPOSTGRES_PASSWORD=%s\n' "$password"
} > "$staging/postgres.env"
{
  printf 'DATABASE_URL=postgres://demo:%s@postgres:5432/demo\n' "$password"
  printf 'BS_PLATFORM_VAULT_MASTER_KEY=%s\nBS_FIXTURE_LOGIN=0\n' "$vault"
  printf 'FIXTURE_BEARER_BINDINGS={"%s":{"tenantId":"tenant-rivetquay","actorId":"actor-admin"},"%s":{"tenantId":"tenant-rivetquay","actorId":"actor-operator"},"%s":{"tenantId":"tenant-rivetquay","actorId":"actor-approver"},"%s":{"tenantId":"tenant-rivetquay","actorId":"actor-reader"},"%s":{"tenantId":"tenant-spoolharbour","actorId":"actor-isolation"}}\n' \
    "$admin" "$operator" "$approver" "$reader" "$isolation"
} > "$staging/api.env"
printf 'BS_SESSION_SIGNING_KEY=%s\nBS_SESSION_ENCRYPTION_KEY=%s\n' \
  "$session_signing" "$session_encryption" > "$staging/session.env"
mv -T -- "$staging" "$deploy_root/secrets"
echo 'Generated deployment secrets.'
