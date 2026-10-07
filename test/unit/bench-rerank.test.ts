import { describe, expect, it } from "vitest";
import {
  blendOrder,
  missingScores,
  pickChunk,
  queryTermsOf,
  scoreOrder,
} from "../../bench/lib/rerank.mjs";

// The rules the harness applies around qmd's reranker, as qmd applies them (store.js: Step 5 picks the chunk,
// Step 7 blends the score with the candidate's position). Pure functions, so the rules are tested apart from the
// model and the store.
describe("the ladder re-ranked: the rules around the reranker", () => {
  it("takes the query's terms as qmd does: lower case, split on whitespace, longer than two characters", () => {
    expect(queryTermsOf("How is the FY2026 revenue policy set?")).toEqual([
      "how",
      "the",
      "fy2026",
      "revenue",
      "policy",
      "set?",
    ]);
  });

  it("picks the chunk with the most query terms, the first on a tie, as qmd's Step 5 does", () => {
    const chunks = [
      { text: "intro with nothing" },
      { text: "the revenue policy" },
      { text: "revenue" },
    ];
    expect(pickChunk(chunks, ["revenue", "policy"])).toBe(1);
    expect(pickChunk(chunks, ["revenue"])).toBe(1);
    expect(pickChunk(chunks, ["absent"])).toBe(0);
    expect(pickChunk([{ text: "a" }], [])).toBe(0);
  });

  it("orders by score, ties kept in ladder order", () => {
    expect(scoreOrder(["a", "b", "c", "d"], [0.2, 0.9, 0.2, 0.9])).toEqual(["b", "d", "a", "c"]);
  });

  it("blends as qmd's Step 7 does: 0.75, 0.60 and 0.40 by rank band over the ladder's position", () => {
    // Rank 1 holds at least 0.75; a perfect score at rank 2 blends to 0.625, at rank 11 to about 0.636.
    const candidates = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);
    const scores = candidates.map((_, i) => (i === 0 ? 0 : 1));
    const order = blendOrder(candidates, scores);
    expect(order[0]).toBe("p1");
    // Among the rest, rank 2 (0.75 * 0.5 + 0.25 = 0.625) sits below rank 4 (0.6 * 0.25 + 0.4 = 0.55)? No: 0.625 > 0.55,
    // and rank 11 at a perfect score is 0.4 / 11 + 0.6 = 0.636, above rank 2. qmd's order follows.
    expect(order.slice(0, 3)).toEqual(["p1", "p11", "p12"]);
    for (let trial = 0; trial < 200; trial += 1) {
      const random = candidates.map(() => Math.random());
      expect(blendOrder(candidates, random)[0]).toBe("p1");
    }
  });

  it("breaks a blend tie by the raw score, then by ladder order, as qmd's stable sort does", () => {
    // Ranks 2 and 3 share the weight 0.75: 0.375 + 0.25 s2 equals 0.25 + 0.25 s3 when s3 = s2 + 0.5. With
    // s2 = 0.25 and s3 = 0.75 both blends are exactly 0.4375 (dyadic values, so no rounding), and the higher
    // raw score, rank 3, goes first.
    expect(blendOrder(["a", "b", "c"], [0, 0.25, 0.75])).toEqual(["a", "c", "b"]);
    // Equal blends and equal raw scores keep the ladder's order.
    expect(blendOrder(["a", "b", "c"], [0, 0.5, 0.5]).slice(1)).toEqual(["b", "c"]);
  });

  it("names the candidates whose chunk text the model never scored, even when qmd fills the hole with 0", () => {
    const texts = new Map([
      ["a", "chunk of a"],
      ["b", "chunk of b"],
      ["c", "chunk of a"],
    ]);
    expect(missingScores(texts, new Set(["chunk of a"]))).toEqual(["b"]);
    expect(missingScores(texts, new Set(["chunk of a", "chunk of b"]))).toEqual([]);
  });
});
