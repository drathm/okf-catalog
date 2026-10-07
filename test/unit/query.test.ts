import { describe, expect, it } from "vitest";
import { normaliseQuestion, tokenize } from "../../src/search/query.js";

describe("tokenize", () => {
  it("lower-cases, splits on punctuation, keeps internal hyphens and drops leading or trailing ones", () => {
    expect(tokenize("How to use --force on multi-agent systems?")).toEqual([
      "how",
      "to",
      "use",
      "force",
      "on",
      "multi-agent",
      "systems",
    ]);
  });

  it("drops tokens that are not letters and digits, and tokens shorter than two characters", () => {
    expect(tokenize("rock 'n' roll; snake _ case: a b2 é")).toEqual([
      "rock",
      "roll",
      "snake",
      "case",
      "b2",
    ]);
  });

  it("splits a Chinese run into overlapping pairs and keeps a lone character", () => {
    expect(tokenize("如何申请退款")).toEqual(["如何", "何申", "申请", "请退", "退款"]);
    expect(tokenize("退款 政策 x")).toEqual(["退款", "政策"]);
    expect(tokenize("好")).toEqual(["好"]);
  });
});

describe("normaliseQuestion", () => {
  it("removes stopwords and question words, reports what it dropped, and keeps order", () => {
    expect(normaliseQuestion("What type of statements do customers get quarterly?")).toEqual({
      terms: ["type", "statements", "customers", "quarterly"],
      dropped: ["what", "of", "do", "get"],
    });
  });

  it("removes duplicates and caps at twelve terms in question order", () => {
    const words = Array.from({ length: 15 }, (_, i) => `word${i}`).join(" ");
    const r = normaliseQuestion(`${words} word0`);
    expect(r.terms).toHaveLength(12);
    expect(r.terms[0]).toBe("word0");
    expect(r.terms[11]).toBe("word11");
  });

  it("answers an all-stopword question with no terms", () => {
    expect(normaliseQuestion("the a an of")).toEqual({
      terms: [],
      dropped: ["the", "an", "of"],
    });
    expect(normaliseQuestion("")).toEqual({ terms: [], dropped: [] });
  });

  it("keeps a hyphenated keyword whole", () => {
    expect(normaliseQuestion("okf-stop-check.sh conditions").terms).toEqual([
      "okf-stop-check",
      "sh",
      "conditions",
    ]);
  });
});
