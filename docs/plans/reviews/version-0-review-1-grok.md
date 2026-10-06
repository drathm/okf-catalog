# Version 0 plan, review 1

Independent adversarial review of `docs/plans/version-0.md` draft 1, run 2026-10-06 on Grok Build (grok-4.7), headless, read-only, with web access to qmd's source, the MCP SDK documentation, the OKF specification and the npm registry. 28 turns, about twenty minutes, about $0.83. The reviewer's text follows verbatim; the dispositions are in the plan's review record.

## 1. Verdict

**NOT READY.**

The catalog type has no place for a conformant `index.md` or `log.md`, and `stale_after` is one UTC-midnight `Date` for two specification texts that define different instants.

`searchLex` ANDs every token and indexes the whole derived file, while the paraphrase acceptance item is not tested until bite 6.

The publish refresh names no commands, and the git environment clears `GIT_SSH_COMMAND` while still running the user's own filters.

Those three have to be rewritten in the plan before bite 1.

## 2. Findings

### 1. A conformant index or log does not fit the catalog, and the refusals match its shape

**Severity:** critical

**Evidence.** The plan's page requires `type: string`, and the refusal union is `'no-frontmatter' | 'no-type' | ...` (`docs/plans/version-0.md` lines 150 and 171). Load "parses each file into a `Page` or a `Refusal`" (`version-0.md` line 233). `Catalog.folders` stores `indexSource` and page paths, and nothing else (`version-0.md` lines 191–195). `loadBundle` does not take `company`, while `Catalog.company` is required (`version-0.md` lines 192 and 360).

OKF 0.2 at `0b87c52` says reserved names "MUST NOT be used for concept documents", and "Index files contain no frontmatter, with one exception: a bundle-root `index.md` MAY carry an `okf_version` key". Conformance item 1 applies to "Every non-reserved `.md` file". The same reserved-file rule is in the pinned text at `25461db`, section 3.1. Intent §6 says `index.md` is served by `catalog` and `log.md` is "served by `get_page` on request" (`docs/intent.md` lines 86–87).

`sources` is `{ id?: string; resource: string; title?: string }` (`version-0.md` line 159). The 21 August text also defines sibling and per-entry `usage_window`, plus `author`, `usage_count`, and `last_modified`. Those values survive only inside `frontmatter: Record<string, unknown>`. `Provenance` is used by `get_page` (`version-0.md` line 391) and never declared.

**Why it matters.** A bundle that follows the spec, which is the bundle intent §3 expects, has an `index.md` with no `type`. Run through this loader, that file is a `no-frontmatter` or `no-type` refusal, or it is dropped because nothing in `Catalog` can hold its text or `okf_version`. `log.md` has the same fate, so "served on request" has no value to return. `okf_version` has no field at all.

What the model can hold, once parsing normalizes it: `verified` as a list after a bare mapping is wrapped (the plan's bite 2 test matches the spec's MUST); `sources[].id`; bundle-absolute links as `links[].target` once the path convention is written down (leading slash, `.md` suffix).

**Change.** Add a `ReservedFile` (`kind: 'index' | 'log'`, `body`, optional root `okfVersion`) and keep it off the page parser. Route on the filename before `no-frontmatter` / `no-type`. Pass `company` into `loadBundle`. Define `Provenance` to include `sources` with `id`. Either promote `usage_window`, `author`, `usage_count`, and `last_modified` onto the source type, or state that v0 provenance omits them and `get_page` still returns the original frontmatter so an Attested Computation contract is not lost.

### 2. `stale_after` is one UTC-midnight `Date` for two texts that disagree

**Severity:** critical

**Evidence.** The plan stores `staleAfter?: { raw: string; at: Date; form: 'date' | 'datetime' }` and tests "overdue from the start of the day UTC" for both forms (`version-0.md` lines 155 and 255). `spec_text` is optional, `'2026-08-15' | '2026-08-21'` (`version-0.md` line 225).

Pinned `25461db` §5.5: "An absolute date (`YYYY-MM-DD`). A concept is stale when `today >= stale_after`."

