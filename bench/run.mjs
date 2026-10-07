#!/usr/bin/env node
// The benchmark. Loads the public corpus (or a bundle named with --bundle and its --config) as one bundle,
// indexes it through the qmd adapter, and runs the questions in the seven lexical configurations: the question
// text or its keyword form with the relaxed rung on or off, and the question text with the gold page's topic
// as the filter, with its type as the filter, and with a relaxed per-term pool of 100. With --modes it then
// opens qmd's store itself over the same index and runs the modes decision D7 waits for: `vector` (the
// embedding model alone), `fused` (okf-catalog's production ladder fused with the vectors by reciprocal rank
// in this harness), `hybrid` (qmd's own pipeline without the reranker) and `full` (qmd's pipeline with it).
// The models are never downloaded here: they must already be in bench/.models/, put there by
// bench/pull-models.mjs, which is the maintainer's approval (invariant 6). Writes one JSON line per question
// per configuration, a summary with the run's metadata, and nothing else; the work folder is removed at the
// end. Build first: npm run build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { approvalText, MODELS, MODES, missingModels, modelPath, modelsFor } from "./lib/models.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const EXIT_USAGE = 2;
const EXIT_MODELS_MISSING = 3;
const EXIT_MODES_REFUSED = 4;
const EXIT_MODES_FAILED = 5;

// --- arguments ---------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const flag = (name) => argv.includes(name);
const modes = (option("--modes") ?? "").split(",").filter((m) => m.length > 0);
const bundleDir = option("--bundle");
const configPath = option("--config");
const questionsPath = option("--questions") ?? join(here, "questions.json");
const outDir = option("--out");
const stubEmbedder = flag("--stub-embedder");
const samples = Number(option("--samples") ?? 3);
const fail = (code, message) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
for (const mode of modes) if (MODES[mode] === undefined) fail(EXIT_USAGE, `unknown mode ${mode}`);
if (!Number.isInteger(samples) || samples < 1)
  fail(EXIT_USAGE, "--samples must be a positive integer");
if (bundleDir !== undefined && configPath === undefined)
  fail(
    EXIT_USAGE,
    "--bundle needs --config (the company configuration naming its admission and types)",
  );
if (bundleDir !== undefined) {
  if (outDir === undefined)
    fail(EXIT_USAGE, "--bundle needs --out, a folder outside this checkout");
  const rel = relative(resolve(repo), resolve(outDir));
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    fail(
      EXIT_USAGE,
      "--out must lie outside this checkout for a bundle that is not the public corpus",
    );
  }
}

// --- the modes' environment, settled before qmd is imported ------------------------------------------------
// qmd reads its three model variables when it constructs an LLM instance and the Metal residency variable when
// its native binding loads; both happen after the imports below, but nothing is left to ordering: the
// variables are set here, first, and refused when something else set them already.
const MODELS_DIR = resolve(option("--models-dir") ?? join(here, ".models"));
const modelMeta = [];
if (modes.length > 0) {
  // A preset model variable would send qmd to a file this harness never checked; a preset GPU variable could
  // steer qmd's own runtime load away from the packaged binary and into a source build.
  const guarded = [
    ...MODELS.map((m) => m.variable),
    "CI",
    "QMD_LLAMA_GPU",
    "QMD_FORCE_CPU",
    "NODE_LLAMA_CPP_GPU",
  ];
  const preset = guarded.filter((v) => process.env[v] !== undefined);
  if (preset.length > 0) {
    fail(
      EXIT_MODES_REFUSED,
      `refusing to measure with ${preset.join(", ")} set: qmd would read a model, refuse model work or load a runtime this harness did not check`,
    );
  }
  process.env.GGML_METAL_NO_RESIDENCY = "1";
  if (stubEmbedder) {
    process.env.QMD_EMBED_MODEL = "stub:bag-of-words-64";
    process.env.QMD_RERANK_MODEL = join(MODELS_DIR, "no-reranker-under-the-stub.gguf");
    process.env.QMD_GENERATE_MODEL = join(MODELS_DIR, "no-expansion-model-under-the-stub.gguf");
  } else {
    const statFor = (path) => {
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        return undefined;
      }
      const head = new Uint8Array(4);
      if (stat.isFile()) {
        const fd = openSync(path, "r");
        try {
          readSync(fd, head, 0, 4, 0);
        } finally {
          closeSync(fd);
        }
      }
      return { isFile: stat.isFile(), size: stat.size, head };
    };
    const missing = missingModels(MODELS_DIR, modes, statFor);
    if (missing.length > 0) {
      process.stderr.write(approvalText(missing, MODELS_DIR));
      process.exit(EXIT_MODELS_MISSING);
    }
    // The files the modes need are hashed, so a different GGUF of the pinned size cannot pass as the pinned one.
    const sha256File = (path) =>
      new Promise((resolveHash, reject) => {
        const hash = createHash("sha256");
        createReadStream(path)
          .on("data", (chunk) => hash.update(chunk))
          .on("end", () => resolveHash(hash.digest("hex")))
          .on("error", reject);
      });
    const needed = new Set(modelsFor(modes).map((m) => m.key));
    for (const entry of MODELS) {
      const path = modelPath(MODELS_DIR, entry);
      // Every model variable is set, so a model no mode asked for resolves to a missing file that throws,
      // never to qmd's default `hf:` URI, which would download.
      process.env[entry.variable] = path;
      if (!needed.has(entry.key)) continue;
      const digest = await sha256File(path);
      if (digest !== entry.sha256) {
        fail(
          EXIT_MODELS_MISSING,
          `${path} is not the pinned ${entry.key}: sha256 ${digest}, expected ${entry.sha256}; remove it and run node bench/pull-models.mjs ${entry.key}`,
        );
      }
      modelMeta.push({
        key: entry.key,
        uri: entry.uri,
        path,
        bytes: entry.bytes,
        sha256: digest,
        revision: entry.revision,
      });
    }
  }
}

