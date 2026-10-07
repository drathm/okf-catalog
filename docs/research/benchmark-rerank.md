# The ladder re-ranked, bite 7

Run 2026-10-07 on darwin arm64, Node v24.15.0, qmd 2.8.3, node-llama-cpp 3.20.0, okf-catalog commit `72b71de` (clean tree).

## Why

Bite 6 compared the production lexical ladder with qmd's vector, fused, hybrid and full modes and left D7's reservation narrowed but open. It never measured the cheapest middle option: the ladder's own twenty candidates re-ranked by the reranker model alone, with no embedding index and no expansion model. This note is that measurement. Its bar was written before the run (`docs/plans/version-0-progress.md`, bite 7 plan, revised), and the run is a separate process from bite 6's, whose note stands as it was.

## Method

For each of the 25 questions, in two forms (the question text and the keyword string, production's input), the ladder's list twenty deep (`question/relaxed@20`, `keywords/relaxed@20`) is handed to qmd's reranker as qmd's own pipeline hands it: one chunk per candidate, cut by qmd's chunker from the derived document as indexed (chunks of at most 3600 characters), the chunk with the most query terms longer than two characters, and the reranker's own token budget (context 4096 tokens, 4 contexts). qmd's cache is emptied before every pass, so every pass is a real scoring pass; the run fails when a candidate comes back unscored or every score is alike. From one pass two orders are reported: `rerank` (the raw score, ties in ladder order) and `rerank-blend` (qmd's Step 7 rule over the ladder's positions, weights 0.75, 0.60 and 0.40 by rank band, which cannot displace the ladder's first result). The rank is the gold page's position in the top five; the controls are the same lists cut to five, D51's anchor `question/relaxed`, and the production limit (`@8`). 2 sample(s), the cache emptied between them.

## Results

| List or order | samples | hit@1 | hit@3 | MRR@5 |
|---|---|---|---|---|
| question/relaxed (lexical) | 1 | 16/25 | 18/25 | 0.68 |
| question/relaxed@8 (lexical) | 1 | 16/25 | 18/25 | 0.69 |
| question/relaxed@20 (lexical) | 1 | 17/25 | 20/25 | 0.73 |
| keywords/relaxed (lexical) | 1 | 23/25 | 25/25 | 0.96 |
| keywords/relaxed@8 (lexical) | 1 | 23/25 | 25/25 | 0.96 |
| keywords/relaxed@20 (lexical) | 1 | 23/25 | 25/25 | 0.96 |
| rerank-blend/keywords | 2 | 23 | 25 | 0.96 |
| rerank-blend/question | 2 | 17 | 21 | 0.76 |
| rerank/keywords | 2 | 23 | 25 | 0.95 |
| rerank/question | 2 | 19 | 20 | 0.80 |

Ceiling, question form: the gold page is among the twenty candidates for 22 of 25 questions (its positions in ladder order: 1, 1, 2, 1, 1, 1, 1, 1, 2, 1, none, 3, 1, none, 1, 1, none, 1, 1, 1, 1, 9, 1, 1, 8); no re-ranking of this list can lift hit@1 above 22.

Ceiling, keywords form: the gold page is among the twenty candidates for 25 of 25 questions (its positions in ladder order: 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1); no re-ranking of this list can lift hit@1 above 25.

### Per question, question form, sample 1

