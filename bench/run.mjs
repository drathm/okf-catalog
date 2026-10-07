#!/usr/bin/env node
// The lexical benchmark. Loads the public corpus as one bundle, indexes it through the qmd adapter, and runs the
// questions in seven configurations: the question text or its keyword form with the relaxed rung on or off, and
// the question text with the gold page's topic as the filter, with its type as the filter, and with a relaxed
// per-term pool of 100. Writes one JSON line per question per configuration, a per-style summary, paired
// comparisons, and the run's metadata under bench/results/ (gitignored). Build first: npm run build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle } from "../dist/bundle/load.js";
import { DEFAULT_CAPS } from "../dist/bundle/model.js";
import { folderOf } from "../dist/bundle/paths.js";
import { deriveDocument } from "../dist/derive/derived-document.js";
import { QmdEngine } from "../dist/engine/qmd.js";
import { walkBundle } from "../dist/fs/walk.js";
import { STOPWORDS } from "../dist/search/query.js";
import { search } from "../dist/search/search.js";

process.env.NODE_LLAMA_CPP_SKIP_DOWNLOAD = "1";
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const corpus = join(here, "corpus");
if (!existsSync(corpus)) {
  process.stderr.write("no corpus: run bench/fetch-corpus.sh first\n");
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const resultsDir = join(here, "results");
const work = join(here, ".work", stamp);
mkdirSync(resultsDir, { recursive: true });
mkdirSync(work, { recursive: true });

const NOW = new Date("2026-10-06T12:00:00Z");
const CORPUS_REPOS = ["okf-skills", "okf-agent-memory", "cole-medin", "superops-okf"];
const questions = JSON.parse(readFileSync(join(here, "questions.json"), "utf8"));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const git = (args, cwd) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
};

const caps = { ...DEFAULT_CAPS, files: 50_000 };
const walked = walkBundle(corpus, caps);
const options = {
  admit: ["draft", "stable", "deprecated"],
  dev: true,
  integrity: "none",
  specText: "2026-08-15",
  caps,
  walkRefusals: walked.refusals,
  hiddenPaths: walked.hidden,
  hiddenFolders: walked.hiddenFolders,
};
if (walked.fatal !== undefined) options.walkFatal = walked.fatal;
const { catalog, report } = loadBundle("bench", walked.files, options, NOW);
const docs = [...catalog.pages.values()].map(deriveDocument);
const engine = await QmdEngine.open({ company: "bench", dir: work });
const indexStarted = performance.now();
const indexed = await engine.index(docs);
const indexMs = Math.round(performance.now() - indexStarted);

// Each configuration: the request built from a question, and the text form it uses.
const CONFIGS = [
  { key: "question/relaxed", form: "question", request: () => ({ relax: true }) },
  { key: "question/strict", form: "question", request: () => ({ relax: false }) },
  { key: "keywords/relaxed", form: "keywords", request: () => ({ relax: true }) },
  { key: "keywords/strict", form: "keywords", request: () => ({ relax: false }) },
  {
    key: "question/relaxed+topic",
    form: "question",
    request: (q) => ({ relax: true, topic: folderOf(q.gold) }),
  },
  {
    key: "question/relaxed+type",
    form: "question",
    request: (q) => ({ relax: true, type: catalog.pages.get(q.gold)?.type }),
  },
  {
    key: "question/relaxed+pool100",
    form: "question",
    request: () => ({ relax: true, relaxedPool: 100 }),
  },
];

const lines = [];
const ranks = new Map();
for (const config of CONFIGS) {
  const outcomes = new Map();
  ranks.set(config.key, outcomes);
  for (const q of questions) {
    const text = config.form === "question" ? q.question : q.keywords.join(" ");
    const extra = config.request(q);
    const started = performance.now();
    const r = await search(
      catalog,
      engine,
      { question: text, includeStale: true, limit: 5, ...extra },
      NOW,
    );
    const ms = Math.round((performance.now() - started) * 10) / 10;
    const position = r.hits.findIndex((h) => h.path === q.gold);
    const rank = position === -1 ? null : position + 1;
    outcomes.set(q.id, rank);
    lines.push(
      JSON.stringify({
        config: config.key,
        id: q.id,
        style: q.style,
        filter: {
          topic: extra.topic ?? null,
          type: extra.type ?? null,
          relaxedPool: extra.relaxedPool ?? null,
        },
        terms: r.terms,
        dropped: r.dropped,
        rung: r.strategy,
        rank,
        top5: r.hits.map((h) => h.path),
        considered: r.considered,
        pool: r.pool,
        topicExhausted: r.topicExhausted,
        ms,
      }),
    );
  }
}