`0b87c52` §5 preamble: "Every timestamp-valued key in OKF is an ISO 8601 datetime with an explicit UTC offset." §5.5: "An absolute instant. A concept is stale when `now >= stale_after`." The example is `2026-09-23T00:00:00Z`. That text does not define a date-only form, and it does not say to ignore one.

**Why it matters.** A datetime of `2026-09-23T18:00:00Z` under the 21 August rule becomes overdue at 18:00Z. The plan's start-of-day rule marks it overdue at 00:00Z, eighteen hours early, and the citation then says "overdue since" the wrong instant. A date-only value is legal in one pinned text and non-conformant in the other. The config switch does not select a comparison.

**Change.** Branch on `spec_text`. For `2026-08-15`, accept `YYYY-MM-DD` and compare calendar days in UTC; a datetime degrades and is reported. For `2026-08-21`, accept only a datetime with an explicit offset and compare instants; a date-only degrades, is reported, and is never overdue. Give `spec_text` a default. Keep `raw` for the citation and stop using one `Date` as the meaning of both forms.

### 3. Lexical search ANDs every token, and the body column is the whole derived file

**Severity:** major

**Evidence.** qmd 2.8.3 `buildFTS5Query` ends with "Join positive terms with AND", and a plain term becomes `"${sanitized}"*` (`store.ts` at tag `v2.8.3`, the query builder and the `positive.join(' AND ')` line). `rebuildDocumentFTS` inserts `content.doc` as the body column. `insertContent` stores the file text that was hashed. `extractTitle` uses `content.match(/^##?\s+(.+)$/m)` on the whole file, frontmatter included.

The derived copy appends `qmd: metadata:` inside the original frontmatter, then `# <title>`, the description, a tags line, and the body (`version-0.md` line 235). The ranking A/B of that block is bite 6 (`version-0.md` line 451). Intent §7 requires "one a paraphrase and one answerable only from a body" (`docs/intent.md` line 99). The tool argument is `question: string (1..500)` with no description (`version-0.md` line 387).

**Why it matters.** A question such as "how do we restate revenue" is an AND of `how`, `do`, `we`, `restate`, and `revenue`, each a prefix. A page that contains "revenue" and not "how" is a miss. qmd's own hybrid path exists because this lexer is keyword-shaped. The metadata block, the description, and the tags line all enter the body column at weight 1.0, and FTS5's default `unicode61` tokenizer splits on `_`, so `okf_status` is the tokens `okf` and `status` on every page. Bite 3 can pass on ten keyword fixtures and still fail the acceptance paraphrase. Bite 6 is the first time anyone measures it.

Dropping a duplicate opening heading is safe for `get_page`, because the original is what gets served. It does not protect the title: the first `#` or `##` anywhere in the file wins, including a line inside frontmatter that appears before the server's heading.

**Change.** State in the tool description that `question` is keywords, one concept per term, quotes for a phrase. In bite 3, add a fixture where the sentence returns nothing and the keyword query returns the page, and record that this is what lexical mode promises. Move the with-block / without-block ranking run to bite 3. Leave the metadata block out of v0 until qmd's filter ships: the title line and the tags line do the lexical work, and the block only adds body tokens. Intent line 66 already says that filter is unreleased.

### 4. Lexical mode downloads at install

**Severity:** major

**Evidence.** The plan says "`createStore` touches no config files and loads no model until `search`, `searchVector` or `embed` is called, so lexical mode never downloads anything" (`version-0.md` line 28).

