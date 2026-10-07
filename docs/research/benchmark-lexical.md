# Lexical benchmark, bite 3

Run 2026-10-07 on darwin arm64, Node v24.15.0, qmd 2.8.3, okf-catalog commit `02cba7c` with uncommitted changes (diff hash `0b442d7b68f4`). Reproduce with `sh bench/fetch-corpus.sh`, `npm run build`, `node bench/run.mjs`, then `node bench/report.mjs` to regenerate this note. The run writes one JSON line per question per configuration and a summary under `bench/results/` (gitignored).

## Why

Decision D7 makes lexical search the default and records a reservation that qmd's full mode might change results. Decision D25 pushes the type and topic filters into the query and widens the pool while the filters leave it short. Decision D31 replaces reciprocal-rank fusion with summed BM25 on the relaxed rung and puts a keyword contract in the tool description. Plan review finding F10 asked for a benchmark that records its run metadata, measures both the question text and its keyword form, and compares the relaxation ladder on and off, paired by question; the build review added the filter configurations and a larger relaxed pool. The qmd metadata block runs were deferred until a qmd release reads the block (D30).

## Corpus and questions

Four public OKF bundles at pinned commits, arranged under `bench/corpus/` by `bench/fetch-corpus.sh`:

| Folder | Repository | Commit | Files walked | Pages admitted | Questions |
|---|---|---|---|---|---|
| `okf-skills` | scaccogatto/okf-skills (`.okf/`) | `8e3187875e66` | 30 | 24 | 6 |
| `okf-agent-memory` | okf-memory/okf-agent-memory (`knowledge/`) | `533b63475d42` | 30 | 23 | 6 |
| `cole-medin` | coleam00/cole-medin-knowledge-base (`concepts/`, `entities/`, `sources/`) | `eba5e31bc628` | 689 | 683 | 10 |
| `okf-docs` | superops-team/okf (`docs/knowledge/`, served as `okf-docs/`) | `88a751032e36` | 8 | 6 | 3 |

The walker found 757 files; with drafts admitted and integrity off, 736 pages were admitted and 1 file was refused. 93% of the admitted pages come from one bundle (`cole-medin`), so the corpus is mostly that bundle's vocabulary and the wrong first hits below are mostly its pages. All 25 gold pages of the 25 questions in `bench/questions.json` are admitted. Ten questions reuse the page's own words (`reuse`), fifteen paraphrase it (`paraphrase`). Each question also carries a keyword form, three terms a reader who knows the page would type. The questions were written by the author of the system against pages chosen by reading the corpus, so they are a smoke test of the ranking, not an unbiased sample of what users ask.

## Method

Every question runs in seven configurations: the question text or its keyword form with the relaxed rung on or off; and the question text with the gold page's own folder as the topic filter, with its type as the type filter, and with a relaxed per-term pool of 100 instead of the first rung's pool. `limit` is 5, overdue pages are included, and the clock is pinned to 2026-10-06T12:00:00.000Z. The gold page's rank in the five hits gives hit@1, hit@3 and MRR@5 (a miss contributes 0). The paired tables count, per question, whether the first configuration moved the gold page's rank up, down or not at all against the second; a miss ranks as 99. The filter configurations use the gold page's own folder and type, which a real caller does not know; they measure what the filters do to the ranking (D25), not how often a caller would guess them.

## Results

| Configuration | hit@1 | hit@3 | MRR@5 |
|---|---|---|---|
| question/relaxed | 16/25 | 18/25 | 0.68 |
| question/strict | 8/25 | 8/25 | 0.32 |
| keywords/relaxed | 23/25 | 25/25 | 0.96 |
| keywords/strict | 23/25 | 25/25 | 0.96 |
| question/relaxed+topic | 19/25 | 23/25 | 0.85 |
| question/relaxed+type | 19/25 | 22/25 | 0.85 |
| question/relaxed+pool100 | 16/25 | 20/25 | 0.71 |

By question style:

| Configuration | reuse hit@1 | reuse hit@3 | reuse MRR@5 | paraphrase hit@1 | paraphrase hit@3 | paraphrase MRR@5 |
|---|---|---|---|---|---|---|
| question/relaxed | 9/10 | 9/10 | 0.90 | 7/15 | 9/15 | 0.53 |
| question/strict | 6/10 | 6/10 | 0.60 | 2/15 | 2/15 | 0.13 |
| keywords/relaxed | 9/10 | 10/10 | 0.95 | 14/15 | 15/15 | 0.97 |
| keywords/strict | 9/10 | 10/10 | 0.95 | 14/15 | 15/15 | 0.97 |
| question/relaxed+topic | 9/10 | 10/10 | 0.95 | 10/15 | 13/15 | 0.78 |
| question/relaxed+type | 9/10 | 10/10 | 0.95 | 10/15 | 12/15 | 0.78 |
| question/relaxed+pool100 | 9/10 | 9/10 | 0.90 | 7/15 | 11/15 | 0.58 |

