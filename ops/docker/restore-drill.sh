#!/usr/bin/env bash
set -euo pipefail
umask 077

usage='Usage: bash ops/docker/restore-drill.sh (--dry-run | --apply --object <filename.dump.age> --identity <age-key-file>)'
if [[ $# == 1 && $1 == --dry-run ]]; then
  echo 'Fetch one encrypted object, decrypt to an isolated disposable Postgres, verify migrations and the synthetic order, then destroy the scratch database.'
  exit 0
fi
if [[ $# != 5 || $1 != --apply || $2 != --object || $4 != --identity ]]; then
  echo "$usage" >&2; exit 2
fi
object=$3
identity=$5
[[ $object =~ ^[0-9]{8}T[0-9]{6}Z-[a-zA-Z0-9]+\.dump\.age$ && -f $identity ]]
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_root
source "$deploy_root/backup.env"
: "${S3_BUCKET:?Set S3_BUCKET}"
archive=$(mktemp "$deploy_root/.restore.XXXXXXXX")
trap 'rm -f -- "$archive"' EXIT
s3 cp --only-show-errors "s3://$S3_BUCKET/rivetquay/postgres/$object" "$archive"

restore=$(cat <<'EOF'
unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
initdb -A trust -U demo --no-sync >/dev/null
pg_ctl -o "-c listen_addresses=''" -w start </dev/null >/dev/null
createdb -U demo demo
pg_restore -U demo -d demo --exit-on-error --single-transaction --no-owner --no-acl
test "$(psql -U demo -d demo -Atc "SELECT count(*) FROM governance.migration")" -gt 0
test "$(psql -U demo -d demo -Atc "SELECT id FROM demo_fixture.sales_order WHERE tenant_id = 'tenant-rivetquay' AND id = 'ord-001'")" = ord-001
pg_ctl -m fast -w stop >/dev/null
EOF
)
age -d -i "$identity" "$archive" |
  docker run --rm --pull never --interactive --network none --read-only --user 70:70 \
    --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /var/lib/postgresql/data:uid=70,gid=70,mode=0700,size=2g \
    --tmpfs /var/run/postgresql:uid=70,gid=70,mode=0775 \
    --tmpfs /tmp:mode=1777 \
    --entrypoint /bin/sh postgres:17.7-alpine -ec "$restore"
echo 'Restore drill verified the migration ledger and synthetic order.'