`LlamaCpp`'s constructor only stores model URIs, the cache directory, and timers (`llm.ts` at `v2.8.3`, the constructor body). That part of the sentence is true for model weights. `node-llama-cpp@3.20.0` `package.json` has `"postinstall": "node ./dist/cli/cli.js postinstall"` and optional packages `@node-llama-cpp/mac-arm64-metal`, `linux-x64`, and the CUDA and Vulkan variants. `dist/config.js` sets `defaultSkipDownload` from `NODE_LLAMA_CPP_SKIP_DOWNLOAD`, default `"false"`, and `defaultNodeLlamaCppPostinstall` default `"auto"`. `OnPostInstallCommand.js` returns immediately only when `defaultSkipDownload` is set or the postinstall config is `"skip"`; otherwise it calls `getLlamaForOptions({ progressLogs: true }, { updateLastBuildInfoOnCompile: true })` and `process.exit(1)` on failure.

Opening the store does not require sqlite-vec. `initializeDatabase` catches a load failure, sets `_sqliteVecAvailable = false`, `console.warn`s, and continues, with the comment "vector search won't work but FTS is fine" (`store.ts`).

**Why it matters.** `npm ci` of this package installs qmd, which installs `node-llama-cpp`, which runs that postinstall and installs a platform binary. Bite 1 measures the footprint and does not say what CI must set, so a runner without a prebuild fails the install with exit 1, or spends the job compiling. Whether `getLlamaForOptions` still compiles when the optional prebuild is already present was not read. Model weights stay lazy. The sentence in the plan covers both and is false for install.

**Change.** Split the claim. Query time in lexical mode loads no model. Install time runs `node-llama-cpp`'s postinstall unless `NODE_LLAMA_CPP_SKIP_DOWNLOAD=1` or `--node-llama-cpp-postinstall=skip`. Bite 1 records bytes downloaded, whether a compiler ran, and the flag CI uses. Document the same flag for a local install. Keep stderr-only logging: `console.warn` from a missing sqlite-vec is stderr, which stdio can tolerate; a stdout line cannot.

### 5. The publish refresh has no procedure, and the git environment fights the credential claim

**Severity:** major

**Evidence.** Refresh is "`source.fetch()`; if the commit changed, load, derive, index, then replace the catalog" (`version-0.md` line 241). The option set is clone flags, `ls-tree`, then "checks out detached" (`version-0.md` line 326). No second-fetch command appears anywhere. The same paragraph "clears inherited `GIT_*` variables". The tooling table says system git is chosen for "The person's own credentials and SSH setup" (`version-0.md` line 314). The size cap is in `fs/walk`, which runs on the checked-out tree (`version-0.md` line 325). `ls-tree -l` is already in the command and its sizes are unused.

`GIT_ALLOW_PROTOCOL`, an empty `--template=`, and `core.hooksPath=/dev/null` were not checked against git's documentation.

**Why it matters.** A shallow clone does not update itself. `git pull` merges; a second `clone` throws the cache away. Without `fetch` of an explicit refspec, `checkout --detach --force` of `FETCH_HEAD`, and `git clean -fd`, a deleted page stays on disk and is indexed again. Clearing every `GIT_*` removes `GIT_SSH_COMMAND`, which is how many people point git at a particular key, while `SSH_AUTH_SOCK`, `~/.ssh/config`, and `~/.gitconfig` remain. Global smudge and LFS filters therefore still run on checkout. A repository string that starts with `-` is another git argument, because the plan never ends the option list with `--`. A huge blob is materialized before the size cap can refuse it. The symlink and gitlink check before checkout is the right shape and should stay.

**Change.** Write the refresh as commands: `git fetch --depth=1 origin <branch>` with a refspec, `ls-tree -r -t -l` on `FETCH_HEAD`, refuse mode `120000`, mode `160000`, a blob over the byte cap, or a tree over the count cap, then `git checkout --detach --force FETCH_HEAD` and `git clean -fd`. Put `--` before the remote and the paths. Keep `SSH_AUTH_SOCK`, `HOME`, and an explicit allowlist that includes `GIT_SSH_COMMAND`; set `GIT_CONFIG_COUNT=0` and `GIT_CONFIG_NOSYSTEM=1` so `~/.gitconfig` cannot enable a filter. Add `core.sshCommand` with `BatchMode=yes` so a passphrase prompt cannot hang a stdio server. Confirm the three unverified options in bite 0 against the git version CI installs, with the stand-in `git` the plan already wants in bite 5.