// --- the runtime, imported only now ------------------------------------------------------------------------
if (!existsSync(join(repo, "dist", "cli.js")))
  fail(EXIT_USAGE, "dist/ is missing: run npm run build first");
process.env.NODE_LLAMA_CPP_SKIP_DOWNLOAD = "1";
const { loadBundle } = await import("../dist/bundle/load.js");
const { DEFAULT_CAPS } = await import("../dist/bundle/model.js");
const { folderOf } = await import("../dist/bundle/paths.js");
const { parseCompanyConfig } = await import("../dist/config/company-config.js");
const { deriveDocument } = await import("../dist/derive/derived-document.js");
const { QmdEngine } = await import("../dist/engine/qmd.js");
const { decodePath, encodePath } = await import("../dist/engine/qmd-render.js");
const { walkBundle } = await import("../dist/fs/walk.js");
const { STOPWORDS } = await import("../dist/search/query.js");
const { search } = await import("../dist/search/search.js");

const corpus = bundleDir === undefined ? join(here, "corpus") : resolve(bundleDir);
if (!existsSync(corpus))
  fail(
    EXIT_USAGE,
    bundleDir === undefined
      ? "no corpus: run bench/fetch-corpus.sh first"
      : `no bundle at ${corpus}`,
  );
// The runner imports dist/; a stale build would measure code that is not the tree's. Refuse to run one.
const newestSource = (dir) => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const at = entry.isDirectory() ? newestSource(path) : statSync(path).mtimeMs;
    if (at > newest) newest = at;
  }
  return newest;
};
if (newestSource(join(repo, "src")) > statSync(join(repo, "dist", "cli.js")).mtimeMs)
  fail(EXIT_USAGE, "dist/ is older than src/: run npm run build first");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const resultsDir = outDir === undefined ? join(here, "results") : resolve(outDir);
mkdirSync(resultsDir, { recursive: true });
// The work folder (the derived tree, the store, qmd's own cache folder) lives under the system temp folder,
// never inside the checkout, with a name of its own, and goes away on a signal as on a normal end.
const work = mkdtempSync(join(tmpdir(), "okf-catalog-bench-"));
const removeWork = () => rmSync(work, { recursive: true, force: true });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    removeWork();
    process.exit(130);
  });
}
if (modes.length > 0) process.env.XDG_CACHE_HOME = join(work, "xdg");
const jsonlPath = join(resultsDir, `${stamp}.jsonl`);
writeFileSync(jsonlPath, "");
const emit = (row) => appendFileSync(jsonlPath, `${JSON.stringify(row)}\n`);