Paired by question:

| Comparison | first better | first worse | same |
|---|---|---|---|
| question: relaxed vs strict | 10 | 0 | 15 |
| keywords: relaxed vs strict | 0 | 0 | 25 |
| question: topic filter vs none | 8 | 0 | 17 |
| question: type filter vs none | 8 | 0 | 17 |
| question: relaxed pool 100 vs the first rung's pool | 3 | 3 | 19 |

Reading. With keywords, the all-terms rung puts the gold page in place for every question; relaxation only appends hits after the first rung's, so it cannot move a gold page the first rung found, and the two keyword rows are identical. For the same reason the relaxed-versus-strict pairing cannot show a loss: it measures what relaxation adds, not a trade. With the question text, the all-terms rung alone puts the gold page first eight times in twenty-five; relaxation lifts that to sixteen at the top and eighteen in the top three, improving ten questions and worsening zero. The paraphrase rows are the reservation in D7 made concrete: lexical search over a paraphrase finds the page at the top 7 times in 15. The topic filter changes eight questions (eight better, zero worse) and the type filter eight (eight better, zero worse); a relaxed pool of 100 changes six (three better, three worse) against the first rung's pool of 20.

## Where the gold page was not first

| Configuration | Question | Style | Gold rank | Rung | Terms sent | First hit |
|---|---|---|---|---|---|---|
| question/relaxed | B5 | paraphrase | miss | relaxed | experiment status staleness fields stop agent repeating outdated facts telling model prefer | `cole-medin/concepts/ai-coding-limitations.md` |
| question/relaxed | B9 | paraphrase | 2 | all-terms | project vendored dependency define concept id one wins | `cole-medin/entities/people/cole-medin.md` |
| question/relaxed | B11 | paraphrase | miss | relaxed | two notes tie relevance memory search decide comes first | `cole-medin/concepts/cloud-gpu-hosting.md` |
| question/relaxed | B14 | paraphrase | miss | relaxed | happens agent saves note twice retry key changed text | `cole-medin/concepts/commandify-everything.md` |
| question/relaxed | B15 | paraphrase | miss | relaxed | single okf mcp server process speak old new revision spec | `cole-medin/entities/tools/fastmcp.md` |
| question/relaxed | B17 | paraphrase | miss | relaxed | locally hosted model forget earlier messages skip tool calls default settings room | `cole-medin/concepts/context-window-limits.md` |
| question/relaxed | B22 | reuse | miss | all-terms | video covers stripe coding agents ship 300 prs week | `cole-medin/entities/organizations/aws.md` |
| question/relaxed | B24 | paraphrase | 2 | relaxed | way vectorize entire file cutting pieces piece remembers rest said | `cole-medin/concepts/ai-tech-stack.md` |
| question/relaxed | B25 | paraphrase | miss | relaxed | video agent harness running whole day straight recreate anthropic chat website share | `cole-medin/sources/claude-skills-arent-just-for-claude-heres-how-to-build-them-for-any-agent.md` |
| question/strict | B1 | reuse | miss | none | conditions hold okf-stop-check sh blocks agent finishing | (no hits) |
| question/strict | B2 | paraphrase | miss | none | graph viewer switch away default force layout knowledge base large | (no hits) |
| question/strict | B3 | paraphrase | miss | none | two plugin versions bumped published releases changed cannot happen | (no hits) |
| question/strict | B5 | paraphrase | miss | none | experiment status staleness fields stop agent repeating outdated facts telling model prefer | (no hits) |
| question/strict | B6 | paraphrase | miss | none | rebuilding knowledge base git history much grouping small events one analyzer call | (no hits) |
| question/strict | B7 | reuse | miss | none | governance levels constraint hold context mean agent editing code | (no hits) |
| question/strict | B9 | paraphrase | miss | all-terms | project vendored dependency define concept id one wins | `cole-medin/entities/people/cole-medin.md` |
| question/strict | B10 | reuse | miss | none | ai agents allowed run git tag push release procedure | (no hits) |
| question/strict | B11 | paraphrase | miss | none | two notes tie relevance memory search decide comes first | (no hits) |
| question/strict | B12 | paraphrase | miss | none | two-layer memory model agents large always-loaded instruction file | (no hits) |
| question/strict | B14 | paraphrase | miss | none | happens agent saves note twice retry key changed text | (no hits) |
| question/strict | B15 | paraphrase | miss | none | single okf mcp server process speak old new revision spec | (no hits) |
| question/strict | B17 | paraphrase | miss | none | locally hosted model forget earlier messages skip tool calls default settings room | (no hits) |
| question/strict | B18 | paraphrase | miss | none | wipe document old pieces vector database uploading new version | (no hits) |
| question/strict | B22 | reuse | miss | all-terms | video covers stripe coding agents ship 300 prs week | `cole-medin/entities/organizations/aws.md` |
| question/strict | B24 | paraphrase | miss | none | way vectorize entire file cutting pieces piece remembers rest said | (no hits) |
| question/strict | B25 | paraphrase | miss | none | video agent harness running whole day straight recreate anthropic chat website share | (no hits) |
| keywords/relaxed | B2 | paraphrase | 2 | all-terms | concentric cose 000 concepts | `okf-skills/components/visualizer.md` |
| keywords/relaxed | B22 | reuse | 2 | all-terms | stripe minions 300 | `cole-medin/entities/tools/stripe-minions.md` |
| keywords/strict | B2 | paraphrase | 2 | all-terms | concentric cose 000 concepts | `okf-skills/components/visualizer.md` |
| keywords/strict | B22 | reuse | 2 | all-terms | stripe minions 300 | `cole-medin/entities/tools/stripe-minions.md` |
| question/relaxed+topic | B11 | paraphrase | 3 | relaxed | two notes tie relevance memory search decide comes first | `okf-agent-memory/architecture/layers.md` |
| question/relaxed+topic | B14 | paraphrase | 2 | relaxed | happens agent saves note twice retry key changed text | `okf-docs/cli.md` |
| question/relaxed+topic | B17 | paraphrase | 5 | relaxed | locally hosted model forget earlier messages skip tool calls default settings room | `cole-medin/concepts/context-window-limits.md` |
| question/relaxed+topic | B22 | reuse | 2 | all-terms | video covers stripe coding agents ship 300 prs week | `cole-medin/sources/the-next-evolution-of-ai-coding-is-harnesses-heres-how-to-build-them.md` |
| question/relaxed+topic | B24 | paraphrase | 2 | relaxed | way vectorize entire file cutting pieces piece remembers rest said | `cole-medin/concepts/ai-tech-stack.md` |
| question/relaxed+topic | B25 | paraphrase | 5 | relaxed | video agent harness running whole day straight recreate anthropic chat website share | `cole-medin/sources/claude-skills-arent-just-for-claude-heres-how-to-build-them-for-any-agent.md` |
| question/relaxed+type | B11 | paraphrase | 4 | relaxed | two notes tie relevance memory search decide comes first | `okf-skills/decisions/map-phase-routing.md` |
| question/relaxed+type | B14 | paraphrase | 2 | relaxed | happens agent saves note twice retry key changed text | `okf-docs/cli.md` |
| question/relaxed+type | B17 | paraphrase | 5 | relaxed | locally hosted model forget earlier messages skip tool calls default settings room | `cole-medin/concepts/context-window-limits.md` |
| question/relaxed+type | B22 | reuse | 2 | all-terms | video covers stripe coding agents ship 300 prs week | `cole-medin/sources/the-next-evolution-of-ai-coding-is-harnesses-heres-how-to-build-them.md` |
| question/relaxed+type | B24 | paraphrase | 2 | relaxed | way vectorize entire file cutting pieces piece remembers rest said | `cole-medin/concepts/ai-tech-stack.md` |
| question/relaxed+type | B25 | paraphrase | 5 | relaxed | video agent harness running whole day straight recreate anthropic chat website share | `cole-medin/sources/claude-skills-arent-just-for-claude-heres-how-to-build-them-for-any-agent.md` |
| question/relaxed+pool100 | B3 | paraphrase | 2 | relaxed | two plugin versions bumped published releases changed cannot happen | `okf-skills/components/ci-workflow.md` |
| question/relaxed+pool100 | B9 | paraphrase | 3 | all-terms | project vendored dependency define concept id one wins | `cole-medin/entities/people/cole-medin.md` |
| question/relaxed+pool100 | B11 | paraphrase | miss | relaxed | two notes tie relevance memory search decide comes first | `okf-agent-memory/architecture/layers.md` |
| question/relaxed+pool100 | B12 | paraphrase | 3 | relaxed | two-layer memory model agents large always-loaded instruction file | `cole-medin/concepts/self-evolving-memory.md` |
| question/relaxed+pool100 | B14 | paraphrase | miss | relaxed | happens agent saves note twice retry key changed text | `cole-medin/sources/no-code-rag-agents-you-have-to-check-out-n8n-langchain.md` |
| question/relaxed+pool100 | B15 | paraphrase | 2 | relaxed | single okf mcp server process speak old new revision spec | `cole-medin/entities/tools/windsurf.md` |
| question/relaxed+pool100 | B17 | paraphrase | miss | relaxed | locally hosted model forget earlier messages skip tool calls default settings room | `cole-medin/concepts/context-window-limits.md` |
| question/relaxed+pool100 | B22 | reuse | miss | all-terms | video covers stripe coding agents ship 300 prs week | `cole-medin/entities/organizations/aws.md` |
| question/relaxed+pool100 | B25 | paraphrase | miss | relaxed | video agent harness running whole day straight recreate anthropic chat website share | `cole-medin/concepts/chat-interfaces.md` |

