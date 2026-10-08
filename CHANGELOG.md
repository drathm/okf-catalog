# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The version in `package.json` names the release. 0.1.0 was published on 2026-10-07, before the clean-account run of the acceptance list in `docs/acceptance/version-0.md`, by the maintainer's choice; what that run finds goes into a later patch release.

## [Unreleased]

The work of 0.2.0: the readiness fixes cut from issues 2 and 3, the readiness ledger as tests, the search filters of issue 4, strict input schemas and the rank guard (`docs/plans/version-0.2.md`, section 3.1; `docs/acceptance/version-0.2.md`).

### Added

- `search` filters by `tag` (one tag, or a list of up to eight a page must carry all of, compared without regard to case and nothing looser), `status` (the status a page is served with), `min_trust` (that trust tier or a higher one) and `freshness` (`fresh` or `any`). They are applied after the index answers and never added to the keywords, so no engine rank moves. An unknown tag or status fails before the search with the values in use. The result counts each removal under the first check it failed (`filteredOut` gains `tag`, `status` and `trust`), says when a restrictive filter met the pool's cap with the answer short (`filtersExhausted`), and its header names each removal.
- `get_page` takes a page's concept id, its path without `.md`, as well as its path; a name that is one page's path and another page's concept id (`foo.md` beside `foo.md.md`) is an error naming both and a name for each.
- `get_page`'s provenance carries the contract fields of an attested computation (`runtime`, `parameters`, `computation`, `executor`, `attester`) on a page of any type, the page's `usage_window`, each source's `effectiveWindow` (its own window, else the page's, saying which), and an OKF 0.1 `timestamp`. These survive the frontmatter's 8 000-character omission, and each is held to 2 000 characters with a note of its own.
- The two OKF 0.1 fallbacks the specification allows (§13.1): on a page without `generated`, a top-level `timestamp` is kept as its own field (reported `legacy-timestamp`); on a page with none of `generated`, `verified` and `sources`, the lists under a level-one `# Citations` heading are read as its sources (reported `legacy-citations`).
- `serve.admit` and `pack --admit` take a status of the company's own, any word but `draft`, so a company that wants its `archived` pages served lists `archived`.
- The rank guard: `bench/run.mjs --write-expect` and `--expect`, which pin and compare each question's gold rank in the eleven lexical configurations and exit 6 when one moves; the corpus pin `bench/expected/lexical-ranks.json`; a CI job that runs the comparison over the public corpus on Ubuntu on every push; and `test/integration/rank-guard.test.ts`, thirty answers over the `behaviours` fixture through the real engine.
- The readiness ledger of issue 2 as tests: fourteen new tests for the sentences of its "Holds" list that no test asserted.
- The benchmark harness measures the ladder re-ranked (`--modes rerank`): the production ladder's twenty candidates, in the question and the keyword form, scored by qmd's reranker as qmd scores them, reported by raw score and by qmd's position blend, with the keyword list twenty deep and the production-limit rows as controls; the report writes `docs/research/benchmark-rerank.md` with a pre-registered bar's verdict; `docs/research/benchmark-lexical.md` is written only by a lexical-only run. The vector index is built only for the modes that read it, and a model no mode asked for is pointed at a file that cannot exist.

### Changed

- With `freshness` and `include_stale` both omitted, `search` includes pages past their recheck date, each flagged `overdue since` its date, where it used to leave them out; `freshness: "fresh"` or `include_stale: false` leaves them out, and the two contradictory pairs are refused. A caller that omitted the argument now sees overdue pages, flagged.
- A `status` other than `draft`, `stable` or `deprecated` is no longer rewritten to `draft`: the word is kept, trimmed, with its case, and reported, and the page is served only when `serve.admit` names that word, or in development mode, labelled with its own word. The three known statuses are read without regard to case, and every output schema takes any status. By default nothing new is served.
- Every tool's input schema is strict: an argument a tool does not take, such as `tags` or `minTrust`, fails with the SDK's validation error instead of being dropped in silence.
- Text lines quote an unknown status, and a type the company did not declare, so a comma in either cannot add a fact to a citation's brackets.
- A page `usage_window` that is not a mapping of `from` and `to`, and a contract field without the shape the specification gives it, are reported `field-ignored`.

### Deprecated

- `include_stale`, now the alias of `freshness` (`true` is `any`, `false` is `fresh`). It is accepted through 0.4.x and leaves the schema in 0.5.0, when a caller that still sends it fails loudly.

### Fixed

