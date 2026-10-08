# Version 0.4 acceptance

What 0.4.0 is judged by: a network of bundles, the configuration and its `company:` alias, one index with a collection per bundle, failure and refresh per bundle, identity across bundles, `catalog`, `status` and `pack` per bundle, of [../plans/version-0.2.md](../plans/version-0.2.md), section 3.3 (issue 3; decisions D72 to D76). "Automated" means a test in the suite proves it on every run, at UTC+14 and UTC−11; the two scripted items need a person's reading, as the items of the version 0 runbook do. The version 0 runbook ([version-0.md](version-0.md)) and its instruments keep working against a `company:` file, a network of one bundle, which keeps version 0's lines and the shapes of `catalog` and `status` (D74); this release's runs of them are recorded below.

## What changed, and its evidence

| Change | Automated evidence | Status |
|---|---|---|
| The configuration names a network and its bundles; the top-level keys are the defaults, a bundle's own keys win, caps key by key, `limit_default` the network's; `serve.dev` only on a local bundle, integrity off for it alone; a `company:` file is a network of that name with one bundle of that id; refused, each with a sentence naming the key: `company` beside `network`, an id used twice, `vendor`, `dist` and `build`, a local bundle inside the network's cache folder or holding it, a local bundle inside another's folder, a top-level `serve.dev` (D76) | `test/unit/network-config.test.ts` (the version 0 cases through the alias; "inherits network defaults and takes a bundle's overrides", "allows serve.dev on a local bundle only, and turns integrity off for it alone", "refuses company with network, a repeated id, vendor, dist and build, and a local path inside the cache or another bundle") | automated |
| One collection per bundle in the network's store, rooted at `bundles/<id>/derived`, re-indexed by a scoped `update()`; scores on one scale across bundles and not across stores; a dropped bundle's pages out of search and the statistics; a store holding a collection that is not a configured bundle rebuilt; a version 0 store opened without a re-index, its root link and generations removed (D73; plan section 4, findings 1, 3, 4 and 5) | `test/integration/qmd-engine.test.ts` ("scores pages on one scale across bundles", "re-indexes one bundle without touching another", "takes a dropped bundle's pages out of search and the statistics", "rebuilds a store holding a collection that is not a configured bundle…", "keeps each bundle's generations under bundles/<id>…", "opens a version 0 store under the new layout without a reindex (P19)", and the version 0 tests on the new port) | automated |
| Each bundle loads, fails and refreshes on its own: a refused bundle, or one whose first load throws while another loads (`load-failed`), is reported and its pages leave the index; a failed refresh keeps its previous generation; refresh single-flight per bundle, every engine write one at a time; the network refuses only when every bundle's first load throws; one poller per repository bundle (D75) | `test/unit/runtime.test.ts` ("serves the other bundles when one has no manifest", "refreshes one bundle and keeps its previous generation on failure", "keeps refresh single-flight per bundle and commits one at a time", "publishes a refused bundle… takes its pages out of the index"), `test/unit/poller.test.ts` ("refreshes its own bundle by name, and a refusal of another bundle never moves it") | automated |
| Hits and `get_page` carry `bundle` and `conceptId`; a topic matches inside each bundle; equal score and trust order by path, then bundle id; a name two bundles serve is an error naming each page with its bundle and the name to ask for with it; a refused bundle is never a candidate; `get_page`, `citations`, `provenance` and `catalog` take `bundle` (D74) | `test/unit/search.test.ts` ("returns a hit from each bundle and matches a topic inside the bundle", "orders equal paths in two bundles by bundle id"), `test/unit/resolve.test.ts` ("lists the bundle ids for a name two bundles hold, until one is named", "skips a refused bundle", "applies the foo.md rule across bundles"), `test/integration/mcp.test.ts` ("answers a path two bundles hold with two hits and a get_page error") | automated |
| One bundle keeps version 0's lines, `catalog` and `status` (adding `publishedAt` and `okfVersion`); beyond one, lines name the bundle first, `catalog` lists the bundles and their root indexes within the budget, `status` gives the network and a row per bundle; the tools refuse only when every bundle is refused (D74, D75) | `test/integration/mcp.test.ts` ("lists the bundles and their root indexes without a bundle", "reports one status row per bundle", "keeps today's status and catalog shapes for one bundle", "refuses only when every bundle is refused"), `test/unit/text.test.ts` ("lines beyond one bundle"), `test/unit/outputs.test.ts` ("cuts each root index to its share of the budget in both channels, and says so"), `test/unit/load.test.ts` ("reports the manifest's commit and publish time…") | automated |
| One process, one lock and one store for a network; a `company:` file served as a one-bundle network, its version 0 cache moved into `bundles/<id>` under the exclusive lock, the offline fallback kept; nothing moved or removed in the private fallback (D72, D73) | `test/integration/stdio.test.ts` ("serves two local bundles from one lock and one store", "loads a company: file as a one-bundle network and moves the version 0 cache into bundles/<id>", "leaves the version 0 cache alone in the private fallback", and the repository-source tests on the new layout) | automated |
| `pack --bundle` required beyond one bundle and implied by a file with one; `check` unchanged | `test/unit/pack.test.ts` ("refuses a two-bundle file without --bundle and packs with it"), `test/unit/check-command.test.ts` ("checks a folder without --bundle") | automated |
| No engine rank changes for one bundle; the network's shift measured, not gated (D-D) | `test/integration/rank-guard.test.ts` and `bench/expected/lexical-ranks.json`, both pins untouched; `test/unit/bench-network.test.ts`; the measurement below | automated |
| The version 0 instruments keep working against a `company:` file | `test/integration/acceptance-scripts.test.ts` ("ask.mjs prints the rank…", over a `company:` file); the runs below | automated; run by the author |
| An agent answering from a network names the page's bundle and path | `test/integration/acceptance-scripts.test.ts` (`verify.mjs --expect-bundle`, `claude.sh`'s bundle argument); the scripted items below | automated; scripted by the author, the person's reading pending |