| Question | style | ladder @20, cut to five | ladder @8, cut to five | rerank | rerank-blend | gold at | gold score | top score | gold chunk (index of count, chars) | ms |
|---|---|---|---|---|---|---|---|---|---|---|
| B1 | reuse | 1 | 1 | 1 | 1 | 1 | 0.99976 | 0.99976 | 1 of 2, 2979 | 4749.8 |
| B2 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99918 | 0.99918 | 1 of 1, 1681 | 3899.6 |
| B3 | paraphrase | 2 | 1 | 1 | 2 | 2 | 0.99985 | 0.99985 | 1 of 1, 2018 | 3734.2 |
| B4 | reuse | 1 | 1 | 1 | 1 | 1 | 0.99992 | 0.99992 | 1 of 1, 2853 | 2981.9 |
| B5 | paraphrase | 1 | 5 | 1 | 1 | 1 | 0.99954 | 0.99954 | 1 of 2, 3345 | 3490.6 |
| B6 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99812 | 0.99812 | 1 of 2, 3029 | 3465.3 |
| B7 | reuse | 1 | 1 | 1 | 1 | 1 | 0.99994 | 0.99994 | 1 of 2, 3445 | 3703 |
| B8 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99482 | 0.99482 | 1 of 2, 3031 | 3806.1 |
| B9 | paraphrase | 2 | 2 | 1 | 2 | 2 | 0.99468 | 0.99468 | 1 of 3, 3033 | 3858.7 |
| B10 | reuse | 1 | 1 | 1 | 1 | 1 | 0.99938 | 0.99938 | 1 of 2, 3501 | 3879 |
| B11 | paraphrase | none | none | none | none | none | – | 0.07683 | – | 3934.9 |
| B12 | paraphrase | 3 | 1 | 1 | 2 | 3 | 0.99841 | 0.99841 | 1 of 2, 2961 | 3848.5 |
| B13 | reuse | 1 | 1 | 1 | 1 | 1 | 0.99934 | 0.99934 | 1 of 2, 3506 | 4196.3 |
| B14 | paraphrase | none | none | none | none | none | – | 0.00991 | – | 4219.8 |
| B15 | paraphrase | 1 | none | 1 | 1 | 1 | 0.99894 | 0.99894 | 1 of 4, 3476 | 3872 |
| B16 | reuse | 1 | 1 | 1 | 1 | 1 | 0.99962 | 0.99962 | 1 of 1, 2992 | 3834.8 |
| B17 | paraphrase | none | none | none | none | none | – | 0.99672 | – | 4485 |
| B18 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99972 | 0.99972 | 1 of 3, 3366 | 4192 |
| B19 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99972 | 0.99972 | 1 of 2, 3262 | 4835.6 |
| B20 | reuse | 1 | 1 | 2 | 1 | 1 | 0.99143 | 0.99560 | 3 of 4, 3367 | 4379.7 |
| B21 | reuse | 1 | 1 | 5 | 1 | 1 | 0.99880 | 0.99974 | 1 of 2, 3363 | 5124.1 |
| B22 | reuse | none | none | 5 | none | 9 | 0.99801 | 0.99942 | 1 of 2, 3522 | 5161.6 |
| B23 | reuse | 1 | 1 | 1 | 1 | 1 | 0.99919 | 0.99919 | 1 of 2, 3543 | 5599.8 |
| B24 | paraphrase | 1 | 2 | 1 | 1 | 1 | 0.98283 | 0.98283 | 1 of 1, 2808 | 5706.1 |
| B25 | paraphrase | none | none | 1 | 2 | 8 | 0.99893 | 0.99893 | 1 of 2, 3281 | 5591.4 |

### Per question, keywords form, sample 1