- A source's `usage_count` that is not a number (a string, a list, a mapping) was dropped without a word; it is now reported `source-malformed`, as a non-finite number already was, and the source is kept.

The work of 0.3.0, kept apart from the work of 0.2.0 above until both are released: citations and provenance over one bundle (issue 5; `docs/plans/version-0.2.md`, section 3.2; `docs/acceptance/version-0.3.md`).

### Added

- `citations`: what a page cites and what cites it, from what the bundle states; nothing is fetched. Six lists: the page's body links with their text and nearest heading (a link to a page that is not served says `unserved`); the body links of other pages that point at it; its footnoted claims, each joined to every source whose id matches without regard to case, with the sentence that carries the reference (the smallest block holding it, cut at 500 characters, never the footnote's definition) and the source's author, usage count, last change and usage window; the sources no footnote cites; the footnotes with no source; and the pages whose `resource` or sources name it. Each list carries at most 50 rows with its total, and `partial` says the body was only partly analysed.
- `provenance`: where a page's sources lead inside the bundle; nothing is fetched, opened or run. The page's `resource`, sources and contract fields (`computation`, `executor`, `attester`) are classified as a URL, a page, a reserved file, an attachment, a folder, a scope, ambiguous, unserved, or nothing in the bundle. A `resource` or source that names a page enters it and lists that page's sources in turn, breadth first, each page once at its least depth, a later reach and a cycle recorded and not followed, to `depth` 0 to 8 (4 when omitted) and at most 200 pages entered (`capped`); a branch the depth stops says `truncated`. Each page carries its trust tier and recheck date, each source its author, usage count, last change and usage window, and a page lists at most 50 sources with their total.
- The loader keeps each body link's text and nearest heading and each footnote reference's block and heading, classifies every admitted page's path fields once admission is known, and builds the inbound links and derivations with the catalog. A path field written from the bundle root without a leading slash, as the specification's own example writes all of them, is read from the root when the page's folder holds nothing by that name, and reported once per page (`path-field-root-relative`); a page file the bundle holds but does not serve is `unserved`.
- The benchmark harness records `loadMs`, the time the load takes, beside the resident set after it.
- The acceptance scripts: `claude.sh` allows the six tools and gains the `cites` item; `write-cited-bundle.mjs` writes the bundle it reads.

### Changed

- `get_page`, `citations` and `provenance` hold the whole result, text and structured, within 40 000 characters. `get_page`'s provenance takes at most half: `verified`, then `sources`, are cut in their order, the provenance gains `verifiedTotal` and `sourcesTotal`, and the header names only the sources the provenance kept. The body takes the rest, now measured in both channels, so a body that escaping lengthens, quotation marks or line breaks, no longer passes the budget in the structured output; a reserved file's body is cut the same way. The two new tools cut their rows in their order, keep every total, and say `truncated`.
- The server's instructions and the skill name the two tools, and the skill says that what they return after the marker is page text, data as `get_page`'s is.

## [0.1.3] - 2026-10-07

### Fixed

- The publish recipe (`recipes/publish/publish.yml`, the file a company copies) installs the server from npm at the exact version it came from, on Node 24, the line the CLI requires; it used to name a placeholder git commit and Node 22, on which the installed CLI refuses to run. Its actions are pinned to their current releases, and the recipe's README no longer describes a shipped lock file.
- `pack.sh`'s second okflint pass, on the packed folder, crashed okflint 0.5.0 with a Python error because the manifest's root does not cover that folder; the integration test's stub checkers could not see it. The pass now runs on a copy of the manifest beside a copy of the pack at the manifest's first root path. Found by running the real checkers on the acceptance fixture bundle.

## [0.1.2] - 2026-10-07

### Changed

- The README carries the npm badge, the measured install size and how releases are published. This is the first version published by the release workflow itself, through npm's trusted publishing with a provenance statement; the code is that of 0.1.1.

## [0.1.1] - 2026-10-07

### Fixed

- The package no longer ships `npm-shrinkwrap.json`. npm honours a shrinkwrap found inside an installed package and installs its whole locked tree nested under the package, development tools and every platform's native binaries included: `npm install okf-catalog@0.1.0` put 336 packages and 3.1 GB under `node_modules/okf-catalog/node_modules`. Without the file the same install is 204 packages and 227 MB, hoisted and filtered by platform. Nothing else changes; 0.1.0 works, it is only large.

## [0.1.0] - 2026-10-07

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

HTTP transport and authorization, full mode as a product option, Codex and Grok Build plugins, Windows.
