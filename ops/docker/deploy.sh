#!/usr/bin/env bash
set -euo pipefail
umask 077

usage='Usage: bash ops/docker/deploy.sh (--dry-run | --apply) (--release <id> | --rollback)'
if [[ ${1:-} != --apply && ${1:-} != --dry-run ]]; then echo "$usage" >&2; exit 2; fi
mode=$1
shift
if [[ $# == 1 && $1 == --rollback ]]; then
  release_id=
elif [[ $# == 2 && $1 == --release && $2 =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$ ]]; then
  release_id=$2
else
  echo "$usage" >&2; exit 2
fi
if [[ $mode == --dry-run ]]; then
  if [[ -n $release_id ]]; then
    printf 'Validate and pull digest-pinned release %s, enable maintenance, start Postgres, migrate, wait for stack health, record the release and restore traffic.\n' "$release_id"
  else
    echo 'Validate and pull the previous release, enable maintenance, wait for stack health on the existing schema, record the switch and restore traffic.'
  fi
  exit 0
fi
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_root
lock_deployment

read_state() {
  active=
  previous=
  if [[ -f $deploy_root/releases/state ]]; then
    { IFS= read -r active; IFS= read -r previous; } < "$deploy_root/releases/state"
    release_file "$active" >/dev/null
    if [[ -n $previous ]]; then release_file "$previous" >/dev/null; fi
  fi
}

validate_release() {
  local key ref
  local -A seen=()
  while IFS='=' read -r key ref || [[ -n $key ]]; do
    [[ $key == API_IMAGE || $key == WEB_IMAGE || $key == WORKER_IMAGE ]] || return 1
    [[ ! ${seen[$key]+present} && $ref =~ ^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$ ]] || return 1
    seen[$key]=1
  done < "$1"
  [[ ${#seen[@]} == 3 ]]
}

read_state
rollback=0
if [[ -z $release_id ]]; then
  rollback=1
  release_id=$previous
  if [[ -z $release_id ]]; then echo 'No previous healthy release is recorded.' >&2; exit 1; fi
fi
release=$(release_file "$release_id")
if [[ ! -f $release ]] || ! validate_release "$release"; then
  echo 'Release must contain exactly API_IMAGE, WEB_IMAGE and WORKER_IMAGE pinned by digest.' >&2
  exit 1
fi

compose "$release" config --quiet
compose "$release" pull
maintenance=$deploy_root/switch/maintenance
: > "$maintenance"
trap 'echo "Deployment interrupted. Maintenance stays enabled." >&2; exit 1' HUP INT TERM
trap 'echo "Deployment failed. Maintenance stays enabled. Check status before rolling back." >&2' ERR
compose "$release" up -d --wait --wait-timeout 120 postgres
compose "$release" --profile demo stop mailpit
if (( ! rollback )); then
  compose "$release" run --rm --no-deps api node infra/migrate.mjs
fi
compose "$release" up -d --remove-orphans --wait --wait-timeout 180
if [[ $release_id != "$active" ]]; then
  state=$(mktemp "$deploy_root/releases/.state.XXXXXXXX")
  printf '%s\n%s\n' "$release_id" "$active" > "$state"
  mv -T -- "$state" "$deploy_root/releases/state"
fi
rm -- "$maintenance"
echo "Release $release_id is serving."
