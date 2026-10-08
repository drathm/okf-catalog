import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  NETWORK_CONFIGS,
  pairNetwork,
  renderNetworkNote,
  splitGold,
} from "../../bench/lib/network.mjs";

// Step 8 of bite c (D-D, D73): `bench/run.mjs --split` loads each corpus folder as its own bundle in one index and
// pairs the four unfiltered configurations with the one-bundle run. Recorded, not gated.
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = join(REPO, "bench", "run.mjs");
const temp = mkdtempSync(join(tmpdir(), "okf-catalog-bench-network-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("the network measurement's arithmetic (bench/lib/network.mjs)", () => {
  it("splits a gold path into its bundle and its path inside the bundle", () => {
    expect(splitGold("okf-skills/docs/a.md")).toEqual({ bundle: "okf-skills", path: "docs/a.md" });
    expect(splitGold("cole-medin/x.md")).toEqual({ bundle: "cole-medin", path: "x.md" });
    expect(() => splitGold("root.md")).toThrow(/folder/);
  });

  it("pairs each unfiltered configuration's split ranks with the one-bundle run's", () => {
    expect(NETWORK_CONFIGS).toEqual([
      "question/relaxed",
      "question/strict",
      "keywords/relaxed",
      "keywords/strict",
    ]);
    const questions = [
      { id: "Q1", style: "reuse" },
      { id: "Q2", style: "paraphrase" },
      { id: "Q3", style: "paraphrase" },
    ];
    const one = new Map(
      NETWORK_CONFIGS.map((config) => [
        config,
        new Map<string, number | null>([
          ["Q1", 1],
          ["Q2", 3],
          ["Q3", null],
        ]),
      ]),
    );
    const split = new Map(
      NETWORK_CONFIGS.map((config) => [
        config,
        new Map<string, number | null>([
          ["Q1", 1],
          ["Q2", config === "question/strict" ? 1 : 3],
          ["Q3", config === "keywords/strict" ? 4 : null],
        ]),
      ]),
    );
    const paired = pairNetwork(one, split, questions);
    expect(paired["question/relaxed"]).toMatchObject({
      better: 0,
      worse: 0,
      same: 3,
      changed: [],
      one: { all: { n: 3, "hit@1": 1, "hit@3": 2, "MRR@5": 0.444 } },
      split: { all: { n: 3, "hit@1": 1, "hit@3": 2, "MRR@5": 0.444 } },
    });
    expect(paired["question/strict"]).toMatchObject({
      better: 1,
      worse: 0,
      same: 2,
      changed: [{ id: "Q2", one: 3, split: 1 }],
    });
    expect(paired["keywords/strict"]?.changed).toEqual([{ id: "Q3", one: null, split: 4 }]);
    expect(paired["keywords/strict"]?.split.paraphrase).toEqual({
      n: 2,
      "hit@1": 0,
      "hit@3": 1,
      "MRR@5": 0.292,
    });
  });

  it("renders the note from the result alone, each configuration paired with the one-bundle run", () => {
    const row = { n: 25, "hit@1": 10, "hit@3": 15, "MRR@5": 0.5 };
    const note = renderNetworkNote({
      meta: {
        ran: "2026-10-08T00:00:00.000Z",
        okfCatalogCommit: "abc1234",
        qmd: "2.8.3",
        node: "v24.15.0",
        os: "darwin arm64",
        corpus: { "okf-skills": "8e31878" },
      },
      bundles: [{ id: "okf-skills", pages: 30, documents: 30 }],
      configs: Object.fromEntries(
        NETWORK_CONFIGS.map((config) => [
          config,
          {
            one: { all: row },
            split: { all: { ...row, "hit@1": 11 } },
            better: 1,
            worse: 0,
            same: 24,
            changed: [{ id: "Q7", one: 2, split: 1 }],
          },
        ]),
      ),
    });
    expect(note).toMatch(/^# Benchmark: a network of bundles\n/);
    expect(note).toContain(
      "| question/relaxed | 10/25 | 15/25 | 0.50 | 11/25 | 15/25 | 0.50 | 1 | 0 | 24 |",
    );
    expect(note).toContain("Q7: 2 → 1");
    expect(note).toContain("okf-skills");
    expect(note).toContain("not gated");
  });
});

describe("bench/run.mjs --split", () => {
  it("loads each folder of a bundle as its own bundle in one index and reports the four configurations paired", () => {
    const questions = join(temp, "questions.json");
    writeFileSync(
      questions,
      JSON.stringify([
        {
          id: "N1",
          style: "reuse",
          question: "What is gross margin?",
          keywords: ["gross", "margin"],
          gold: "metrics/gross-margin.md",
        },
        {
          id: "N2",
          style: "paraphrase",
          question: "How is revenue recognised?",
          keywords: ["revenue", "recognition"],
          gold: "policies/revenue-recognition.md",
        },
      ]),
    );
    const config = join(temp, "okf-catalog.yaml");
    writeFileSync(config, "company: bench\nsource:\n  local: ./unused\n");
    const out = join(temp, "out");
    const run = spawnSync(
      process.execPath,
      [
        RUNNER,
        "--bundle",
        join(REPO, "test", "fixtures", "bundles", "spec-example"),
        "--config",
        config,
        "--questions",
        questions,
        "--out",
        out,
        "--split",
      ],
      {
        cwd: REPO,
        env: { ...process.env, NODE_LLAMA_CPP_SKIP_DOWNLOAD: "1" },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const summaryFile = readdirSync(out).find((f) => f.endsWith(".summary.json"));
    const summary = JSON.parse(readFileSync(join(out, summaryFile ?? ""), "utf8")) as {
      network: {
        bundles: Array<{ id: string; pages: number; documents: number }>;
        skippedAtRoot: number;
        configs: Record<
          string,
          { one: unknown; split: unknown; same: number; better: number; worse: number }
        >;
      };
    };
    // Each top-level folder its own bundle; the root's own files belong to none and are counted.
    expect(summary.network.bundles.map((b) => b.id)).toEqual([
      "attesters",
      "computations",
      "metrics",
      "policies",
      "skills",
      "tables",
    ]);
    expect(summary.network.skippedAtRoot).toBeGreaterThan(0);
    expect(Object.keys(summary.network.configs)).toEqual(NETWORK_CONFIGS);
    for (const paired of Object.values(summary.network.configs))
      expect(paired.better + paired.worse + paired.same).toBe(2);
    // For another bundle, the note goes beside the results, never into the checkout.
    expect(readdirSync(out).some((f) => f.endsWith("benchmark-network.md"))).toBe(true);
  });
});