| Question | style | ladder @20, cut to five | ladder @8, cut to five | rerank | rerank-blend | gold at | gold score | top score | gold chunk (index of count, chars) | ms |
|---|---|---|---|---|---|---|---|---|---|---|
| B1 | reuse | 1 | 1 | 1 | 1 | 1 | 0.99994 | 0.99994 | 1 of 2, 2979 | 3582.9 |
| B2 | paraphrase | 2 | 2 | 1 | 2 | 2 | 0.99856 | 0.99856 | 1 of 1, 1681 | 4181 |
| B3 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99988 | 0.99988 | 1 of 1, 2018 | 3384 |
| B4 | reuse | 1 | 1 | 1 | 1 | 1 | 0.99998 | 0.99998 | 1 of 1, 2853 | 2846.2 |
| B5 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99449 | 0.99449 | 1 of 2, 3345 | 3338.1 |
| B6 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.98334 | 0.98334 | 1 of 2, 3029 | 3807.4 |
| B7 | reuse | 1 | 1 | 1 | 1 | 1 | 0.99986 | 0.99986 | 1 of 2, 3445 | 3701.7 |
| B8 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99977 | 0.99977 | 1 of 2, 3031 | 1655.5 |
| B9 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.98938 | 0.98938 | 1 of 3, 3033 | 3667 |
| B10 | reuse | 1 | 1 | 1 | 1 | 1 | 0.99125 | 0.99125 | 1 of 2, 3501 | 3430.9 |
| B11 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99948 | 0.99948 | 1 of 1, 362 | 3545 |
| B12 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99867 | 0.99867 | 1 of 2, 2961 | 3847.9 |
| B13 | reuse | 1 | 1 | 1 | 1 | 1 | 0.99969 | 0.99969 | 1 of 2, 3506 | 4281.9 |
| B14 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99033 | 0.99033 | 1 of 1, 2555 | 3826.3 |
| B15 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99499 | 0.99499 | 1 of 4, 3476 | 4200 |
| B16 | reuse | 1 | 1 | 1 | 1 | 1 | 0.99942 | 0.99942 | 1 of 1, 2992 | 4053 |
| B17 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99939 | 0.99939 | 1 of 2, 3390 | 4067.6 |
| B18 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99873 | 0.99873 | 1 of 3, 3366 | 4578 |
| B19 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99817 | 0.99817 | 1 of 2, 3262 | 4639.7 |
| B20 | reuse | 1 | 1 | 2 | 1 | 1 | 0.99335 | 0.99550 | 1 of 4, 3202 | 4539.9 |
| B21 | reuse | 1 | 1 | 3 | 1 | 1 | 0.99668 | 0.99733 | 1 of 2, 3363 | 5101.6 |
| B22 | reuse | 2 | 2 | 1 | 2 | 2 | 0.99853 | 0.99853 | 1 of 2, 3522 | 4931.6 |
| B23 | reuse | 1 | 1 | 1 | 1 | 1 | 0.99938 | 0.99938 | 1 of 2, 3543 | 5691.7 |
| B24 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99990 | 0.99990 | 1 of 1, 2808 | 5874.4 |
| B25 | paraphrase | 1 | 1 | 1 | 1 | 1 | 0.99275 | 0.99275 | 1 of 2, 3281 | 5423 |

## Paired by question, per sample (first better / first worse / same)

| Order | against the same list cut to five | against the same form at the production limit (@8) | against question/relaxed | against keywords/relaxed |
|---|---|---|---|---|
| rerank-blend/keywords | 0/0/25, 0/0/25 | 0/0/25, 0/0/25 | 9/1/15, 9/1/15 | 0/0/25, 0/0/25 |
| rerank-blend/question | 2/0/23, 2/0/23 | 4/2/19, 4/2/19 | 4/2/19, 4/2/19 | 1/8/16, 1/8/16 |
| rerank/keywords | 2/2/21, 2/2/21 | 2/2/21, 2/2/21 | 9/2/14, 9/2/14 | 2/2/21, 2/2/21 |
| rerank/question | 5/2/18, 5/2/18 | 6/2/17, 6/2/17 | 6/2/17, 6/2/17 | 1/6/18, 1/6/18 |

## Against the bar

The plan's words (docs/plans/version-0-progress.md, "Bite 7 plan, revised"): "on the keyword form, against `keywords/relaxed@20`, no more than one question loses at hit@1 and at least one gains at hit@3 or MRR@5; on the question form, against `question/relaxed@20`, at least three questions gain at hit@1 and no more than one loses; the median latency per question with the model loaded is at most 1 000 ms; the resident set grows by at most 1.0 GiB over the lexical run." How they are read: a loss or a gain at hit@k is a question whose gold page crosses the top k between the control and the mode; "gains at MRR@5" is the aggregate; the latency is the median over the scored passes (one per question and form); the memory is the process's resident set at two points the harness records, after the model's warm-up and after the scoring loop, over the reading after the lexical run, and is undecided when the two disagree; every sample must meet a condition.

