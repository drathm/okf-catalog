# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The version in `package.json` names the release. 0.1.0 was published on 2026-10-07, before the clean-account run of the acceptance list in `docs/acceptance/version-0.md`, by the maintainer's choice; what that run finds goes into a later patch release.

## [Unreleased]

The work of 0.2.0: the readiness fixes cut from issues 2 and 3, the readiness ledger as tests, the search filters of issue 4, strict input schemas and the rank guard (`docs/plans/version-0.2.md`, section 3.1; `docs/acceptance/version-0.2.md`).

### Added

- `search` filters by `tag` (one tag, or a list of up to eight a page must carry all of, compared without regard to case and nothing looser), `status` (the status a page is served with), `min_trust` (that trust tier or a higher one) and `freshness` (`fresh` or `any`). They are applied after the index answers and never added to the keywords, so no engine rank moves. An unknown tag or status fails before the search with the values in use, each JSON-quoted as it is stored (neither trimmed nor collapsed), cut at 200 characters, at most 50 listed and then the total; an unknown type lists the types in use the same way, and an unknown topic, like an unknown folder in `catalog`, the folders. The result counts each removal under the first check it failed (`filteredOut` gains `tag`, `status` and `trust`), says when a restrictive filter met the pool's cap with the answer short while the index held more matches past it (`filtersExhausted`), and its header names each removal.
- `get_page` takes a page's concept id, its path without `.md`, as well as its path; a name that is one page's path and another page's concept id (`foo.md` beside `foo.md.md`) is an error naming both, each with a name that means it alone; in a chain of three such names the middle page has none, and the error says so.
- `get_page`'s provenance carries the contract fields of an attested computation (`runtime`, `parameters`, `computation`, `executor`, `attester`) on a page of any type, the page's `usage_window`, each source's `effectiveWindow` (its own window with its dates, or `{ inherited: true }` when it takes the page's, whose dates the page's `usageWindow` carries once), and an OKF 0.1 `timestamp`. These survive the frontmatter's 8 000-character omission, and each is held to 2 000 characters with a note of its own.
- The two OKF 0.1 fallbacks the specification allows (§13.1): on a page without `generated`, a top-level `timestamp` is kept as its own field (reported `legacy-timestamp`); on a page with none of `generated`, `verified` and `sources`, the lists under a level-one `# Citations` heading are read as its sources (reported `legacy-citations`), each item's text and link cut at 500 characters.
- `serve.admit`, `pack --admit` and `check --admit` take a status of the company's own, any word but `draft`, trimmed and never blank, so a company that wants its `archived` pages served lists `archived`.
- A word of the admission list that no page carries, other than the three known statuses, is named in the load report (`unmatchedAdmits`), in the output of `check` and `pack`, and in a `serve.admit` warning in the server's log at each load: a typo such as `depreciated` admits nothing, and says so.
- The rank guard: `bench/run.mjs --write-expect` and `--expect`, which pin and compare each question's gold rank in the eleven lexical configurations and exit 6 when one moves; the corpus pin `bench/expected/lexical-ranks.json`; a CI job that runs the comparison over the public corpus on Ubuntu on every push; and `test/integration/rank-guard.test.ts`, thirty answers over the `behaviours` fixture through the real engine.
- The readiness ledger of issue 2 as tests: fourteen new tests for the sentences of its "Holds" list that no test asserted.
- The benchmark harness measures the ladder re-ranked (`--modes rerank`): the production ladder's twenty candidates, in the question and the keyword form, scored by qmd's reranker as qmd scores them, reported by raw score and by qmd's position blend, with the keyword list twenty deep and the production-limit rows as controls; the report writes `docs/research/benchmark-rerank.md` with a pre-registered bar's verdict; `docs/research/benchmark-lexical.md` is written only by a lexical-only run. The vector index is built only for the modes that read it, and a model no mode asked for is pointed at a file that cannot exist.

### Changed

- With `freshness` and `include_stale` both omitted, `search` includes pages past their recheck date, each flagged `overdue since` its date, where it used to leave them out; `freshness: "fresh"` or `include_stale: false` leaves them out, and the two contradictory pairs are refused. A caller that omitted the argument now sees overdue pages, flagged.
- A `status` other than `draft`, `stable` or `deprecated` is no longer rewritten to `draft`: the word is kept, trimmed, with its case, and reported, and the page is served only when `serve.admit` names that word, or in development mode, labelled with its own word. The three known statuses are read without regard to case, and every output schema takes any status. By default nothing new is served.
- `pack` refuses to write a bundle in which no page is admitted (exit 2) unless given `--allow-empty`, so the publish recipe, which never passes it, fails on a typo that empties the bundle instead of publishing a branch with no page.
- Every tool's input schema is strict: an argument a tool does not take, such as `tags` or `minTrust`, fails with the SDK's validation error instead of being dropped in silence.
- Text lines quote a status outside the three known values, a type the company did not declare, and any type or status, declared or not, that carries a comma, a bracket, a quotation mark, a backslash or a control character; the verifier, a recheck date and the page's resource are quoted whenever they carry such a character. Inside the quotes, backslashes and quotation marks are escaped, backslashes first, so no character of the value can add a fact to a citation's brackets or close the quote.
- A page's citation header names at most ten sources, each id and resource quoted as a status or type is and cut at 200 characters with an ellipsis, then how many more, so neither a long list of sources nor a long source can add facts to the header or crowd the body out of `get_page`'s result.
- A page `usage_window` that is not a mapping of `from` and `to`, and a contract field without the shape the specification gives it, are reported `field-ignored`.

### Deprecated

- `include_stale`, now the alias of `freshness` (`true` is `any`, `false` is `fresh`). It is accepted through 0.4.x and leaves the schema in 0.5.0, when a caller that still sends it fails loudly.

### Fixed

- A source's `usage_count` that is not a number (a string, a list, a mapping) was dropped without a word; it is now reported `source-malformed`, as a non-finite number already was, and the source is kept. A source's own `usage_window` that is not a mapping of `from` and `to` was dropped the same way; it is now reported `source-malformed`, and that source takes no window, never the page's, since its producer framed its count otherwise.
- `topicExhausted` said the topic may hold more whenever the first rung's pool reached its cap with the answer short, even when the index had run out of matches under the cap; it now needs the index to hold more matches past the cap, as `filtersExhausted` does.

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
