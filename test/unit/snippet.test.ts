import { describe, expect, it } from "vitest";
import { snippet } from "../../src/search/snippet.js";

const prose =
  "The alpha term is the first term of the glossary. Beta follows alpha in the glossary and gamma follows beta. " +
  "Delta is a legacy term that points at a successor. Epsilon was retired without a successor and stays deprecated.";

describe("snippet", () => {
  it("picks the earliest window that holds the most distinct terms, trimmed to words and marked where cut", () => {
    const s = snippet({ prose }, ["gamma", "delta"], 60);
    expect(s.length).toBeLessThanOrEqual(64);
    expect(s).toMatch(/gamma/);
    expect(s).toMatch(/Delta/);
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s).not.toMatch(/\s{2,}/);
  });
  it("matches terms as prefixes at word starts, case-insensitively", () => {
    expect(snippet({ prose }, ["epsil"], 40)).toMatch(/Epsilon/);
    expect(snippet({ prose }, ["lossary"], 40)).not.toMatch(/glossary/);
  });
  it("matches a CJK pair anywhere in a run", () => {
    const s = snippet({ prose: "前言。知識庫是公司的記憶，搜尋引擎讀它。結語。" }, ["記憶"], 12);
    expect(s).toContain("記憶");
  });
  it("falls back to the description, then to the first characters, then to an empty string", () => {
    expect(snippet({ prose, description: "A short description." }, ["zzzz"], 40)).toBe(
      "A short description.",
    );
    expect(snippet({ prose }, ["zzzz"], 20)).toBe("The alpha term is…");
    expect(snippet({}, ["alpha"], 20)).toBe("");
  });
  it("returns the whole prose when it fits", () => {
    expect(snippet({ prose: "Short text." }, ["short"], 200)).toBe("Short text.");
  });
});
