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
      "vector,fused",
      "--stub-embedder",
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
    expect(Object.keys(summary.modes.perMode).sort()).toEqual(["fused", "vector"]);
    expect(summary.modes.perMode.vector?.samples).toBe(1);
    expect(summary.modes.perMode.fused?.overall["hit@3"]?.median).toBe(2);
    expect(summary.summary["question/relaxed"]?.all.n).toBe(2);
    const rows = readFileSync(
      join(out, (summaryFile as string).replace(".summary.json", ".jsonl")),
      "utf8",
    )
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { mode?: string; config?: string; rank: number | null });
    expect(rows.filter((row) => row.mode === "vector")).toHaveLength(2);
    expect(rows.filter((row) => row.mode === "fused")).toHaveLength(2);
    expect(rows.filter((row) => row.config === "question/relaxed")).toHaveLength(2);
    expect(existsSync(join(REPO, "bench", "results", summaryFile as string))).toBe(false);
  });

  it("exits 3 with the itemised approval, before any store opens, when a requested mode's model is absent", () => {
    const empty = join(temp, "no-models");
    mkdirSync(empty, { recursive: true });
    // A file that only resembles a model must not count: the plain name, an etag sidecar, a partial download.
    writeFileSync(join(empty, "embeddinggemma-300M-Q8_0.gguf"), "GGUF");
    writeFileSync(join(empty, "hf_ggml-org_embeddinggemma-300M-Q8_0.gguf.etag"), "x");
    writeFileSync(join(empty, "hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf.ipull"), "x");
    const workBefore = existsSync(join(REPO, "bench", ".work"))
      ? readdirSync(join(REPO, "bench", ".work"))
      : [];
    const r = run(["--modes", "full", "--models-dir", empty]);
    expect(r.status).toBe(3);
    expect(r.stderr).not.toContain("TRIPWIRE");
    expect(r.stderr).toContain("node bench/pull-models.mjs embed rerank expand");
    expect(r.stderr).toContain("333 590 944");
    expect(r.stderr).toContain("Gemma");
    expect(r.stderr).toMatch(/embeddinggemma-300M-Q8_0\.gguf: absent/);
    const workAfter = existsSync(join(REPO, "bench", ".work"))
      ? readdirSync(join(REPO, "bench", ".work"))
      : [];
    expect(workAfter).toEqual(workBefore);
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
  });
});
