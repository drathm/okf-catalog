#!/bin/sh
# Checks the source bundle with the OKF checkers, packs it with okf-catalog, checks the result, and prints the
# commit it recorded. Nothing is pushed here: push.sh does that, in a job that holds the write token (D46).
#
# usage: pack.sh --config <path> --source <bundle folder> --out <folder> [--commit <sha>]
# needs: sh, git, okf-catalog (or OKF_CATALOG_BIN, such as "node dist/cli.js"), and the checkers you enable on PATH.
# settings: OKFLINT_MANIFEST (okflint's manifest file; unset leaves okflint out), OKF_SCHEMA (1, strict, or unset).
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

# The checkers are the company's gates, run when their setting is given: OKFLINT_MANIFEST names okflint's own
# manifest file (okflint 0.5.0 exits 2 without one); OKF_SCHEMA is 1, or strict to fail on warnings (okf-schema
# 0.12.0 fails the specification's own example on its log.md, so a company decides). They run on the source,
# then the pack, then on what will be published.
case "${OKF_SCHEMA:-}" in
  ""|1|strict) ;;
  *) echo "OKF_SCHEMA must be unset, 1 or strict" >&2; exit 2 ;;
esac
if [ -n "${OKFLINT_MANIFEST:-}" ]; then
  okflint validate --manifest "$OKFLINT_MANIFEST" "$SOURCE" >&2
fi
if [ "${OKF_SCHEMA:-}" = 1 ]; then
  okf-schema validate --path "$SOURCE" >&2
elif [ "${OKF_SCHEMA:-}" = strict ]; then
  okf-schema validate --path "$SOURCE" --strict >&2
fi
# OKF_CATALOG_BIN may carry arguments ("node dist/cli.js"), so it is split on purpose.
# shellcheck disable=SC2086
$OKF_CATALOG_BIN pack --config "$CONFIG" --from "$SOURCE" --out "$OUT" --commit "$COMMIT" >&2
if [ -n "${OKFLINT_MANIFEST:-}" ]; then
  okflint validate --manifest "$OKFLINT_MANIFEST" "$OUT" >&2
fi
if [ "${OKF_SCHEMA:-}" = 1 ]; then
  okf-schema validate --path "$OUT" >&2
elif [ "${OKF_SCHEMA:-}" = strict ]; then
  okf-schema validate --path "$OUT" --strict >&2
fi

echo "$COMMIT"
