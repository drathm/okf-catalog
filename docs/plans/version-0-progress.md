# Version 0: execution record

One section per bite: the concrete plan, the independent review of that plan and what was done with it, the build, the review of the build and what was done with it, and the measurements the plan asked for. The plan itself is [version-0.md](version-0.md).

## Bite 1. Scaffold, fixtures, CI

### Plan

Rulings taken as working defaults from the plan's own proposals, each reversible and flagged to the maintainer: Apache-2.0; qmd 2.8.3; decisions D20 to D31 as proposed; the repository stays local until the maintainer creates the remote.

Tasks, in order, each with its check:

1. `package.json`: name `okf-catalog`, version `0.0.0`, `private: true` until the npm ruling, `type: module`, `engines.node >=22.12`, `bin.okf-catalog → dist/cli.js`, `files: [dist]`, scripts `build` (tsc -p tsconfig.build.json), `typecheck` (tsc --noEmit), `lint` (biome ci .), `format` (biome format --write .), `depcruise` (depcruise src --config .dependency-cruiser.cjs), `check` (lint, typecheck, depcruise), `test` (vitest run). Exact pins: `@tobilu/qmd` 2.8.3, `@modelcontextprotocol/server` 2.3.1, `zod` 4.6.5, `yaml` 2.9.1, `mdast-util-from-markdown` 2.1.0, `mdast-util-to-string` 4.0.0; dev `typescript` 5.9.3, `@types/node` 22.x latest, `vitest` 5.0.3, `vite` (the version Vitest 5.0.3 requires, pinned exactly), `@biomejs/biome` 2.5.15, `dependency-cruiser` latest 18.x pinned, `@modelcontextprotocol/client` 2.3.1. Check: `npm ci` with `NODE_LLAMA_CPP_SKIP_DOWNLOAD=1` succeeds; the lockfile is committed.
2. `tsconfig.json` (type-checks `src` and `test`): strict, `module` and `moduleResolution` NodeNext, target and lib ES2023, `types: ["node"]`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`, `noEmit`. `tsconfig.build.json` extends it with `include: ["src"]`, `noEmit: false`, `outDir: dist`, `rootDir: src`, `declaration`, `sourceMap`. Check: `npm run typecheck` and `npm run build` pass; `dist/cli.js` exists.
3. `biome.json`: Biome 2 schema, formatter on (two spaces, line width 100), linter recommended, `files.includes` for `src`, `test`, `bench`, config files. Check: `npm run lint` passes on the scaffold.
4. `vitest.config.ts`: `include: ["test/**/*.test.ts"]`, environment node, `testTimeout` 30 s. One smoke test asserting `--version` output equals `package.json`'s version. Check: `npm test` passes and reports one test.
5. `.dependency-cruiser.cjs`: `options.tsConfig = { fileName: "tsconfig.json" }`, `tsPreCompilationDeps: true`, `doNotFollow: node_modules`; forbidden rules, all severity error: core (`^src/(bundle|catalog|derive|search)/`) to `node:(fs|fs/promises|child_process|http|https|net|os|process)`, to `@tobilu/qmd`, to `@modelcontextprotocol/`, to `^src/(engine|mcp|source|fs|config|commands|report)/`; adapters `^src/engine/` to `^src/(mcp|source|commands|fs|config)/` and `^src/mcp/` to `^src/(engine|source|commands|fs|config)/`; edges `^src/(source|fs|config|report)/` to `^src/(engine|mcp|commands)/`; `^src/cli\.ts` to anything but `^src/commands/`. Proof: a scratch core file importing `node:fs`, and another importing `../engine/qmd.js` by its `.js` specifier; `npm run depcruise` must fail on both and pass once they are removed; the run and its output recorded here.
6. `.github/workflows/ci.yml`: matrix `ubuntu-latest`, `macos-latest` × Node 22, 24; `env: NODE_LLAMA_CPP_SKIP_DOWNLOAD: "1"`; actions pinned to full commit SHAs with version comments; steps checkout, setup-node with npm cache, `npm ci`, `npm run check`, `npm test`, `npm run build`. Check: the YAML parses; it runs when the maintainer pushes.
7. `LICENSE` (Apache-2.0, canonical text) and `NOTICE` (the project, the copyright holder, and attribution for fixture pages derived from the Open Knowledge Format specification's examples, Apache-2.0, Google LLC).
8. `src/cli.ts`: `parseArgs` with `--version` and `--help`; prints only those to stdout; exits 2 on an unknown command with the usage on stderr. No other logic.
9. Fixtures. `test/fixtures/bundles/spec-example/`: pages transcribed from the specification's own examples (§4.3, §4.4, Appendix A), `index.md` files in the §8 layout at the root and in each folder, a `log.md`, a non-Markdown file under `references/`, and a `manifest.json` produced by a documented one-off command (sha256 per file); `test/fixtures/README.md` says how. `test/fixtures/bundles/behaviours/`: one page per behaviour row of intent §6 (deprecated with replacement and its replacement; overdue by date; overdue by instant; fresh; unverified; machine-confirmed; human-reviewed; unknown type; no title with a body heading; no title and no heading; no description; a bundle-absolute link, a relative link and a broken link; a folder without `index.md`; a folder named `dist`; a page with a `qmd` key; a draft; sources with ids and footnotes; a `resource` page), with an `index.md` at the root and in one folder. The hostile fixture is generated at test time and lands with the walker in bite 3.
10. Measurements appended to `docs/research/facts.md`: `npm ci` wall time and `node_modules` size with and without the skip flag; whether a compiler ran; the installed git version and the three options confirmed (`GIT_ALLOW_PROTOCOL`, `--template=`, `core.hooksPath=/dev/null`); cold start of `node dist/cli.js --version`.
11. Commit on the `version-0` branch: `chore: scaffold, fixtures and CI (bite 1)`.

Done when: `npm run check`, `npm test` and `npm run build` pass locally on Node 24 (CI's matrix runs on the maintainer's first push); the dependency rule failed both violations and passes without them; the measurements are recorded; the fixtures exist with a README.

### Plan review

Reviewer: an independent Opus agent, read-only, with web access; 85 tool calls, about 27 minutes. Verdict: ready with changes. Dispositions:

| # | Finding | Disposition |
|---|---|---|
| 1 | `dist/` in `.gitignore` matched at any depth, so the `dist` fixture folder would never be committed | Applied: entries anchored with a leading slash |
| 2 | The `.js`-specifier proof needed an existing target; the config should carry `exportsFields`, `conditionNames` and the unresolvable, non-package and dev-dependency rules | Applied: the planted import targets the existing `src/cli.ts`; the three rules and the resolver options are in the config; the plan's claim that `tsConfig` provides the `.js` mapping is corrected in draft 3 of the plan |
| 3 | The core rule was a denylist (missing bare `fs`, `node:module`, `node:vm`, `getBuiltinModule`); the CLI rule forbade `node:util`; the single-importer property was not enforced; `log.ts` had no layer; globals were invisible | Applied: allowlists for Node built-ins and npm packages in the core, qmd only in the engine, the SDK only in the MCP adapter, the CLI rule limited to our own files, `log.ts` in the edge layer, `detectProcessBuiltinModuleCalls`, and a Biome override denying `process` and `fetch` in the core |
| 4 | CI ran tests before the build; the smoke test spawns the built CLI | Applied: `pretest` builds; CI builds before testing |
| 5 | Fixture bytes unprotected: Biome and TypeScript would touch them; no `.gitattributes`; no manifest re-verification; `behaviours` had no manifest | Applied: fixtures excluded from both tools, `.gitattributes` marks them binary, `test/unit/fixtures.test.ts` re-verifies every committed manifest, `behaviours` has one |
| 6 | Fixture dates expire; spawned tests cannot inject the clock | Applied: test pages use 2000 and 2999, `NOW` is fixed in the helpers, and the CLI will read `OKF_CATALOG_NOW` (bite 4) |
| 7 | Coverage gaps in the behaviour pages; the specification repository ships complete example bundles; licence attribution should name the repository and commit, not a company | Applied: the missing pages added (tags, generated with and without a date, markup, bare verified mapping, deprecated without replacement, unparseable and offset-less recheck dates, unknown status, root `okf_version`, a refused bundle, the page that gives orders); `spec-example` is a verbatim copy of `bundles/acme_retail` at `25461db`; NOTICE and the fixtures README attribute the repository and commit. Flagged for bite 2: the specification's own deprecated page opens with a heading and puts the replacement link in the next paragraph, so the replacement rule becomes "the first link in the body that resolves inside the bundle" |
| 8 | The skip flag does not control install size: platform binaries are optional dependencies npm installs regardless | Applied: measured as such (13 MB on macOS arm64); the Linux figure is left to CI; invariant 6's wording is corrected in draft 3 of the plan |
| 9 | Smaller corrections: `skipLibCheck`, version through `createRequire`, shebang, `license` field, `files` with NOTICE, no declarations for a CLI, Vite pinned at 8.3.3, `biome check --write` for the format script, spaces and width 100, pinned action SHAs with `permissions`, `persist-credentials: false` and `fail-fast: false`, measurements as CI steps, licence to confirm before the first push | Applied in full. Not done: a local run on Node 22.12, because installing another Node version is a toolchain change for the maintainer to see; CI covers Node 22 on the first push |
| 10 | Scaffold pieces later bites need: test helpers, `@types/mdast`, `.npmrc` with `save-exact`, no path aliases | Applied |

### Build

- Red: `test/unit/cli.test.ts` written first (version on stdout, nothing on stderr; unknown command exits 2 with usage on stderr); watched both fail against an empty entry file (exit 0, empty stdout). Green: `src/cli.ts` with `parseArgs` and `createRequire`; both pass. Then `biome check --write` formatted two files; `tsc --noEmit` clean; dependency-cruiser clean on the scaffold.
- Dependency rule proof: recorded in `docs/research/facts.md` under "Dependency rule proof", with the resolved edge and the rule names.
- Fixtures: `spec-example` (verbatim copy, 19 files, manifest added), `behaviours` (24 files, manifest), `refused` (5 files, no manifest), `make-manifest.mjs`, README, integrity test.

### Measurements

Recorded in `docs/research/facts.md` under "Bite 1 measurements": install time and footprint, the one compile (fsevents, a macOS development dependency), the skip flag's effect, duplicate packages, qmd's import time and stdout silence, lexical search without optional dependencies, and the three git options confirmed, with the consequence that bite 5's tests need `file` in an injectable protocol allowlist.

## Bite 2. The pure core

### Plan

Scope: `src/bundle/*`, `src/catalog/*`, `src/report/report.ts`, their unit tests. Nothing in these modules may import `node:fs`, `node:child_process`, qmd or the MCP SDK; the dependency rule from bite 1 enforces it. Every function takes data and returns data. The deliverable is `loadBundle(company, files, options, now)` returning `{ catalog, report }` and passing one test per row of the field table in intent §6.

Modules and their one job:

| Module | Job | Key signatures |
|---|---|---|
| `src/bundle/model.ts` | The core types from plan §2.3: `PagePath`, `BundleFile`, `Status`, `Trust`, `StaleAfter`, `Source`, `Page`, `ReservedFile`, `Refusal`, `Degradation`, `RefusalRule`, `Caps`, `LoadOptions` | types only |
| `src/bundle/frontmatter.ts` | Split a UTF-8 text into frontmatter and body (BOM, CRLF, `---` fences) and parse the YAML strictly | `splitFrontmatter(text) → { block?: string; body: string }`; `parseFrontmatter(block) → { ok: true; data: Record<string, unknown> } \| { ok: false; error: string }` using `yaml` with `version: "1.2"`, `schema: "core"`, `uniqueKeys: true`; a non-mapping is an error |
| `src/bundle/reserved.ts` | Recognise `index.md` and `log.md` at any depth before any page rule runs; tolerate frontmatter on them; lift `okf_version` from a root index | `isReservedName(path) → "index" \| "log" \| undefined`; `parseReserved(file) → ReservedFile` |
| `src/bundle/markdown.ts` | Read a body with `mdast-util-from-markdown`: first heading, first sentence of the first paragraph, every link in document order, whether raw HTML is present | `firstHeading(body)`, `firstSentence(body)`, `links(body) → Array<{ url, text }>`, `hasHtml(body)` |
| `src/bundle/links.ts` | Resolve a link to a page path: bundle-absolute (leading slash) or relative to the page's folder, fragment stripped, external URLs ignored | `classifyLink(url) → "bundle" \| "external"`; `resolveLink(url, fromPath, pagePaths) → PagePath \| undefined` |
| `src/bundle/page.ts` | Turn one `BundleFile` into a `Page` or a `Refusal`, deriving every field in the table with its source and a degradation wherever a fallback was used | `parsePage(file, context: { pagePaths: Set<PagePath>; specText }) → Page \| Refusal` |
| `src/bundle/manifest.ts` | The manifest schema (zod), building one from files, verifying files against one | `ManifestSchema`; `buildManifest(files, { commit, publishedAt }) → Manifest`; `verifyManifest(manifest, files) → Array<{ path; problem: "hash-mismatch" \| "size-mismatch" \| "not-in-manifest" \| "missing-on-disk" }>` |
| `src/bundle/index-file.ts` | Parse a §8 index file into sections and entries; generate one for a folder from its pages and subfolders in the §8 layout | `parseIndex(text) → IndexSections`; `generateIndex(folder, pages, subfolders) → string` |
| `src/bundle/contract.ts` | The admission rule, the bundle-level refusals, caps, unknown types | `admit(page, admitStatuses, dev) → boolean`; `bundleRefusals(files, options) → Refusal[]`; `unknownTypes(pages, declared) → string[]` |
| `src/bundle/load.ts` | Orchestrate: classify files, verify the manifest, parse reserved files and pages, resolve links, admit, build the catalog and the report | `loadBundle(company, files, options, now) → { catalog: Catalog; report: Report }` |
| `src/catalog/model.ts` | The immutable catalog and its lookups | `Catalog`, `Folder`; `buildCatalog(...)`, `getPage`, `getFolder`, `listTypes` |
| `src/catalog/provenance.ts` | The provenance view of a page, with `overdue` computed from the clock by the page's own `stale_after` form | `provenanceOf(page, now) → Provenance`; `isOverdue(staleAfter, now) → boolean` |
| `src/report/report.ts` | The report type and its text rendering | `Report`; `renderReport(report) → string` |

Rules decided for this bite, each flagged to the reviewer as a judgement call:

1. **Unparseable frontmatter** is a refusal with its own rule, `frontmatter-unparseable`, added to the `RefusalRule` union: it is distinct from "no frontmatter" and the message names the YAML error.
2. **Unknown `status` value** (not `draft`, `stable` or `deprecated`): treated as `draft` for admission, so it is not served by default, with a degradation naming the value. The specification's "absent means stable" applies only to an absent key.
3. **`stale_after` by form.** `YYYY-MM-DD` is the date form: `at` is the start of that UTC day and the page is overdue when `now >= at`. An ISO datetime with an explicit offset is the datetime form: overdue when `now >= at`. A datetime without an offset is read as UTC and reported. Anything else is unparseable: no `staleAfter`, never overdue, reported. A form other than the one `spec_text` expects is reported as a degradation and still judged by its own rule.
4. **`verified`**: a bare mapping becomes a one-entry list; an entry without `by` and `at` is dropped and reported; `trust` follows §5.3 on what remains.
5. **Replacement link on a deprecated page**: the first link in the body, in document order, that resolves to another page in the bundle. This replaces draft 2's "first non-empty body line", because the specification's own deprecated example opens with a heading and links in the next paragraph.
6. **Links** resolve against every `.md` page path in the bundle, admitted or not, so a link to a draft counts as resolved; whether the target is served is a separate question `get_page` answers.
7. **`generated`**: `by` is required inside it per the specification; an entry without `by` is dropped and reported; `at` is optional and kept raw beside its instant.
8. **Bundle-level refusals**: a missing manifest outside development mode, caps exceeded, and an engine configuration folder or file (`.qmd`) anywhere in the tree. Per-file refusals: no frontmatter, unparseable frontmatter, no type, hash mismatch, size mismatch, a file present on disk but absent from the manifest. A manifest entry whose file is missing on disk is reported, not refused. A bundle-level refusal sets `report.fatal`, which the commands treat as "do not serve".
9. **Attachments**: any non-`.md` file other than `manifest.json` is counted, never parsed; a `.md` file is a page unless its name is reserved.
10. **Degradations are reported for admitted pages only**; excluded pages are counted. Refusals are always reported.
11. **The report's `encodedFolders`** is filled by the command after the engine's path codec runs (bite 3); the core leaves it empty.

Tests first, one file per module under `test/unit/`, each test named after the behaviour it pins. The fixtures from bite 1 are read into memory with `readFixture`; variants that are easier to express inline (a tampered byte, a bare mapping, CRLF line endings, a BOM) are built in the test. The table in plan §2.5 is the checklist. Done when every row has a passing test, `loadBundle` runs on all three fixtures with the expected reports asserted field by field, `npm run check` is clean, and the dependency rule still passes.

Review before build: an independent review of this plan. Review after build: an independent review of `contract.ts`, `page.ts`, `reserved.ts` and `load.ts` against the specification text and intent §6.

### Plan review

Reviewer: an independent Opus agent, read-only, probing the installed `yaml`, `mdast` and `zod` packages in memory and reading the two specification texts. Verdict: ready with changes. Dispositions, all applied before the first test:

| # | Finding | Disposition |
|---|---|---|
| F1 | The core would import `Report` from `src/report/`, an edge layer the dependency rule forbids, so the bite could never pass its own gate | `Report` lives in `src/bundle/model.ts`; `src/report/report.ts` keeps only `renderReport`; `console` added to the globals the core may not use |
| F2 | `dev` conflated "admit drafts" with "skip integrity", so `pack` on a source checkout could not be expressed; the manifest came in twice | `options.integrity: "require-manifest" \| "none"` separate from `dev`; the core reads the root `manifest.json` from the files; new rule `manifest-invalid`; the manifest type is inferred from the zod schema, path keys are validated, timestamps accept an offset, lookups use `Object.hasOwn` |
| F3 | Rule 8 made `.qmd` and any exceeded cap fatal, contradicting the `refused` fixture; the report had no `fatal` field; walker refusals had no way in | Fatal only for a missing or invalid manifest when integrity is required, and for the file-count and tree-byte caps; per path for an oversize file, `.qmd/**`, walker refusals and page rules; `walkRefusals` is an input; `fatal` and `missingOnDisk` are report fields; `manifest.json` is recognised at the root only; hidden entries (a dot-leading segment) are skipped and counted, except `.qmd`, which is refused |
| F4 | An unknown `status` was excluded and then never reported, since degradations were reported for admitted pages only | Values trimmed and lower-cased; unknown values excluded by default and always listed in `report.unknownStatuses`; `statusRaw` on the page; an empty `status` counts as absent |
| F5 | The replacement rule could fall through to a "see also" link or name a draft, and the documents still stated the superseded rule | The first body link that is not a same-page anchor decides: a replacement when it resolves to an admitted page other than itself; otherwise none, with a coded degradation (`broken`, `external`, `not-served`, `self`); resolved after admission; plan §2.3 and §2.5 and intent §3 and §6 updated |
| F6 | Resolving links only against page paths would report folders, reserved files and attachments as broken, miss reference-style links, and misread protocol-relative URLs | Links classify as page, folder, reserved, attachment, anchor, external or broken; any scheme and `//` are external; segments are percent-decoded; paths above the root are broken; `linkReference` resolves through its `definition`; links to excluded or refused pages have their own report list |
| F7 | `new Date` made the staleness rules depend on the machine's time zone and accepted impossible dates | One `parseTimestamp` with explicit grammars (`YYYY-MM-DD`, RFC 3339 with `Z` or `±hh:mm`), built with `Date.UTC` and a calendar round trip; used for every timestamp; the unit suite runs under a non-UTC zone with a guard test; boundary tests at the instant and one millisecond before; a `verified` entry keeps its valid `by` when `at` is missing or bad, with a degradation |
| F8 | The named `yaml` options were all defaults; `!!timestamp` and other tags would resolve; `parse()` writes warnings to stderr; a self-referencing alias crashes serialisation; an empty block was misclassified | `parseDocument` with `resolveKnownTags: false`, errors and warnings carried in the result, `toJS` with an alias cap, a JSON round trip to catch cycles; `null` becomes an empty mapping and then `no-type`; `type`, `title` and `description` must be non-empty strings after trimming, with scalars of other types taken as text and reported; duplicate keys refused, noted as stricter than okflint |
| F9 | CommonMark without GFM mis-parses the specification's own tables, footnotes and autolinks | `micromark-extension-gfm` 3.0.0 and `mdast-util-gfm` 3.1.0 added and allowlisted; the description fallback skips tables and footnote definitions; a footnote reference with no matching source id is a degradation; one sentence splitter with whitespace collapsed, footnote marks stripped and a length cap; `hasHtml` counts block HTML and any `script`, `style` or `iframe` element |
| F10 | Reserved files parsed without splitting their frontmatter would yield a heading built from YAML; the index round trip cannot be literal on the example bundle | `ReservedFile` carries frontmatter, body, text and degradations; `parseIndex` takes the body; a reserved file's unparseable frontmatter degrades, never refuses; the round trip is parse-after-generate; a test checks that each example index's page links equal the folder's pages, treating `x/` as `x/index.md` and excluding attachments; generated indexes list admitted pages only; a file index is served as the company wrote it |
| F11 | "One test per row" named functions from later bites and bundled five behaviours in one row; free-text degradations make assertions brittle | The checklist is the rows whose functions live in the core, one test per rule, and the inline variants named (BOM, CRLF, fence at end of file, tampered and truncated bytes, empty file, `---\n---`, unclosed fence, a 0xFF byte with a new `not-utf8` rule, duplicate key, `!!timestamp`, alias cycle, `type: 123`, malformed verified entries); `Degradation.code` is a union; core tests set a far-off system time; `unknownTypes` is empty when no types are declared; a folder with only attachments is not a page folder |

Also from the hand-walked pages: `StaleAfter.form` gains `unparseable` so provenance can say the recheck date is unreadable rather than absent.

### Build

Order, each module red then green: `model.ts` (types only), then `timestamp.ts`, `frontmatter.ts`, `markdown.ts`, `links.ts` (41 tests), then `reserved.ts`, `manifest.ts`, `index-file.ts` (19), then `page.ts` with `contract.ts` (33), then `catalog/model.ts`, `catalog/provenance.ts`, `load.ts` and `report/report.ts` (20). Three of my own inline test expectations were too narrow (pages written without a title or description legitimately earned extra degradations) and were corrected; the implementations stood. Committed as 16e88b8 with 126 tests.

Decisions taken while building, for the reviewers: two degradation codes beyond the plan's list, `frontmatter-warning` and `field-ignored`, and three refusal rules beyond it, `not-utf8`, `frontmatter-unparseable` and `manifest-invalid`; a numeric or boolean scalar in `type`, `title`, `description`, `resource` or `stale_after` is read as its source text and reported (`scalar-coerced`); `verified: null` and `verified: "text"` are reported and leave the page unverified while `[]` is simply empty; status values are trimmed and lower-cased and an unknown value becomes `draft` with `statusRaw` kept and `unknownStatuses` filled whether or not the page is admitted; links resolve against every page in play and admission decides replacements afterwards; folders are the ancestors of admitted pages plus any folder holding a reserved file; with integrity not required a valid manifest still supplies the commit but is not verified.

### Build review, round 1 (Grok)

Reviewer: Grok Build (grok-4.7), headless, read-only, with the specification fetched; 21 turns, about fifteen minutes, about $0.61. Verdict: not ready, on two high findings. Dispositions:

| Finding | Severity | Disposition |
|---|---|---|
| A `__proto__` frontmatter key would abort the load | high | Applied in substance: the source map is a null-prototype object (probed: the assignment does not throw as the review said, the language drops the value silently, which is still a bug), and the loader now catches any exception from a page or reserved file and records a refusal or degradation instead |
| A generated index below the root linked subfolders by their full path | high | Applied: relative names are passed to the generator; a nested-folder test added |
| Files skipped before manifest verification were reported missing; refused attachments stayed in the count | medium | Applied: verification runs over every file on disk, the attachment count is taken after refusals |
| Hidden files and `.qmd` never counted toward the caps | medium | Applied: caps are measured over everything that arrived; an oversize engine file carries both refusals |
| Zod drops a `__proto__` manifest key silently | medium | Applied: the raw key is rejected as `manifest-invalid`; `buildManifest` refuses an unsafe path |
| Percent-decoding ran after dot handling; `%2F` became a separator | medium | Applied: decode first, then dot rules, and a decoded separator is broken |
| An undefined reference link was deleted | medium | Not a defect: probed, CommonMark reads `[a][b]` with no definition as plain text, so no link exists to keep; a test pins the behaviour |
| Footnote ids are lower-cased by GFM while source ids are not | medium | Applied: case-insensitive join |
| The text report dropped degradation paths and details | medium | Applied: one line per degradation, as for refusals |
| Skipping integrity was silent | medium | Applied: `report.integrity` and a sentence in the report |

Of the nineteen missing tests the review listed, seventeen were added (one bad page not taking the load down is covered by the refused bundle; the determinism run belongs to the Opus review's probes). 148 tests pass.

### Build review, round 2 (Opus)

Reviewer: an independent Opus agent that built both commits from `git archive` and ran twenty-two probes against each. Verdict: 16e88b8 not ready; 8e2dc1c ready with changes. Dispositions, applied in the second correction round:

| # | Finding | Disposition |
|---|---|---|
| F1 | A body nested a few thousand levels deep overflowed the recursive Markdown walk; the catch filed it under the frontmatter and made admission depend on stack depth | Applied: the walk is iterative; a deterministic pre-scan of block-quote and bracket nesting above 256 levels leaves the body unanalysed with `body-unanalysed`, and the page is admitted; the last-resort catch files under `body-unreadable` |
| F2 | The GFM autolink extension cost 35 seconds on a 98 KiB page of nested brackets, with no bound, inside the serving process | Applied: only the footnote and table extensions are used, as separate pinned packages; analysis is bounded at 256 KiB with `body-truncated`; a timed test pins a hundred kilobytes of brackets under a second; bare URLs no longer become links, so a bare email cannot decide a replacement |
| F3 | Generated indexes pasted titles, descriptions and links raw | Applied: brackets and backslashes escaped, markup disarmed, whitespace collapsed, link targets percent-encoded; a test round-trips generate, parse and resolve for awkward titles and names |
| F4 | A fence with trailing whitespace refused the page while both checkers accept it | Applied: spaces and tabs after either fence; an unclosed block says so |
| F5 | Numeric source ids were dropped and a missing id was reported once per citation | Applied: scalar ids read as text; one degradation per missing id |
| F6 | A verification without `at` passed silently; nothing computed the latest verifier | Applied: `verification-without-at`; `latestVerification` on the page and in provenance, by instant, undated entries last |
| F7 | Integrity and caps over visible files only; degradations hidden in the text report | Fixed in round 1, confirmed by the reviewer's re-probe |
| F8 | Detail strings misled: positions off by one with a dangling colon, duplicate keys unnamed, wrong-type values described as missing, no entry indices, a zero count printed | Applied: file-line positions, the key named, "is a list, not text", `sources[3]`-style indices, counts printed only when non-zero, `replacement-not-a-page` for a folder, attachment or index |
| F9 | Years 0001 to 0099 rejected; a leap second rejected; `±hhmm` and `±hh` offsets rejected, all on the unsafe side | Applied: dates built with `setUTCFullYear`; `:60` reads as the last millisecond; both offset forms accepted |
| F10 | Reports asserted field by field let a false "missing" pass; one time zone; a misnamed test | Applied in part: two test projects at +14 and −11 run every test twice; the test renamed; whole-report golden files are deferred to bite 3's `check --json`, which fixes the serialisation they need |
| F11 | The plan's §2.3 types, the bite 2 interface and the intent's integrity wording lagged the code; the record filed the first build review under bite 3 and had no bite 2 build section | Applied: all three documents aligned; the record restructured |
| F12 | Inline HTML unreported and copied into descriptions; company indexes never checked; unsafe paths accepted; SHA-256 commits refused; duplicated helpers; a literal byte-order mark; a mutable catalog | Applied: inline HTML counted and kept out of the description; `index-lists-unserved` on a company index whose entries point at unserved pages; `path-escape` for absolute, empty, parent and backslash paths; 40- or 64-character commits; shared `paths.ts`; the mark written as an escape; provenance returns copies and the report keeps its own date. Not applied: `buildManifest` still throws on an unsafe path, which the loader has already refused by then; it is a programming guard, not a content path |

## Bite 3. Derived documents, engine adapter, search policy, `check`

### Plan

Scope: `src/derive/derived-document.ts`, `src/search/{engine,query,policy,search}.ts` (core); `src/engine/qmd.ts` (adapter); `src/fs/{walk,cache-dir,swap-tree}.ts` (edges); `src/commands/check.ts` and the `check` wiring in `src/cli.ts`; `bench/`; tests. Done when a question against the fixture bundles returns the right page through qmd's lexical search with the OKF filters and the relaxation ladder applied, from a test, with no model download; `okf-catalog check <dir>` prints the report and exits non-zero only on refusals; and the four benchmark numbers are recorded.

The layering, settled by the bite 1 review: an adapter may import the core and its own files, never an edge. So the engine does not write files. The port is:

```ts
interface DerivedDocument { path; title; description?; type; tags; metadata: Record<string, string | string[] | number>; body }   // core
interface Engine {
  render(doc: DerivedDocument): { relPath: string; text: string };   // pure; the adapter owns the text shape and the path codec
  index(dir: string): Promise<{ indexed: number; removed: number }>;  // the folder the command wrote the rendered documents into
  lex(terms: string[], limit: number): Promise<EngineHit[]>;         // hits carry decoded bundle paths
  status(): Promise<{ documents: number }>;
  close(): Promise<void>;
}
```

The command composes: load → `deriveDocument` per admitted page → `engine.render` → `fs/swap-tree` writes the rendered tree under the cache and swaps it in → `engine.index(dir)` → searches. `search/search.ts` receives the catalog, the engine, a request and the clock, and never touches a path.

Modules and their one job:

| Module | Job |
|---|---|
| `derive/derived-document.ts` | `deriveDocument(page) → DerivedDocument`: title, description, type, tags; the `okf_*` metadata map (`okf_type`, `okf_status`, `okf_tags`, `okf_stale_after` raw string, `okf_trust`, `okf_verified_by` latest verifier, `okf_source_count`); the body with a leading heading equal to the title removed (case- and whitespace-insensitive compare) |
| `search/query.ts` | `normaliseQuestion(question) → { terms; dropped }`: lower-case, punctuation to spaces, a fixed English stopword list of about 120 words including question words, duplicates removed, at most twelve terms, each at least two characters; hyphenated tokens kept whole |
| `search/policy.ts` | `poolSize(limit, filtered) → number` (`limit × 4` unfiltered; `max(limit × 10, 100)` filtered; cap 500); filters by `type` (case-insensitive exact), `topic` (folder prefix), staleness (`isOverdue` unless `include_stale`); rank keeps engine order and tie-breaks equal scores by trust (human-reviewed, machine-confirmed, unverified); `shape(page, hit, now) → SearchHit` |
| `search/search.ts` | `search(catalog, engine, request, now) → SearchResponse`: the ladder (all terms; if fewer than `limit` hits, one query per term fused by reciprocal rank with k = 60, appended after the all-terms hits, de-duplicated), the pool, the filters, the one-time widening to the cap when every candidate was filtered out, `topicExhausted`, `strategy`, `considered`, `filteredOut` |
| `engine/qmd.ts` | `QmdEngine`: `createStore({ dbPath, config: { collections: { [company]: { path: dir, pattern: "**/*.md" } } } })`; `render` emits `# <title>`, the description line, `Type: <type>`, `Tags: a, b`, a blank line and the body, with the metadata rendered as a `qmd: metadata:` frontmatter block only when `renderMetadataBlock` is true (off by default, D30); the path codec encodes any segment qmd would skip (`node_modules`, `.git`, `.cache`, `vendor`, `dist`, `build`, or dot-leading) with an `_` prefix and decodes it on the way back; `lex` joins the terms with spaces, calls `searchLex` with no collection filter, maps `displayPath` by removing the single company segment and decoding; a read-write lock makes `lex` wait while `index` runs (D28); `status` from `getStatus()`; `close` closes the store |
| `fs/walk.ts` | `walkBundle(root, caps) → { files: BundleFile[]; refusals: Refusal[] }`: `lstat` every entry, refuse symbolic links (`symlink`) and anything whose real path leaves the root (`path-escape`), refuse a file over `caps.fileBytes` without reading it (`oversize`), stop and refuse the bundle beyond `caps.files` or `caps.treeBytes` (reported as `fatal` by the loader through `walkRefusals`? No: the walker returns `tooMany` and `tooLarge` flags the command turns into the same fatal refusals the core would); never follows a path it did not list; skips nothing itself, since hidden handling is the core's |
| `fs/cache-dir.ts` | `cacheRoot() → string` (`$XDG_CACHE_HOME`, else `~/Library/Caches` on macOS, else `~/.cache`), `companyCache(root, company) → { source, derived, dbPath, state }`; `ensureCache(dir)` refuses a folder not owned by the user or writable by group or others |
| `fs/swap-tree.ts` | `swapTree(target, write: (stagingDir) => Promise<void>)`: write into a fresh sibling folder, rename the live folder aside, rename the new one in, delete the old one; on failure, leave the live folder untouched |
| `commands/check.ts` | `okf-catalog check <dir> [--dev] [--integrity none] [--spec-text 2026-08-15\|2026-08-21] [--admit stable,deprecated] [--types a,b]`: walk → load → `renderReport` to stdout (this command's stdout is for people, not a protocol) → exit 1 on any refusal or fatal, else 0; `--json` prints the report as JSON |
| `bench/` | `fetch-corpus.sh` clones the four public OKF repositories at pinned commits into `bench/corpus/` (gitignored); `questions.json` holds the twenty-five public-corpus questions with gold paths; `run.ts` loads the corpus, derives, indexes and runs the questions in four configurations (ladder on or off, metadata block on or off), printing hit@1, hit@3 and MRR |

Tests first: golden derived documents and golden rendered text for the behaviours fixture, including the duplicate-heading rule and the codec; `normaliseQuestion` on sentences; `policy` pool sizes, filters, tie-break and shaping on synthetic hits; `walk` on a hostile tree generated at test time (a symbolic link, a path escape through a link to a folder outside the root, an oversize file, too many files); `swap-tree` with a failing writer; `cache-dir` resolution and the ownership check; an integration test that derives the fixtures into a temp cache, indexes them with a real qmd store and asserts the gold page for ten keyword questions and five sentence questions, recording the rung that answered and asserting that at least one sentence fails on the all-terms rung alone; the reindex lock under a concurrent search; `check` on the four fixtures with expected exit codes and a `--json` round trip.

Measure and record: index time and database size for the fixtures and for the public corpus; the four benchmark runs.

Review before build: an independent review of this plan. Review after build: an independent review of `qmd.ts`, `search.ts`, `walk.ts` and `swap-tree.ts`.

### Plan review

Reviewer: an independent Opus agent, read-only on the repository, running fourteen Node probes against the installed qmd 2.8.3 (no model ever called), three shell checks, and reading qmd's compiled source. Verdict: ready with changes. Dispositions, all applied to the design below before the first test:

| # | Finding | Disposition |
|---|---|---|
| F1 | The walker as planned would read every checkout's `.git`, count it against the caps, and hang on a named pipe; `lstat` refuses links before any escape check can fire; a realpath check against an un-realpathed root refuses everything under macOS temp folders | Applied: the walker never descends into or reads a dot-leading entry and returns those paths as `hidden`; it reads regular files only (`special-file` for anything else), opened without following links and non-blocking, reading at most the cap plus one byte; the root is realpathed once; too-many and too-large become `walkFatal`; hidden and walker-refused paths count as present for manifest verification; `path-escape` is documented as reachable only through a race; hard links are accepted and recorded as a residual risk |
| F2 | qmd empties or thins the index without an error (a missing or empty folder deactivates every document; a file with a backslash is skipped and counted only), and the planned port dropped that evidence; the rename-aside swap has a window with no live folder | Applied: the adapter checks the generation folder before `update()`, compares `getStatus().totalDocuments` with the rendered count after it and names the gap through `multiGet` as `not-indexed`; `index()` returns the full counts; the live tree is a symbolic link to a generation folder flipped by `symlink` then `rename`, with older generations removed; a start-up always re-derives before indexing |
| F3 | Two servers for one company would share one derived tree and one database, and one could silently empty the other's index | Taken as a working default, flagged for the maintainer's ruling as D32: an exclusive per-company lock file holding the process id, treated as stale when that process is gone; a process that cannot take it uses a private per-process folder removed at exit. `cache-dir` moves to bite 4, where `serve` first needs it; `check` needs no cache |
| F4 | Reciprocal-rank fusion on the relaxed rung lets terms present in every page (the collection name in the path column, the planned `Type:` and `Tags:` label words) vote as loudly as real terms, because SQLite floors their inverse document frequency; per-term BM25 values sum exactly to the AND query's value | Applied: the relaxed rung sums BM25 recovered from qmd's score (`b = s / (1 − s)`), ranks by terms matched then by summed BM25, drops hits below one percent of the best, and both rungs report the same raw scale; the rendered copy writes type and tag values without label words and collapses whitespace; ties break by trust within a tolerance, then by path; qmd's "Notes" title quirk is pinned in the golden test; the facts note's explanation of the 0.000 score is corrected |
| F5 | The normaliser could emit queries qmd answers with nothing: a leading hyphen means NOT, a token of only apostrophes or underscores poisons an AND query, a Chinese run is one phrase with nothing to relax, and an all-stopword question has no defined answer | Applied: tokens must match `^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$` with length in code points; CJK runs split into overlapping two-character pairs; an empty term list answers with no hits and the reason `no-content-terms`; the English stopword list stays, documented as a limitation; twelve terms in question order |
| F6 | The adapter lock is not needed on qmd 2.8.3, whose write loop never yields to the event loop, and with the planned signature it makes a request see a catalog older than the index | Applied: no lock in the adapter; refresh is single-flight in the composition layer, and the generation reference is swapped right after `index()` resolves; `close()` waits for a refresh in flight; an integration test pins that no macrotask runs during `update()`, so a qmd that starts yielding fails the suite; D28's rationale is replaced |
| F7 | `render` plus `index(dir)` put qmd's file-based indexing into the port; the dependency rule forbids importing the `fs` edge, not using Node's file system; `relPath` and the codec belong to a pure module | Applied: `Engine.index(docs)` takes the derived documents and the adapter writes its own generation tree with Node's file system; `render` and the path codec are pure exports in a module that does not import qmd, used by the golden tests and by `check`; `lex` returns the raw BM25 beside qmd's score; snippets come from the original body in the core (bite 4) |
| F8 | The codec was not reversible: `dist/` and `_dist/` both rendered to `_dist/`; backslashes are skipped by qmd; the dot rule never fires for a page | Applied: a segment equal to one of qmd's six skipped names, or starting with `_`, is prefixed with one `_`; decoding strips one `_`; `\` and `%` are percent-encoded; a decoded hit whose first segment is not the company is dropped; golden cases `dist`, `_dist`, `__dist`, `Dist`, `a\b.md` |
| F9 | Pool size, ladder trigger and widening were under-specified; every row carries its body, so wide pools cost memory | Applied as the algorithm in the revised design: widen while fewer than `limit` survive and the rung returned a full pool; relax only when still short; topic segments and the type value are pushed into every query as terms, with the exact filter kept; topics match by segment; `considered`, `filteredOut` per reason and the rung per hit are defined; peak memory is measured on a worst case |
| F10 | The benchmark needs run metadata to be comparable, over-reads twenty-five questions, kept its clones inside the walked root, and the block runs measure only dilution on a qmd that reads no block | Applied: one JSON line per question per configuration with the gold rank and top five; run metadata recorded; MRR@5 and paired wins and losses, reuse and paraphrase apart; both the question text and the keyword form, ladder on and off; the block runs deferred until a qmd release reads the block; clones moved beside the corpus; the retrieval note's question count corrected |
| F11 | `XDG_CACHE_HOME` must be absolute; cache folders need mode 0700 after `mkdir`; `check` had no exit code for a missing folder and emitted `Date` objects in JSON | Applied to `check` now (exit 0 served, 1 refused or fatal, 2 usage or environment; `--json` as `{ "okf_catalog_report": 1, ... }` with ISO strings; the usage text says a source checkout needs `--integrity none`); the cache rules go with `cache-dir` to bite 4 |

### Plan, revised after review

The port and the composition:

```ts
interface DerivedDocument { path; title; description?; type; tags; metadata: Record<string, string | string[] | number>; body }
interface EngineHit { path: PagePath; score: number; bm25: number }
interface IndexResult { documents; indexed; updated; unchanged; removed; skipped; notIndexed: PagePath[]; encodedFolders: string[] }
interface Engine {
  index(docs: readonly DerivedDocument[]): Promise<IndexResult>;   // writes its own generation tree, flips the link, indexes, verifies the count
  lex(terms: readonly string[], limit: number): Promise<EngineHit[]>;
  status(): Promise<{ documents: number }>;
  close(): Promise<void>;
}
```

`src/engine/qmd-render.ts` (pure, no qmd import): `renderDocument(doc) → string` writes `# <title>`, the description, the type value, the tag values joined by spaces, a blank line and the body, with whitespace collapsed in the first four; `encodePath(path)` and `decodePath(path)` implement the codec. `src/engine/qmd.ts` owns the store, the generation folders under a directory it is given, the symlink flip, the count check and the `multiGet` diff.

`src/search/query.ts`: the tokenizer above; `normaliseQuestion(question) → { terms; dropped }`. `src/search/search.ts`: the algorithm. Run all content terms plus the topic's path segments plus the type value, as one query at pool `P = limit × 4`; filter by type, topic (`path.startsWith(topic + "/")`), status rule and staleness; while fewer than `limit` survive and the rung returned `P` rows, widen `P` fourfold up to 500. If still short, run one query per content term at the same `P`, fuse by summed BM25 with a one-percent floor, rank by terms matched then score, append after the all-terms hits without duplicates. Every hit carries its rung and raw BM25; the response carries `considered` (distinct engine hits examined), `filteredOut` per reason, `strategy`, `terms`, `dropped`, and `reason: "no-content-terms"` when the question had none.

`src/fs/walk.ts`: `walkBundle(root, caps) → { files; hidden; refusals; fatal? }` as F1 describes. `LoadOptions` gains `hiddenPaths` and `walkFatal`; the core counts hidden paths, refuses `.qmd` among them by path, treats hidden and refused paths as present for the manifest, and measures caps over the files that arrived. `src/commands/check.ts`: walk, load, render the report, exit codes 0, 1 and 2, `--json`.

Dropped from this bite: `fs/cache-dir.ts` and `fs/swap-tree.ts` (the adapter owns its generations; the cache layout and the per-company lock, D32, go to bite 4). Added: `engine/qmd-render.ts`, the no-yield pin test, the walker's special-file and hidden handling, the benchmark's run metadata.

Decisions this bite adds or changes, proposed for the maintainer: D25 (the algorithm above replaces the fixed pool), D28 (single-flight refresh in the composition layer, no adapter lock), D31 (summed BM25 instead of reciprocal rank for the relaxed rung; tokenizer and CJK rule), D32 (one process per company enforced by a lock file, with a private fallback folder).
