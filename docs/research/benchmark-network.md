# Benchmark: a network of bundles

Written by `node bench/run.mjs --split` on 2026-10-08T08:47:22.748Z, okf-catalog at `fd923398fde7ad98060f718be3fc16f381d5393c`, qmd 2.8.3, Node v24.15.0, darwin arm64. Recorded, not gated: the gate is the one-bundle guard (`bench/expected/lexical-ranks.json`, D66), which this run also held or failed on its own.

What it measures (plan for 0.2 to 0.4, section 3.3, step 8; D-D, D73). SQLite's BM25 counts N, n(q) and avgdl over the whole FTS table, which every collection of one store shares, so a bundle that joins a network moves every other bundle's scores; and a bundle's id is a token of each of its pages' `filepath` (`<id>/<path>`). Two pairings over the four unfiltered lexical configurations at limit 5, the gold page's rank in the first five paired question by question: better, worse or the same. Each corpus folder is loaded as its own bundle, with its own `loadBundle` call and its own catalog; the loads read no manifest, which covers a whole tree and never one folder of it (the public corpus has none).

## Each folder alone against the network

The measurement D-D asks for: the shift it accepts when other bundles join a bundle's index. Each question is asked of its gold page's folder indexed alone, a store of its own holding that bundle only, and of the network, the four folders' bundles in one store: the gold page's rank and score alone are paired with its rank and score among every bundle's pages. The network columns count the questions whose gold rank is better, worse or the same there; the last column counts, of the answers that found the gold page in both runs, those that gave it another score. A score moves for one reason, the statistics the bundles share (the page's `filepath` is `<id>/<path>` in both stores); a rank moves for that reason and a second, which this pairing does not separate: the other bundles' pages compete for the first five.

| Configuration | alone hit@1 | hit@3 | MRR@5 | network hit@1 | hit@3 | MRR@5 | network better | worse | same | gold score changed |
|---|---|---|---|---|---|---|---|---|---|---|
| question/relaxed | 17/25 | 20/25 | 0.75 | 16/25 | 18/25 | 0.68 | 2 | 3 | 20 | 18 of 18 |
| question/strict | 8/25 | 8/25 | 0.32 | 8/25 | 8/25 | 0.32 | 0 | 0 | 25 | 8 of 8 |
| keywords/relaxed | 24/25 | 25/25 | 0.98 | 23/25 | 25/25 | 0.96 | 0 | 1 | 24 | 25 of 25 |
| keywords/strict | 24/25 | 25/25 | 0.98 | 23/25 | 25/25 | 0.96 | 0 | 1 | 24 | 25 of 25 |

The questions whose gold rank moved, alone → network:

- question/relaxed: B3: 2 → 1; B5: 1 → miss; B9: 5 → 2; B14: 2 → miss; B15: 1 → miss
- question/strict: none
- keywords/relaxed: B2: 1 → 2
- keywords/strict: B2: 1 → 2

## The same pages, split

A near no-op by construction, kept as a check that collections change no rank, and not the measurement of a bundle joining. The one-bundle run loads the public corpus as one bundle, `bench`, in one collection; the split run loads each folder as its own bundle, one collection each, in one store. Both stores hold the same pages, so N, n(q) and avgdl are the same but for the `filepath` column, which loses the token `bench` (`bench/<folder>/<path>` becomes `<folder>/<path>`).

| Configuration | one bundle hit@1 | hit@3 | MRR@5 | split hit@1 | hit@3 | MRR@5 | better | worse | same |
|---|---|---|---|---|---|---|---|---|---|
| question/relaxed | 16/25 | 18/25 | 0.68 | 16/25 | 18/25 | 0.68 | 0 | 0 | 25 |
| question/strict | 8/25 | 8/25 | 0.32 | 8/25 | 8/25 | 0.32 | 0 | 0 | 25 |
| keywords/relaxed | 23/25 | 25/25 | 0.96 | 23/25 | 25/25 | 0.96 | 0 | 0 | 25 |
| keywords/strict | 23/25 | 25/25 | 0.96 | 23/25 | 25/25 | 0.96 | 0 | 0 | 25 |

The questions whose gold rank moved, one bundle → split:

- question/relaxed: none
- question/strict: none
- keywords/relaxed: none
- keywords/strict: none

## Bundles

| Bundle | Pages admitted | Documents indexed |
|---|---|---|
| cole-medin | 683 | 683 |
| okf-agent-memory | 23 | 23 |
| okf-docs | 6 | 6 |
| okf-skills | 24 | 24 |

Corpus commits: okf-skills 8e3187875e66051bb52f91a5ed27342e2c3208da, okf-agent-memory 533b63475d42a4796e4c81c25a8121e660e1e416, cole-medin eba5e31bc628280c546d4828491051c308d550dc, superops-okf 88a751032e36300c57af291394ded61ae6db67eb.
