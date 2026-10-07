# okf-catalog

A small-company hosted knowledge catalog for AI agents.

okf-catalog is an MCP server that serves a company's [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format) bundle to agents. It runs on a developer's machine today and from a cheap cloud recipe later, so that local coding agents (Claude Code, Codex, Grok Build) and the web versions of Claude and ChatGPT answer from the same cited knowledge.

What it adds: **qmd done right for OKF.** [qmd](https://github.com/tobi/qmd) is the best Markdown search engine there is. okf-catalog makes it understand OKF's fields: titles, descriptions and tags ranked as they should be, status and recheck dates respected, trust and provenance returned with every answer, deprecated pages pointing to their replacements.

**Status: version 0 release candidate (0.1.0), not yet accepted, not published.** Every item of the version 0 acceptance list that a test can prove is proven on every run; the items that need a person on a clean account (a signed-in Claude Code answering from a bundle, a real publish, the network off) are pending, with their runbook in [docs/acceptance/version-0.md](docs/acceptance/version-0.md). The package is marked private and nothing is on npm; the licence is Apache-2.0 as proposed in decision D1, awaiting the maintainer's confirmation. Start with [docs/intent.md](docs/intent.md); the implementation plan and its execution record are under [docs/plans/](docs/plans/).

## Quickstart

The install is a checkout; publication to npm is a separate ruling.

```bash
git clone <this repository> okf-catalog && cd okf-catalog
NODE_LLAMA_CPP_SKIP_DOWNLOAD=1 npm ci
```

`npm ci` builds `dist/` on its way out (the `prepare` script), and the flag keeps qmd's native dependency from downloading or compiling anything: lexical mode needs no model. Check the install and a bundle:

```bash
node dist/cli.js --version
node dist/cli.js check path/to/bundle --integrity none --types Term,Guide
```

Write the company's configuration, `okf-catalog.yaml`. A folder on this machine, served as it is, drafts admitted and labelled:

```yaml
company: acme
source:
  local: ./knowledge
serve:
  dev: true
types: [Term, Guide, Policy]
```

Or a published branch, fetched into the server's own cache and polled:

```yaml
company: acme
source:
  repository: git@github.com:acme/knowledge.git
  branch: published
  bundle_path: kb
serve:
  pull_interval: 10m
types: [Term, Guide, Policy]
```

Give it to Claude Code through the plugin folder:

```bash
claude --plugin-dir ./plugin/claude-code
```

In the session, `/plugin configure okf-catalog` asks for the two settings (this checkout as the install folder, the configuration file), then `/reload-plugins` and `/mcp` show the `okf-catalog` server connected, and the skill tells Claude to search with keywords, read pages whole and cite the path, the trust tier, the verifier and the recheck date. Whether `/plugin configure` fills the plugin's settings under `--plugin-dir` is still to be confirmed by hand (an item of the acceptance runbook); the server itself can always be started from a shell with `node dist/cli.js serve --config okf-catalog.yaml` and speaks MCP over stdio.

To publish, `node dist/cli.js pack --config okf-catalog.yaml --from ./knowledge --out ./published` writes what a server serves; `recipes/publish/` has the workflow and scripts that run the OKF checkers around it and push the branch. Not in this version: full mode, a hosted server, Windows, a registry install.

## Requirements

- Node 22.12 or later, on macOS or Linux (Windows is not a version 0 host: the cache folder's ownership and mode checks assume POSIX).
- The cache folder (`$XDG_CACHE_HOME/okf-catalog/<company>`, or the platform's user cache folder) must be on a local filesystem: the one-process-per-company lock is an operating-system lock on a SQLite file, which network filesystems do not honour reliably, and it must not lie inside the bundle folder.

## Publishing

A server reads a `published` branch, which `okf-catalog pack` writes from a bundle folder: the admitted pages, their index files, the attachments and a manifest. `recipes/publish/` holds the GitHub Actions workflow and the two shell scripts that produce that branch on every push to the source branch, with the OKF checkers run before and after `pack`. A configuration with `source.repository`, `branch` and `bundle_path` serves that branch and polls it at `serve.pull_interval`; one with `source.local` serves a folder as it is.

## Documents

| Document | Holds |
|---|---|
| [docs/intent.md](docs/intent.md) | What this is, for whom, what it must do, and how done is judged |
| [docs/decisions/0001-founding-decisions.md](docs/decisions/0001-founding-decisions.md) | Every decision behind the design, what was rejected and why, and whether it is settled |
| [docs/research/](docs/research/) | The verified facts the design rests on, with sources and dates |

## Licence

Apache-2.0 (see `LICENSE` and `NOTICE`), proposed in decision D1 and awaiting the maintainer's confirmation before the first push.
