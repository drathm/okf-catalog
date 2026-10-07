import { describe, expect, it } from "vitest";
import { evaluateBar } from "../../bench/lib/bar.mjs";

// The bar of bite 7 (docs/plans/version-0-progress.md, "Bite 7 plan, revised"), evaluated from the rows a run
// writes, apart from the report that prints it.
const row = (mode: string, id: string, rank: number | null, sample = 1, rerankMs = 500) => ({
  mode,
  id,
  sample,
  rank,
  rerankMs,
  form: mode.split("/")[1],
});

describe("the bar of the ladder re-ranked", () => {
  const controls = new Map<string, number | null>([
    ["keywords/relaxed@20:Q1", 1],
    ["keywords/relaxed@20:Q2", 1],
    ["keywords/relaxed@20:Q3", 2],
    ["question/relaxed@20:Q1", 1],
    ["question/relaxed@20:Q2", 2],
    ["question/relaxed@20:Q3", null],
  ]);
  const controlRank = (config: string, id: string) => controls.get(`${config}:${id}`) ?? null;
  const memory = { afterLexical: 1000, afterWarmUp: 1200, afterLoop: 1100 };

  it("passes when every condition holds and names the proposal", () => {
    const rows = [
      // keyword form: no hit@1 lost, Q3 gained at hit@1 (and so at hit@3), MRR up
      row("rerank/keywords", "Q1", 1),
      row("rerank/keywords", "Q2", 1),
      row("rerank/keywords", "Q3", 1),
      // question form: three gained at hit@1 (Q2, Q3 and Q1 kept), none lost
      row("rerank/question", "Q1", 1),
      row("rerank/question", "Q2", 1),
      row("rerank/question", "Q3", 1),
    ];
    const bar = evaluateBar(rows, controlRank, memory, 1);
    expect(bar.conditions.map((c) => c.state)).toEqual(["met", "not met", "met", "met"]);
    expect(bar.met).toBe(false);
  });

  it("fails the keyword condition on two losses at hit@1, counted against the same list cut to five", () => {
    const rows = [
      row("rerank/keywords", "Q1", 2),
      row("rerank/keywords", "Q2", 3),
      row("rerank/keywords", "Q3", 1),
      row("rerank/question", "Q1", 1),
      row("rerank/question", "Q2", 1),
      row("rerank/question", "Q3", 1),
    ];
    const bar = evaluateBar(rows, controlRank, memory, 1);
    expect(bar.conditions[0]?.state).toBe("not met");
    expect(bar.conditions[0]?.detail).toContain("lost 2");
    expect(bar.met).toBe(false);
  });

  it("fails the latency condition on the median over passes, computed as a median", () => {
    const rows = [
      row("rerank/keywords", "Q1", 1, 1, 100),
      row("rerank/keywords", "Q2", 1, 1, 2000),
      row("rerank/question", "Q1", 1, 1, 100),
      row("rerank/question", "Q2", 1, 1, 2000),
    ];
    const bar = evaluateBar(rows, controlRank, memory, 1);
    expect(bar.conditions[2]?.detail).toContain("median 1050 ms");
    expect(bar.conditions[2]?.state).toBe("not met");
  });

  it("leaves the memory condition undecided when the spike and the steady reading disagree", () => {
    const rows = [row("rerank/keywords", "Q1", 1), row("rerank/question", "Q1", 1)];
    const spike = evaluateBar(
      rows,
      controlRank,
      { afterLexical: 1000, afterWarmUp: 1000 + 2 * 1073741824, afterLoop: 1100 },
      1,
    );
    expect(spike.conditions[3]?.state).toBe("undecided");
    const both = evaluateBar(
      rows,
      controlRank,
      { afterLexical: 1000, afterWarmUp: 1000 + 2 * 1073741824, afterLoop: 1000 + 2 * 1073741824 },
      1,
    );
    expect(both.conditions[3]?.state).toBe("not met");
    const neither = evaluateBar(rows, controlRank, memory, 1);
    expect(neither.conditions[3]?.state).toBe("met");
  });

  it("requires every sample to meet a condition", () => {
    const rows = [
      row("rerank/keywords", "Q1", 1, 1),
      row("rerank/keywords", "Q1", 2, 2),
      row("rerank/question", "Q1", 1, 1),
      row("rerank/question", "Q1", 1, 2),
    ];
    const bar = evaluateBar(rows, controlRank, memory, 2);
    expect(bar.conditions[0]?.detail).toMatch(/lost 0, 1/);
    expect(bar.conditions[0]?.state).toBe("not met");
  });
});
