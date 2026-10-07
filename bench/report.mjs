#!/usr/bin/env node
// Renders docs/research/benchmark-lexical.md from the latest benchmark run (or the summary file given as the
// first argument), and docs/research/benchmark-modes.md when the run measured qmd's modes. Every number in a
// note comes from the run's files, so a re-run and a re-render keep the notes honest. A run over a bundle
// that is not the public corpus renders its modes note beside its results, with aggregates only, and never
// touches docs/. Usage: node bench/report.mjs [<stamp>.summary.json]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateBar } from "./lib/bar.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, "results");
const summaryPath =
  process.argv[2] ??
  join(
    resultsDir,
    readdirSync(resultsDir)
      .filter((n) => n.endsWith(".summary.json"))
      .sort()
      .at(-1),
  );
const S = JSON.parse(readFileSync(summaryPath, "utf8"));
const rows = readFileSync(summaryPath.replace(".summary.json", ".jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.length > 0)
  .map((l) => JSON.parse(l));
const m = S.meta;
const fmt = (v) => `${v["hit@1"]}/${v.n} | ${v["hit@3"]}/${v.n} | ${v["MRR@5"].toFixed(2)}`;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const words = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "twenty-one",
  "twenty-two",
  "twenty-three",
  "twenty-four",
  "twenty-five",
];
const w = (n) => words[n] ?? String(n);
const REPOS = {
  "okf-skills": "scaccogatto/okf-skills (`.okf/`)",
  "okf-agent-memory": "okf-memory/okf-agent-memory (`knowledge/`)",
  "cole-medin": "coleam00/cole-medin-knowledge-base (`concepts/`, `entities/`, `sources/`)",
  "superops-okf": "superops-team/okf (`docs/knowledge/`, served as `okf-docs/`)",
};
const qr = S.summary["question/relaxed"].all;
const qs = S.summary["question/strict"].all;
const n = qr.n;
const topicP = S.paired["question: topic filter vs none"];
const typeP = S.paired["question: type filter vs none"];
const poolP = S.paired["question: relaxed pool 100 vs the first rung's pool"];
const relaxP = S.paired["question: relaxed vs strict"];
const commitLine = m.okfCatalog.dirty
  ? `okf-catalog commit \`${m.okfCatalog.commit.slice(0, 7)}\` with uncommitted changes (diff hash \`${m.okfCatalog.diffSha256.slice(0, 12)}\`)`
  : `okf-catalog commit \`${m.okfCatalog.commit.slice(0, 7)}\` (clean tree)`;

const out = [];
out.push("# Lexical benchmark, bite 3\n");
out.push(
  `Run ${m.ran.slice(0, 10)} on ${m.os}, Node ${m.node}, qmd ${m.qmd}, ${commitLine}. Reproduce with \`sh bench/fetch-corpus.sh\`, \`npm run build\`, \`node bench/run.mjs\`, then \`node bench/report.mjs\` to regenerate this note. The run writes one JSON line per question per configuration and a summary under \`bench/results/\` (gitignored).\n`,
);
out.push("## Why\n");
out.push(
  "Decision D7 makes lexical search the default and records a reservation that qmd's full mode might change results. Decision D25 pushes the type and topic filters into the query and widens the pool while the filters leave it short. Decision D31 replaces reciprocal-rank fusion with summed BM25 on the relaxed rung and puts a keyword contract in the tool description. Plan review finding F10 asked for a benchmark that records its run metadata, measures both the question text and its keyword form, and compares the relaxation ladder on and off, paired by question; the build review added the filter configurations and a larger relaxed pool. The qmd metadata block runs were deferred until a qmd release reads the block (D30).\n",
);
out.push("## Corpus and questions\n");
out.push(
  "Four public OKF bundles at pinned commits, arranged under `bench/corpus/` by `bench/fetch-corpus.sh`:\n",
);
out.push(
  "| Folder | Repository | Commit | Files walked | Pages admitted | Questions |\n|---|---|---|---|---|---|",
);
const folderOfRepo = {
  "okf-skills": "okf-skills",
  "okf-agent-memory": "okf-agent-memory",
  "cole-medin": "cole-medin",
  "superops-okf": "okf-docs",
};
for (const [repoName, commit] of Object.entries(m.corpus ?? {})) {
  const b = m.pages.byBundle[folderOfRepo[repoName]] ?? { walked: 0, admitted: 0, questions: 0 };
  out.push(
    `| \`${folderOfRepo[repoName]}\` | ${REPOS[repoName]} | \`${commit.slice(0, 12)}\` | ${b.walked} | ${b.admitted} | ${b.questions} |`,
  );
}
const biggest = Object.entries(m.pages.byBundle).sort((a, b) => b[1].admitted - a[1].admitted)[0];
out.push(
  `\nThe walker found ${m.pages.walked} files; with drafts admitted and integrity off, ${m.pages.admitted} pages were admitted and ${m.pages.refused} ${m.pages.refused === 1 ? "file was" : "files were"} refused. ${Math.round((100 * biggest[1].admitted) / m.pages.admitted)}% of the admitted pages come from one bundle (\`${biggest[0]}\`), so the corpus is mostly that bundle's vocabulary and the wrong first hits below are mostly its pages. All ${m.pages.goldAdmitted} gold pages of the ${m.pages.questions} questions in \`bench/questions.json\` are admitted. Ten questions reuse the page's own words (\`reuse\`), fifteen paraphrase it (\`paraphrase\`). Each question also carries a keyword form, three terms a reader who knows the page would type. The questions were written by the author of the system against pages chosen by reading the corpus, so they are a smoke test of the ranking, not an unbiased sample of what users ask.\n`,
);
out.push("## Method\n");
out.push(
  `Every question runs in ${Object.keys(S.summary).length} configurations: the question text or its keyword form with the relaxed rung on or off; the question text with the gold page's own folder as the topic filter, with its type as the type filter, and with a relaxed per-term pool of 100 instead of the first rung's pool; the question text through the ladder twenty deep, cut to five for the rank (\`question/relaxed@20\`, the control for the fusion mode of the modes note and for the re-ranked question list, since the ladder's pools grow with its limit); the keyword form twenty deep (\`keywords/relaxed@20\`, the control for the re-ranked keyword list); and both forms at the production limit of eight, cut to five (\`@8\`). \`limit\` is ${m.request.limit}, overdue pages are included, and the clock is pinned to ${m.clock}. The gold page's rank in the five hits gives hit@1, hit@3 and MRR@5 (a miss contributes 0). The paired tables count, per question, whether the first configuration moved the gold page's rank up, down or not at all against the second; a miss ranks as 99. The filter configurations use the gold page's own folder and type, which a real caller does not know; they measure what the filters do to the ranking (D25), not how often a caller would guess them.\n`,
);
out.push("## Results\n");
out.push("| Configuration | hit@1 | hit@3 | MRR@5 |\n|---|---|---|---|");
for (const [k, v] of Object.entries(S.summary)) out.push(`| ${k} | ${fmt(v.all)} |`);
out.push("\nBy question style:\n");
out.push(
  "| Configuration | reuse hit@1 | reuse hit@3 | reuse MRR@5 | paraphrase hit@1 | paraphrase hit@3 | paraphrase MRR@5 |\n|---|---|---|---|---|---|---|",
);
for (const [k, v] of Object.entries(S.summary))
  out.push(`| ${k} | ${fmt(v.reuse)} | ${fmt(v.paraphrase)} |`);
out.push("\nPaired by question:\n");
out.push("| Comparison | first better | first worse | same |\n|---|---|---|---|");
for (const [k, v] of Object.entries(S.paired))
  out.push(`| ${k} | ${v.better} | ${v.worse} | ${v.same} |`);
out.push(
  `\nReading. With keywords, the all-terms rung puts the gold page in place for every question; relaxation only appends hits after the first rung's, so it cannot move a gold page the first rung found, and the two keyword rows are identical. For the same reason the relaxed-versus-strict pairing cannot show a loss: it measures what relaxation adds, not a trade. With the question text, the all-terms rung alone puts the gold page first ${w(qs["hit@1"])} times in ${w(n)}; relaxation lifts that to ${w(qr["hit@1"])} at the top and ${w(qr["hit@3"])} in the top three, improving ${w(relaxP.better)} questions and worsening ${w(relaxP.worse)}. The paraphrase rows are the reservation in D7 made concrete: lexical search over a paraphrase finds the page at the top ${S.summary["question/relaxed"].paraphrase["hit@1"]} times in ${S.summary["question/relaxed"].paraphrase.n}. The topic filter changes ${w(topicP.better + topicP.worse)} questions (${w(topicP.better)} better, ${w(topicP.worse)} worse) and the type filter ${w(typeP.better + typeP.worse)} (${w(typeP.better)} better, ${w(typeP.worse)} worse); a relaxed pool of 100 changes ${w(poolP.better + poolP.worse)} (${w(poolP.better)} better, ${w(poolP.worse)} worse) against the first rung's pool of ${rows.find((r) => r.config === "question/relaxed")?.pool ?? "?"}.\n`,
);
out.push("## Where the gold page was not first\n");
out.push(
  "| Configuration | Question | Style | Gold rank | Rung | Terms sent | First hit |\n|---|---|---|---|---|---|---|",
);
// The lexical note reads the lexical rows only; a run with modes appends mode rows to the same file.
for (const r of rows.filter((x) => x.config !== undefined)) {
  if (r.rank !== 1) {
    out.push(
      `| ${r.config} | ${r.id} | ${r.style} | ${r.rank ?? "miss"} | ${r.rung} | ${r.terms.join(" ")} | ${r.top5[0] ? `\`${r.top5[0]}\`` : "(no hits)"} |`,
    );
  }
}
const b2 = rows.find((r) => r.config === "keywords/relaxed" && r.id === "B2");
out.push(
  `\nObservations. The paraphrase misses share two or fewer content terms with their page, which no lexical ranking can recover. B22's question form is answered by the all-terms rung with a long entity page that happens to contain every term as a prefix, so relaxation never runs for it. The keyword form of B2 sends \`${b2?.terms.join(" ") ?? ""}\`: the tokenizer splits \`1,000\` into \`1\` (dropped, one character) and \`000\`, which is exactly how the engine's FTS5 tokenizer indexes it (a query token \`1000\` matches nothing, probed against qmd 2.8.3), so the split is kept. The relaxed per-term pool is the first rung's pool by default; the pool-100 row above measures the first alternative.\n`,
);
out.push("## Determinism\n");
out.push(
  "The first two runs of this benchmark disagreed on one question (B25: rank 1, then a miss). Three fresh indexes of the same corpus answered it two ways. The cause is in qmd: its lexical query orders by `bm25_score` alone (`store.js`, `ORDER BY bm25_score ASC LIMIT ?`), rows with equal scores come back in insertion order, and insertion order follows `fastGlob`'s traversal, which is not sorted. A pool that cut inside a group of equal scores therefore depended on the index build. The search policy now completes the tie group at every engine cut: it asks for one row beyond the pool, and when that row ties with the cut it widens the request until a lower score is seen, the engine runs out, or the cap is reached (`lexComplete` in `src/search/search.ts`). After the change three consecutive runs produced identical ranks, scores and paired outcomes (only timings and sizes differ) and three fresh indexes agreed on every question and score.\n",
);
out.push("## Cost\n");
out.push("| Measure | Value |\n|---|---|");
out.push(`| Index time, ${m.index.documents} pages | ${m.index.ms} ms |`);
out.push(
  `| Database size, ${m.index.documents} pages | ${(m.index.dbBytes / 1024 / 1024).toFixed(1)} MiB |`,
);
out.push(
  `| Documents not indexed | ${m.index.notIndexed} (${m.index.collisions ?? 0} by path collision) |`,
);
out.push(
  `| Process RSS after the lexical phase | ${Math.round((m.memory.phases?.afterLexical ?? m.memory.rssAfterBytes) / 1024 / 1024)} MiB (walked files, catalog and qmd store resident; ${Math.round(m.memory.rssAfterBytes / 1024 / 1024)} MiB at the end, with the store closed) |`,
);
const lexicalRows = rows.filter((x) => x.config !== undefined);
const byConfig = new Map();
for (const r of lexicalRows) byConfig.set(r.config, [...(byConfig.get(r.config) ?? []), r.ms]);
for (const [k, v] of byConfig)
  out.push(
    `| Query latency, ${k} | median ${median(v).toFixed(1)} ms, max ${Math.max(...v).toFixed(1)} ms |`,
  );
const rowsBy = new Map();
for (const r of lexicalRows)
  rowsBy.set(r.config, [...(rowsBy.get(r.config) ?? []), r.rowsFetched ?? 0]);
for (const [k, v] of rowsBy)
  out.push(
    `| Rows fetched per search, ${k} | median ${median(v)}, max ${Math.max(...v)} (every row carries its page body) |`,
  );
const relaxedRows = lexicalRows.filter((r) => r.config === "question/relaxed");
out.push(
  `| Questions with a term at the frequency floor (question/relaxed) | ${relaxedRows.filter((r) => (r.floored ?? []).length > 0).length} of ${relaxedRows.length} |`,
);
out.push("\nFixtures, for the record (measured once on the same machine):\n");
out.push("| Fixture | Pages | Index time | Database |\n|---|---|---|---|");
out.push(
  "| `behaviours` | 19 | 16 ms | 124 KiB |\n| `spec-example` | 9 | 7 ms | 188 KiB |\n| `no-manifest` | 1 | 2 ms | 120 KiB |\n| `refused` | 1 | 2 ms | 120 KiB |",
);
out.push("\nThe SQLite file has a floor of about 120 KiB regardless of content.\n");
out.push("## What this does not show\n");
out.push(
  "qmd's modes are measured in notes of their own, `benchmark-modes.md` (bite 6) and `benchmark-rerank.md` (bite 7); the rows here are the controls those notes pair against. Twenty-five questions over one corpus, nine tenths of it one bundle, written by the system's author. The keyword form uses terms chosen with the page in view, so its numbers are an upper bound on what a reader who already knows the page can do. The filter rows use the gold page's own folder and type. The metadata block (D30) is not measured until a qmd release reads it.\n",
);
const onCorpus = (m.bundle ?? "the public corpus") === "the public corpus";
// The lexical note is written by a lexical-only run of the corpus: a modes run measures the same rows, but its
// memory and its database size carry the models, so it leaves the note to a run of its own kind.
if (onCorpus && (S.modes === null || S.modes === undefined)) {
  writeFileSync(join(here, "..", "docs", "research", "benchmark-lexical.md"), out.join("\n"));
  process.stdout.write(`wrote docs/research/benchmark-lexical.md from ${summaryPath}\n`);
} else if (onCorpus) {
  process.stdout.write("a modes run: the lexical note is not rewritten\n");
} else {
  process.stdout.write("a run over another bundle: the lexical note is not rewritten\n");
}

const M = S.modes ?? null;
const bite6Modes =
  M === null ? [] : ["vector", "fused", "hybrid", "full"].filter((k) => k in M.perMode);
// Bite 6's note is written only by a run that measured one of its modes; a `rerank`-only run (bite 7) leaves
// it alone and writes its own note below, so the numbers D51 and D7 quote are never re-sampled by accident.
if (M !== null && bite6Modes.length > 0) {
  const fmtStat = (s) => (s.min === s.max ? `${s.min}` : `${s.min} / ${s.median} / ${s.max}`);
  const fmtMode = (v) =>
    `${fmtStat(v["hit@1"])} | ${fmtStat(v["hit@3"])} | ${fmtStat({ min: v["MRR@5"].min.toFixed(2), median: v["MRR@5"].median.toFixed(2), max: v["MRR@5"].max.toFixed(2) })}`;
  const modeRows = rows.filter((r) => r.mode !== undefined);
  const note = [];
  note.push("# Lexical versus full mode, bite 6\n");
  note.push(
    `Run ${m.ran.slice(0, 10)} on ${m.os}, Node ${m.node}, qmd ${m.qmd}, node-llama-cpp ${M.nodeLlamaCpp}, ${commitLine}${M.stub ? ", with the embedder STUB (a measurement of the harness, not of a model)" : ""}. Reproduce with \`sh bench/fetch-corpus.sh\`, \`npm run build\`, \`node bench/pull-models.mjs ${M.models.map((x) => x.key).join(" ") || "…"}\` (the approval), \`node bench/run.mjs --modes ${M.requested.join(",")} --samples ${M.samplesRequested}\`, then \`node bench/report.mjs\`.\n`,
  );
  note.push("## Why\n");
  note.push(
    "Decision D7 made lexical search the default with a reservation: if qmd's full mode changes results dramatically, the default is wrong. This note is that measurement, over the same derived index the lexical benchmark uses, so what differs between the rows is the retrieval, with one caveat: the production ladder's list depends on its limit, so `fused`, which fuses the ladder twenty deep, is also paired against that twenty-deep list cut to five (`question/relaxed@20`), the control that isolates what the vectors add. The threshold was written before the run (D51): the worst of `full`'s samples, paired against `question/relaxed`, improves the gold rank of at least 8 of the 25 questions and worsens at most 2. The sample is the lexical note's: 25 author-written questions over a corpus that is mostly one bundle, a smoke test, not a survey of what users ask. Production answers with a default limit of 8; the anchors here use 5, as the lexical note does.\n",
  );
  note.push("## Method\n");
  note.push(
    `The modes, each over the second store the harness opens on the lexical run's database after one \`embed()\` of the collection, every call scoped to it: \`vector\` is \`searchVector\` (the embedding model alone, ${M.retrieval.vectorRows} rows cut to ${M.retrieval.returned} distinct pages); \`fused\` is okf-catalog's own candidate for a full mode, the production ladder's ranked list twenty deep fused with the vector list by reciprocal rank (k = ${M.retrieval.rrfK}) in the harness; \`hybrid\` is qmd's own pipeline without the reranker (its BM25 probe on the raw question, expansion by the language model unless the probe shows a strong signal, lexical and vector lists of ${M.retrieval.qmdListSize} for the original and each expansion, reciprocal-rank fusion with the original lists at double weight); \`full\` is the same with the reranker over ${M.retrieval.qmdCandidateLimit} candidates. The index is ${M.retrieval.indexed}. The modes that run a language model were sampled ${M.samplesRequested} times with qmd's cache cleared before each sample; their rows read min / median / max. Every mode is paired per question against \`question/relaxed\`, \`question/strict\` and \`keywords/relaxed\`, which bracket what production sends.\n`,
  );
  note.push("## Results\n");
  note.push("| Mode | samples | hit@1 | hit@3 | MRR@5 |\n|---|---|---|---|---|");
  for (const base of [
    "question/relaxed",
    "question/relaxed@20",
    "question/strict",
    "keywords/relaxed",
  ]) {
    const v = S.summary[base]?.all;
    if (v)
      note.push(
        `| ${base} (lexical) | 1 | ${v["hit@1"]}/${v.n} | ${v["hit@3"]}/${v.n} | ${v["MRR@5"].toFixed(2)} |`,
      );
  }
  for (const [mode, v] of Object.entries(M.perMode))
    note.push(`| ${mode} | ${v.samples} | ${fmtMode(v.overall)} |`);
  note.push("\nBy question style (min / median / max over the samples where they differ):\n");
  const styles = Object.keys(Object.values(M.perMode)[0]?.byStyle ?? {});
  note.push(
    `| Mode | ${styles.map((s) => `${s} hit@1 | ${s} hit@3 | ${s} MRR@5`).join(" | ")} |\n|---|${styles.map(() => "---|---|---").join("|")}|`,
  );
  for (const [mode, v] of Object.entries(M.perMode))
    note.push(`| ${mode} | ${styles.map((s) => fmtMode(v.byStyle[s])).join(" | ")} |`);
  note.push("\nPaired by question, per sample (first better / first worse / same):\n");
  note.push(
    "| Mode | against question/relaxed | against question/relaxed@20 | against question/strict | against keywords/relaxed |\n|---|---|---|---|---|",
  );
  for (const [mode, v] of Object.entries(M.perMode)) {
    const cell = (list) => (list ?? []).map((p) => `${p.better}/${p.worse}/${p.same}`).join(", ");
    note.push(
      `| ${mode} | ${cell(v.paired["question/relaxed"])} | ${cell(v.paired["question/relaxed@20"])} | ${cell(v.paired["question/strict"])} | ${cell(v.paired["keywords/relaxed"])} |`,
    );
  }
  const full = M.perMode.full;
  if (full !== undefined && onCorpus) {
    // Every sample must meet both bounds: the fewest improvements and the most regressions across the samples.
    const pairs = full.paired["question/relaxed"] ?? [];
    const minBetter = Math.min(...pairs.map((p) => p.better));
    const maxWorse = Math.max(...pairs.map((p) => p.worse));
    const met = pairs.length > 0 && minBetter >= 8 && maxWorse <= 2;
    note.push(
      `\nAgainst the threshold: across \`full\`'s ${pairs.length} sample(s) paired with \`question/relaxed\`, the fewest questions improved is ${minBetter} and the most worsened is ${maxWorse}; the D51 threshold (every sample at least 8 better and at most 2 worse) is ${met ? "met, so the maintainer decides with the sample's limits in view" : "not met, so the lexical default stands and D7's reservation can close"}.\n`,
    );
  }
  note.push("## Stability and cost\n");
  note.push("| Measure | Value |\n|---|---|");
  for (const [mode, v] of Object.entries(M.perMode)) {
    note.push(
      `| ${mode}: questions whose rank differed between samples | ${v.questionsWhoseRankVaried} of ${Object.keys(v.rankSpread).length} |`,
    );
    note.push(
      `| ${mode}: first query of the mode (a warm-up no question uses; for vector and fused the embedder was already loaded by embed()) | ${v.modelLoadMs} ms |`,
    );
    const ms = modeRows.filter((r) => r.mode === mode).map((r) => r.ms);
    if (ms.length > 0)
      note.push(
        `| ${mode}: query latency | median ${median(ms).toFixed(1)} ms, max ${Math.max(...ms).toFixed(1)} ms |`,
      );
  }
  note.push(
    `| Embedding the collection | ${M.embed.ms} ms, ${M.embed.docsProcessed} documents, ${M.embed.chunksEmbedded} chunks, ${M.embed.errors} errors |`,
  );
  note.push(
    `| Store size before and after embedding | ${(M.dbBytesBefore / 1024 / 1024).toFixed(1)} MiB, ${(M.dbBytesAfterEmbed / 1024 / 1024).toFixed(1)} MiB |`,
  );
  note.push(`| qmd's cache rows at the end | ${M.llmCacheRowsAtEnd ?? "n/a"} |`);
  const ph = m.memory.phases ?? {};
  note.push(
    `| Resident memory after load / index / lexical / embed / modes | ${["afterLoad", "afterIndex", "afterLexical", "afterEmbed", "afterModes"].map((k) => `${Math.round((ph[k] ?? 0) / 1024 / 1024)} MiB`).join(" / ")} |`,
  );
  if (onCorpus) {
    note.push("\n## Where the gold page was not first\n");
    note.push(
      "| Mode | Sample | Question | Style | Shared terms | Gold rank | First hit | Lexical strings run (qmd's FTS queries, or the ladder's terms) |\n|---|---|---|---|---|---|---|---|",
    );
    for (const r of modeRows) {
      if (r.rank !== 1)
        note.push(
          `| ${r.mode} | ${r.sample} | ${r.id} | ${r.style}${r.shared !== null && r.shared !== undefined && r.shared <= 2 ? " †" : ""} | ${r.shared ?? "?"} | ${r.rank ?? "miss"} | ${r.top5[0] ? `\`${r.top5[0]}\`` : "(no hits)"} | ${r.lexString ?? ""} |`,
        );
    }
    note.push(
      "\n† a question whose ladder terms share two or fewer with the gold page's own text, which no lexical ranking can recover (the lexical note's observation, counted here).\n",
    );
    const listed = modeRows.filter((r) => Array.isArray(r.lists) && r.lists.length > 0);
    if (listed.length > 0) {
      note.push("\nThe lists qmd fused per question (source:query type:query), every sample:\n");
      note.push("| Mode | Sample | Question | Lists |\n|---|---|---|---|");
      for (const r of listed)
        note.push(
          `| ${r.mode} | ${r.sample} | ${r.id} | ${r.lists.map((l) => `\`${l}\``).join(", ")} |`,
        );
    }
    const expanded = modeRows.filter((r) => r.trace?.expansions);
    if (expanded.length > 0) {
      note.push(
        "\nExpansions qmd generated (first sample of each mode), with the strong-signal shortcut where it fired:\n",
      );
      note.push("| Mode | Question | Strong signal | Expansions |\n|---|---|---|---|");
      for (const r of expanded.filter((x) => x.sample === 1))
        note.push(
          `| ${r.mode} | ${r.id} | ${r.trace.strongSignal === null ? "no" : `yes (${r.trace.strongSignal.toFixed(3)})`} | ${(r.trace.expansions ?? []).map((e) => `${e.type}: ${e.query}`).join("; ")} |`,
        );
    }
  } else {
    note.push(
      "\nThis run was over a bundle that is not the public corpus; per-question rows stay in the results folder and are not rendered here.\n",
    );
  }
  note.push("\n## Reproducibility\n");
  note.push("| Item | Value |\n|---|---|");
  for (const x of M.models)
    note.push(
      `| ${x.key} | ${x.uri}, ${x.bytes} bytes, sha256 ${x.sha256}, host revision ${x.revision.slice(0, 12)}, at ${x.path} |`,
    );
  if (M.models.length === 0) note.push("| models | none: the embedder stub |");
  note.push(
    `| Environment | ${
      Object.entries(M.environment)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "none"
    } |`,
  );
  note.push(`| Device | ${JSON.stringify(M.device)} |`);
  note.push(
    `| Retrieval depth | vector rows ${M.retrieval.vectorRows}, returned ${M.retrieval.returned}, qmd lists ${M.retrieval.qmdListSize}, candidates ${M.retrieval.qmdCandidateLimit}, RRF k ${M.retrieval.rrfK} |`,
  );
  note.push(`| Clock, request | ${m.clock}; limit ${m.request.limit}, overdue included |`);
  note.push(`| qmd console lines during the modes | ${M.consoleLines.length} |`);
  note.push("\n## What this does not show\n");
  note.push(
    "Twenty-five questions over one corpus, nine tenths of it one bundle, written by the system's author; the modes see the derived documents, not the original pages; the expansion model samples, so its rows are a range, not a point; a company's own questions run through the same harness with `--bundle`, `--config` and `--questions`, and their note stays beside their results.\n",
  );
  const target = onCorpus
    ? join(here, "..", "docs", "research", "benchmark-modes.md")
    : join(dirname(summaryPath), "benchmark-modes.md");
  writeFileSync(target, note.join("\n"));
  process.stdout.write(`wrote ${target} from ${summaryPath}\n`);
}

if (M !== null && Object.keys(M.perMode).some((k) => k.startsWith("rerank"))) {
  const R = M.rerank ?? {};
  const forms = R.forms ?? ["question", "keywords"];
  const controlFor = { question: "question/relaxed@20", keywords: "keywords/relaxed@20" };
  const rerankKeys = Object.keys(M.perMode)
    .filter((k) => k.startsWith("rerank"))
    .sort();
  const rerankRows = rows.filter((r) => typeof r.mode === "string" && r.mode.startsWith("rerank"));
  const sampleCount = new Set(rerankRows.map((r) => r.sample)).size;
  const controlRank = (config, id) =>
    rows.find((r) => r.config === config && r.id === id)?.rank ?? null;
  const fmtStat = (x) => (x.min === x.max ? `${x.min}` : `${x.min} / ${x.median} / ${x.max}`);
  const fmtMode = (v) =>
    `${fmtStat(v["hit@1"])} | ${fmtStat(v["hit@3"])} | ${fmtStat({ min: v["MRR@5"].min.toFixed(2), median: v["MRR@5"].median.toFixed(2), max: v["MRR@5"].max.toFixed(2) })}`;
  const mib = (bytes) => `${Math.round(bytes / 1_048_576)} MiB`;
  const controlFor8 = { question: "question/relaxed@8", keywords: "keywords/relaxed@8" };
  const note = [];
  note.push("# The ladder re-ranked, bite 7\n");
  note.push(
    `Run ${m.ran.slice(0, 10)} on ${m.os}, Node ${m.node}, qmd ${m.qmd}, node-llama-cpp ${M.nodeLlamaCpp}, ${commitLine}${M.stub ? ", with the STUB reranker (a measurement of the harness, not of a model)" : ""}.\n`,
  );
  note.push("## Why\n");
  note.push(
    "Bite 6 compared the production lexical ladder with qmd's vector, fused, hybrid and full modes and left D7's reservation narrowed but open. It never measured the cheapest middle option: the ladder's own twenty candidates re-ranked by the reranker model alone, with no embedding index and no expansion model. This note is that measurement. Its bar was written before the run (`docs/plans/version-0-progress.md`, bite 7 plan, revised), and the run is a separate process from bite 6's, whose note stands as it was.\n",
  );
  note.push("## Method\n");
  note.push(
    `For each of the ${m.pages.questions} questions, in two forms (the question text and the keyword string, production's input), the ladder's list twenty deep (\`question/relaxed@20\`, \`keywords/relaxed@20\`) is handed to qmd's reranker as qmd's own pipeline hands it: one chunk per candidate, cut by qmd's chunker from the derived document as indexed (chunks of at most ${R.chunkChars ?? "3600"} characters), the chunk with the most query terms longer than two characters, and the reranker's own token budget (context ${R.contextSize ?? "?"} tokens${R.contexts === null || R.contexts === undefined ? "" : `, ${R.contexts} contexts`}). qmd's cache is emptied before every pass, so every pass is a real scoring pass; the run fails when a candidate comes back unscored or every score is alike. From one pass two orders are reported: \`rerank\` (the raw score, ties in ladder order) and \`rerank-blend\` (qmd's Step 7 rule over the ladder's positions, weights 0.75, 0.60 and 0.40 by rank band, which cannot displace the ladder's first result). The rank is the gold page's position in the top five; the controls are the same lists cut to five, D51's anchor \`question/relaxed\`, and the production limit (\`@8\`). ${sampleCount} sample(s), the cache emptied between them.\n`,
  );
  note.push("## Results\n");
  note.push("| List or order | samples | hit@1 | hit@3 | MRR@5 |\n|---|---|---|---|---|");
  for (const base of [
    "question/relaxed",
    "question/relaxed@8",
    "question/relaxed@20",
    "keywords/relaxed",
    "keywords/relaxed@8",
    "keywords/relaxed@20",
  ]) {
    const v = S.summary[base]?.all;
    if (v)
      note.push(
        `| ${base} (lexical) | 1 | ${v["hit@1"]}/${v.n} | ${v["hit@3"]}/${v.n} | ${v["MRR@5"].toFixed(2)} |`,
      );
  }
  for (const key of rerankKeys)
    note.push(`| ${key} | ${M.perMode[key].samples} | ${fmtMode(M.perMode[key].overall)} |`);
  for (const form of forms) {
    const first = rerankRows.filter((r) => r.mode === `rerank/${form}` && r.sample === 1);
    const present = first.filter((r) => r.goldInCandidates !== null).length;
    note.push(
      `\nCeiling, ${form} form: the gold page is among the twenty candidates for ${present} of ${first.length} questions (its positions in ladder order: ${first.map((r) => r.goldInCandidates ?? "none").join(", ")}); no re-ranking of this list can lift hit@1 above ${present}.`,
    );
  }
  for (const form of forms) {
    note.push(`\n### Per question, ${form} form, sample 1\n`);
    note.push(
      "| Question | style | ladder @20, cut to five | ladder @8, cut to five | rerank | rerank-blend | gold at | gold score | top score | gold chunk (index of count, chars) | ms |\n|---|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const r of rerankRows.filter((x) => x.mode === `rerank/${form}` && x.sample === 1)) {
      const blend = rerankRows.find(
        (b) => b.mode === `rerank-blend/${form}` && b.sample === 1 && b.id === r.id,
      );
      const gi = r.goldInCandidates === null ? -1 : r.goldInCandidates - 1;
      const goldScore = gi >= 0 ? r.scores[gi] : null;
      const top = r.scores.length > 0 ? Math.max(...r.scores) : null;
      const chunk = gi >= 0 ? r.chunks[gi] : null;
      note.push(
        `| ${r.id} | ${r.style} | ${controlRank(controlFor[form], r.id) ?? "none"} | ${controlRank(controlFor8[form], r.id) ?? "none"} | ${r.rank ?? "none"} | ${blend?.rank ?? "none"} | ${r.goldInCandidates ?? "none"} | ${goldScore === null ? "–" : goldScore.toFixed(5)} | ${top === null ? "–" : top.toFixed(5)} | ${chunk ? `${chunk.index + 1} of ${chunk.count}, ${chunk.length}` : "–"} | ${r.rerankMs} |`,
      );
    }
  }
  note.push("\n## Paired by question, per sample (first better / first worse / same)\n");
  note.push(
    "| Order | against the same list cut to five | against the same form at the production limit (@8) | against question/relaxed | against keywords/relaxed |\n|---|---|---|---|---|",
  );
  for (const key of rerankKeys) {
    const form = key.split("/")[1];
    const v = M.perMode[key];
    const cell = (list) => (list ?? []).map((p) => `${p.better}/${p.worse}/${p.same}`).join(", ");
    note.push(
      `| ${key} | ${cell(v.paired[controlFor[form]])} | ${cell(v.paired[controlFor8[form]])} | ${cell(v.paired["question/relaxed"])} | ${cell(v.paired["keywords/relaxed"])} |`,
    );
  }
  // The bar, as written before the run, evaluated by bench/lib/bar.mjs (unit-tested) for a run of `rerank`
  // alone: a run that also measured another mode would find the reranker already loaded or count its calls.
  const mem = M.memoryByMode?.rerank;
  const memory =
    mem && m.memory?.phases
      ? {
          afterLexical: m.memory.phases.afterLexical,
          afterWarmUp: mem.rssAfterWarmUp,
          afterLoop: m.memory.phases.afterModes,
        }
      : null;
  const rerankOnly =
    Array.isArray(M.requested) && M.requested.length === 1 && M.requested[0] === "rerank";
  const bar = rerankOnly ? evaluateBar(rerankRows, controlRank, memory, sampleCount) : null;
  const passRows = rerankRows.filter((r) => r.mode.startsWith("rerank/"));
  const latencies = passRows.map((r) => r.rerankMs);
  const medianMs = median(latencies);
  const maxMs = latencies.length ? Math.max(...latencies) : null;
  const perSampleMedian = Array.from({ length: sampleCount }, (_, i) => {
    const own = passRows.filter((r) => r.sample === i + 1).map((r) => r.rerankMs);
    return own.length ? median(own) : null;
  });
  note.push("\n## Against the bar\n");
  note.push(
    'The plan\'s words (docs/plans/version-0-progress.md, "Bite 7 plan, revised"): "on the keyword form, against `keywords/relaxed@20`, no more than one question loses at hit@1 and at least one gains at hit@3 or MRR@5; on the question form, against `question/relaxed@20`, at least three questions gain at hit@1 and no more than one loses; the median latency per question with the model loaded is at most 1 000 ms; the resident set grows by at most 1.0 GiB over the lexical run." How they are read: a loss or a gain at hit@k is a question whose gold page crosses the top k between the control and the mode; "gains at MRR@5" is the aggregate; the latency is the median over the scored passes (one per question and form); the memory is the process\'s resident set at two points the harness records, after the model\'s warm-up and after the scoring loop, over the reading after the lexical run, and is undecided when the two disagree; every sample must meet a condition.\n',
  );
  if (bar === null) {
    note.push(
      `The bar is evaluated only for a run of \`rerank\` alone; this run requested ${JSON.stringify(M.requested)}, so it is not evaluated here.`,
    );
  } else {
    for (const [i, c] of bar.conditions.entries())
      note.push(`${i + 1}. ${c.name}: ${c.detail}: **${c.state}**.`);
    const failed = bar.conditions.filter((c) => c.state === "not met").length;
    const undecided = bar.conditions.filter((c) => c.state === "undecided").length;
    note.push(
      `\n**Verdict: ${
        bar.met
          ? "the bar is met; the proposal is an optional rerank step over the ladder behind a configuration flag, as D7's narrowed reservation"
          : `the bar is not met: ${failed} condition(s) fail${undecided > 0 ? ` and ${undecided} cannot be decided from the process's resident set (the model's memory is better read from the GPU allocation in the device record)` : ""}; the lexical default stands, and D7 records that a reranker over the ladder was measured and declined, with these numbers`
      }.**`,
    );
  }
  note.push(
    `\nDeterminism: across ${sampleCount} sample(s), questions whose rank varied: ${rerankKeys.map((k) => `${k} ${M.perMode[k].questionsWhoseRankVaried}`).join("; ")}.`,
  );
  note.push("\n## Cost\n");
  note.push("| What | Value |\n|---|---|");
  for (const x of M.models.filter((e) => e.key === "rerank"))
    note.push(`| Model | ${x.uri}, ${x.bytes} bytes, sha256 ${x.sha256}, at ${x.path} |`);
  if (M.models.length === 0) note.push("| Model | none: the stub reranker |");
  note.push(
    `| Reranker | context ${R.contextSize ?? "?"} tokens, ${R.contexts ?? "?"} context(s), chunks of at most ${R.chunkChars ?? "?"} characters; ${passRows.length} scored passes over ${(R.calls?.documents ?? 0) - (R.calls?.warmUp ? R.calls.warmUp.documents : 1)} chunks (identical texts scored once), the warm-up apart |`,
  );
  note.push(`| Load | ${M.perMode[rerankKeys[0]]?.modelLoadMs ?? "?"} ms for the first call |`);
  note.push(
    `| Latency per pass | median ${medianMs} ms over ${latencies.length} passes (per sample: ${perSampleMedian.join(", ")} ms), maximum ${maxMs} ms; the figure is this laptop's and varies between runs of the same work |`,
  );
  if (mem)
    note.push(
      `| Resident set | ${mib(m.memory.phases.afterLexical)} after the lexical run, ${mib(mem.rssBeforeWarmUp)} before the warm-up, ${mib(mem.rssAfterWarmUp)} after it, ${mib(m.memory.phases.afterModes)} after the scoring loop; the process's resident set, not the model's memory, and it differs between runs of the same code |`,
    );
  note.push(`| Device | ${JSON.stringify(M.device)} |`);
  note.push(
    `| Environment | ${
      Object.entries(M.environment)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "none"
    } |`,
  );
  note.push("\n## What this does not show\n");
  note.push(
    "Twenty-five questions over one corpus, written by the system's author and tuned for the ladder, not for the reranker: even a perfect five gained and none lost is a sign test near p = 0.06, so the bar is a bar, not a significance claim. The raw-score order is not qmd's: qmd blends the score with the candidate's position, which is the second order reported, and under it the gold page's rank never changes where the ladder had it first; the pages at positions two to five do change, which hit@k and MRR do not see. The reranker's scores sit close to 1.0 for most candidates, so the gains and losses turn on differences of a thousandth or less. The twenty-deep list is not production's: at the production limit of eight the ladder's own question-form order differs on a few questions (the `ladder @8` column), so a gain against the twenty-deep list may only restore the eight-deep one. The latency is a laptop GPU's, not a container's, and varies between runs of the same work; the process's resident set is a poor measure of the model's memory. The reranker scores one chunk per page, as qmd does; a whole page or a different chunk rule was not measured. Stronger or other rerankers, other inputs, and a bundle with questions written by someone else remain open under D7.\n",
  );
  const target = onCorpus
    ? join(here, "..", "docs", "research", "benchmark-rerank.md")
    : join(dirname(summaryPath), "benchmark-rerank.md");
  writeFileSync(target, note.join("\n"));
  process.stdout.write(`wrote ${target} from ${summaryPath}\n`);
}
