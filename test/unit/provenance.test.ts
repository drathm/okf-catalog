import { describe, expect, it } from "vitest";
import type { Page } from "../../src/bundle/model.js";
import { isOverdue, provenanceOf } from "../../src/catalog/provenance.js";

const page = (patch: Partial<Page>): Page =>
  ({
    path: "terms/x.md",
    folder: "terms",
    hash: "h",
    type: "Term",
    title: "X",
    titleSource: "frontmatter",
    descriptionSource: "none",
    tags: [],
    status: "stable",
    statusSource: "frontmatter",
    verified: [],
    trust: "unverified",
    sources: [],
    links: [],
    footnoteReferences: [],
    frontmatter: { type: "Term", extra: 1 },
    body: "",
    degradations: [],
    ...patch,
  }) as Page;

describe("isOverdue", () => {
  it("judges a date by the start of its UTC day, with the boundary exact to the millisecond", () => {
    const stale = { raw: "2000-01-31", form: "date" as const, at: new Date(Date.UTC(2000, 0, 31)) };
    expect(isOverdue(stale, new Date("2000-01-30T23:59:59.999Z"))).toBe(false);
    expect(isOverdue(stale, new Date("2000-01-31T00:00:00.000Z"))).toBe(true);
  });

  it("judges a datetime by its instant, so an evening deadline is not overdue in the morning", () => {
    const stale = {
      raw: "2000-06-01T18:00:00Z",
      form: "datetime" as const,
      at: new Date(Date.UTC(2000, 5, 1, 18)),
    };
    expect(isOverdue(stale, new Date("2000-06-01T12:00:00Z"))).toBe(false);
    expect(isOverdue(stale, new Date("2000-06-01T17:59:59.999Z"))).toBe(false);
    expect(isOverdue(stale, new Date("2000-06-01T18:00:00.000Z"))).toBe(true);
  });

  it("never finds an unparseable or absent recheck date overdue", () => {
    expect(isOverdue({ raw: "soon", form: "unparseable" }, new Date("2999-01-01T00:00:00Z"))).toBe(
      false,
    );
    expect(isOverdue(undefined, new Date("2999-01-01T00:00:00Z"))).toBe(false);
  });
});

describe("provenanceOf", () => {
  it("renders timestamps as written, computes overdue from the clock, and carries the whole frontmatter", () => {
    const p = page({
      generated: {
        by: "human:editor",
        at: { raw: "2000-02-01T10:00:00Z", at: new Date(Date.UTC(2000, 1, 1, 10)) },
      },
      verified: [
        {
          by: "human:reviewer",
          at: { raw: "2000-03-01T09:00:00Z", at: new Date(Date.UTC(2000, 2, 1, 9)) },
        },
      ],
      trust: "human-reviewed",
      staleAfter: { raw: "2000-01-31", form: "date", at: new Date(Date.UTC(2000, 0, 31)) },
      resource: "https://example.test/x",
      replacement: "terms/y.md",
    });
    expect(provenanceOf(p, new Date("2026-10-06T12:00:00Z"))).toEqual({
      path: "terms/x.md",
      title: "X",
      type: "Term",
      status: "stable",
      trust: "human-reviewed",
      generated: { by: "human:editor", at: "2000-02-01T10:00:00Z" },
      verified: [{ by: "human:reviewer", at: "2000-03-01T09:00:00Z" }],
      staleAfter: { raw: "2000-01-31", form: "date", overdue: true },
      sources: [],
      resource: "https://example.test/x",
      replacement: "terms/y.md",
      frontmatter: { type: "Term", extra: 1 },
    });
  });

  it("leaves out what the page does not have rather than inventing it", () => {
    const prov = provenanceOf(page({}), new Date("2026-10-06T12:00:00Z"));
    expect(prov.generated).toBeUndefined();
    expect(prov.staleAfter).toBeUndefined();
    expect(prov.verified).toEqual([]);
  });
});

describe("provenance on parsed fixture pages (review round 1)", () => {
  it("judges beta and theta at noon on their day by the instant rule, not the calendar day", async () => {
    const { loadBundle } = await import("../../src/bundle/load.js");
    const { DEFAULT_CAPS } = await import("../../src/bundle/model.js");
    const { readFixture } = await import("../helpers/fixtures.js");
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
      new Date("2000-06-01T12:00:00Z"),
    );
    const noon = new Date("2000-06-01T12:00:00Z");
    expect(isOverdue(catalog.pages.get("terms/beta.md")?.staleAfter, noon)).toBe(false);
    expect(isOverdue(catalog.pages.get("terms/theta.md")?.staleAfter, noon)).toBe(false);
    expect(isOverdue(catalog.pages.get("terms/zeta.md")?.staleAfter, noon)).toBe(true);
  });
});
