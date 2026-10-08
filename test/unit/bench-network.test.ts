import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  NETWORK_CONFIGS,
  pairAlone,
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

  // The fold of bite c's build reviews (C-I-D1, C-A-D1): the pairing that measures D-D sets each folder indexed alone
  // against the same folder inside the network, on the gold page's rank and its score.
  it("pairs each folder alone with the same folder in the network, on the gold rank and the gold page's score", () => {
    const questions = [
      { id: "Q1", style: "reuse", gold: "a/one.md" },
      { id: "Q2", style: "paraphrase", gold: "a/two.md" },
      { id: "Q3", style: "paraphrase", gold: "b/three.md" },
    ];
    type Outcome = { rank: number | null; score: number | null };
    const of = (rows: Array<[string, Outcome]>) =>
      new Map(NETWORK_CONFIGS.map((config) => [config, new Map<string, Outcome>(rows)]));
    const alone = of([
      ["Q1", { rank: 1, score: 2.5 }],
      ["Q2", { rank: 3, score: 1.25 }],
      ["Q3", { rank: null, score: null }],
    ]);
    const network = of([
      ["Q1", { rank: 1, score: 2.5 }],
      ["Q2", { rank: 2, score: 1.5 }],
      ["Q3", { rank: 4, score: 0.5 }],
    ]);
    const paired = pairAlone(alone, network, questions);
    expect(Object.keys(paired)).toEqual(NETWORK_CONFIGS);
    expect(paired["question/relaxed"]).toMatchObject({
      better: 2,
      worse: 0,
      same: 1,
      changed: [
        { id: "Q2", alone: 3, network: 2 },
        { id: "Q3", alone: null, network: 4 },
      ],
      // Found in both runs: Q1 and Q2; Q2's score moved.
      scored: 2,
      scoreChanged: 1,
      alone: { all: { n: 3, "hit@1": 1, "hit@3": 2, "MRR@5": 0.444 } },
      network: { all: { n: 3, "hit@1": 1, "hit@3": 2, "MRR@5": 0.583 } },
    });
    // A question no folder answers alone (its gold is in no bundle that ran) is left out of the pairing.
    const fewer = pairAlone(of([["Q1", { rank: 1, score: 2.5 }]]), network, questions);
    expect(fewer["keywords/strict"]).toMatchObject({ better: 0, worse: 0, same: 1, scored: 1 });
  });

  it("renders the note from the result alone: each folder alone against the network first, then the same pages split", () => {
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
      alone: Object.fromEntries(
        NETWORK_CONFIGS.map((config) => [
          config,
          {
            alone: { all: { ...row, "hit@1": 12 } },
            network: { all: row },
            better: 0,
            worse: 2,
            same: 23,
            changed: [
              { id: "Q3", alone: 1, network: 2 },
              { id: "Q9", alone: 4, network: null },
            ],
            scored: 20,
            scoreChanged: 17,
          },
        ]),
      ),
    });
    expect(note).toMatch(/^# Benchmark: a network of bundles\n/);
    expect(note).toContain("not gated");
    // The measurement of D-D comes first: each folder alone against the same folder in the network.
    const alone = note.indexOf("## Each folder alone against the network");
    const split = note.indexOf("## The same pages, split");
    expect(alone).toBeGreaterThan(-1);
    expect(split).toBeGreaterThan(alone);
    expect(note).toContain(
      "| question/relaxed | 12/25 | 15/25 | 0.50 | 10/25 | 15/25 | 0.50 | 0 | 2 | 23 | 17 of 20 |",
    );
    expect(note.slice(alone, split)).toContain("Q3: 1 → 2; Q9: 4 → miss");
    // The split pairing says what it is: the same pages, which no statistic of the table tells apart.
    expect(note.slice(split)).toContain("near no-op by construction");
    expect(note.slice(split)).toContain(
      "| question/relaxed | 10/25 | 15/25 | 0.50 | 11/25 | 15/25 | 0.50 | 1 | 0 | 24 |",
    );
    expect(note.slice(split)).toContain("Q7: 2 → 1");
    expect(note).toContain("okf-skills");
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
        alone: Record<
          string,
          {
            same: number;
            better: number;
            worse: number;
            scored: number;
            scoreChanged: number;
          }
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
    // Each question asked of its gold page's folder alone, and of the network: the measurement of D-D.
    expect(Object.keys(summary.network.alone)).toEqual(NETWORK_CONFIGS);
    for (const paired of Object.values(summary.network.alone)) {
      expect(paired.better + paired.worse + paired.same).toBe(2);
      expect(paired.scoreChanged).toBeLessThanOrEqual(paired.scored);
    }
    // For another bundle, the note goes beside the results, never into the checkout.
    expect(readdirSync(out).some((f) => f.endsWith("benchmark-network.md"))).toBe(true);
  });
});
