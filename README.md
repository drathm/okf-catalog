# okf-catalog

[![npm](https://img.shields.io/npm/v/okf-catalog)](https://www.npmjs.com/package/okf-catalog)

A small-company hosted knowledge catalog for AI agents.

okf-catalog is an MCP server that serves a company's [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format) bundle to agents. It runs on a developer's machine today and from a cheap cloud recipe later, so that local coding agents (Claude Code, Codex, Grok Build) and the web versions of Claude and ChatGPT answer from the same cited knowledge.

What it adds: **qmd done right for OKF.** [qmd](https://github.com/tobi/qmd) is the best Markdown search engine there is. okf-catalog makes it understand OKF's fields: titles, descriptions and tags ranked as they should be, status and recheck dates respected, trust and provenance returned with every answer, deprecated pages pointing to their replacements.

**Status: version 0 (0.1.3) on npm, not yet accepted; the next release, 0.2.0, filters search by tag, status and trust tier, includes pages past their recheck date by default (flagged), takes a page's concept id, and reads the contract fields, usage windows and OKF 0.1 fallbacks; 0.3.0 adds `citations`, what a page cites and what cites it, and `provenance`, where its sources lead inside the bundle, neither fetching anything (`CHANGELOG.md`, Unreleased).** Every item of the version 0 acceptance list that a test can prove is proven on every run; the items that need a person on a clean account (a signed-in Claude Code answering from a bundle, a real publish, the network off) are pending, with their runbook in [docs/acceptance/version-0.md](docs/acceptance/version-0.md). The package is public on npm as `okf-catalog`; releases are tagged `v<version>` and published by the repository's release workflow through npm's trusted publishing, each with a provenance statement, and `CHANGELOG.md` has the entries. The licence is Apache-2.0 (decision D1). Start with [docs/intent.md](docs/intent.md); the implementation plan and its execution record are under [docs/plans/](docs/plans/).

## Quickstart

The install is one command, and the `okf-catalog` command lands on your PATH:

```bash
NODE_LLAMA_CPP_SKIP_DOWNLOAD=1 npm install -g okf-catalog
```

To work on the code, use a checkout:

```bash
git clone https://github.com/drathm/okf-catalog.git && cd okf-catalog
NODE_LLAMA_CPP_SKIP_DOWNLOAD=1 npm ci
```

`npm ci` builds `dist/` on its way out (the `prepare` script), and the flag keeps qmd's native dependency from downloading or compiling anything: lexical mode needs no model. Either install pulls about 230 MB of dependencies, most of it qmd's search engine and its native packages. Check the install and a bundle (`node dist/cli.js` in a checkout stands in for `okf-catalog`, or `npm install -g .` puts the command on PATH):

```bash
okf-catalog --version
okf-catalog check path/to/bundle --integrity none --types Term,Guide
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

Give it to Claude Code through the plugin, which asks for no settings: it runs the `okf-catalog` command from PATH in the project folder, where the server finds `okf-catalog.yaml` (or the file named by `OKF_CATALOG_CONFIG`). The plugin folder ships inside the package:

```bash
claude --plugin-dir "$(npm root -g)/okf-catalog/plugin/claude-code"
```

From a checkout, `npm install -g .` puts the command on PATH and `claude --plugin-dir ./plugin/claude-code` loads the same plugin. In the session, `/mcp` shows the `okf-catalog` server connected, and the skill tells Claude to search with keywords, read pages whole and cite the path, the trust tier, the verifier and the recheck date. The server can also be started from a shell with `okf-catalog serve --config okf-catalog.yaml`; it speaks MCP over stdio.

To publish, `node dist/cli.js pack --config okf-catalog.yaml --from ./knowledge --out ./published` writes what a server serves; `recipes/publish/` has the workflow and scripts that run the OKF checkers around it and push the branch. Not in this version: full mode, a hosted server, Windows, a registry install.

## Requirements

- Node 24 or later (the Active LTS line when version 0 was built), on macOS or Linux (Windows is not a version 0 host: the cache folder's ownership and mode checks assume POSIX).
- The cache folder (`$XDG_CACHE_HOME/okf-catalog/<company>`, or the platform's user cache folder) must be on a local filesystem: the one-process-per-company lock is an operating-system lock on a SQLite file, which network filesystems do not honour reliably, and it must not lie inside the bundle folder.

## Publishing

A server reads a `published` branch, which `okf-catalog pack` writes from a bundle folder: the admitted pages, their index files, the attachments and a manifest. `recipes/publish/` holds the GitHub Actions workflow and the two shell scripts that produce that branch on every push to the source branch, with the OKF checkers run before and after `pack`. A configuration with `source.repository`, `branch` and `bundle_path` serves that branch and polls it at `serve.pull_interval`; one with `source.local` serves a folder as it is.

## Documents

| Document | Holds |
|---|---|
| [docs/intent.md](docs/intent.md) | What this is, for whom, what it must do, and how done is judged |
| [docs/architecture.md](docs/architecture.md) | The layers, the data flow at serve time, the publish loop, and what lives where |
| [docs/decisions/0001-founding-decisions.md](docs/decisions/0001-founding-decisions.md) | Every decision behind the design, what was rejected and why, and whether it is settled |
| [docs/research/](docs/research/) | The verified facts the design rests on, with sources and dates |

## Licence

Apache-2.0 (see `LICENSE` and `NOTICE`); okf-catalog is a product of Bitfusion PR LLC (bitfusion.tech), settled in decision D1 on 2026-10-07. Contributions need the one-time signature of [CLA.md](CLA.md), which keeps a later change of licence possible; see [CONTRIBUTING.md](CONTRIBUTING.md).
