# Retrieval engines compared: qmd and superops okf

Both codebases were read with line citations on 2026-10-06: qmd at release 2.8.3 and at main, superops okf at main `88a7510`. The comparison is why okf-catalog builds on qmd and what the alternative would have cost.

## Component by component

| Component | qmd v2.8.3 | superops okf main |
|---|---|---|
| Unit and chunking | Whole document for lexical; 900-token chunks with 15% overlap for vectors; one result per document | OKF page; chunks at H2 to H4, 1,024 bytes, no overlap; description only in chunk 0 |
| Lexical analysis | FTS5 `porter unicode61`: stemming, case folding, no stopwords; CJK as exact phrases | Hand-written: identifier sub-words, CJK bigrams, no stemming or stopwords |
| Lexical scoring | FTS5 BM25, weights title 4.0, path 1.5, body 1.0; terms ANDed with prefix | In-memory BM25 per query; OR; single field |
| Embeddings | embeddinggemma-300M, 768-d, multilingual, 334 MB; env-swappable; no remote backend | all-MiniLM-L6-v2 int8, 384-d, English-centric, 23 MB; hard-wired at five call sites |
| Vector index | sqlite-vec exact scan; content-hash incremental | HNSW; exact below 2,048; not content-aware, rebuild after edits |
| Query expansion | 1.7B fine-tune writes lex, vec, HyDE sub-queries; skipped when BM25 is confident; bypassed by caller-supplied sub-queries | None |
| Fusion | RRF k=60, original query weighted 2.0, top-rank bonus | RRF k=60, 0.5/0.5, multiplied by chunk-hit count: long pages win; locked by a test and a mutation gate |
| Reranker | Qwen3-Reranker-0.6B, probability, blended by rank, cannot displace the top hit; can be disabled | None; a 23 MB cross-encoder planned in a proposed change |
| Frontmatter | Ignored, including `title:`; namespaced metadata filter merged on main, unreleased | Parsed; filters by type and tag on the substring tool; hybrid path indexes none of type, tags, status |
| Agent-facing MCP | Full pipeline via `query`; `searches` for typed sub-queries | Substring matching; hybrid only on a legacy tool after loading a bundle; the installer's MCP command cannot reach it |
| Evaluation | `qmd bench`: precision, recall, MRR; vector and rerank quality tests skipped in CI | 28 queries over 7 documents; random ranking already scores about 0.71 recall at 5 |
| Footprint | About 2.3 GB of models, Node 22, native SQLite extension | About 63 MB |
| Health | 30k stars, 91 contributors, 14 releases, 198 commits since July | 32 stars, 5 contributors including bots, 1 release, every pull request from the owner |

Gap list for superops to reach qmd-class English retrieval, estimated: route the agent-facing tools through the hybrid pipeline and fix the installer's index path, ~250 lines plus tests; fix the fusion multiplier, ~30 plus tests, reversing a mutation-gated decision; fielded BM25 with boosts, ~150; agent-supplied sub-queries, ~150; a 100-question golden set; the 23 MB MiniLM cross-encoder, 500 to 700; stemming, stopwords and a content-aware index, ~600; remote models, 350 to 450, against their offline stance. Itemised, that is about 760 lines including tests for the 80/20 (routing, fusion fix, sub-queries) and roughly 2,000 lines of code for the full English list before tests and their required change-proposal documents; the earlier figure of 3,500 to 4,000 was an unitemised rounding. All in Go, in a one-maintainer repository or a fork.

## Measured: superops okf on a public corpus

Corpus: 737 OKF pages from okf-skills `.okf/`, okf-agent-memory `knowledge/`, superops `docs/knowledge`, and cole-medin-knowledge-base `concepts/`, `entities/`, `sources/`. 33 questions in the original run, one gold page each, 39% reusing page wording, 61% paraphrased; the 25 that target the public corpus (10 reusing wording, 15 paraphrased) are the ones kept in this repository's `bench/questions.json`.

| Engine | Corpus | hit@1 | hit@3 | MRR@5 | zero-result queries |
|---|---|---|---|---|---|
| superops `okf_query` (substring) | big | 0/25 | 0/25 | 0.000 | 25/25 |
| superops CLI `search` | big | 0/25 | 0/25 | 0.000 | 25/25 |
| superops hybrid `-semantic` | big | 12/25 | 16/25 | 0.580 | 0/25 |

Hybrid by question style on the big corpus: reuse 9/10 hit@1, paraphrase 3/15. Latency per query, one CLI process each: `tool query` substring path 0.10 s median, CLI `search` 0.11 s, hybrid 0.51 s. Index build for 737 pages: 52 s. Runtime and model extracted on first use: 63,367,124 bytes, measured with `du` on the benchmark's `ort` folder. Caveat: the CLI `search` row's zero results were read through the benchmark's parser; a probe showed the command does find single exact keywords and fails on any two-word input, consistent with substring matching, but its raw output for the full questions was not inspected. qmd, IWE and okf-agent-memory have not been measured yet; the lexical-versus-full comparison of qmd is a version 0 item (decision D7).
