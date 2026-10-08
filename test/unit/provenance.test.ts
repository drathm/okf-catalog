import { describe, expect, it } from "vitest";
import type { Page } from "../../src/bundle/model.js";
import { effectiveWindow, isOverdue, provenanceOf } from "../../src/catalog/provenance.js";

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

// The readiness ledger (issue 2's "Holds", D59, row 20): a form the pinned text did not expect is reported and used.
describe("provenance: the readiness ledger (D59)", () => {
  it("keeps the unexpected stale_after form in use", async () => {
    const { loadBundle } = await import("../../src/bundle/load.js");
    const { DEFAULT_CAPS } = await import("../../src/bundle/model.js");
    const { readFixture } = await import("../helpers/fixtures.js");
    const load = (specText: "2026-08-15" | "2026-08-21") =>
      loadBundle(
        "b",
        readFixture("behaviours"),
        {
          admit: ["stable", "deprecated"],
          dev: false,
          integrity: "require-manifest",
          specText,
          caps: DEFAULT_CAPS,
        },
        new Date("2026-10-06T12:00:00Z"),
      ).catalog;
    // A datetime where the 15 August text expects a date: reported, and its instant still decides.
    const beta = load("2026-08-15").pages.get("terms/beta.md");
    expect(beta?.degradations.map((d) => d.code)).toContain("stale-after-unexpected-form");
    expect(isOverdue(beta?.staleAfter, new Date("2000-06-01T17:59:59.999Z"))).toBe(false);
    expect(isOverdue(beta?.staleAfter, new Date("2000-06-01T18:00:00.000Z"))).toBe(true);
    if (beta === undefined) throw new Error("beta");
    expect(provenanceOf(beta, new Date("2000-06-01T18:00:00Z")).staleAfter).toEqual({
      raw: "2000-06-01T18:00:00Z",
      form: "datetime",
      overdue: true,
    });
    // A date where the 21 August text expects a datetime: reported, and overdue from the start of its UTC day.
    const zeta = load("2026-08-21").pages.get("terms/zeta.md");
    expect(zeta?.degradations.map((d) => d.code)).toContain("stale-after-unexpected-form");
    expect(isOverdue(zeta?.staleAfter, new Date("2000-01-30T23:59:59.999Z"))).toBe(false);
    expect(isOverdue(zeta?.staleAfter, new Date("2000-01-31T00:00:00.000Z"))).toBe(true);
  });
});

// R3 (D62): one inheritance function for a source's usage window.
describe("provenance: the usage window (R3)", () => {
  it("takes a source's own window, else the page's, and says which", () => {
    const own = { from: "2026-06-01", to: "2026-06-30" };
    const shared = { from: "2026-01-01", to: "2026-12-31" };
    expect(effectiveWindow({ resource: "a", usageWindow: own }, shared)).toEqual({
      ...own,
      inherited: false,
    });
    // An inherited window is named, not copied: the page's usageWindow carries its dates once (build review I-E1).
    expect(effectiveWindow({ resource: "b" }, shared)).toEqual({ inherited: true });
    expect(effectiveWindow({ resource: "c" }, undefined)).toBeUndefined();
    const prov = provenanceOf(
      page({
        usageWindow: shared,
        sources: [{ resource: "a", usageWindow: own }, { resource: "b" }],
      }),
      new Date("2026-10-06T12:00:00Z"),
    );
    expect(prov.usageWindow).toEqual(shared);
    expect(prov.sources).toEqual([
      { resource: "a", usageWindow: own, effectiveWindow: { ...own, inherited: false } },
      { resource: "b", effectiveWindow: { inherited: true } },
    ]);
    // One source that inherits: the dates stay on the page, once.
    const one = provenanceOf(
      page({ usageWindow: shared, sources: [{ resource: "d" }] }),
      new Date("2026-10-06T12:00:00Z"),
    );
    expect(one.usageWindow).toEqual(shared);
    expect(one.sources).toEqual([{ resource: "d", effectiveWindow: { inherited: true } }]);
    // A source whose own window was malformed takes none, not the page's (build review I-A1, A-A5), and the marker
    // that says so stays out of the result.
    expect(effectiveWindow({ resource: "e", usageWindowIgnored: true }, shared)).toBeUndefined();
    const ignored = provenanceOf(
      page({
        usageWindow: shared,
        sources: [{ resource: "e", usageCount: 7, usageWindowIgnored: true }, { resource: "f" }],
      }),
      new Date("2026-10-06T12:00:00Z"),
    );
    expect(ignored.sources).toEqual([
      { resource: "e", usageCount: 7 },
      { resource: "f", effectiveWindow: { inherited: true } },
    ]);
    expect(Object.keys(ignored.sources[0] ?? {})).toEqual(["resource", "usageCount"]);
    // Nothing is copied onto the stored sources: the page keeps only what it was given.
    const alone = provenanceOf(page({ sources: [{ resource: "c" }] }), new Date());
    expect(alone.sources).toEqual([{ resource: "c" }]);
    expect(alone.usageWindow).toBeUndefined();
  });
});
