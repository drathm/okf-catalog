import { describe, expect, it } from "vitest";
import { loadBundle } from "../../src/bundle/load.js";
import { DEFAULT_CAPS } from "../../src/bundle/model.js";
import { deriveDocument } from "../../src/derive/derived-document.js";
import { NOW, readFixture } from "../helpers/fixtures.js";

const { catalog } = loadBundle(
  "b",
  readFixture("behaviours"),
  {
    admit: ["stable", "deprecated"],
    dev: false,
    integrity: "require-manifest",
    specText: "2026-08-15",
    caps: DEFAULT_CAPS,
  },
  NOW,
);
const page = (path: string) => {
  const p = catalog.pages.get(path);
  if (!p) throw new Error(path);
  return p;
};

describe("deriveDocument", () => {
  it("carries the fields and the okf metadata of a fully described page", () => {
    const doc = deriveDocument(page("terms/alpha.md"));
    expect(doc.path).toBe("terms/alpha.md");
    expect(doc.title).toBe("Alpha");
    expect(doc.type).toBe("Term");
    expect(doc.tags).toEqual(["alpha", "glossary"]);
    expect(doc.metadata).toEqual({
      okf_type: "Term",
      okf_status: "stable",
      okf_tags: ["alpha", "glossary"],
      okf_stale_after: "2999-12-31",
      okf_trust: "human-reviewed",
      okf_verified_by: "human:reviewer",
      okf_source_count: 1,
    });
  });

  it("leaves out metadata a page does not have", () => {
    const doc = deriveDocument(page("terms/gamma.md"));
    expect(doc.metadata).toEqual({
      okf_type: "Term",
      okf_status: "stable",
      okf_tags: ["gamma"],
      okf_trust: "unverified",
      okf_source_count: 0,
    });
    expect(doc.description).toBe("The gamma term, never verified and never overdue.");
  });

  it("removes a leading heading equal to the title, and keeps one that differs", () => {
    expect(
      deriveDocument(page("terms/alpha.md"))
        .body.trimStart()
        .startsWith("Alpha is the first term."),
    ).toBe(true);
    expect(
      deriveDocument(page("notes/no-title.md"))
        .body.trimStart()
        .startsWith("The title comes from this heading."),
    ).toBe(true);
    expect(deriveDocument(page("terms/delta.md")).body.trimStart().startsWith("# Deprecated")).toBe(
      true,
    );
  });

  it("compares the heading and the title without regard to case or spacing", () => {
    const p = { ...page("terms/alpha.md"), title: "alpha", body: "#   ALPHA  \n\nBody.\n" };
    expect(deriveDocument(p).body).toBe("Body.\n");
  });
});
