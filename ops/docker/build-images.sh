#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  --dry-run)
    printf '%s\n' 'Archive the committed tree, place ops/docker/.dockerignore at the context root, and build api, web and worker locally.'
    exit 0 ;;
  --apply) ;;
  *) echo 'Usage: bash ops/docker/build-images.sh (--dry-run | --apply)' >&2; exit 2 ;;
esac
[[ $# == 1 ]]
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
context=$(mktemp -d)
trap 'rm -rf -- "$context"' EXIT
revision=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" archive "$revision" | tar -x -C "$context"
cp "$context/ops/docker/.dockerignore" "$context/.dockerignore"
for service in api web worker; do
  docker build -t "rivetquay-$service:$revision" -f "$context/ops/docker/$service.Dockerfile" "$context"
done
