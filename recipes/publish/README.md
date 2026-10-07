# Publishing a bundle

The server reads a `published` branch: the admitted pages, their index files and a manifest, exactly as `okf-catalog pack` writes them. This folder is the recipe that produces that branch from the source branch on every push.

## What runs

1. `pack.sh` runs the OKF checkers (`okflint`, `okf-schema`) on the bundle folder, runs `okf-catalog pack`, and runs the checkers again on the packed folder. It prints the commit it recorded. It never pushes.
2. `push.sh` commits the packed folder onto the published branch, with the current tip as the parent, and pushes without force. A push that loses a race is rejected and the next run follows. The commit message carries the source commit through a variable; no event text ever reaches a shell.

`publish.yml` is the GitHub Actions workflow. Copy it to `.github/workflows/publish.yml` in the repository that holds the bundle and set the four values under `env`: the bundle folder (`BUNDLE_PATH`, the folder with the pages, never the repository root), the configuration file (`CONFIG_PATH`), the published branch's name, and `OKF_CATALOG_SOURCE`, the server package from a pinned commit of its repository (the workflow never installs a bare package name). Set the source branch under `on.push.branches`; it must never be the published branch, or the workflow would run on its own push.

The workflow has two jobs. `build` holds `contents: read` only and does not keep the checkout's credentials, so the third-party code it installs (the checkers, the server package) never sees a write token. `publish` holds `contents: write` and runs git alone. Every action is pinned to a commit. One run at a time, none cancelled.

## What the company sets up once

- A ruleset or branch protection that lets the workflow push `published` and nothing else. The `contents: write` permission is repository-wide, so the rule is what limits it.
- Protection on the source branch as the company sees fit; the workflow only reads it.
- The checkers' versions are in `checkers.txt`; `checkers.lock` is their hash-pinned resolution, which the workflow installs with `--require-hashes`. Regenerate the lock after changing a version (the command is in `checkers.txt`).

## Running by hand

With git, `uv`, Node 22.12 or later and the checkers on `PATH`:

```sh
OKF_CATALOG_BIN="node /path/to/okf-catalog/dist/cli.js" \
  sh recipes/publish/pack.sh --config okf-catalog.yaml --source kb --out /tmp/bundle
sh recipes/publish/push.sh --repo . --bundle /tmp/bundle --commit "$(git rev-parse HEAD)"
```

`pack.sh` fails, and nothing is pushed, when a checker fails on the source or on the packed folder, or when `okf-catalog pack` refuses a file (the report says which and why).

Optional: `actionlint` on `publish.yml` before committing it.