Tests that held on arrival, because the behaviour existed before this bite (the resolver took a list of bundles from bite a, and `check` reads no configuration), were each seen red against a deliberate local mutation, never committed: "applies the foo.md rule across bundles", "checks a folder without --bundle", "leaves the version 0 cache alone in the private fallback", and the unit tests of the lines and of the network's catalog, written after the code they test.

## The guards' results

Both pins are untouched and hold with the network engine. `node bench/run.mjs --expect bench/expected/lexical-ranks.json`, the public corpus loaded as the one bundle `bench`, held every gold rank and every top five (275 answers) before any source change, after the engine's port, after the search's, with `--split` at the measurement below, and again, plain and with `--split`, after the merge of bite b's verification (`0f6c505`), on darwin arm64 with Node 24.15.0 and qmd 2.8.3. The corpus was a copy without its clones, so the runs could not read its commits (the note says unknown); its files are identical to the four clones at the pinned commits. `test/integration/rank-guard.test.ts` passes with `test/expected/ranks.json` unchanged.

## The measurement: the corpus as a network

`node bench/run.mjs --split` loads each top-level folder of the corpus as its own bundle in one index and pairs the four unfiltered configurations with the one-bundle run ([../research/benchmark-network.md](../research/benchmark-network.md)). Recorded, not gated. On the four corpus folders (736 pages), no gold rank moved in any of the four configurations, and every one of the 100 top fives held the same pages in the same order as the one-bundle run's (read from the run's records, `<bundle>:<path>` against `<folder>/<path>`): a bundle's id in each `filepath` and the shared statistics did not reorder this corpus. The note was written again at `0f6c505`, with the same figures.

## The scripted items

A configuration serving the `behaviours` and `spec-example` fixtures as two local bundles, development mode off:

```yaml
network: fixtures
bundles:
  - id: behaviours
    source:
      local: <checkout>/test/fixtures/bundles/behaviours
    types: [Term, Note, Widget]
  - id: spec-example
    source:
      local: <checkout>/test/fixtures/bundles/spec-example
```

**`ask.mjs` finds a page of each bundle.** With two questions, one per bundle (`terms/alpha.md` in `behaviours`, asked as "Which term is the fully described page every happy-path test starts from?", and `policies/revenue-recognition.md` in `spec-example`, asked as "What is the revenue recognition policy for FY2026?", each with its keywords):

```sh
node bench/acceptance/ask.mjs --config <that configuration> --questions <those two questions>
```

| Run | Outcome | Person |
|---|---|---|
| The author, 2026-10-08 04:38 UTC, at `45e3ae6`, Node 24.15.0 | 2 of 2 expected pages found, each at rank 1 in both the question and the keyword form; each expected page's header named its type, status, tier, verifier and recheck date; exit 0 | pending |
| The author, 2026-10-08 04:58 UTC, at `0f6c505`, after the merge of bite b's verification, Node 24.15.0 | The same: 2 of 2, each at rank 1 in both forms, each header as before; exit 0 | pending |

