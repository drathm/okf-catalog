# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The version in `package.json` names the release candidate; its section below stays `[Unreleased]` until the maintainer tags it, after the acceptance list in `docs/acceptance/version-0.md` has passed on a clean account.

## [Unreleased]

Version 0: serve a company's Open Knowledge Format 0.2 bundle to Claude Code, locally. Needs Node 24 or later (the Active LTS line) on macOS or Linux.

### Added

- `okf-catalog serve`: a stdio MCP server over one company's bundle, lexical mode, with four read-only tools. `search` takes keywords and the type, topic, overdue and limit filters, and returns every hit with its path, trust tier, verifier, recheck date, source count and resource, in the text and in the structured output; `get_page` returns a page's header, a marker line and the body as data, with its provenance; `catalog` lists a folder from its index file or generates the listing; `status` reports the load, the lock, the poller, the fetched commit and every degradation and refusal.
- The intake contract: pages are read by the specification's field table (`type`, `title`, `description`, `tags`, `status`, `stale_after` in both 0.2 texts, `generated`, `verified`, `sources`, `resource`, links, reserved files), degrade and are reported rather than refused (specification §11), and only a page without frontmatter or a type, an unsafe or oversize file, a hash mismatch or a missing manifest is refused.
- `okf-catalog check`: the contract applied to a folder, with the report as text or JSON and an exit code.
- `okf-catalog pack`: the published bundle written from a checkout, with generated index files and a manifest.
- A company configuration file (`okf-catalog.yaml`): the company name, a local folder or a git repository with its branch and bundle path, the admission rule, the development flag, the pull interval, the caps, the declared types and the specification text.
- The cache folder per company with its ownership and mode checks, and one process per company through a lock, with a private fallback for a second process.
- The git source: a bare shallow clone used as transport only, every fetched tree listed and validated before anything is written, raw blobs extracted into the server's own folder, a hardened runner, and a poller that refreshes when the branch moves.
- The publish recipe: a GitHub Actions workflow and two shell scripts that run the OKF checkers, pack, run them again, and push parent-linked commits to the published branch.
- The Claude Code plugin folder with the skill, shipped inside the package; the plugin asks for no settings and runs the `okf-catalog` command from PATH in the project folder, where the server finds `okf-catalog.yaml`.
- The benchmark harness over four public OKF bundles, with the lexical-versus-full measurement behind the maintainer's model approval.

### Not in this version

HTTP transport and authorization, full mode as a product option, Codex and Grok Build plugins, Windows, npm publication.
