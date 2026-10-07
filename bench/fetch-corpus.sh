#!/usr/bin/env sh
# Rebuilds the public benchmark corpus: four OKF bundles from public repositories at pinned commits, arranged
# under bench/corpus/ with the folder names the questions' gold paths use. Read-only on the network; writes
# only under bench/corpus and bench/clones (both gitignored). Needs git and about 50 MB.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
corpus="$here/corpus"
work="$here/clones"
mkdir -p "$work"

fetch() { # name url commit
  if [ ! -d "$work/$1/.git" ]; then git clone -q --no-checkout -- "$2" "$work/$1"; fi
  git -C "$work/$1" fetch -q --depth=1 origin "$3" || true
  git -C "$work/$1" -c advice.detachedHead=false checkout -q --force "$3"
}

fetch okf-skills            https://github.com/scaccogatto/okf-skills            8e3187875e66051bb52f91a5ed27342e2c3208da
fetch okf-agent-memory      https://github.com/okf-memory/okf-agent-memory         533b63475d42a4796e4c81c25a8121e660e1e416
fetch cole-medin            https://github.com/coleam00/cole-medin-knowledge-base  eba5e31bc628280c546d4828491051c308d550dc
fetch superops-okf          https://github.com/superops-team/okf                  88a751032e36300c57af291394ded61ae6db67eb

rm -rf "$corpus/okf-skills" "$corpus/okf-agent-memory" "$corpus/cole-medin" "$corpus/okf-docs"
cp -R "$work/okf-skills/.okf"               "$corpus/okf-skills"
cp -R "$work/okf-agent-memory/knowledge"    "$corpus/okf-agent-memory"
mkdir -p "$corpus/cole-medin"
for folder in concepts entities sources; do
  [ -d "$work/cole-medin/$folder" ] && cp -R "$work/cole-medin/$folder" "$corpus/cole-medin/$folder"
done
cp -R "$work/superops-okf/docs/knowledge"   "$corpus/okf-docs"

echo "corpus ready under $corpus: $(find "$corpus" -name '*.md' | wc -l | tr -d ' ') Markdown files"