**An agent names the bundle and the path of a page of the second bundle.**

```sh
sh bench/acceptance/claude.sh --checkout . --config <that configuration> --results <a folder outside the checkout> question "What is the revenue recognition policy for FY2026?" policies/revenue-recognition.md spec-example
```

`verify.mjs` checks that the server was connected and the plugin loaded, that only the catalog's tools were called, that nothing was denied, and that the answer names `policies/revenue-recognition.md`, a trust tier and the bundle `spec-example`.

| Run | Outcome | Person |
|---|---|---|
| The author, 2026-10-08 04:40 UTC, Claude Code 2.1.292, `claude-sonnet-5-5`, `dontAsk`, on the author's claude.ai sign-in (Max-plan usage; 0.14 USD is the stream's estimate), 4 turns, at `45e3ae6` with the skill's bundle sentences and the bundle check of `claude.sh` and `verify.mjs` in the working tree, committed unchanged right after. The script ran under `env -i` with the variables a terminal has, so the agent session's own Claude Code variables did not reach the run; Claude Code still loaded the author's own user plugins, twenty-four of them besides `okf-catalog` (the catalog its only MCP server) | `verify.mjs` passed. The model called `catalog`, `search` and `get_page`. The answer cited `spec-example:policies/revenue-recognition.md` with its tier (human-reviewed), its verifier and date and its recheck date, said it is not overdue, and summarised the page. The author's reading: passed | pending |
| The author, 2026-10-08 04:59 UTC, the same Claude Code, model and mode, on the author's claude.ai sign-in (Max-plan usage; 0.14 USD is the stream's estimate), 4 turns, at `0f6c505`, after the merge of bite b's verification, with the skill and the descriptions as committed, under the same `env -i`; the same twenty-four user plugins besides `okf-catalog` | `verify.mjs` passed. The model called `catalog`, `search` and `get_page`. The answer cited `spec-example:policies/revenue-recognition.md` with its tier, its verifier and date and its recheck date, said it is not overdue, summarised the page, and said which fact came from the search snippet of a page it did not open. The author's reading: passed | pending |

## The version 0 instruments against a `company:` file

The version 0 runbook's instruments read a `company:` file as a network of one bundle, which answers as version 0 did; the server logs the alias once at start, as a warning, and `pack` notes it on stderr. The author ran each on 2026-10-08, on darwin arm64 with Node 24.15.0, at `45e3ae6` (04:38 to 04:49 UTC) and again at `0f6c505`, after the merge of bite b's verification (04:58 to 05:10 UTC).

| Instrument | Configuration | Outcome |
|---|---|---|
| `ask.mjs --questions bench/acceptance/questions.json` | `company:` with a local source, the `spec-example` fixture | Both runs: 5 of 5 expected pages found, the paraphrases at ranks 3 and 1 by the question's text and 1 by keywords, as version 0 recorded; each expected page's header named its type, status, tier, verifier and recheck date; exit 0 |
| `publish-watch.mjs --until-change --intervals 2 --interval-ms 30000` | `company:` with a repository source, the `published` branch of a local bare repository (`file://`, allowed by `OKF_CATALOG_GIT_PROTOCOLS=file`) polled every 30 s; `spec-example` packed and pushed, then, about 8 s after the server started, a change to `policies/revenue-recognition.md` packed and pushed | Both runs: the first commit served, the second picked up at the first tick, 30 s after the start (`outcome refreshed`), 9 pages admitted before and after; nothing on stderr but the alias's warning; exit 0 |
| `node bench/soak.mjs --cycles 20 --interval 30s` | `company:` with a repository source, a local bare repository, a publish every cycle | First run: 20 cycles, none missed, the page found in every cycle; each change picked up in 29.1 to 30.1 s; resident memory 121 136 KiB at the start and 88 032 KiB at the end (least 87 216, most 124 288); 603.6 s in all. Second run: the same, each change picked up in 29.1 to 30.1 s; resident memory 120 640 KiB at the start and 94 992 KiB at the end (least 91 792, most 131 008); 604.2 s in all. In both, every cycle admitted and indexed 9 pages with 5 degradations and no refusal, and the one warning on stderr was the alias's |

What may be committed for a private bundle is as in version 0: the item, pass or fail, counts, the model id, the dates and the versions; never the questions, the paths, the verifiers or the answers.
