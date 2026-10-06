# okf-catalog

A small-company hosted knowledge catalog for AI agents.

okf-catalog is an MCP server that serves a company's [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format) bundle to agents. It runs on a developer's machine today and from a cheap cloud recipe later, so that local coding agents (Claude Code, Codex, Grok Build) and the web versions of Claude and ChatGPT answer from the same cited knowledge.

What it adds: **qmd done right for OKF.** [qmd](https://github.com/tobi/qmd) is the best Markdown search engine there is. okf-catalog makes it understand OKF's fields: titles, descriptions and tags ranked as they should be, status and recheck dates respected, trust and provenance returned with every answer, deprecated pages pointing to their replacements.

**Status: version 0 in progress, nothing published.** Start with [docs/intent.md](docs/intent.md); the implementation plan and its execution record are under [docs/plans/](docs/plans/).

## Documents

| Document | Holds |
|---|---|
| [docs/intent.md](docs/intent.md) | What this is, for whom, what it must do, and how done is judged |
| [docs/decisions/0001-founding-decisions.md](docs/decisions/0001-founding-decisions.md) | Every decision behind the design, what was rejected and why, and whether it is settled |
| [docs/research/](docs/research/) | The verified facts the design rests on, with sources and dates |

## Licence

Apache-2.0 (see `LICENSE` and `NOTICE`), proposed in decision D1 and awaiting the maintainer's confirmation before the first push.
