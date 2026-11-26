#!/usr/bin/env bash
set -euo pipefail
umask 077

case "${1:-}" in
  --dry-run)
    echo 'Stream a custom Postgres dump through age, upload the encrypted object under the dedicated S3 prefix and let bucket lifecycle expire it after 30 days.'
    exit 0 ;;
  --apply) ;;
  *) echo 'Usage: bash ops/docker/backup.sh (--dry-run | --apply)' >&2; exit 2 ;;
esac
[[ $# == 1 ]]
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_root
lock_deployment
source "$deploy_root/backup.env"
: "${S3_BUCKET:?Set S3_BUCKET}" "${AGE_RECIPIENT:?Set AGE_RECIPIENT}"
IFS= read -r active < "$deploy_root/releases/state"
release=$(release_file "$active")
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
archive=$(mktemp "$deploy_root/.backup.XXXXXXXX")
trap 'rm -f -- "$archive"' EXIT

compose "$release" exec -T postgres pg_dump -U demo -d demo -Fc --no-owner --no-acl --no-password |
  age -r "$AGE_RECIPIENT" -o "$archive"
[[ -s $archive ]]
s3 cp --only-show-errors "$archive" "s3://$S3_BUCKET/rivetquay/postgres/$timestamp-${archive##*.}.dump.age"
echo 'Encrypted database backup uploaded.'