### 6. qmd will not index the derived tree the plan describes

**Severity:** major

**Evidence.** `reindexCollection` globs with `followSymbolicLinks: false`, `dot: false`, and ignores `**/{node_modules,.git,.cache,vendor,dist,build}/**`, then drops any path segment that starts with `.` (`store.ts`). There is no read of `.qmdignore`. An empty trim is skipped. The same hash skips the rewrite; a path that disappeared is `deactivateDocument`'d. The FTS trigger is `DELETE FROM documents_fts WHERE rowid = old.id AND new.active = 0`, so a removed page does not leave a hit.

`display_path` is `d.collection || '/' || d.path` (`store.ts`, the `searchFTS` SELECT). The plan maps `displayPath` "back to a page path" inside `search/search` (`version-0.md` line 239), which is core. If frontmatter already has a `qmd` key, "the page keeps its own and a degradation is recorded" (`version-0.md` line 235). `fs/write-tree` "renames it into place" (`version-0.md` line 235). Node 22's `fsPromises.rename` documentation says only "Renames `oldPath` to `newPath`" and does not promise to replace a populated directory.

**Why it matters.** A company folder named `dist`, `build`, or `vendor` is admitted and then never indexed, because the derived tree mirrors bundle paths. `displayPath` for company `acme` and page `tables/orders.md` is `acme/tables/orders.md`; a lookup that does not strip exactly one segment misses every hit. A page that already contains a `qmd` key is indexed under someone else's metadata block. The second refresh writes into a `derived/` that already exists; the plan's crash story depends on a rename the docs do not define. Removed pages are handled. Adding a ghost-cleanup pass would be cruft.

**Change.** In the adapter, strip the collection segment and require the company name to be a single path segment with no slash. Always write the server's `qmd` block into the derived copy; leave the original file alone. Pass `ignorePatterns: []` only after checking that qmd still appends its defaults — it does — so name the excluded segments in the plan and refuse or rename a bundle folder that collides with them. Swap the tree by renaming the live directory aside, renaming the new one in, then deleting the old one. Keep the hash and deactivation behaviour as written.

### 7. Topic filtering starves on the server's short list

**Severity:** major

**Evidence.** `searchFTS`: with no collection argument, `ftsLimit = limit`; with one collection, `ftsLimit = limit * 10`; with several, it recurses per name and `mergeSearchResultsByScore` keeps the best score per file, sorts, and slices to `limit` (`store.ts`). The plan asks for `limit × 4`, capped at 200, then applies the topic filter (`version-0.md` line 239). D25 says one collection "avoids both" the ten-times fetch and the per-collection merge (`version-0.md` line 441).

**Why it matters.** D25 is right about qmd. One collection and no collection filter returns exactly `limit` rows, so the ten-times path never runs. The server then throws away rows that are outside the topic. Default `limit` is 8, so the candidate list is 32. A page that is the best hit inside `finance/` and 33rd overall is invisible. One collection per folder, passed as a list, re-enters the merge. Passing a single folder name re-enters the ten-times path. Intent §10's "collections per topic" would hit that path.

