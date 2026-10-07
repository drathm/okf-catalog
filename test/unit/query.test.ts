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

describe("tokenize and normaliseQuestion: after the bite 3 build review", () => {
  it("splits a run of hyphens instead of dropping the token", () => {
    expect(tokenize("foo--bar baz---qux")).toEqual(["foo", "bar", "baz", "qux"]);
  });

  it("reads a number with a thousands separator the way the engine indexes it: the digit groups apart", () => {
    // FTS5's tokenizer splits "1,000" into "1" and "000"; a query token "1000" would match nothing (probed against qmd 2.8.3).
    expect(tokenize("1,000 concepts")).toEqual(["000", "concepts"]);
  });

  it("reports the terms beyond the twelfth as dropped, so a cut question does not look complete", () => {
    const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi".split(
      " ",
    );
    const r = normaliseQuestion(words.join(" "));
    expect(r.terms).toEqual(words.slice(0, 12));
    expect(r.dropped).toEqual(["nu", "xi"]);
  });
});

describe("tokenize: scripts and contractions (bite 3 build review)", () => {
  it("keeps a word with combining marks whole, as the engine's tokenizer does", () => {
    expect(tokenize("हिन्दी भाषा")).toEqual(["हिन्दी", "भाषा"]);
  });

  it("strips English contractions so their residue cannot become a content term", () => {
    expect(
      tokenize("We've used it; don't, can't, won't, it's, I'm, they'll, you're, he'd"),
    ).toEqual(["we", "used", "it", "do", "can", "will", "it", "they", "you", "he"]);
    expect(tokenize("don’t")).toEqual(["do"]);
  });

  it("treats contraction residues as stopwords when they arrive on their own", () => {
    expect(normaliseQuestion("re ve ll budget").terms).toEqual(["budget"]);
  });
});
