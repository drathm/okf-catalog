# Lexical benchmark, bite 3

Run 2026-10-07 on darwin arm64, Node v24.15.0, qmd 2.8.3, okf-catalog commit `b5b7f58` plus the uncommitted bite 3 tree it was run from. Reproduce with `sh bench/fetch-corpus.sh`, `npm run build`, `node bench/run.mjs`; the run writes one JSON line per question per configuration and a summary under `bench/results/` (gitignored).

## Why

Decision D7 makes lexical search the default and records a reservation that qmd's full mode might change results. Decision D31 replaces reciprocal-rank fusion with summed BM25 on the relaxed rung and puts a keyword contract in the tool description. Plan review finding F10 asked for a benchmark that records its run metadata, measures both the question text and its keyword form, and compares the relaxation ladder on and off, paired by question. This is that benchmark. The qmd metadata block runs were deferred until a qmd release reads the block (D30).

## Corpus and questions

Four public OKF bundles at pinned commits, arranged under `bench/corpus/` by `bench/fetch-corpus.sh`:

| Folder | Repository | Commit |
|---|---|---|
| `okf-skills` | scaccogatto/okf-skills (`.okf/`) | `8e3187875e66` |
| `okf-agent-memory` | okf-memory/okf-agent-memory (`knowledge/`) | `533b63475d42` |
| `cole-medin` | coleam00/cole-medin-knowledge-base (`concepts/`, `entities/`, `sources/`) | `eba5e31bc628` |
| `superops-okf` | superops-team/okf (`docs/knowledge/`, served as `okf-docs/`) | `88a751032e36` |

The walker found 757 files; with drafts admitted and integrity off, 736 pages were admitted and 1 file was refused. All 25 gold pages of the 25 questions in `bench/questions.json` are admitted. Ten questions reuse the page's own words (`reuse`), fifteen paraphrase it (`paraphrase`). Each question also carries a keyword form, three terms a reader who knows the page would type. The questions were written by the author of the system against pages chosen by reading the corpus, so they are a smoke test of the ranking, not an unbiased sample of what users ask.

## Method

Every question runs in four configurations: the question text or its keyword form, with the relaxed rung on or off. `limit` is 5, overdue pages are included, and the clock is pinned to 2026-10-06T12:00:00.000Z. The gold page's rank in the five hits gives hit@1, hit@3 and MRR@5 (a miss contributes 0). The paired table counts, per question, whether relaxation moved the gold page's rank up, down or not at all; a miss ranks as 99.

## Results

| Configuration | hit@1 | hit@3 | MRR@5 |
|---|---|---|---|
| question/relaxed | 17/25 | 19/25 | 0.72 |
| question/strict | 8/25 | 8/25 | 0.32 |
| keywords/relaxed | 23/25 | 25/25 | 0.96 |
| keywords/strict | 23/25 | 25/25 | 0.96 |

By question style:

| Configuration | reuse hit@1 | reuse hit@3 | reuse MRR@5 | paraphrase hit@1 | paraphrase hit@3 | paraphrase MRR@5 |
|---|---|---|---|---|---|---|
| question/relaxed | 9/10 | 9/10 | 0.90 | 8/15 | 10/15 | 0.60 |
| question/strict | 6/10 | 6/10 | 0.60 | 2/15 | 2/15 | 0.13 |
| keywords/relaxed | 9/10 | 10/10 | 0.95 | 14/15 | 15/15 | 0.97 |
| keywords/strict | 9/10 | 10/10 | 0.95 | 14/15 | 15/15 | 0.97 |

Relaxation paired by question:

| Form | relaxed better | relaxed worse | same |
|---|---|---|---|
| question | 11 | 0 | 14 |
| keywords | 0 | 0 | 25 |

Reading: with keywords, the all-terms rung answers every question and relaxation never runs, so the two keyword rows are identical. With the question text, the all-terms rung alone answers eight of twenty-five; relaxation lifts that to seventeen at the top and nineteen in the top three, and never pushes a gold page down. The paraphrase rows are the reservation in D7 made concrete: lexical search over a paraphrase finds the page at the top about half the time.

## Where the gold page was not first