Observations. The paraphrase misses share two or fewer content terms with their page, which no lexical ranking can recover. B22's question form is answered by the all-terms rung with a long entity page that happens to contain every term as a prefix, so relaxation never runs for it. The keyword form of B2 sends `concentric cose 000 concepts`: the tokenizer splits `1,000` into `1` (dropped, one character) and `000`, which is exactly how the engine's FTS5 tokenizer indexes it (a query token `1000` matches nothing, probed against qmd 2.8.3), so the split is kept. The relaxed per-term pool is the first rung's pool by default; the pool-100 row above measures the first alternative.

## Determinism

The first two runs of this benchmark disagreed on one question (B25: rank 1, then a miss). Three fresh indexes of the same corpus answered it two ways. The cause is in qmd: its lexical query orders by `bm25_score` alone (`store.js`, `ORDER BY bm25_score ASC LIMIT ?`), rows with equal scores come back in insertion order, and insertion order follows `fastGlob`'s traversal, which is not sorted. A pool that cut inside a group of equal scores therefore depended on the index build. The search policy now completes the tie group at every engine cut: it asks for one row beyond the pool, and when that row ties with the cut it widens the request until a lower score is seen, the engine runs out, or the cap is reached (`lexComplete` in `src/search/search.ts`). After the change three consecutive runs produced identical ranks, scores and paired outcomes (only timings and sizes differ) and three fresh indexes agreed on every question and score.

