#!/bin/sh
# Checks the source bundle with the OKF checkers, packs it with okf-catalog, checks the result, and prints the
# commit it recorded. Nothing is pushed here: push.sh does that, in a job that holds the write token (D46).
#
# usage: pack.sh --config <path> --source <bundle folder> --out <folder> [--commit <sha>]
# needs: sh, git, okflint and okf-schema on PATH, and okf-catalog (or OKF_CATALOG_BIN, such as "node dist/cli.js").
set -eu

usage() {
  echo "usage: pack.sh --config <path> --source <bundle folder> --out <folder> [--commit <sha>]" >&2
  exit 2
}

COMMIT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG=$2; shift 2 ;;
    --source) SOURCE=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --commit) COMMIT=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "${CONFIG:-}" ] && [ -n "${SOURCE:-}" ] && [ -n "${OUT:-}" ] || usage

OKF_CATALOG_BIN="${OKF_CATALOG_BIN:-okf-catalog}"
if [ -z "$COMMIT" ]; then
  COMMIT=$(git -C "$SOURCE" rev-parse HEAD)
fi

# The checkers on the source, then the pack, then the checkers on what will be published.
okflint validate "$SOURCE" >&2
okf-schema validate --path "$SOURCE" >&2
# OKF_CATALOG_BIN may carry arguments ("node dist/cli.js"), so it is split on purpose.
# shellcheck disable=SC2086
$OKF_CATALOG_BIN pack --config "$CONFIG" --from "$SOURCE" --out "$OUT" --commit "$COMMIT" >&2
okflint validate "$OUT" >&2
okf-schema validate --path "$OUT" >&2

echo "$COMMIT"