1. keyword form, against keywords/relaxed@20 cut to five: hit@1 lost 2, 2, gained 2, 2; hit@3 gained 0, 0; MRR@5 delta -0.007, -0.007: **not met**.
2. question form, against question/relaxed@20 cut to five: hit@1 gained 4, 4, lost 2, 2: **not met**.
3. latency, median per pass at most 1 000 ms: median 4484.1 ms, maximum 5874.4 ms, over 100 passes: **not met**.
4. memory, at most 1.0 GiB over the lexical run: after the lexical run 1301 MiB; after the model's warm-up 3671 MiB (2370 MiB more); after the scoring loop 1461 MiB (160 MiB more): **undecided**.

**Verdict: the bar is not met: 3 condition(s) fail and 1 cannot be decided from the process's resident set (the model's memory is better read from the GPU allocation in the device record); the lexical default stands, and D7 records that a reranker over the ladder was measured and declined, with these numbers.**

Determinism: across 2 sample(s), questions whose rank varied: rerank-blend/keywords 0; rerank-blend/question 0; rerank/keywords 0; rerank/question 0.

## Cost

| What | Value |
|---|---|
| Model | hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf, 639153184 bytes, sha256 22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48, at /Users/drathm/Projects/drathm/okf-catalog/.claude/worktrees/bite4-fold/bench/.models/hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf |
| Reranker | context 4096 tokens, 4 context(s), chunks of at most 3600 characters; 100 scored passes over 1976 chunks (identical texts scored once), the warm-up apart |
| Load | 1386 ms for the first call |
| Latency per pass | median 4484.1 ms over 100 passes (per sample: 3993.95, 4590.1 ms), maximum 5874.4 ms; the figure is this laptop's and varies between runs of the same work |
| Resident set | 1301 MiB after the lexical run, 2029 MiB before the warm-up, 3671 MiB after it, 1461 MiB after the scoring loop; the process's resident set, not the model's memory, and it differs between runs of the same code |
| Device | {"gpu":"metal","gpuOffloading":true,"gpuDevices":["Apple M4 Max"],"vram":{"total":55662788608,"used":3780739072,"free":51882049536},"cpuCores":12} |
| Environment | GGML_METAL_NO_RESIDENCY=1, QMD_EMBED_MODEL=/Users/drathm/Projects/drathm/okf-catalog/.claude/worktrees/bite4-fold/bench/.models/hf_ggml-org_embeddinggemma-300M-Q8_0.gguf, QMD_RERANK_MODEL=/Users/drathm/Projects/drathm/okf-catalog/.claude/worktrees/bite4-fold/bench/.models/hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf, QMD_GENERATE_MODEL=/Users/drathm/Projects/drathm/okf-catalog/.claude/worktrees/bite4-fold/bench/.models/hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf |

## What this does not show

Twenty-five questions over one corpus, written by the system's author and tuned for the ladder, not for the reranker: even a perfect five gained and none lost is a sign test near p = 0.06, so the bar is a bar, not a significance claim. The raw-score order is not qmd's: qmd blends the score with the candidate's position, which is the second order reported, and under it the gold page's rank never changes where the ladder had it first; the pages at positions two to five do change, which hit@k and MRR do not see. The reranker's scores sit close to 1.0 for most candidates, so the gains and losses turn on differences of a thousandth or less. The twenty-deep list is not production's: at the production limit of eight the ladder's own question-form order differs on a few questions (the `ladder @8` column), so a gain against the twenty-deep list may only restore the eight-deep one. The latency is a laptop GPU's, not a container's, and varies between runs of the same work; the process's resident set is a poor measure of the model's memory. The reranker scores one chunk per page, as qmd does; a whole page or a different chunk rule was not measured. Stronger or other rerankers, other inputs, and a bundle with questions written by someone else remain open under D7.
