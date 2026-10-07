#!/usr/bin/env node
// The lexical benchmark. Loads the public corpus as one bundle, indexes it through the qmd adapter, and runs the
// questions in four configurations: the question text or its keyword form, with the relaxed rung on or off.
// Writes one JSON line per question per configuration, a per-style summary, the paired relaxed-versus-strict
// outcome, and the run's metadata under bench/results/ (gitignored). Build first: npm run build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle } from "../dist/bundle/load.js";
import { DEFAULT_CAPS } from "../dist/bundle/model.js";
import { deriveDocument } from "../dist/derive/derived-document.js";
import { QmdEngine } from "../dist/engine/qmd.js";
import { walkBundle } from "../dist/fs/walk.js";
import { STOPWORDS } from "../dist/search/query.js";
import { search } from "../dist/search/search.js";

process.env.NODE_LLAMA_CPP_SKIP_DOWNLOAD = "1";
const here = dirname(fileURLToPath(import.meta.url));
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
const FORMS = ["question", "keywords"];
const questions = JSON.parse(readFileSync(join(here, "questions.json"), "utf8"));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const gitHead = (cwd) => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};
const configKey = (form, relax) => `${form}/${relax ? "relaxed" : "strict"}`;

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
};
if (walked.fatal !== undefined) options.walkFatal = walked.fatal;
const { catalog, report } = loadBundle("bench", walked.files, options, NOW);
const docs = [...catalog.pages.values()].map(deriveDocument);
const engine = await QmdEngine.open({ company: "bench", dir: work });
const indexStarted = performance.now();
const indexed = await engine.index(docs);
const indexMs = Math.round(performance.now() - indexStarted);

const lines = [];
const byConfig = new Map();
for (const form of FORMS) {
  for (const relax of [true, false]) {
    const key = configKey(form, relax);
    const outcomes = new Map();
    byConfig.set(key, outcomes);
    for (const q of questions) {
      const text = form === "question" ? q.question : q.keywords.join(" ");
      const started = performance.now();
      const r = await search(
        catalog,
        engine,
        { question: text, includeStale: true, limit: 5, relax },
        NOW,
      );
      const ms = Math.round((performance.now() - started) * 10) / 10;
      const position = r.hits.findIndex((h) => h.path === q.gold);
      const rank = position === -1 ? null : position + 1;
      outcomes.set(q.id, rank);
      lines.push(
        JSON.stringify({
          config: key,
          id: q.id,
          style: q.style,
          terms: r.terms,
          dropped: r.dropped,
          rung: r.strategy,
          rank,
          top5: r.hits.map((h) => h.path),
          considered: r.considered,
          pool: r.pool,
          ms,
        }),
      );
    }
  }
}

const summary = {};
for (const [key, outcomes] of byConfig) {
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
  const row = (s) => ({
    n: s.n,
    "hit@1": s.hit1,
    "hit@3": s.hit3,
    "MRR@5": Math.round((s.rr / s.n) * 1000) / 1000,
  });
  summary[key] = {
    all: row(all),
    ...Object.fromEntries(Object.entries(styles).map(([k, s]) => [k, row(s)])),
  };
}

// Relaxation on versus off, per form, paired by question on the gold rank (a miss ranks as 99).
const paired = {};
for (const form of FORMS) {
  const on = byConfig.get(configKey(form, true));
  const off = byConfig.get(configKey(form, false));
  const tally = { relaxedWins: 0, relaxedLosses: 0, ties: 0, changed: [] };
  for (const q of questions) {
    const a = on.get(q.id) ?? 99;
    const b = off.get(q.id) ?? 99;
    if (a < b) tally.relaxedWins += 1;
    else if (a > b) tally.relaxedLosses += 1;
    else tally.ties += 1;
    if (a !== b) tally.changed.push({ id: q.id, relaxed: on.get(q.id), strict: off.get(q.id) });
  }
  paired[form] = tally;
}

const meta = {
  ran: new Date().toISOString(),
  clock: NOW.toISOString(),
  request: { includeStale: true, limit: 5 },
  load: { admit: options.admit, dev: true, integrity: "none", specText: options.specText },
  okfCatalogCommit: gitHead(here),
  node: process.version,
  os: `${process.platform} ${process.arch}`,
  qmd: JSON.parse(
    readFileSync(join(here, "..", "node_modules", "@tobilu", "qmd", "package.json"), "utf8"),
  ).version,
  questionsSha256: sha256(readFileSync(join(here, "questions.json"))),
  stopwordsSha256: sha256([...STOPWORDS].sort().join(" ")),
  corpus: Object.fromEntries(
    CORPUS_REPOS.map((name) => [name, gitHead(join(here, "clones", name))]),
  ),
  pages: {
    walked: walked.files.length,
    admitted: report.admitted,
    refused: report.refusals.length,
    goldAdmitted: questions.filter((q) => catalog.pages.has(q.gold)).length,
    questions: questions.length,
  },
  index: {
    documents: indexed.documents,
    notIndexed: indexed.notIndexed.length,
    encodedFolders: indexed.encodedFolders,
    ms: indexMs,
    dbBytes: statSync(join(work, "index.sqlite")).size,
  },
};
meta.memory = {
  rssAfterBytes: process.memoryUsage().rss,
  heapUsedBytes: process.memoryUsage().heapUsed,
};
const result = { meta, summary, paired };
writeFileSync(join(resultsDir, `${stamp}.jsonl`), `${lines.join("\n")}\n`);
writeFileSync(join(resultsDir, `${stamp}.summary.json`), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
await engine.close();