const row = (s) => ({
  n: s.n,
  "hit@1": s.hit1,
  "hit@3": s.hit3,
  "MRR@5": Math.round((s.rr / s.n) * 1000) / 1000,
});
const summary = {};
for (const [key, outcomes] of ranks) {
  const styles = {};
  for (const q of questions) {
    const rank = outcomes.get(q.id);
    const s = styles[q.style] ?? { n: 0, hit1: 0, hit3: 0, rr: 0 };
    s.n += 1;
    if (rank === 1) s.hit1 += 1;
    if (rank !== null && rank <= 3) s.hit3 += 1;
    if (rank !== null) s.rr += 1 / rank;
    styles[q.style] = s;
  }
  const all = Object.values(styles).reduce(
    (acc, s) => ({
      n: acc.n + s.n,
      hit1: acc.hit1 + s.hit1,
      hit3: acc.hit3 + s.hit3,
      rr: acc.rr + s.rr,
    }),
    { n: 0, hit1: 0, hit3: 0, rr: 0 },
  );
  summary[key] = {
    all: row(all),
    ...Object.fromEntries(Object.entries(styles).map(([k, s]) => [k, row(s)])),
  };
}

// Paired by question on the gold rank (a miss ranks as 99): the first configuration against the second.
const pair = (a, b) => {
  const tally = { better: 0, worse: 0, same: 0, changed: [] };
  for (const q of questions) {
    const x = ranks.get(a).get(q.id) ?? 99;
    const y = ranks.get(b).get(q.id) ?? 99;
    if (x < y) tally.better += 1;
    else if (x > y) tally.worse += 1;
    else tally.same += 1;
    if (x !== y)
      tally.changed.push({ id: q.id, [a]: ranks.get(a).get(q.id), [b]: ranks.get(b).get(q.id) });
  }
  return tally;
};
const paired = {
  "question: relaxed vs strict": pair("question/relaxed", "question/strict"),
  "keywords: relaxed vs strict": pair("keywords/relaxed", "keywords/strict"),
  "question: topic filter vs none": pair("question/relaxed+topic", "question/relaxed"),
  "question: type filter vs none": pair("question/relaxed+type", "question/relaxed"),
  "question: relaxed pool 100 vs the first rung's pool": pair(
    "question/relaxed+pool100",
    "question/relaxed",
  ),
};

const byBundle = {};
for (const f of walked.files) {
  const top = f.path.split("/")[0];
  byBundle[top] = byBundle[top] ?? { walked: 0, admitted: 0, questions: 0 };
  byBundle[top].walked += 1;
}
for (const path of catalog.pages.keys()) byBundle[path.split("/")[0]].admitted += 1;
for (const q of questions) byBundle[q.gold.split("/")[0]].questions += 1;

// Dirty means tracked files differ from HEAD. Untracked files are ignored, and so is the rendered note, which
// `bench/report.mjs` rewrites from this run and which is therefore never the code that produced it.
const porcelain = (git(["status", "--porcelain", "--untracked-files=no"], repo) ?? "")
  .split("\n")
  .filter((line) => line.length > 0 && !line.endsWith("docs/research/benchmark-lexical.md"))
  .join("\n");
const meta = {
  ran: new Date().toISOString(),
  clock: NOW.toISOString(),
  request: { includeStale: true, limit: 5 },
  load: { admit: options.admit, dev: true, integrity: "none", specText: options.specText },
  okfCatalog: {
    commit: git(["rev-parse", "HEAD"], repo),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], repo),
    dirty: porcelain.length > 0,
    diffSha256: porcelain.length > 0 ? sha256(git(["diff", "HEAD"], repo) ?? "") : null,
  },
  node: process.version,
  os: `${process.platform} ${process.arch}`,
  qmd: JSON.parse(
    readFileSync(join(repo, "node_modules", "@tobilu", "qmd", "package.json"), "utf8"),
  ).version,
  questionsSha256: sha256(readFileSync(join(here, "questions.json"))),
  stopwordsSha256: sha256([...STOPWORDS].sort().join(" ")),
  corpus: Object.fromEntries(
    CORPUS_REPOS.map((name) => [name, git(["rev-parse", "HEAD"], join(here, "clones", name))]),
  ),
  pages: {
    walked: walked.files.length,
    admitted: report.admitted,
    refused: report.refusals.length,
    goldAdmitted: questions.filter((q) => catalog.pages.has(q.gold)).length,
    questions: questions.length,
    byBundle,
  },
  index: {
    documents: indexed.documents,
    notIndexed: indexed.notIndexed.length,
    encodedFolders: indexed.encodedFolders,
    ms: indexMs,
    dbBytes: statSync(join(work, "index.sqlite")).size,
  },
  memory: {
    rssAfterBytes: process.memoryUsage().rss,
    heapUsedBytes: process.memoryUsage().heapUsed,
  },
};
const result = { meta, summary, paired };
writeFileSync(join(resultsDir, `${stamp}.jsonl`), `${lines.join("\n")}\n`);
writeFileSync(join(resultsDir, `${stamp}.summary.json`), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
await engine.close();