const NOW = new Date("2026-10-06T12:00:00Z");
const CORPUS_REPOS = ["okf-skills", "okf-agent-memory", "cole-medin", "superops-okf"];
const questions = JSON.parse(readFileSync(questionsPath, "utf8"));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const git = (args, cwd) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
};
const rss = () => process.memoryUsage().rss;
const memory = { afterLoad: 0, afterIndex: 0, afterLexical: 0, afterEmbed: 0, afterModes: 0 };

// --- load and index ----------------------------------------------------------------------------------------
let caps = { ...DEFAULT_CAPS, files: 50_000 };
let options;
let company = null;
if (configPath === undefined) {
  options = {
    admit: ["draft", "stable", "deprecated"],
    dev: true,
    integrity: "none",
    specText: "2026-08-15",
  };
} else {
  const parsed = parseCompanyConfig(
    readFileSync(configPath, "utf8"),
    dirname(resolve(configPath)),
    homedir(),
  );
  if (!parsed.ok) fail(EXIT_USAGE, `configuration: ${parsed.problems.join("; ")}`);
  company = parsed.config;
  caps = company.caps;
  options = {
    admit: company.serve.dev ? [...company.serve.admit, "draft"] : company.serve.admit,
    dev: company.serve.dev,
    integrity: company.integrity,
    specText: company.specText,
  };
  if (company.types !== undefined) options.types = company.types;
}
const walked = walkBundle(corpus, caps);
options = {
  ...options,
  caps,
  walkRefusals: walked.refusals,
  hiddenPaths: walked.hidden,
  hiddenFolders: walked.hiddenFolders,
};
if (walked.fatal !== undefined) options.walkFatal = walked.fatal;
const { catalog, report } = loadBundle("bench", walked.files, options, NOW);
if (report.fatal !== undefined)
  fail(EXIT_USAGE, `the bundle was refused: ${report.fatal.rule} ${report.fatal.path}`);
memory.afterLoad = rss();
const docs = [...catalog.pages.values()].map(deriveDocument);
const engine = await QmdEngine.open({ company: "bench", dir: work });
const indexStarted = performance.now();
const indexed = await engine.index(docs);
const indexMs = Math.round(performance.now() - indexStarted);
memory.afterIndex = rss();

// --- the lexical configurations ----------------------------------------------------------------------------
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
  // The ladder twenty deep, cut to five for the rank: the control for the fusion mode, which fuses this list.
  { key: "question/relaxed@20", form: "question", limit: 20, request: () => ({ relax: true }) },
];
const policyLists = new Map();
/** Content terms of the question (as the ladder sent them) that the gold page's own text carries. */
const sharedTerms = new Map();
const tokensOf = (text) =>
  new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w));
const textOf = (q, form) => (form === "question" ? q.question : q.keywords.join(" "));
const ranks = new Map();
for (const config of CONFIGS) {
  const outcomes = new Map();
  ranks.set(config.key, outcomes);
  for (const q of questions) {
    const text = textOf(q, config.form);
    const extra = config.request(q);
    const started = performance.now();
    const r = await search(
      catalog,
      engine,
      { question: text, includeStale: true, limit: config.limit ?? 5, ...extra },
      NOW,
    );
    const ms = Math.round((performance.now() - started) * 10) / 10;
    const position = r.hits.slice(0, 5).findIndex((h) => h.path === q.gold);
    const rank = position === -1 ? null : position + 1;
    outcomes.set(q.id, rank);
    if (config.key === "question/relaxed@20") {
      policyLists.set(q.id, { paths: r.hits.map((h) => h.path), terms: r.terms });
    }
    if (config.key === "question/relaxed") {
      const page = catalog.pages.get(q.gold);
      const pageTokens = tokensOf(
        `${page?.title ?? ""} ${page?.description ?? ""} ${page?.body ?? ""}`,
      );
      sharedTerms.set(q.id, r.terms.filter((term) => pageTokens.has(term.toLowerCase())).length);
    }
    emit({
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
      top5: r.hits.slice(0, 5).map((h) => h.path),
      considered: r.considered,
      pool: r.pool,
      engineQueries: r.engineQueries,
      rowsFetched: r.rowsFetched,
      floored: r.floored,
      topicExhausted: r.topicExhausted,
      ms,
    });
  }
}
memory.afterLexical = rss();
await engine.close();