**Change.** Say this in D25. For v0, when `topic` is set, call `searchLex` without a collection filter at a documented cap (qmd's own factor is 10, not 4) and record misses when `filteredOut.topic` equals the candidate count. Do not pass a collection list.

### 8. `npx okf-catalog@<version>` cannot meet the offline acceptance item

**Severity:** major

**Evidence.** D27 launches with `` `npx okf-catalog@<exact version> serve` `` (`version-0.md` line 443). Intent §7 requires: "offline, the server serves its cache and reports when it last pulled" (`docs/intent.md` line 104). Plugin start latency is measured in bite 4 (`version-0.md` line 454).

Claude Code's plugin reference substitutes `${user_config.KEY}` "in MCP server config", and the channel example sets `"env": { "BOT_TOKEN": "${user_config.bot_token}" }`. `startupTimeout` in that document is a field of `lspServers`, not of MCP servers. What Claude Code does when a stdio server is slow to start was not found there.

**Why it matters.** A cold `npx` needs the registry, writes progress, and can write it to stdout, which is the MCP channel (invariant 3). An offline machine with a warm cache still fails at process start. The `userConfig` → `env` mechanism itself is real and should be written as config, not as prose.

**Change.** For v0, `.mcp.json` runs `node` on a path, with `"env": { "OKF_CATALOG_CONFIG": "${user_config.config_path}" }` and `userConfig.config_path` of type `file`. Keep `npx` as a post-publish alternative and say the offline acceptance item is "process already installed, registry unreachable, cache present". Measure cold start in bite 1, including whatever npm prints.

### 9. The tool contracts name types and citation fields that are not defined

**Severity:** major

**Evidence.** `search` takes `sub_queries?: SubQuery[]` and `SearchRequest` uses `SubQuery` (`version-0.md` lines 203, 209, 388). No `SubQuery` type is declared. `get_page` returns `Provenance & { body }` (`version-0.md` line 391). The hit line is `"<path> — <title> [<type>, <status>, <trust>, recheck <date>|overdue since <date>] <snippet>"` (`version-0.md` lines 389–390). `serveStdio`'s default legacy posture is `'serve'`, once per connection, for a 2025-era `initialize` (SDK `docs/serving/legacy-clients.md` at tag `v2.3.1`). `tools.md` says structured-result encoding differs by era; the era matrix in `protocol-versions.md` does not mention `structuredContent` or `outputSchema`. Whether today's Claude Code rejects `outputSchema` was not verified.

**Why it matters.** `SubQuery` on the lexical tool is the full-mode API, unused in v0, and it does not typecheck. A page with no `stale_after` has no recheck date, and an unverified page has no verifier, but the citation line and the bite 4 done-when ("cites path, verifier and recheck date") require both. `content` is the text a 2025 client actually shows; `structuredContent` is extra. Returning the body in both is fine if `content` stands alone.

**Change.** Delete `hybrid`, `subQueries`, and `SubQuery` from the v0 port and the v0 tool. Define `Provenance`. Give the citation line three branches: `recheck <raw>`, `overdue since <raw>`, and `no recheck date`, plus `unverified` when `verified` is empty. Keep `isError: true` with a repair message; the SDK validates `outputSchema` on success results and the handler should not depend on a 2025 client reading `structuredContent`. `serveStdio`'s default already serves a 2025 client. Do not set `legacy: 'reject'`.

### 10. Vitest 5 is not one dev dependency, and the layer rule is unproven for NodeNext

**Severity:** minor

**Evidence.** The plan rejects alternatives because Vitest is "one dev dependency" (`version-0.md` line 307) and pins `vitest` 5.0.3 (`version-0.md` line 344). `vitest@5.0.3` `package.json` has peer `vite: "^6.4.0 || ^7.0.0 || ^8.0.0"` with `peerDependenciesMeta.vite.optional: false`, and engines `^22.12.0 || ^24.0.0 || >=26.0.0`. qmd's peer is `"typescript": "^5.9.3"` with no `peerDependenciesMeta` (`@tobilu/qmd@2.8.3` `package.json`). Pinning 5.9.3 is the right call. `dependency-cruiser@18.5.0` depends on `enhanced-resolve@5.26.0` and allows Node `^22||^24||>=26`. Its TypeScript-version cap and its NodeNext `.js`-specifier behaviour were not re-read from its schema.

The core import list (`version-0.md` lines 44–46) does not need `node:fs`, qmd, or MCP to represent the field table. Hash, paths, and the clock are already injected. The false sentence is "either library can be swapped behind its port" (`version-0.md` line 52): `derive/` emits qmd's title line and `qmd:` block, and that folder is core.

**Why it matters.** `npm` 7 and later installs non-optional peers and fails the tree on a conflict. Vite will be in the lockfile whether or not the plan names it. A dependency-cruiser rule that only matches `.ts` specifiers will pass a core file that imports `node:fs` through a `.js` specifier, which is what NodeNext emits.

**Change.** Pin `vite` next to Vitest. Point `.dependency-cruiser.cjs` at `tsconfig.json`, and make the bite 1 deliberate violation `import 'node:fs'` and `import {} from './page.js'` from a core file. Move the qmd-shaped text into `engine/qmd` so the core emits a structured derived document and the adapter renders it. The layer rule can then stay.

### 11. Two settled rules are restated differently

**Severity:** minor

**Evidence.** Intent §6: "On a deprecated page, the first body line links to the page that replaced it" (`docs/intent.md` line 79). The plan: "the first body link, when it resolves" (`version-0.md` line 161).

D10: "a development flag admits drafts and labels them, local mode only" (`docs/decisions/0001-founding-decisions.md`). `CompanyConfig.serve` allows `dev: true` beside a git `source` (`version-0.md` lines 221–223).

**Why it matters.** A link on line 2 becomes a replacement under the plan and a reported gap under the intent. `dev: true` on a published branch skips the manifest check on the tree the server serves to agents.

**Change.** `deriveReplacement` accepts a link only from the first non-empty body line. Reject `dev: true` unless `source.local` is set.

### 12. The checkers never see the tree `pack` writes, and the v0 port carries full-mode types

**Severity:** minor

**Evidence.** The recipe is "okflint validate, okf-schema validate, npx okf-catalog pack, push published" (`version-0.md` line 127). Pack "writes an `index.md` into every folder that lacks one" after those checkers (`version-0.md` line 410). D3 keeps checkers out of the product; D20 puts pack in the package so manifest and index code have one implementation (`version-0.md` lines 410 and 436). That split is sound.

`Engine.hybrid` and `subQueries` are on the v0 port (`version-0.md` lines 203 and 209). Nothing in version 0 calls them.

**Why it matters.** The published branch can contain index files no checker looked at. A second implementation of `index.md` inside pack drifts from `okflint index`. The unused hybrid signature is the full-mode API arriving early, and it pulls `SubQuery` into the lexical schema (finding 9).

**Change.** Run the checkers on `--out` after pack, or stop having pack invent index files and let `catalog` synthesize them, which the spec already allows. Delete `hybrid` from the v0 interface.

## 3. Alternatives

**Omit the `qmd:` block in v0.** The unreleased metadata filter cannot read it. Title line plus tags line is the lexical signal. Cost: delete the block writer and the bite 6 A/B. Gain: body tokens stop including `okf`, `stable`, and every tag twice. Add the block back when the filter ships, behind the adapter from finding 10.

**Keyword contract, recorded.** About twenty lines of tool description and one fixture. No new dependency. The alternative, qmd's query expander, downloads the generation model and leaves lexical mode.

**Install flags, not a different native stack.** `NODE_LLAMA_CPP_SKIP_DOWNLOAD=1` in CI and in the README. better-sqlite3 still has to load. Replacing qmd to avoid the postinstall throws away the engine the product is built on.

**Vitest 3.2.7**, which is what qmd itself dev-depends on, avoids a week-old Vitest 5 and its required Vite. Cost: worse diffs, the thing the plan wanted. Pinning Vite is the smaller change. Biome 2.5.15 is a current 2.x patch and is not the problem.

**A thirty-line import test beside dependency-cruiser**, asserting the core graph from `tsc`'s NodeNext resolution. Cruiser stays for the layer table. The test is what proves `.js` specifiers. Dropping cruiser saves one dev tool and loses the ongoing rule.

**Git stays system git.** isomorphic-git was rightly rejected: it has its own credential story. The missing piece is the refresh command list in finding 5, on the order of forty lines and one test against a bare repo. No new dependency.

**For version 1, one sentence now.** `createMcpHandler`'s default legacy posture builds a server per request (`legacy-clients.md`). The store, the poller, and the catalog reference have to be created outside that factory. Searching while `update()` writes the same database is already in the risk table; the guard is a mutex or a second sqlite file, chosen before bite 5, because `reindexCollection` commits per file.

## 4. Verification table

| Claim | Status | Source |
|---|---|---|
| Core field table needs no `node:fs`, qmd, or MCP import | verified | Plan §2.3 types are pure data; walk and `createStore` sit outside core |
| "Either library can be swapped behind its port" | contradicted | `version-0.md` line 52; derive emits qmd's heading and `qmd:` block, line 235 |
| dependency-cruiser 18.5.0 runs on Node 22 and 24 and uses enhanced-resolve | verified | `dependency-cruiser@18.5.0` package.json, `engines` and `dependencies` |
| dependency-cruiser resolves NodeNext `.js` specifiers to `.ts` | could not verify | Schema not re-read |
| `verified` bare mapping must become a one-element list | verified | OKF `0b87c52` §5.2; plan stores an array and tests the wrap |
| `sources[].id` is the footnote join key, resolved by the consumer | verified | OKF `0b87c52` §5.1; intent §6 "so an agent can resolve a `[^id]`" |
| `usage_window`, `author`, `usage_count`, `last_modified` are spec fields | verified | OKF `0b87c52` §5.1; absent from `Page.sources` |
| `index.md` / `log.md` are non-concepts; root index may carry `okf_version` | verified | OKF `0b87c52` §3.1, §8, §11, §12 |
| 15 August text: `stale_after` is `YYYY-MM-DD`, stale when `today >=` | verified | `25461db` SPEC §5.5 |
| 21 August text: timestamps are datetimes with an offset; stale when `now >=` | verified | `0b87c52` SPEC §5 preamble and §5.5 |
| 21 August text tells consumers to ignore a date-only value | contradicted | That sentence is not in `0b87c52`; §11 has no such bullet |
| Plan judges both forms from UTC midnight | verified | `version-0.md` lines 155, 255 |
| qmd indexes the whole file as the FTS body | verified | `store.ts` `rebuildDocumentFTS` inserts `content.doc` |
| Title is the first `#` or `##` anywhere in the file | verified | `store.ts` `extractTitle`, `/^##?\s+(.+)$/m` |
| BM25 weights path 1.5, title 4.0, body 1.0 | verified | `store.ts` `bm25(documents_fts, 1.5, 4.0, 1.0)` |
| `display_path` is `collection/path` | verified | `store.ts` `searchFTS` SELECT |
| One collection filter fetches `limit * 10`; no filter fetches `limit` | verified | `store.ts` `const ftsLimit = collectionFilter ? limit * 10 : limit` |
| Several collections are merged by best score then sliced | verified | `store.ts` `mergeSearchResultsByScore` |
| Lex queries AND every positive term as a prefix | verified | `store.ts` `buildFTS5Query` |
| Removed documents leave FTS hits | contradicted | Trigger `DELETE FROM documents_fts ... AND new.active = 0` |
| `.qmdignore` is read by `reindexCollection` | contradicted | Ignore list is the built-in directories plus `options.ignorePatterns` |
| Default ignore drops `dist`, `build`, `vendor`, dot segments | verified | `store.ts` `reindexCollection` |
| Same content hash skips the rewrite | verified | `store.ts` `existing.hash === hash` |
| `LlamaCpp` constructor downloads models | contradicted | `llm.ts` constructor assigns URIs and timers only |
| `node-llama-cpp@3.20.0` postinstall calls `getLlamaForOptions` unless skip | verified | package.json `scripts.postinstall`; `dist/config.js`; `OnPostInstallCommand.js` |
| `getLlamaForOptions` compiles even when the platform prebuild is installed | could not verify | `getLlama.js` not read |
| sqlite-vec failure aborts `createStore` | contradicted | `store.ts` `initializeDatabase` catches, warns, continues |
| qmd peer `typescript` `^5.9.3` is non-optional | verified | `@tobilu/qmd@2.8.3` package.json, no `peerDependenciesMeta` |
| TypeScript 7 is the registry latest | verified | First pass of this review, `registry.npmjs.org/-/package/typescript/dist-tags`, latest `7.0.2` |
| npm refuses `typescript@7` beside that peer | could not verify | Peer range verified; an install was not run |
| Vitest 5.0.3 requires Vite | verified | `vitest@5.0.3` package.json, `vite.optional: false` |
| `serveStdio` default legacy mode is `'serve'` for a 2025 `initialize` | verified | SDK `v2.3.1` `docs/serving/legacy-clients.md` |
| `outputSchema` encoding differs by protocol era | could not verify | `tools.md` asserts it; `protocol-versions.md` does not say it |
| Claude Code rejects `outputSchema` or times out a slow stdio server | could not verify | Not in the plugin reference sections read |
| `${user_config.KEY}` substitutes in MCP server config, including an `env` example | verified | `code.claude.com/docs/en/plugins-reference`, reference section and the channel `env` example |
| `startupTimeout` applies to plugin MCP servers | contradicted | In that document it is an `lspServers` field |
| YAML 2.9 keeps dates as strings by default | could not verify | Plan line 310; package schema not read |
| `GIT_ALLOW_PROTOCOL`, empty `--template=`, `hooksPath=/dev/null` are valid | could not verify | Git documentation not fetched |
| Node `fs.rename` replaces a non-empty directory | could not verify | Node 22 docs say only "Renames `oldPath` to `newPath`" |
| D20 pack-in-package contradicts D3 | contradicted | Checkers stay in the recipe; the hole is order, finding 12 |
| Plan refresh specifies `fetch` plus `reset` | contradicted | `version-0.md` line 241 names `source.fetch()` and no git commands |

## 5. Questions the maintainer must answer before bite 1

1. When `spec_text` is omitted, which text applies, and does a date-only `stale_after` under the 21 August text degrade or parse?
2. Is the acceptance paraphrase a lexical-mode requirement, or only part of the full-mode measurement? Lexical mode can promise keyword hits.
3. What are the byte cap and the file-count cap? `ls-tree -l` cannot refuse a bomb until those numbers exist.
4. May `dev: true` be combined with a git source? D10 says the flag is local-mode only.
5. Does the published branch contain index files the author committed, or files `pack` invents after the checkers have run?
6. What alphabet is `company`? It is a cache path segment and a qmd collection name, and `displayPath` is split on the first slash.
7. Which git version does CI install, so `GIT_ALLOW_PROTOCOL`, `--template=`, and `hooksPath=/dev/null` can be confirmed before anyone writes `git.ts`?

## 6. Residual risk after these changes

qmd pins `zod@4.2.1` and `@modelcontextprotocol/server@2.0.0`; the app pins `zod@4.6.5` and server `2.3.1`. npm will nest two copies. Import only the app's copy.

better-sqlite3 13's prebuilt binaries for Node 22 and 24 were not checked. The CI matrix is the right test. A source build needs a compiler the plan never installs. sqlite-vec missing is non-fatal for lexical search and fatal later for full mode.

`reindexCollection` commits per file into the live database. The risk row is real. A mutex or a second database file has to be chosen before bite 5, or a search can mix old and new pages. `deleteInactiveDocuments` is not part of `update`, so inactive rows accumulate; hits stay correct because the FTS row is deleted.

`get_page` as "provenance plus body" drops `runtime`, `parameters`, `executor`, and `attester` unless original frontmatter is included. Version 0 can ship without Attested Computation support only if that omission is written down.

The skill text is the only control for "page bodies are data", and it is unspecified. "Refused five times" is a session with a model, not a CI test.

qmd's `setConfigSource` is process-global. That is safe under one company per process, and it breaks if version 1 puts two companies in one process.

Pin `yaml`'s schema to `core` in the parser call. The plan's "dates stay strings" claim was not verified against yaml 2.9, and a YAML 1.1 schema would turn `stale_after` into a `Date` and erase the two-text distinction the plan already tripped over.

Claude Code's stdio startup limit and its treatment of `outputSchema` remain unverified. The text block has to be readable on its own.