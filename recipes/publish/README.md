# Publishing a bundle

The server reads a `published` branch: the admitted pages, their index files and a manifest, exactly as `okf-catalog pack` writes them. This folder is the recipe that produces that branch from the source branch on every push.

## What runs

1. `pack.sh` runs the OKF checkers you enable on the bundle folder, runs `okf-catalog pack`, and runs them again on the packed folder. It prints the commit it recorded. It never pushes. okflint 0.5.0 resolves its manifest's roots against the manifest's folder and fails on a folder outside them, so the second okflint pass runs on a copy of the manifest beside a copy of the pack placed at the manifest's first root path; that root must be a relative path (`kb`, `../kb`), which is how the manifests in the wild are written. The checkers are the company's gates, each switched on by a setting: `OKFLINT_MANIFEST` names okflint's own manifest file (okflint 0.5.0 exits 2 without one, so it is left out when unset); `OKF_SCHEMA` is `1`, or `strict` to fail on warnings, or empty to leave okf-schema out. Note that okf-schema 0.12.0 fails the specification's own example bundle (its `log.md` carries frontmatter, which that checker calls an error), so whether to run it is your call; `okf-catalog pack` itself applies the intake contract either way.
2. `push.sh` commits the packed folder onto the published branch, with the current tip as the parent, and pushes without force. A push that loses a race is rejected and the next run follows. It stages the files as plain blobs with git's plumbing (`hash-object --no-filters`, `update-index`), so no line-ending rule, filter or ignore rule of the machine it runs on can change the bytes `pack` hashed. The commit message carries the source commit through a variable; no event text ever reaches a shell.

`publish.yml` is the GitHub Actions workflow, and the only file a company copies: to `.github/workflows/publish.yml` in the repository that holds the bundle. The scripts and the checker lock travel inside the server package, which the workflow installs from npm at the exact version the file came from (`OKF_CATALOG_SOURCE`, `okf-catalog@<version>`) and finds under `npm root -g`. Set the values under `env`: the bundle folder (`BUNDLE_PATH`, the folder with the pages, never the repository root), the configuration file (`CONFIG_PATH`), the published branch's name, the checker settings, and `OKF_CATALOG_SOURCE`. Set the source branch under `on.push.branches`; it must never be the published branch, or the workflow would run on its own push.

The workflow has two jobs. `build` holds `contents: read` only and does not keep the checkout's credentials, so the third-party code it installs (the checkers, the server package) never sees a write token; it hands the packed bundle over as one archive, so file names the artifact store would refuse travel untouched. `publish` holds `contents: write` and runs git alone. Every action is pinned to a commit, as is `uv`. One run at a time: a running one is never cancelled, and a queued one is replaced by a newer queued one.

## What the company sets up once

- A ruleset or branch protection that lets the workflow push `published` and nothing else. The `contents: write` permission is repository-wide, so the rule is what limits it.
- Protection on the source branch as the company sees fit; the workflow only reads it.
- The checkers' versions are in `checkers.txt`; `checkers.lock` is their hash-pinned resolution, which the workflow installs with `--require-hashes` into a Python 3.12 environment, the interpreter the lock was built for. Regenerate the lock after changing a version (the command is in `checkers.txt`). The server package is installed at an exact version from npm; every published version carries a provenance statement that ties it to its source commit and its build on GitHub Actions, and `npm audit signatures` verifies it. Unpinned: the runner's Node is whatever `setup-node` gives for "24", the line the server requires.

## Running by hand

With git, `uv`, Node 24 or later and the checkers on `PATH`:

```sh
OKF_CATALOG_BIN="node /path/to/okf-catalog/dist/cli.js" \
  sh recipes/publish/pack.sh --config okf-catalog.yaml --source kb --out /tmp/bundle
sh recipes/publish/push.sh --repo . --bundle /tmp/bundle --commit "$(git rev-parse HEAD)"
```

`pack.sh` fails, and nothing is pushed, when a checker fails on the source or on the packed folder, or when `okf-catalog pack` refuses a file (the report says which and why). It also fails when no page is admitted, since `pack` refuses to write such a bundle unless given `--allow-empty`, which the recipe never passes: a typo in `serve.admit` that empties the bundle fails the run instead of publishing a branch with no page, and the report names the word that matched nothing.

Optional: `actionlint` on `publish.yml` before committing it.