## Cost

| Measure | Value |
|---|---|
| Index time, 736 pages | 712 ms |
| Database size, 736 pages | 10.7 MiB |
| Documents not indexed | 0 (0 by path collision) |
| Process RSS after the run | 1116 MiB (walked files, catalog and qmd store all resident) |
| Query latency, question/relaxed | median 10.3 ms, max 27.8 ms |
| Query latency, question/strict | median 0.4 ms, max 3.4 ms |
| Query latency, keywords/relaxed | median 2.3 ms, max 12.1 ms |
| Query latency, keywords/strict | median 0.3 ms, max 1.4 ms |
| Query latency, question/relaxed+topic | median 12.1 ms, max 27.2 ms |
| Query latency, question/relaxed+type | median 10.6 ms, max 26.5 ms |
| Query latency, question/relaxed+pool100 | median 45.4 ms, max 104.9 ms |
| Rows fetched per search, question/relaxed | median 210, max 515 (every row carries its page body) |
| Rows fetched per search, question/strict | median 0, max 21 (every row carries its page body) |
| Rows fetched per search, keywords/relaxed | median 45, max 250 (every row carries its page body) |
| Rows fetched per search, keywords/strict | median 2, max 21 (every row carries its page body) |
| Rows fetched per search, question/relaxed+topic | median 212, max 515 (every row carries its page body) |
| Rows fetched per search, question/relaxed+type | median 212, max 515 (every row carries its page body) |
| Rows fetched per search, question/relaxed+pool100 | median 937, max 2445 (every row carries its page body) |
| Questions with a term at the frequency floor (question/relaxed) | 16 of 25 |

Fixtures, for the record (measured once on the same machine):

| Fixture | Pages | Index time | Database |
|---|---|---|---|
| `behaviours` | 19 | 16 ms | 124 KiB |
| `spec-example` | 9 | 7 ms | 188 KiB |
| `no-manifest` | 1 | 2 ms | 120 KiB |
| `refused` | 1 | 2 ms | 120 KiB |

The SQLite file has a floor of about 120 KiB regardless of content.

## What this does not show

No comparison with qmd's full mode (bite 6, with approval for the model download), so D7's reservation stays open. Twenty-five questions over one corpus, nine tenths of it one bundle, written by the system's author. The keyword form uses terms chosen with the page in view, so its numbers are an upper bound on what a reader who already knows the page can do. The filter rows use the gold page's own folder and type. The metadata block (D30) is not measured until a qmd release reads it.
