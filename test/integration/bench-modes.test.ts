import { spawnSync } from "node:child_process";
import {
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
  // The ladder ranks alpha.md first for "alpha"; the stub reranker prefers the shortest chunk, which is beta.md's,
  // so this question is the one the reranker has to lift (bite 7 review R8).
  { id: "Q3", style: "reuse", question: "alpha", gold: "terms/beta.md", keywords: ["alpha"] },
];
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
    const config = join(temp, "okf-catalog.yaml");
    writeFileSync(
      config,
      `company: fixture\nsource:\n  local: ${FIXTURE}\nserve:\n  dev: true\ntypes: [Term, Note, Widget]\n`,
    );
    const questions = join(temp, "questions.json");
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
      modes: {
        stub: boolean;
        embed: { errors: number; chunksEmbedded: number };
        perMode: Record<string, { samples: number; overall: Record<string, { median: number }> }>;
      };
      summary: Record<string, { all: { n: number } }>;
    };
    expect(summary.modes.stub).toBe(true);
    expect(summary.modes.embed.errors).toBe(0);
    expect(summary.modes.embed.chunksEmbedded).toBeGreaterThan(0);
    expect(Object.keys(summary.modes.perMode).sort()).toEqual(["fused", ...RERANK_KEYS, "vector"]);
    expect(summary.modes.perMode.vector?.samples).toBe(1);
    // The vector path on its own, not the lexical list it is fused with: both gold pages at the top.
    expect(summary.modes.perMode.vector?.overall["hit@1"]?.median).toBe(2);
    expect(summary.modes.perMode.fused?.overall["hit@3"]?.median).toBe(3);
    expect(summary.summary["question/relaxed"]?.all.n).toBe(3);
    expect(summary.summary["keywords/relaxed@20"]?.all.n).toBe(3);
    expect(summary.summary["question/relaxed@8"]?.all.n).toBe(3);
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
    expect(fused).toHaveLength(3);
    for (const row of fused) expect(row.lists?.vector, JSON.stringify(row)).toBeGreaterThan(0);
    expect(rows.filter((row) => row.config === "question/relaxed@20")).toHaveLength(3);
    expect(rows.filter((row) => row.config === "question/relaxed")).toHaveLength(3);
    // The reranker over the ladder's list: one scoring pass per question and form, every candidate scored,
    // qmd's best chunk recorded for each, and the stub's order (the shortest chunk first) applied.
    const reranked = rows.filter((row) => row.mode === "rerank/question");
    expect(reranked.map((row) => row.id)).toEqual(["Q1", "Q2", "Q3"]);
    for (const row of reranked) {
      expect(row.form).toBe("question");
      expect(row.candidates?.length, row.id).toBeGreaterThan(0);
      expect(row.scores?.length, row.id).toBe(row.candidates?.length);
      expect(row.chunks?.length, row.id).toBe(row.candidates?.length);
      expect(row.rerankMs, row.id).toBeGreaterThanOrEqual(0);
      const byLength = [...(row.chunks ?? [])]
        .sort(
          (a, b) =>
            a.length - b.length ||
            (row.candidates?.indexOf(a.path) ?? 0) - (row.candidates?.indexOf(b.path) ?? 0),
        )
        .map((c) => c.path)
        .slice(0, 5);
      expect(row.top5, row.id).toEqual(byLength);
    }
    const ladderQ3 = rows.find((row) => row.config === "question/relaxed@20" && row.id === "Q3");
    expect(ladderQ3?.rank === null || (ladderQ3?.rank ?? 0) > 1, JSON.stringify(ladderQ3)).toBe(
      true,
    );
    const rerankQ3 = reranked.find((row) => row.id === "Q3");
    expect(rerankQ3?.rank).toBe(1);
    expect(rerankQ3?.goldInCandidates).toBeGreaterThan(1);
    // qmd's blend protects the ladder's first result: Q1's gold stays first, and Q3 cannot be lifted to first.
    const blended = rows.filter((row) => row.mode === "rerank-blend/question");
    expect(blended.find((row) => row.id === "Q1")?.rank).toBe(1);
    expect(blended.find((row) => row.id === "Q3")?.rank).not.toBe(1);
    expect(rows.filter((row) => row.mode === "rerank/keywords")).toHaveLength(3);
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
