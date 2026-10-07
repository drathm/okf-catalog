#!/usr/bin/env node
// Renders docs/research/benchmark-lexical.md from the latest benchmark run (or the summary file given as the
// first argument), and docs/research/benchmark-modes.md when the run measured qmd's modes. Every number in a
// note comes from the run's files, so a re-run and a re-render keep the notes honest. A run over a bundle
// that is not the public corpus renders its modes note beside its results, with aggregates only, and never
// touches docs/. Usage: node bench/report.mjs [<stamp>.summary.json]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
for (const [repoName, commit] of Object.entries(m.corpus)) {
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
  `Every question runs in seven configurations: the question text or its keyword form with the relaxed rung on or off; and the question text with the gold page's own folder as the topic filter, with its type as the type filter, and with a relaxed per-term pool of 100 instead of the first rung's pool. \`limit\` is ${m.request.limit}, overdue pages are included, and the clock is pinned to ${m.clock}. The gold page's rank in the five hits gives hit@1, hit@3 and MRR@5 (a miss contributes 0). The paired tables count, per question, whether the first configuration moved the gold page's rank up, down or not at all against the second; a miss ranks as 99. The filter configurations use the gold page's own folder and type, which a real caller does not know; they measure what the filters do to the ranking (D25), not how often a caller would guess them.\n`,
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
for (const r of rows) {
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
  `| Process RSS after the run | ${Math.round(m.memory.rssAfterBytes / 1024 / 1024)} MiB (walked files, catalog and qmd store all resident) |`,
);
const byConfig = new Map();
for (const r of rows) byConfig.set(r.config, [...(byConfig.get(r.config) ?? []), r.ms]);
for (const [k, v] of byConfig)
  out.push(
    `| Query latency, ${k} | median ${median(v).toFixed(1)} ms, max ${Math.max(...v).toFixed(1)} ms |`,
  );
const rowsBy = new Map();
for (const r of rows) rowsBy.set(r.config, [...(rowsBy.get(r.config) ?? []), r.rowsFetched ?? 0]);
for (const [k, v] of rowsBy)
  out.push(
    `| Rows fetched per search, ${k} | median ${median(v)}, max ${Math.max(...v)} (every row carries its page body) |`,
  );
const relaxedRows = rows.filter((r) => r.config === "question/relaxed");
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
  "No comparison with qmd's full mode (bite 6, with approval for the model download), so D7's reservation stays open. Twenty-five questions over one corpus, nine tenths of it one bundle, written by the system's author. The keyword form uses terms chosen with the page in view, so its numbers are an upper bound on what a reader who already knows the page can do. The filter rows use the gold page's own folder and type. The metadata block (D30) is not measured until a qmd release reads it.\n",
);
const onCorpus = (m.bundle ?? "the public corpus") === "the public corpus";
if (onCorpus) {
  writeFileSync(join(here, "..", "docs", "research", "benchmark-lexical.md"), out.join("\n"));
  process.stdout.write(`wrote docs/research/benchmark-lexical.md from ${summaryPath}\n`);
} else {
  process.stdout.write("a run over another bundle: the lexical note is not rewritten\n");
}

if (S.modes !== null && S.modes !== undefined) {
  const M = S.modes;
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
    "Decision D7 made lexical search the default with a reservation: if qmd's full mode changes results dramatically, the default is wrong. This note is that measurement, over the same derived index the lexical benchmark uses, so the only thing that differs between the rows is the retrieval. The threshold was written before the run (D51): the worst of `full`'s samples, paired against `question/relaxed`, improves the gold rank of at least 8 of the 25 questions and worsens at most 2. The sample is the lexical note's: 25 author-written questions over a corpus that is mostly one bundle, a smoke test, not a survey of what users ask.\n",
  );
  note.push("## Method\n");
  note.push(
    `The modes, each over the second store the harness opens on the lexical run's database after one \`embed()\` of the collection, every call scoped to it: \`vector\` is \`searchVector\` (the embedding model alone, ${M.retrieval.vectorRows} rows cut to ${M.retrieval.returned} distinct pages); \`fused\` is okf-catalog's own candidate for a full mode, the production ladder's ranked list twenty deep fused with the vector list by reciprocal rank (k = ${M.retrieval.rrfK}) in the harness; \`hybrid\` is qmd's own pipeline without the reranker (its BM25 probe on the raw question, expansion by the language model unless the probe shows a strong signal, lexical and vector lists of ${M.retrieval.qmdListSize} for the original and each expansion, reciprocal-rank fusion with the original lists at double weight); \`full\` is the same with the reranker over ${M.retrieval.qmdCandidateLimit} candidates. The index is ${M.retrieval.indexed}. The modes that run a language model were sampled ${M.samplesRequested} times with qmd's cache cleared before each sample; their rows read min / median / max. Every mode is paired per question against \`question/relaxed\`, \`question/strict\` and \`keywords/relaxed\`, which bracket what production sends.\n`,
  );
  note.push("## Results\n");
  note.push("| Mode | samples | hit@1 | hit@3 | MRR@5 |\n|---|---|---|---|---|");
  for (const base of ["question/relaxed", "question/strict", "keywords/relaxed"]) {
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
    "| Mode | against question/relaxed | against question/strict | against keywords/relaxed |\n|---|---|---|---|",
  );
  for (const [mode, v] of Object.entries(M.perMode)) {
    const cell = (list) => list.map((p) => `${p.better}/${p.worse}/${p.same}`).join(", ");
    note.push(
      `| ${mode} | ${cell(v.paired["question/relaxed"])} | ${cell(v.paired["question/strict"])} | ${cell(v.paired["keywords/relaxed"])} |`,
    );
  }
  const full = M.perMode.full;
  if (full !== undefined) {
    const worst = full.paired["question/relaxed"].reduce(
      (acc, p) => (acc === null || p.better - p.worse < acc.better - acc.worse ? p : acc),
      null,
    );
    const met = worst !== null && worst.better >= 8 && worst.worse <= 2;
    note.push(
      `\nAgainst the threshold: the worst \`full\` sample improves ${worst?.better ?? "?"} questions and worsens ${worst?.worse ?? "?"} against \`question/relaxed\`; the D51 threshold (at least 8 better, at most 2 worse) is ${met ? "met, so the maintainer decides with the sample's limits in view" : "not met, so the lexical default stands and D7's reservation can close"}.\n`,
    );
  }
  note.push("## Stability and cost\n");
  note.push("| Measure | Value |\n|---|---|");
  for (const [mode, v] of Object.entries(M.perMode)) {
    note.push(
      `| ${mode}: questions whose rank differed between samples | ${v.questionsWhoseRankVaried} of ${Object.keys(v.rankSpread).length} |`,
    );
    note.push(`| ${mode}: model load, timed on a warm-up query | ${v.modelLoadMs} ms |`);
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
      "| Mode | Sample | Question | Style | Gold rank | First hit | Lexical string qmd or the ladder ran |\n|---|---|---|---|---|---|---|",
    );
    for (const r of modeRows) {
      if (r.rank !== 1)
        note.push(
          `| ${r.mode} | ${r.sample} | ${r.id} | ${r.style} | ${r.rank ?? "miss"} | ${r.top5[0] ? `\`${r.top5[0]}\`` : "(no hits)"} | ${r.lexString ?? ""} |`,
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
