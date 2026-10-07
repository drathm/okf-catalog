import { describe, expect, it } from "vitest";
import { nearestPaths } from "../../src/catalog/nearest.js";

const paths = [
  "terms/alpha.md",
  "terms/beta.md",
  "terms/gamma.md",
  "notes/alpha-notes.md",
  "notes/injection.md",
  "dist/page.md",
  "index.md",
];

describe("nearestPaths", () => {
  it("prefers paths that share leading folders, then the smallest edit distance, then path order", () => {
    expect(nearestPaths(paths, "terms/alpa.md")).toEqual([
      "terms/alpha.md",
      "terms/beta.md",
      "terms/gamma.md",
    ]);
    expect(nearestPaths(paths, "notes/alpha.md")).toEqual([
      "notes/alpha-notes.md",
      "notes/injection.md",
      "terms/alpha.md",
    ]);
  });
  it("returns at most n, and every served path when fewer exist", () => {
    expect(nearestPaths(paths, "zzz", 2)).toHaveLength(2);
    expect(nearestPaths(["a.md"], "b.md")).toEqual(["a.md"]);
    expect(nearestPaths([], "b.md")).toEqual([]);
  });
  it("stays fast on a long path against many candidates", () => {
    const many = Array.from({ length: 2000 }, (_, i) => `folder${i % 20}/page-${i}.md`);
    const started = performance.now();
    nearestPaths(many, "x".repeat(30_000));
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("nearestPaths: cost (bite 4 build review)", () => {
  it("answers within a small budget against a bundle at the file cap", () => {
    const many = Array.from(
      { length: 20_000 },
      (_, i) => `folder${i % 40}/section${i % 7}/page-${i}.md`,
    );
    const started = performance.now();
    const found = nearestPaths(many, "folder3/section2/page-9999.md".replace("9999", "999x"));
    expect(performance.now() - started).toBeLessThan(500);
    expect(found).toHaveLength(3);
  });
});
