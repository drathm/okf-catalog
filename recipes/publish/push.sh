#!/bin/sh
# Commits a packed bundle onto the published branch, on top of its current tip, and pushes it without force. It
# works through a checkout whose remote already carries the credentials (in GitHub Actions, the checkout step's),
# so no credential ever appears in a URL here, and it never touches that checkout's index or working tree: the
# bundle is staged into an index of its own and written as a tree with git's plumbing.
#
# usage: push.sh --repo <checkout> --bundle <packed folder> --commit <sha> [--remote origin] [--branch published]
set -eu

usage() {
  echo "usage: push.sh --repo <checkout> --bundle <packed folder> --commit <sha> [--remote origin] [--branch published]" >&2
  exit 2
}

REMOTE=origin
BRANCH=published
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO=$2; shift 2 ;;
    --bundle) BUNDLE=$2; shift 2 ;;
    --commit) COMMIT=$2; shift 2 ;;
    --remote) REMOTE=$2; shift 2 ;;
    --branch) BRANCH=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "${REPO:-}" ] && [ -n "${BUNDLE:-}" ] && [ -n "${COMMIT:-}" ] || usage

GIT_DIR=$(git -C "$REPO" rev-parse --absolute-git-dir)
export GIT_DIR
export GIT_AUTHOR_NAME="okf-catalog publish" GIT_AUTHOR_EMAIL="okf-catalog-publish@invalid"
export GIT_COMMITTER_NAME="okf-catalog publish" GIT_COMMITTER_EMAIL="okf-catalog-publish@invalid"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
GIT_INDEX_FILE="$TMP/index"
export GIT_INDEX_FILE

# The new commit's parent is the branch's current tip, so a race is rejected by the remote and the next run follows.
PARENT=""
if git fetch -q "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null; then
  PARENT=$(git rev-parse --verify -q "FETCH_HEAD^{commit}")
fi

# Stage the packed folder into the private index, as the whole tree, ignore rules included.
(cd "$BUNDLE" && git --work-tree="$BUNDLE" add -A -f .)
TREE=$(git write-tree)

# The message carries the source commit through a variable, never text from an event.
MESSAGE="publish $COMMIT"
if [ -n "$PARENT" ]; then
  NEW=$(printf '%s\n' "$MESSAGE" | git commit-tree "$TREE" -p "$PARENT")
else
  NEW=$(printf '%s\n' "$MESSAGE" | git commit-tree "$TREE")
fi
git push -q "$REMOTE" "$NEW:refs/heads/$BRANCH"
echo "published $COMMIT to $BRANCH as $NEW"