| Configuration | Question | Style | Gold rank | Rung | Terms sent | First hit |
|---|---|---|---|---|---|---|
| question/relaxed | B5 | paraphrase | miss | relaxed | experiment status staleness fields stop agent repeating outdated facts telling model prefer | `cole-medin/concepts/ai-coding-limitations.md` |
| question/relaxed | B9 | paraphrase | 2 | all-terms | project vendored dependency define concept id one wins | `cole-medin/entities/people/cole-medin.md` |
| question/relaxed | B11 | paraphrase | miss | relaxed | two notes tie relevance memory search decide comes first | `cole-medin/concepts/cloud-gpu-hosting.md` |
| question/relaxed | B14 | paraphrase | miss | relaxed | happens agent saves note twice retry key changed text | `cole-medin/concepts/commandify-everything.md` |
| question/relaxed | B15 | paraphrase | miss | relaxed | single okf mcp server process speak old new revision spec | `cole-medin/entities/tools/fastmcp.md` |
| question/relaxed | B17 | paraphrase | miss | relaxed | locally hosted model forget earlier messages skip tool calls default settings room | `cole-medin/concepts/local-llms-as-agents.md` |
| question/relaxed | B22 | reuse | miss | all-terms | video covers stripe coding agents ship 300 prs week | `cole-medin/entities/organizations/aws.md` |
| question/relaxed | B24 | paraphrase | 2 | relaxed | way vectorize entire file cutting pieces piece remembers rest said | `cole-medin/concepts/ai-tech-stack.md` |
| question/strict | B1 | reuse | miss | none | conditions hold okf-stop-check sh blocks agent finishing | `` |
| question/strict | B2 | paraphrase | miss | none | graph viewer switch away default force layout knowledge base large | `` |
| question/strict | B3 | paraphrase | miss | none | two plugin versions bumped published releases changed cannot happen | `` |
| question/strict | B5 | paraphrase | miss | none | experiment status staleness fields stop agent repeating outdated facts telling model prefer | `` |
| question/strict | B6 | paraphrase | miss | none | rebuilding knowledge base git history much grouping small events one analyzer call | `` |
| question/strict | B7 | reuse | miss | none | governance levels constraint hold context mean agent editing code | `` |
| question/strict | B9 | paraphrase | miss | all-terms | project vendored dependency define concept id one wins | `cole-medin/entities/people/cole-medin.md` |
| question/strict | B10 | reuse | miss | none | ai agents allowed run git tag push release procedure | `` |
| question/strict | B11 | paraphrase | miss | none | two notes tie relevance memory search decide comes first | `` |
| question/strict | B12 | paraphrase | miss | none | two-layer memory model agents large always-loaded instruction file | `` |
| question/strict | B14 | paraphrase | miss | none | happens agent saves note twice retry key changed text | `` |
| question/strict | B15 | paraphrase | miss | none | single okf mcp server process speak old new revision spec | `` |
| question/strict | B17 | paraphrase | miss | none | locally hosted model forget earlier messages skip tool calls default settings room | `` |
| question/strict | B18 | paraphrase | miss | none | wipe document old pieces vector database uploading new version | `` |
| question/strict | B22 | reuse | miss | all-terms | video covers stripe coding agents ship 300 prs week | `cole-medin/entities/organizations/aws.md` |
| question/strict | B24 | paraphrase | miss | none | way vectorize entire file cutting pieces piece remembers rest said | `` |
| question/strict | B25 | paraphrase | miss | none | video agent harness running whole day straight recreate anthropic chat website share | `` |
| keywords/relaxed | B2 | paraphrase | 2 | all-terms | concentric cose 000 concepts | `okf-skills/components/visualizer.md` |
| keywords/relaxed | B22 | reuse | 2 | all-terms | stripe minions 300 | `cole-medin/entities/tools/stripe-minions.md` |
| keywords/strict | B2 | paraphrase | 2 | all-terms | concentric cose 000 concepts | `okf-skills/components/visualizer.md` |
| keywords/strict | B22 | reuse | 2 | all-terms | stripe minions 300 | `cole-medin/entities/tools/stripe-minions.md` |

Observations. The paraphrase misses share two or fewer content terms with their page, which no lexical ranking can recover. B22's question form is answered by the all-terms rung with a long entity page that happens to contain every term as a prefix, so relaxation never runs for it. The keyword form of B2 ranks second because the tokenizer reads `1,000` as `1` (dropped, one character) and `000`; thousands separators are an open tokenizer question for the reviewers. In the relaxed rung each term's pool is the first rung's pool (20 rows here); in 119 of the 214 question-term pairs that pool was full without the gold page, so a larger per-term pool is the first tuning to measure (D31).

## Determinism

The first two runs of this benchmark disagreed on one question (B25: rank 1, then a miss). Three fresh indexes of the same corpus answered it two ways. The cause is in qmd: its lexical query orders by `bm25_score` alone (`store.js`, `ORDER BY bm25_score ASC LIMIT ?`), rows with equal scores come back in insertion order, and insertion order follows `fastGlob`'s traversal, which is not sorted. A pool that cut inside a group of equal scores therefore depended on the index build. The search policy now completes the tie group at every engine cut: it asks for one row beyond the pool, and when that row ties with the cut it widens the request until a lower score is seen, the engine runs out, or the cap is reached (`lexComplete` in `src/search/search.ts`). After the change three consecutive runs produced byte-identical summaries and three fresh indexes agreed on every question and score.

## Cost

| Measure | Value |
|---|---|
| Index time, 736 pages | 662 ms |
| Database size, 736 pages | 10.8 MiB |
| Documents not indexed | 0 |
| Process RSS after the run | 413 MiB (walked files, catalog and qmd store all resident) |
| Query latency, question/relaxed | median 11.5 ms, max 24.8 ms |
| Query latency, question/strict | median 0.3 ms, max 1.6 ms |
| Query latency, keywords/relaxed | median 2.5 ms, max 13.4 ms |
| Query latency, keywords/strict | median 0.3 ms, max 1.1 ms |

Fixtures, for the record:

| Fixture | Pages | Index time | Database |
|---|---|---|---|
| `behaviours` | 19 | 16 ms | 124 KiB |
| `spec-example` | 9 | 7 ms | 188 KiB |
| `no-manifest` | 1 | 2 ms | 120 KiB |
| `refused` | 1 | 2 ms | 120 KiB |

The SQLite file has a floor of about 120 KiB regardless of content.

## What this does not show

No comparison with qmd's full mode (bite 6, with approval for the model download), so D7's reservation stays open. Twenty-five questions over one corpus of 736 pages, written by the system's author. The keyword form uses terms chosen with the page in view, so its numbers are an upper bound on what a reader who already knows the page can do. The metadata block (D30) is not measured until a qmd release reads it.
