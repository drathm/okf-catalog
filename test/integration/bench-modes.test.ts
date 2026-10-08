import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { blendOrder, scoreOrder } from "../../bench/lib/rerank.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = join(REPO, "bench", "run.mjs");
const TRIPWIRE = join(REPO, "bench", "lib", "tripwire.mjs");
const FIXTURE = join(REPO, "test", "fixtures", "bundles", "behaviours");
const temp = mkdtempSync(join(tmpdir(), "okf-catalog-bench-modes-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const QUESTIONS = [
  { id: "Q1", style: "reuse", question: "alpha", gold: "terms/alpha.md", keywords: ["alpha"] },
  {
    id: "Q2",
    style: "paraphrase",
    question: "a page whose tags are the thing under test",
    gold: "notes/tags-only.md",
    keywords: ["tags"],
  },
  // The ladder ranks alpha.md first for "alpha"; the stub reranker gives equal matches a length bonus, so the
  // long essay that mentions alpha once comes first for it: the question the reranker has to lift (review R8).
  {
    id: "Q3",
    style: "reuse",
    question: "alpha",
    gold: "notes/alpha-essay.md",
    keywords: ["alpha"],
  },
  // A page long enough for more than one of qmd's chunks, with its one distinctive word in the last: the
  // reranker must be handed that chunk, not the first (bite 7 build review).
  {
    id: "Q4",
    style: "reuse",
    question: "zebraquartz",
    gold: "notes/long.md",
    keywords: ["zebraquartz"],
  },
  // Six pages that each carry "quokka" once, of growing length: the ladder puts the short ones first, the stub
  // the long ones, so qmd's blend has to move candidates below the top three (build review: an identity blend
  // must not pass).
  { id: "Q5", style: "reuse", question: "quokka", gold: "notes/quokka-6.md", keywords: ["quokka"] },
];
/** The fixture bundle plus the long page, copied so that the shared fixture stays as the other tests know it. */
function bundleWithLongPage(dir: string): string {
  const bundle = join(dir, "bundle");
  cpSync(FIXTURE, bundle, { recursive: true });
  const filler = (n: number) =>
    Array.from(
      { length: n },
      (_, i) =>
        `Paragraph ${i + 1} of the long note keeps the ovens, the racks and the counting of trays in plain words so that the chunker has prose to cut.`,
    ).join("\n\n");
  const page = (title: string, description: string, body: string) =>
    `---\ntype: Note\ntitle: ${title}\ndescription: ${description}\nstatus: stable\nverified:\n  - by: human:x\n    at: 2026-01-01T00:00:00Z\n---\n\n# ${title}\n\n${body}\n`;
  writeFileSync(
    join(bundle, "notes", "long.md"),
    page(
      "A long note",
      "A page long enough for several chunks, with one distinctive word near its end.",
      `${filler(30)}\n\nThe word zebraquartz appears here and nowhere else in this bundle.\n\n${filler(10)}`,
    ),
  );
  writeFileSync(
    join(bundle, "notes", "alpha-essay.md"),
    page(
      "A long essay",
      "An essay that mentions the alpha term once, deep in its body.",
      `${filler(12)}\n\nSomewhere in the middle the essay mentions alpha, once.\n\n${filler(12)}`,
    ),
  );
  for (const [n, words] of [1, 2, 4, 8, 16, 32].entries()) {
    writeFileSync(
      join(bundle, "notes", `quokka-${n + 1}.md`),
      page(
        `Quokka note ${n + 1}`,
        `The quokka note number ${n + 1}.`,
        `A quokka sat here.\n\n${filler(words)}`,
      ),
    );
  }
  return bundle;
}
const RERANK_KEYS = [
  "rerank-blend/keywords",
  "rerank-blend/question",
  "rerank/keywords",
  "rerank/question",
];

/** Runs the harness under the network tripwire with a clean model environment. */
const run = (args: string[], env: Record<string, string> = {}) => {
  const base: Record<string, string | undefined> = {
    ...process.env,
    NODE_LLAMA_CPP_SKIP_DOWNLOAD: "1",
  };
  for (const key of ["CI", "QMD_EMBED_MODEL", "QMD_RERANK_MODEL", "QMD_GENERATE_MODEL"])
    delete base[key];
  return spawnSync(process.execPath, ["--import", TRIPWIRE, RUNNER, ...args], {
    cwd: REPO,
    env: { ...base, ...env },
    encoding: "utf8",
    timeout: 110_000,
  });
};

describe("the benchmark harness's modes path", { timeout: 120_000 }, () => {
  it("runs vector and fused over a fixture with the embedder stub, offline, and writes its rows outside the checkout", () => {
    const out = join(temp, "out");
    const bundle = bundleWithLongPage(temp);
    const config = join(temp, "okf-catalog.yaml");
    writeFileSync(
      config,
      `company: fixture\nsource:\n  local: ${bundle}\nserve:\n  dev: true\ntypes: [Term, Note, Widget]\n`,
    );
    const questions = join(temp, "questions.json");
    writeFileSync(questions, JSON.stringify(QUESTIONS));
    const r = run([
      "--bundle",
      bundle,
      "--config",
      config,
      "--questions",
      questions,
      "--out",
      out,
      "--modes",
      "vector,fused,rerank",
      "--stub-embedder",
      "--samples",
      "1",
    ]);
    expect(r.stderr, r.stderr).not.toContain("TRIPWIRE");
    expect(r.status, r.stderr).toBe(0);
    const files = readdirSync(out);
    const summaryFile = files.find((f) => f.endsWith(".summary.json"));
    expect(summaryFile).toBeDefined();
    const summary = JSON.parse(readFileSync(join(out, summaryFile as string), "utf8")) as {
      meta: { loadMs: number; memory: { phases: { afterLoad: number } } };
      modes: {
        stub: boolean;
        embed: { errors: number; chunksEmbedded: number };
        perMode: Record<string, { samples: number; overall: Record<string, { median: number }> }>;
      };
      summary: Record<string, { all: { n: number } }>;
    };
    // The load's own time beside the resident set after it, so a change to what the loader stores is measured
    // (bite b's stored edges and inbound maps, plan P15).
    expect(Number.isInteger(summary.meta.loadMs)).toBe(true);
    expect(summary.meta.loadMs).toBeGreaterThanOrEqual(0);
    expect(summary.meta.memory.phases.afterLoad).toBeGreaterThan(0);
    expect(summary.modes.stub).toBe(true);
    expect(summary.modes.embed.errors).toBe(0);
    expect(summary.modes.embed.chunksEmbedded).toBeGreaterThan(0);
    expect(Object.keys(summary.modes.perMode).sort()).toEqual(["fused", ...RERANK_KEYS, "vector"]);
    expect(summary.modes.perMode.vector?.samples).toBe(1);
    // The vector path on its own, not the lexical list it is fused with: both gold pages at the top.
    expect(summary.modes.perMode.vector?.overall["hit@1"]?.median).toBeGreaterThanOrEqual(2);
    expect(summary.modes.perMode.fused?.overall["hit@3"]?.median).toBeGreaterThanOrEqual(3);
    expect(summary.summary["question/relaxed"]?.all.n).toBe(5);
    expect(summary.summary["keywords/relaxed@20"]?.all.n).toBe(5);
    expect(summary.summary["question/relaxed@8"]?.all.n).toBe(5);
    const rows = readFileSync(
      join(out, (summaryFile as string).replace(".summary.json", ".jsonl")),
      "utf8",
    )
      .split("\n")
      .filter((l) => l.length > 0)
      .map(
        (l) =>
          JSON.parse(l) as {
            mode?: string;
            config?: string;
            id?: string;
            rank: number | null;
            top5?: string[];
            order?: string[];
            lists?: { policy: number; vector: number };
            form?: string;
            candidates?: string[];
            goldInCandidates?: number | null;
            scores?: number[];
            chunks?: Array<{ path: string; index: number; length: number; count: number }>;
            rerankMs?: number;
          },
      );
    const vector = rows.filter((row) => row.mode === "vector");
    expect(vector.slice(0, 2).map((row) => row.rank)).toEqual([1, 1]);
    // Q3's gold is the page the stub reranker lifts; the vector path does not put it first.
    expect(vector[2]?.rank).not.toBe(1);
    const fused = rows.filter((row) => row.mode === "fused");
    expect(fused).toHaveLength(5);
    for (const row of fused) expect(row.lists?.vector, JSON.stringify(row)).toBeGreaterThan(0);
    expect(rows.filter((row) => row.config === "question/relaxed@20")).toHaveLength(5);
    expect(rows.filter((row) => row.config === "question/relaxed")).toHaveLength(5);
    // The reranker over the ladder's list: one scoring pass per question and form, a score for every candidate,
    // the chunk qmd's rule picks recorded for each, and the two orders exactly those the rules give from the
    // recorded scores (the rules themselves are tested against qmd's code in test/unit/bench-rerank.test.ts).
    const reranked = rows.filter((row) => row.mode === "rerank/question");
    expect(reranked.map((row) => row.id)).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5"]);
    for (const form of ["question", "keywords"]) {
      for (const row of rows.filter((x) => x.mode === `rerank/${form}`)) {
        const candidates = row.candidates ?? [];
        const scores = row.scores ?? [];
        expect(row.form, row.id).toBe(form);
        expect(candidates.length, row.id).toBeGreaterThan(0);
        expect(scores.length, row.id).toBe(candidates.length);
        expect(row.chunks?.length, row.id).toBe(candidates.length);
        expect(row.rerankMs, row.id).toBeGreaterThanOrEqual(0);
        expect(row.order, `${row.id} ${form}`).toEqual(scoreOrder(candidates, scores));
        expect(row.top5, `${row.id} ${form}`).toEqual(scoreOrder(candidates, scores).slice(0, 5));
        const blend = rows.find((x) => x.mode === `rerank-blend/${form}` && x.id === row.id);
        expect(blend?.order, `${row.id} ${form} blend`).toEqual(blendOrder(candidates, scores));
        expect(blend?.top5, `${row.id} ${form} blend`).toEqual(
          blendOrder(candidates, scores).slice(0, 5),
        );
      }
    }
    // The stub reads the query: Q2's eight-word question gives some candidate a partial share (a score strictly
    // between the none-matched 0.3 and the all-matched 0.7 of the stub's formula), which a one-word query
    // cannot, and its keyword form "tags" gives every candidate a full share or none.
    const q2 = (form: string) => rows.find((x) => x.mode === `rerank/${form}` && x.id === "Q2");
    expect((q2("question")?.scores ?? []).some((x) => x > 0.31 && x < 0.69)).toBe(true);
    expect((q2("keywords")?.scores ?? []).every((x) => x >= 0.7 || x <= 0.3)).toBe(true);
    // The ladder ranks alpha.md first for "alpha"; the stub scores every page that carries the word alike and
    // puts the longest first, the essay: the list the reranker returns is not the ladder's.
    const ladderQ3 = rows.find((row) => row.config === "question/relaxed@20" && row.id === "Q3");
    expect(ladderQ3?.rank === null || (ladderQ3?.rank ?? 0) > 1, JSON.stringify(ladderQ3)).toBe(
      true,
    );
    const rerankQ3 = reranked.find((row) => row.id === "Q3");
    expect(rerankQ3?.rank).toBe(1);
    expect(rerankQ3?.goldInCandidates).toBeGreaterThan(1);
    // Q4: the long page's distinctive word sits in a later chunk, and that chunk is the one handed over.
    const rerankQ4 = reranked.find((row) => row.id === "Q4");
    const q4Gold = rerankQ4?.chunks?.find((c) => c.path === "notes/long.md");
    expect(q4Gold?.count, JSON.stringify(q4Gold)).toBeGreaterThanOrEqual(2);
    expect(q4Gold?.index, JSON.stringify(q4Gold)).toBeGreaterThan(0);
    expect(rerankQ4?.rank).toBe(1);
    // qmd's blend protects the ladder's first result: Q1's gold stays first, and Q3 cannot be lifted to first.
    const blended = rows.filter((row) => row.mode === "rerank-blend/question");
    expect(blended.find((row) => row.id === "Q1")?.rank).toBe(1);
    expect(blended.find((row) => row.id === "Q3")?.rank).not.toBe(1);
    // The blend is not the identity either: somewhere in some list it moves a candidate (positions beyond the
    // top five count, since the position weights settle the top of these short lists).
    expect(
      rows
        .filter((row) => typeof row.mode === "string" && row.mode.startsWith("rerank-blend/"))
        .some((row) => JSON.stringify(row.order) !== JSON.stringify(row.candidates)),
    ).toBe(true);
    // Q5: the longest quokka page is the stub's first and the ladder's last; the blend lifts it, but not to the top.
    const rerankQ5 = reranked.find((row) => row.id === "Q5");
    expect(rerankQ5?.rank).toBe(1);
    expect(rerankQ5?.goldInCandidates).toBeGreaterThan(3);
    const blendQ5 = blended.find((row) => row.id === "Q5");
    expect(blendQ5?.rank).toBeGreaterThan(1);
    expect(blendQ5?.rank).toBeLessThan(rerankQ5?.goldInCandidates ?? 0);
    expect(rows.filter((row) => row.mode === "rerank/keywords")).toHaveLength(5);
    expect(existsSync(join(REPO, "bench", "results", summaryFile as string))).toBe(false);
  });

  it("runs rerank alone without building the vector index, and records the reranker's context size", () => {
    const out = join(temp, "out-rerank");
    const config = join(temp, "okf-catalog-rerank.yaml");
    writeFileSync(
      config,
      `company: fixture\nsource:\n  local: ${FIXTURE}\nserve:\n  dev: true\ntypes: [Term, Note, Widget]\n`,
    );
    const questions = join(temp, "questions-rerank.json");
    writeFileSync(questions, JSON.stringify(QUESTIONS));
    const r = run([
      "--bundle",
      FIXTURE,
      "--config",
      config,
      "--questions",
      questions,
      "--out",
      out,
      "--modes",
      "rerank",
      "--stub-embedder",
      "--samples",
      "2",
    ]);
    expect(r.stderr, r.stderr).not.toContain("TRIPWIRE");
    expect(r.status, r.stderr).toBe(0);
    const summaryFile = readdirSync(out).find((f) => f.endsWith(".summary.json")) as string;
    const summary = JSON.parse(readFileSync(join(out, summaryFile), "utf8")) as {
      modes: {
        embed: unknown;
        rerank: { contextSize: number; contexts: number | null; samples: number };
        perMode: Record<string, { samples: number }>;
      };
    };
    expect(summary.modes.embed).toBeNull();
    expect(Object.keys(summary.modes.perMode).sort()).toEqual(RERANK_KEYS);
    expect(summary.modes.perMode["rerank/question"]?.samples).toBe(2);
    expect(summary.modes.rerank.contextSize).toBe(4096);
    const preset = run(["--modes", "rerank", "--models-dir", join(temp, "none"), "--out", out], {
      QMD_RERANK_CONTEXT_SIZE: "8192",
    });
    expect(preset.status).toBe(4);
    expect(preset.stderr).toContain("QMD_RERANK_CONTEXT_SIZE");
    // A reranker that scores every candidate alike (qmd's fallback, or a no-op) fails the run.
    const uniform = run(
      [
        "--bundle",
        FIXTURE,
        "--config",
        config,
        "--questions",
        questions,
        "--out",
        join(temp, "out-uniform"),
        "--modes",
        "rerank",
        "--stub-embedder",
        "--samples",
        "1",
      ],
      { OKF_BENCH_STUB_RERANK: "uniform" },
    );
    expect(uniform.status, uniform.stderr).toBe(5);
    expect(uniform.stderr).toMatch(/scored every candidate .* alike/);
  });

  it("exits 3 with the itemised approval, before any store opens, when a requested mode's model is absent", () => {
    const empty = join(temp, "no-models");
    mkdirSync(empty, { recursive: true });
    // A file that only resembles a model must not count: the plain name, an etag sidecar, a partial download.
    writeFileSync(join(empty, "embeddinggemma-300M-Q8_0.gguf"), "GGUF");
    writeFileSync(join(empty, "hf_ggml-org_embeddinggemma-300M-Q8_0.gguf.etag"), "x");
    writeFileSync(join(empty, "hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf.ipull"), "x");
    const out = join(temp, "out-absent");
    mkdirSync(out, { recursive: true });
    const r = run(["--modes", "full", "--models-dir", empty, "--out", out]);
    expect(r.status).toBe(3);
    expect(r.stderr).not.toContain("TRIPWIRE");
    expect(r.stderr).toContain("node bench/pull-models.mjs embed rerank expand");
    expect(r.stderr).toContain("333 590 944");
    expect(r.stderr).toContain("Gemma");
    expect(r.stderr).toMatch(/embeddinggemma-300M-Q8_0\.gguf: absent/);
    expect(readdirSync(out)).toEqual([]);
    expect(readdirSync(empty).sort()).toEqual([
      "embeddinggemma-300M-Q8_0.gguf",
      "hf_ggml-org_embeddinggemma-300M-Q8_0.gguf.etag",
      "hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf.ipull",
    ]);
  });

  it("refuses to measure when CI or a qmd model variable was already set", () => {
    const empty = join(temp, "no-models-2");
    mkdirSync(empty, { recursive: true });
    const ci = run(["--modes", "vector", "--models-dir", empty], { CI: "true" });
    expect(ci.status).toBe(4);
    expect(ci.stderr).toContain("CI");
    const preset = run(["--modes", "vector", "--models-dir", empty], {
      QMD_EMBED_MODEL: "hf:x/y/z.gguf",
    });
    expect(preset.status).toBe(4);
    expect(preset.stderr).toContain("QMD_EMBED_MODEL");
    const gpu = run(["--modes", "vector", "--models-dir", empty], { QMD_LLAMA_GPU: "vulkan" });
    expect(gpu.status).toBe(4);
    expect(gpu.stderr).toContain("QMD_LLAMA_GPU");
  });
});
