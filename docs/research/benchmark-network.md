# Benchmark: a network of bundles

Written by `node bench/run.mjs --split` on 2026-10-08T04:57:31.560Z, okf-catalog at `0f6c505d78ab63a986396ab7bb9236120c640403`, qmd 2.8.3, Node v24.15.0, darwin arm64. Recorded, not gated: the gate is the one-bundle guard (`bench/expected/lexical-ranks.json`, D66), which this run also held or failed on its own.

What it measures (plan for 0.2 to 0.4, section 3.3, step 8; D-D, D73). The one-bundle run loads the public corpus as one bundle, `bench`, in one qmd collection. The split run loads each top-level folder of the corpus as its own bundle, with its own `loadBundle` call and its own catalog, one collection each, in one index: the shape of a network. Both run the four unfiltered lexical configurations at limit 5, question by question, and the gold page's rank in the first five is paired: better, worse or the same. The split loads read no manifest, which covers a whole tree and never one folder of it; the public corpus has none, so both runs read the same pages. A shift is expected: SQLite's BM25 counts N, n(q) and avgdl over the whole FTS table, which every collection shares, and a bundle's id is a token of each of its pages' `filepath` (`<id>/<path>`), where the one-bundle run had `bench/<folder>/<path>`.

## Bundles

| Bundle | Pages admitted | Documents indexed |
|---|---|---|
| cole-medin | 683 | 683 |
| okf-agent-memory | 23 | 23 |
| okf-docs | 6 | 6 |
| okf-skills | 24 | 24 |

## The four unfiltered configurations

| Configuration | one bundle hit@1 | hit@3 | MRR@5 | split hit@1 | hit@3 | MRR@5 | better | worse | same |
|---|---|---|---|---|---|---|---|---|---|
| question/relaxed | 16/25 | 18/25 | 0.68 | 16/25 | 18/25 | 0.68 | 0 | 0 | 25 |
| question/strict | 8/25 | 8/25 | 0.32 | 8/25 | 8/25 | 0.32 | 0 | 0 | 25 |
| keywords/relaxed | 23/25 | 25/25 | 0.96 | 23/25 | 25/25 | 0.96 | 0 | 0 | 25 |
| keywords/strict | 23/25 | 25/25 | 0.96 | 23/25 | 25/25 | 0.96 | 0 | 0 | 25 |

## The questions whose gold rank moved

- question/relaxed: none
- question/strict: none
- keywords/relaxed: none
- keywords/strict: none

Corpus commits: okf-skills unknown, okf-agent-memory unknown, cole-medin unknown, superops-okf unknown.
