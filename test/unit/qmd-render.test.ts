import { describe, expect, it } from "vitest";
import type { DerivedDocument } from "../../src/derive/derived-document.js";
import { decodePath, encodePath, renderDocument } from "../../src/engine/qmd-render.js";

const doc: DerivedDocument = {
  path: "terms/alpha.md",
  title: "Alpha",
  description: "The alpha  term,\nfirst of all.",
  type: "Term",
  tags: ["alpha", "glossary"],
  metadata: { okf_type: "Term" },
  body: "Alpha is the first term.\n",
};

describe("renderDocument", () => {
  it("writes the title first, then description, type and tags without label words, then the body", () => {
    expect(renderDocument(doc)).toBe(
      "# Alpha\nThe alpha term, first of all.\nTerm\nalpha glossary\n\nAlpha is the first term.\n",
    );
  });

  it("skips empty lines for a page without a description or tags, and collapses whitespace in the title", () => {
    const { description: _omitted, ...bare } = doc;
    expect(renderDocument({ ...bare, title: " Multi\nline  title ", tags: [] })).toBe(
      "# Multi line title\nTerm\n\nAlpha is the first term.\n",
    );
  });

  it("renders the metadata as a leading qmd block only when asked", () => {
    const text = renderDocument(doc, { metadataBlock: true });
    expect(text.startsWith("---\nqmd:\n  metadata:\n    okf_type: Term\n---\n# Alpha\n")).toBe(
      true,
    );
    expect(renderDocument(doc)).not.toContain("---");
  });
});

describe("path codec", () => {
  it("escapes the segments qmd would skip and anything that starts with an underscore, reversibly", () => {
    const cases: Array<[string, string]> = [
      ["terms/alpha.md", "terms/alpha.md"],
      ["dist/a.md", "_dist/a.md"],
      ["_dist/a.md", "__dist/a.md"],
      ["__dist/a.md", "___dist/a.md"],
      ["Dist/a.md", "Dist/a.md"],
      ["x/node_modules/y.md", "x/_node_modules/y.md"],
      ["dists/a.md", "dists/a.md"],
      ["a\\b.md", "a%5Cb.md"],
      ["x%y.md", "x%25y.md"],
    ];
    for (const [plain, encoded] of cases) {
      expect(encodePath(plain), plain).toBe(encoded);
      expect(decodePath(encoded), encoded).toBe(plain);
    }
  });

  it("round-trips arbitrary paths", () => {
    for (const p of ["build/vendor/.cache/x.md", "_/_/_.md", "100%/a\\b/_c.md", "déjà/vu.md"]) {
      expect(decodePath(encodePath(p)), p).toBe(p);
    }
  });
});