// --- summaries ---------------------------------------------------------------------------------------------
const row = (s) => ({
  n: s.n,
  "hit@1": s.hit1,
  "hit@3": s.hit3,
  "MRR@5": Math.round((s.rr / s.n) * 1000) / 1000,
});
const summarise = (outcomes) => {
  const styles = {};
  for (const q of questions) {
    const rank = outcomes.get(q.id) ?? null;
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
  return {
    all: row(all),
    ...Object.fromEntries(Object.entries(styles).map(([k, s]) => [k, row(s)])),
  };
};
const summary = {};
for (const [key, outcomes] of ranks) summary[key] = summarise(outcomes);
// Paired by question on the gold rank (a miss ranks as 99): the first configuration against the second.
const pairOutcomes = (a, b) => {
  const tally = { better: 0, worse: 0, same: 0, changed: [] };
  for (const q of questions) {
    const x = a.get(q.id) ?? 99;
    const y = b.get(q.id) ?? 99;
    if (x < y) tally.better += 1;
    else if (x > y) tally.worse += 1;
    else tally.same += 1;
    if (x !== y)
      tally.changed.push({ id: q.id, first: a.get(q.id) ?? null, second: b.get(q.id) ?? null });
  }
  return tally;
};
const pair = (a, b) => pairOutcomes(ranks.get(a), ranks.get(b));
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

// --- the modes ---------------------------------------------------------------------------------------------
let modesResult = null;
if (modes.length > 0) {
  const captured = [];
  const FALLBACK = [
    /Embedding error/i,
    /fallback/i,
    /Session expired/i,
    /Error rate too high/i,
    /aborting embedding/i,
    /disabled in CI/i,
    /Reranker unavailable/i,
    /expansion failed/i,
  ];
  const original = {
    warn: console.warn,
    error: console.error,
    log: console.log,
    info: console.info,
  };
  for (const level of Object.keys(original)) {
    console[level] = (...parts) => {
      captured.push(`${level}: ${parts.map(String).join(" ")}`);
    };
  }
  const restoreConsole = () => Object.assign(console, original);
  const qmdIndexPath = fileURLToPath(import.meta.resolve("@tobilu/qmd"));
  const qmdDir = dirname(qmdIndexPath);
  let store;
  let llama = null;
  try {
    const { createStore } = await import("@tobilu/qmd");
    const storeModule = await import(pathToFileURL(join(qmdDir, "store.js")).href);
    const llmModule = await import(pathToFileURL(join(qmdDir, "llm.js")).href);
    // With the llama folder marked unwritable, qmd's own runtime load passes build: "never" and skipDownload:
    // true to node-llama-cpp, so a packaged binary that fails to load stops the run instead of starting a
    // source build (which would clone llama.cpp through a child process).
    llmModule.setLlamaDirWritableForTest(false);
    let stub = null;
    if (stubEmbedder) {
      const { installStub } = await import("./lib/stub-llm.mjs");
      stub = await installStub();
    } else {
      // A prebuilt binary that cannot load must stop the run here, before qmd could build one from source.
      const nlc = await import("node-llama-cpp");
      llama = await nlc.getLlama({
        build: "never",
        skipDownload: true,
        logLevel: nlc.LlamaLogLevel.error,
        progressLogs: false,
      });
    }
    const dbPath = join(work, "index.sqlite");
    const dbBytesBefore = statSync(dbPath).size;
    store = await createStore({
      dbPath,
      config: { collections: { bench: { path: join(work, "derived"), pattern: "**/*.md" } } },
    });
    if (stub !== null) stub.intoStore(store);
    const llm = store.internal.llm;
    // One known displayPath decoded against a known gold path before any mode is trusted.
    const decodeDisplay = (displayPath) => {
      const slash = displayPath.indexOf("/");
      if (slash === -1 || displayPath.slice(0, slash) !== "bench") return undefined;
      return decodePath(displayPath.slice(slash + 1));
    };
    const probe = await store.multiGet("bench/**", { limit: 1 });
    const probePath = probe.docs[0]?.doc.displayPath;
    const probeDecoded = probePath === undefined ? undefined : decodeDisplay(probePath);
    if (probeDecoded === undefined || !catalog.pages.has(probeDecoded)) {
      throw new Error(`the display path ${probePath} does not decode to a served page`);
    }
    const known = questions[0]?.gold;
    if (known !== undefined && decodeDisplay(`bench/${encodePath(known)}`) !== known) {
      throw new Error(`the codec does not round-trip ${known}`);
    }
    const embedStarted = performance.now();
    const embedded = await store.embed({ collection: "bench" });
    const embedMs = Math.round(performance.now() - embedStarted);
    const status = await store.getStatus();
    if (embedded.errors !== 0 || !status.hasVectorIndex || status.needsEmbedding !== 0) {
      throw new Error(
        `embedding incomplete: ${embedded.errors} errors, vector index ${status.hasVectorIndex}, ${status.needsEmbedding} still to embed`,
      );
    }
    memory.afterEmbed = rss();
    const dbBytesAfterEmbed = statSync(dbPath).size;
    const cacheRows = () => {
      try {
        return store.internal.db.prepare("SELECT count(*) AS n FROM llm_cache").get().n;
      } catch {
        return null;
      }
    };
    const distinct = (paths, n) => {
      const seen = new Set();
      const out = [];
      for (const p of paths) {
        if (p === undefined || seen.has(p)) continue;
        seen.add(p);
        out.push(p);
        if (out.length === n) break;
      }
      return out;
    };
    const vectorPaths = async (text) => {
      const rows = await store.searchVector(text, { collection: "bench", limit: 20 });
      return distinct(
        rows.map((r) => decodeDisplay(r.displayPath)),
        20,
      );
    };
    const RRF_K = 60;
    const fuse = (lists) => {
      const scores = new Map();
      const first = new Map();
      for (const [li, list] of lists.entries()) {
        for (const [i, p] of list.entries()) {
          scores.set(p, (scores.get(p) ?? 0) + 1 / (RRF_K + i + 1));
          if (!first.has(p)) first.set(p, li * 1000 + i);
        }
      }
      return [...scores.entries()]
        .sort((a, b) => b[1] - a[1] || first.get(a[0]) - first.get(b[0]))
        .map(([p]) => p);
    };
    const qmdPipeline = async (text, skipRerank) => {
      const trace = { expansions: null, strongSignal: null, expandMs: null, rerankMs: null };
      const results = await storeModule.hybridQuery(store.internal, text, {
        collection: ["bench"],
        limit: 5,
        skipRerank,
        explain: true,
        hooks: {
          onStrongSignal: (score) => {
            trace.strongSignal = score;
          },
          onExpand: (_original, expanded, ms) => {
            trace.expansions = expanded.map((e) => ({ type: e.type, query: e.query }));
            trace.expandMs = ms;
          },
          onRerankDone: (ms) => {
            trace.rerankMs = ms;
          },
        },
      });
      const lists = new Set();
      const ftsQueries = new Set();
      for (const r of results) {
        for (const c of r.explain?.rrf?.contributions ?? []) {
          lists.add(`${c.source}:${c.queryType}:${c.query}`);
          if (c.source === "fts") ftsQueries.add(c.query);
        }
      }
      // qmd degrades without throwing: an expansion that came back empty (with no strong-signal shortcut), a
      // reranker that never ran, or one that scored every candidate 0.5 (its own fallback) fail the run.
      if (trace.strongSignal === null && (trace.expansions ?? []).length === 0) {
        throw new Error(
          `qmd expanded ${JSON.stringify(text)} to nothing without a strong signal: the expansion model fell back`,
        );
      }
      if (!skipRerank) {
        if (trace.rerankMs === null)
          throw new Error(`the reranker never ran for ${JSON.stringify(text)}`);
        const scores = results.map((r) => r.explain?.rerankScore);
        if (scores.length > 1 && scores.every((s) => s === 0.5)) {
          throw new Error(
            `every candidate of ${JSON.stringify(text)} scored 0.5: the reranker fell back`,
          );
        }
      }
      return {
        paths: results.map((r) => decodeDisplay(r.displayPath)),
        trace,
        lists: [...lists],
        lexString: [...ftsQueries].join(" | "),
      };
    };
    const runs = [];
    const modeSamples = (mode) => (mode === "hybrid" || mode === "full" ? samples : 1);
    const modeLoad = {};
    for (const mode of modes) {
      // The first call of a mode loads its models; timed apart from the questions, on a query no question uses.
      store.internal.clearCache();
      const loadStarted = performance.now();
      if (mode === "vector" || mode === "fused") await vectorPaths("warm up the embedding model");
      else await qmdPipeline("warm up the language models", mode === "hybrid");
      modeLoad[mode] = Math.round(performance.now() - loadStarted);
      for (let sample = 1; sample <= modeSamples(mode); sample += 1) {
        store.internal.clearCache();
        const outcomes = new Map();
        for (const q of questions) {
          const started = performance.now();
          let top5;
          let extra = {};
          if (mode === "vector") {
            top5 = (await vectorPaths(q.question)).slice(0, 5);
          } else if (mode === "fused") {
            const policy = policyLists.get(q.id) ?? { paths: [], terms: [] };
            const vec = await vectorPaths(q.question);
            top5 = fuse([policy.paths, vec]).slice(0, 5);
            extra = {
              lexString: policy.terms.join(" "),
              lists: { policy: policy.paths.length, vector: vec.length },
            };
          } else {
            const r = await qmdPipeline(q.question, mode === "hybrid");
            top5 = distinct(r.paths, 5);
            extra = { lexString: r.lexString, trace: r.trace, lists: r.lists };
          }
          const ms = Math.round((performance.now() - started) * 10) / 10;
          const position = top5.indexOf(q.gold);
          const rank = position === -1 ? null : position + 1;
          outcomes.set(q.id, rank);
          emit({
            mode,
            sample,
            id: q.id,
            style: q.style,
            shared: sharedTerms.get(q.id) ?? null,
            rank,
            top5,
            ms,
            ...extra,
          });
        }
        runs.push({ mode, sample, outcomes });
      }
    }
    memory.afterModes = rss();
    const fallbacks = captured.filter((line) => FALLBACK.some((p) => p.test(line)));
    if (fallbacks.length > 0)
      throw new Error(`qmd fell back during the run: ${fallbacks.join(" | ")}`);
    const stats = (values) => {
      const s = [...values].sort((a, b) => a - b);
      const median =
        s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
      return { min: s[0], median, max: s[s.length - 1] };
    };
    const perMode = {};
    for (const mode of modes) {
      const own = runs.filter((r) => r.mode === mode);
      const summaries = own.map((r) => summarise(r.outcomes));
      const against = {};
      for (const base of [
        "question/relaxed",
        "question/relaxed@20",
        "question/strict",
        "keywords/relaxed",
      ]) {
        against[base] = own.map((r) => pairOutcomes(r.outcomes, ranks.get(base)));
      }
      const spread = {};
      for (const q of questions) {
        const rs = own.map((r) => r.outcomes.get(q.id) ?? null);
        spread[q.id] = rs;
      }
      const metric = (pick) => stats(summaries.map((s) => pick(s)));
      perMode[mode] = {
        samples: own.length,
        modelLoadMs: modeLoad[mode],
        each: summaries,
        overall: {
          "hit@1": metric((s) => s.all["hit@1"]),
          "hit@3": metric((s) => s.all["hit@3"]),
          "MRR@5": metric((s) => s.all["MRR@5"]),
        },
        byStyle: Object.fromEntries(
          [...new Set(questions.map((q) => q.style))].map((style) => [
            style,
            {
              "hit@1": metric((s) => s[style]?.["hit@1"] ?? 0),
              "hit@3": metric((s) => s[style]?.["hit@3"] ?? 0),
              "MRR@5": metric((s) => s[style]?.["MRR@5"] ?? 0),
            },
          ]),
        ),
        paired: against,
        questionsWhoseRankVaried: Object.values(spread).filter((rs) => new Set(rs).size > 1).length,
        rankSpread: spread,
      };
    }
    let device = null;
    try {
      device = stubEmbedder ? { stub: true } : await llm.getDeviceInfo({ allowBuild: false });
    } catch (error) {
      device = { error: error.message };
    }
    modesResult = {
      requested: modes,
      samplesRequested: samples,
      stub: stubEmbedder,
      models: modelMeta,
      modelsDir: MODELS_DIR,
      environment: Object.fromEntries(
        Object.entries(process.env).filter(([k]) => /^(QMD_|GGML_|CI$)/.test(k)),
      ),
      nodeLlamaCpp: JSON.parse(
        readFileSync(join(repo, "node_modules", "node-llama-cpp", "package.json"), "utf8"),
      ).version,
      device,
      llama: llama === null ? null : { gpu: llama.gpu },
      embed: {
        ms: embedMs,
        docsProcessed: embedded.docsProcessed,
        chunksEmbedded: embedded.chunksEmbedded,
        errors: embedded.errors,
      },
      dbBytesBefore,
      dbBytesAfterEmbed,
      dbBytesAfterModes: statSync(dbPath).size,
      llmCacheRowsAtEnd: cacheRows(),
      productionLimitDefault: 8,
      sharedTerms: Object.fromEntries(sharedTerms),
      retrieval: {
        vectorRows: 20,
        returned: 5,
        rrfK: RRF_K,
        qmdListSize: 20,
        qmdCandidateLimit: 40,
        indexed:
          "the derived documents (title line, description, type and tag lines, body), embedded by qmd as 'title: … | text: …' per chunk",
      },
      perMode,
      consoleLines: captured,
    };
  } catch (error) {
    restoreConsole();
    process.stderr.write(`the modes run failed: ${error.message}\n`);
    for (const line of captured) process.stderr.write(`  qmd: ${line}\n`);
    try {
      if (store !== undefined) await store.close();
    } catch {
      // closing is best effort on the failure path
    }
    removeWork();
    process.exit(EXIT_MODES_FAILED);
  }
  restoreConsole();
  await store.close();
  if (llama !== null) await llama.dispose();
  try {
    const llmModule = await import(pathToFileURL(join(qmdDir, "llm.js")).href);
    await llmModule.getDefaultLlamaCpp().dispose();
  } catch {
    // the default instance may hold nothing
  }
}

// --- metadata ----------------------------------------------------------------------------------------------
const byBundle = {};
for (const f of walked.files) {
  const top = f.path.split("/")[0];
  byBundle[top] = byBundle[top] ?? { walked: 0, admitted: 0, questions: 0 };
  byBundle[top].walked += 1;
}
for (const path of catalog.pages.keys()) {
  const top = path.split("/")[0];
  byBundle[top] = byBundle[top] ?? { walked: 0, admitted: 0, questions: 0 };
  byBundle[top].admitted += 1;
}
for (const q of questions) {
  const top = q.gold.split("/")[0];
  byBundle[top] = byBundle[top] ?? { walked: 0, admitted: 0, questions: 0 };
  byBundle[top].questions += 1;
}
// Dirty means tracked files differ from HEAD. Untracked files are ignored, and so are the rendered notes, which
// `bench/report.mjs` rewrites from this run and which are therefore never the code that produced it.
const porcelain = (git(["status", "--porcelain", "--untracked-files=no"], repo) ?? "")
  .split("\n")
  .filter((line) => line.length > 0 && !/docs\/research\/benchmark-(lexical|modes)\.md$/.test(line))
  .join("\n");
const meta = {
  ran: new Date().toISOString(),
  clock: NOW.toISOString(),
  request: { includeStale: true, limit: 5 },
  load: {
    admit: options.admit,
    dev: options.dev,
    integrity: options.integrity,
    specText: options.specText,
  },
  bundle: bundleDir === undefined ? "the public corpus" : "another bundle",
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
  questionsSha256: sha256(readFileSync(questionsPath)),
  stopwordsSha256: sha256([...STOPWORDS].sort().join(" ")),
  corpus:
    bundleDir === undefined
      ? Object.fromEntries(
          CORPUS_REPOS.map((name) => [
            name,
            git(["rev-parse", "HEAD"], join(here, "clones", name)),
          ]),
        )
      : null,
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
    collisions: indexed.collisions.length,
    encodedFolders: indexed.encodedFolders,
    ms: indexMs,
    dbBytes: statSync(join(work, "index.sqlite")).size,
  },
  memory: { rssAfterBytes: rss(), heapUsedBytes: process.memoryUsage().heapUsed, phases: memory },
};
const result = { meta, summary, paired, modes: modesResult };
writeFileSync(join(resultsDir, `${stamp}.summary.json`), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ meta, summary, paired, modes: modesResult === null ? null : { requested: modes, perMode: modesResult.perMode } }, null, 2)}\n`,
);
// The generation tree and the store are measurements' scaffolding, not results: a run leaves no work folder behind.
removeWork();
