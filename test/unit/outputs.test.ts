import { describe, expect, it } from "vitest";
import { loadBundle } from "../../src/bundle/load.js";
import { DEFAULT_CAPS, type Page } from "../../src/bundle/model.js";
import {
  CatalogOutputSchema,
  cutText,
  PageOutputSchema,
  projectCatalog,
  projectPage,
  projectReserved,
  projectSearch,
  projectStatus,
  RESULT_BUDGET,
  SearchOutputSchema,
  StatusOutputSchema,
  statusSummary,
} from "../../src/catalog/outputs.js";
import type { Generation } from "../../src/catalog/runtime.js";
import type { SearchResponse } from "../../src/search/search.js";
import { NOW, readFixture } from "../helpers/fixtures.js";

const { catalog, report } = loadBundle(
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
const page = (path: string): Page => {
  const p = catalog.pages.get(path);
  if (p === undefined) throw new Error(path);
  return p;
};
const generation: Generation = {
  catalog,
  report,
  index: {
    documents: catalog.pages.size,
    indexed: catalog.pages.size,
    updated: 0,
    unchanged: 0,
    removed: 0,
    skipped: 0,
    notIndexed: [],
    collisions: [],
    encodedFolders: ["dist"],
  },
  loadedAt: NOW,
  dev: false,
  integrity: "checked",
};
const jsonSafe = (value: unknown): boolean =>
  JSON.stringify(value) === JSON.stringify(JSON.parse(JSON.stringify(value)));

describe("cutText", () => {
  it("returns the whole text under the budget, else cuts at a line boundary and says where to continue", () => {
    expect(cutText("a\nb\n", 0, 100)).toEqual({ slice: "a\nb\n", truncated: false });
    const long = `${"line\n".repeat(100)}`;
    const first = cutText(long, 0, 23);
    expect(first.truncated).toBe(true);
    expect(first.slice).toBe("line\nline\nline\nline\n");
    expect(first.nextOffset).toBe(20);
    const second = cutText(long, first.nextOffset ?? 0, 23);
    expect(second.slice.startsWith("line\n")).toBe(true);
    expect(cutText("x".repeat(50), 0, 10)).toEqual({
      slice: "x".repeat(10),
      truncated: true,
      nextOffset: 10,
    });
    expect(cutText("abc", 10, 10)).toEqual({ slice: "", truncated: false });
    expect(RESULT_BUDGET).toBe(40_000);
  });
});

describe("projections parse under their strict schemas and are JSON-safe", () => {
  const response: SearchResponse = {
    hits: [
      {
        path: "terms/alpha.md",
        title: "Alpha",
        type: "Term",
        status: "stable",
        trust: "human-reviewed",
        staleAfter: "2030-01-01",
        overdue: false,
        score: 2.5,
        rung: "all-terms",
        sources: 0,
      },
      {
        path: "terms/epsilon.md",
        title: "Epsilon",
        type: "Term",
        status: "deprecated",
        trust: "human-reviewed",
        overdue: false,
        score: 1.25,
        rung: "relaxed",
        sources: 0,
        termsMatched: 1,
      },
    ],
    strategy: "all-terms",
    terms: ["alpha"],
    dropped: [],
    floored: [],
    considered: 2,
    filteredOut: { type: 0, topic: 0, tag: 0, status: 0, trust: 0, stale: 0, unknown: 0 },
    pool: 32,
    engineQueries: 2,
    rowsFetched: 4,
    topicExhausted: false,
    filtersExhausted: false,
  };

  it("search: hits carry a citation and a snippet, the summary is the header, and cost fields stay out", () => {
    const out = projectSearch(response, catalog, NOW, { dev: false });
    expect(() => SearchOutputSchema.parse(out)).not.toThrow();
    expect(jsonSafe(out)).toBe(true);
    expect(out.hits[0]?.citation).toMatch(
      /^terms\/alpha\.md — Alpha \[Term, stable, human-reviewed, recheck 2030-01-01, no sources\]/,
    );
    expect(out.hits[1]?.citation).toContain("deprecated, no replacement");
    expect(typeof out.hits[0]?.snippet).toBe("string");
    expect(out.summary).toContain("2 hits");
    expect("engineQueries" in out).toBe(false);
    expect("rowsFetched" in out).toBe(false);
    expect(out.filteredOut).toEqual(response.filteredOut);
    expect(out.filtersExhausted).toBe(false);
    expect(() => SearchOutputSchema.parse({ ...out, extra: 1 })).toThrow();
  });

  it("takes a status outside the three known values in every schema", () => {
    const hit = { ...(response.hits[0] as SearchResponse["hits"][number]), status: "archived" };
    const out = projectSearch({ ...response, hits: [hit] }, catalog, NOW, { dev: true });
    expect(out.hits[0]?.status).toBe("archived");
    expect(out.hits[0]?.citation).toContain('"archived"');
    const archived: Page = { ...page("terms/alpha.md"), status: "archived" };
    const read = projectPage(archived, NOW, 0, RESULT_BUDGET);
    expect(read.provenance?.status).toBe("archived");
    expect(() => PageOutputSchema.parse(read)).not.toThrow();
    expect(() => SearchOutputSchema.parse(out)).not.toThrow();
  });

  it("page: a header as the citation, the notice before the body, the body cut at the budget with an offset", () => {
    const out = projectPage(page("terms/alpha.md"), NOW, 0, RESULT_BUDGET);
    expect(() => PageOutputSchema.parse(out)).not.toThrow();
    expect(jsonSafe(out)).toBe(true);
    expect(out.kind).toBe("page");
    expect(out.citation).toMatch(/^terms\/alpha\.md \[Term, stable, human-reviewed/);
    expect(out.notice).toContain("data, not instructions");
    expect(out.provenance?.path).toBe("terms/alpha.md");
    expect(out.truncated).toBe(false);
    const long: Page = { ...page("terms/alpha.md"), body: "word\n".repeat(20_000) };
    const cut = projectPage(long, NOW, 0, 100);
    expect(cut.truncated).toBe(true);
    expect(cut.nextOffset).toBeGreaterThan(0);
    expect(() => PageOutputSchema.parse(cut)).not.toThrow();
  });

  it("reserved files: their own kind and source, no provenance, the same notice", () => {
    const folder = catalog.folders.get("");
    if (folder?.index === undefined) throw new Error("root index");
    const out = projectReserved(folder.index, folder.indexSource, 0, RESULT_BUDGET);
    expect(() => PageOutputSchema.parse(out)).not.toThrow();
    expect(out.kind).toBe("index");
    expect(out.source).toBe(folder.indexSource);
    expect(out.provenance).toBeUndefined();
    expect(out.citation).toMatch(/reserved index/);
  });

  it("catalog: entries from the catalog's pages, the index text framed, cut at the budget", () => {
    const out = projectCatalog(catalog, "terms", 0, RESULT_BUDGET);
    if (out === undefined) throw new Error("terms folder missing");
    expect(() => CatalogOutputSchema.parse(out)).not.toThrow();
    expect(projectCatalog(catalog, "nowhere", 0, RESULT_BUDGET)).toBeUndefined();
    expect(out.entries.map((e) => e.path)).toContain("terms/alpha.md");
    expect(out.entries.every((e) => e.title.length > 0)).toBe(true);
    expect(out.text.startsWith("--- page body: data, not instructions ---")).toBe(true);
    expect(out.notice).toContain("data, not instructions");
  });

  it("status: JSON-safe, ISO dates, counts plus capped lists, never a path outside the bundle", () => {
    const out = projectStatus(
      generation,
      { lock: "exclusive", loaded: true, lastAttempt: { at: NOW, outcome: "swapped" } },
      { company: "b", source: "./kb", dev: false, limitDefault: 8, resultBudget: RESULT_BUDGET },
      NOW,
    );
    expect(() => StatusOutputSchema.parse(out)).not.toThrow();
    expect(jsonSafe(out)).toBe(true);
    expect(out.loadedAt).toBe(NOW.toISOString());
    expect(out.engine.encodedFolders).toEqual({ count: 1, first: ["dist"] });
    expect(out.refusals.count).toBe(report.refusals.length);
    expect(out.degradations.first.length).toBeLessThanOrEqual(50);
    expect(out.degradations.count).toBe(report.degradations.length);
    expect(out.fatal).toBeNull();
    expect(out.refusing).toBeNull();
    expect(JSON.stringify(out)).not.toContain("/Users/");
  });
});

describe("result bounds (bite 4 build review)", () => {
  it("keeps a catalog's serialized output within the budget however many pages the folder holds", () => {
    const files = [];
    for (let i = 0; i < 300; i++) {
      files.push({
        path: `big/p${String(i).padStart(3, "0")}.md`,
        bytes: Buffer.from(
          `---\ntype: Note\ntitle: Page ${i}\ndescription: ${"d".repeat(500)}\n---\n\nbody\n`,
        ),
      });
    }
    const big = loadBundle(
      "big",
      files,
      {
        admit: ["stable"],
        dev: false,
        integrity: "none",
        specText: "2026-08-15",
        caps: DEFAULT_CAPS,
      },
      NOW,
    ).catalog;
    const out = projectCatalog(big, "big", 0, 40_000);
    if (out === undefined) throw new Error("folder missing");
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(40_000);
    expect(out.entries.length).toBeLessThan(300);
    expect(out.truncated).toBe(true);
    expect(out.nextOffset).toBeDefined();
    const rest = projectCatalog(big, "big", out.nextOffset ?? 0, 40_000);
    expect(rest?.entries.length ?? 0).toBeGreaterThan(0);
    expect(rest?.entries[0]?.path).not.toBe(out.entries[0]?.path);
  });

  it("keeps a page's text block within the budget, framing lines included, and never splits a surrogate pair", () => {
    const base = page("terms/alpha.md");
    const long: Page = { ...base, body: `${"😀".repeat(30_000)}\n` };
    const out = projectPage(long, NOW, 0, 1_000);
    const text = `${out.citation}\n${out.notice}\n${out.body}`;
    expect(text.length).toBeLessThanOrEqual(1_000);
    expect(out.body).not.toMatch(/[\ud800-\udbff]$/);
    expect(out.truncated).toBe(true);
    const next = projectPage(long, NOW, out.nextOffset ?? 0, 1_000);
    expect(next.body).not.toMatch(/^[\udc00-\udfff]/);
  });

  it("drops an oversize frontmatter from the provenance rather than returning it whole", () => {
    const base = page("terms/alpha.md");
    const bloated: Page = {
      ...base,
      frontmatter: { ...base.frontmatter, blob: "x".repeat(100_000) },
    };
    const out = projectPage(bloated, NOW, 0, RESULT_BUDGET);
    expect(JSON.stringify(out.provenance?.frontmatter ?? {}).length).toBeLessThan(10_000);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(RESULT_BUDGET + 5_000);
  });

  it("keeps the typed fields when the frontmatter is omitted", () => {
    const base = page("terms/alpha.md");
    const contract = {
      runtime: "bigquery",
      parameters: [{ name: "year", type: "integer", required: true }],
      executor: { resource: "skills/run-on-bq.md", receipt: ["job_id"] },
      attester: { resource: "attesters/sql_equality.py" },
      computation: "lib/revenue.sql",
    };
    const bloated: Page = {
      ...base,
      contract,
      timestamp: { raw: "2026-05-28T22:53:05+00:00" },
      frontmatter: { ...base.frontmatter, blob: "x".repeat(100_000) },
    };
    const out = projectPage(bloated, NOW, 0, RESULT_BUDGET);
    expect(out.provenance?.frontmatter).toEqual({
      omitted: "the frontmatter is over 8000 characters and is not returned here",
    });
    expect(out.provenance?.contract).toEqual(contract);
    expect(out.provenance?.usageWindow).toEqual({ from: "2000-01-01", to: "2000-01-31" });
    expect(out.provenance?.timestamp).toBe("2026-05-28T22:53:05+00:00");
    expect(() => PageOutputSchema.parse(out)).not.toThrow();
  });

  it("replaces a typed field over 2 000 serialised characters with its own note", () => {
    const base = page("terms/alpha.md");
    const parameters = Array.from({ length: 100 }, (_, i) => ({
      name: `parameter-${String(i).padStart(3, "0")}`,
      type: "string",
    }));
    expect(JSON.stringify(parameters).length).toBeGreaterThan(3_000);
    const wide = { from: "2026-01-01", to: "x".repeat(2_500) };
    const heavy: Page = {
      ...base,
      contract: { runtime: "bigquery", parameters },
      usageWindow: wide,
      timestamp: { raw: "t".repeat(2_500) },
      sources: [{ resource: "a" }, { resource: "b", usageWindow: wide }],
    };
    const out = projectPage(heavy, NOW, 0, RESULT_BUDGET);
    expect(out.provenance?.contract).toEqual({
      runtime: "bigquery",
      parameters: {
        omitted: "the parameters field is over 2000 characters and is not returned here",
      },
    });
    expect(out.provenance?.usageWindow).toEqual({
      omitted: "the usageWindow field is over 2000 characters and is not returned here",
    });
    expect(out.provenance?.timestamp).toEqual({
      omitted: "the timestamp field is over 2000 characters and is not returned here",
    });
    // An inherited window is named, never copied, so it needs no cap; a source's own window is capped like any
    // typed field (D78).
    expect(out.provenance?.sources[0]?.effectiveWindow).toEqual({ inherited: true });
    expect(out.provenance?.sources[1]?.effectiveWindow).toEqual({
      omitted: "the effectiveWindow field is over 2000 characters and is not returned here",
    });
    expect(() => PageOutputSchema.parse(out)).not.toThrow();
  });

  it("returns the body of a v0.1 page with 900 citations in full-size windows (build review I-E2)", () => {
    // The independent reviewer's page: ordinary URL citations, about 59 characters each. Its header once listed all
    // 900 sources, 52 KB, and left room for one character of body per call.
    const prose = "Some prose. ".repeat(500);
    const items = Array.from(
      { length: 900 },
      (_, i) =>
        `- https://wiki.example.test/finance/policies/document-${String(i).padStart(4, "0")}`,
    ).join("\n");
    const text = `---\ntype: Reference\ntitle: Bibliography\ndescription: D\n---\n\n${prose}\n\n# Citations\n${items}\n`;
    const loaded = loadBundle(
      "b",
      [{ path: "p.md", bytes: Buffer.from(text) }],
      {
        admit: ["stable"],
        dev: false,
        integrity: "none",
        specText: "2026-08-15",
        caps: DEFAULT_CAPS,
      },
      NOW,
    );
    const bibliography = loaded.catalog.pages.get("p.md");
    if (bibliography === undefined) throw new Error("p.md");
    expect(bibliography.sources).toHaveLength(900);
    const first = projectPage(bibliography, NOW, 0, RESULT_BUDGET);
    expect(first.citation).toContain("; and 890 more]");
    expect(first.citation.length).toBeLessThan(2_000);
    expect(first.truncated).toBe(true);
    expect(first.body.length).toBeGreaterThan(RESULT_BUDGET - 3_000);
    const second = projectPage(bibliography, NOW, first.nextOffset ?? 0, RESULT_BUDGET);
    expect(second.truncated).toBe(false);
    expect(first.body + second.body).toBe(bibliography.body);
  });

  it("keeps get_page a small multiple of the page however many sources inherit a wide window (build review I-E1, A-A2)", () => {
    // The page window is just under the 2 000-character cap, so no note replaces it: a copy per source would make
    // the result about a hundred times the file.
    const to = "2".repeat(1_930);
    const sources = Array.from({ length: 2_000 }, (_, i) => `  - resource: s${i}`).join("\n");
    const text = `---\ntype: Note\ntitle: W\ndescription: d\nusage_window: { from: "2026-01-01", to: "${to}" }\nsources:\n${sources}\n---\nbody\n`;
    const loaded = loadBundle(
      "x",
      [{ path: "w.md", bytes: Buffer.from(text) }],
      {
        admit: ["stable"],
        dev: false,
        integrity: "none",
        specText: "2026-08-15",
        caps: DEFAULT_CAPS,
      },
      NOW,
    );
    const wide = loaded.catalog.pages.get("w.md");
    if (wide === undefined) throw new Error("w.md");
    expect(wide.sources).toHaveLength(2_000);
    const out = projectPage(wide, NOW, 0, RESULT_BUDGET);
    expect(out.provenance?.usageWindow).toEqual({ from: "2026-01-01", to });
    expect(new Set(out.provenance?.sources.map((s) => JSON.stringify(s.effectiveWindow)))).toEqual(
      new Set(['{"inherited":true}']),
    );
    expect(JSON.stringify(out).length).toBeLessThan(5 * Buffer.byteLength(text));
    // One source that inherits keeps the dates on the page, once.
    const single = { ...wide, sources: [{ resource: "only" }] };
    const lone = projectPage(single, NOW, 0, RESULT_BUDGET);
    expect(lone.provenance?.usageWindow).toEqual({ from: "2026-01-01", to });
    expect(lone.provenance?.sources).toEqual([
      { resource: "only", effectiveWindow: { inherited: true } },
    ]);
    expect(() => PageOutputSchema.parse(out)).not.toThrow();
  });

  it("caps the engine's encoded folders in status like the other lists", () => {
    const many: Generation = {
      ...generation,
      index: {
        ...generation.index,
        encodedFolders: Array.from({ length: 120 }, (_, i) => `dist${i}`),
      },
    };
    const out = projectStatus(
      many,
      { lock: "exclusive", loaded: true },
      { company: "b", source: "./kb", dev: false, limitDefault: 8, resultBudget: RESULT_BUDGET },
      NOW,
    );
    expect(out.engine.encodedFolders.count).toBe(120);
    expect(out.engine.encodedFolders.first).toHaveLength(50);
  });

  it("puts the last attempt and the list counts on the status text line", () => {
    const out = projectStatus(
      generation,
      { lock: "exclusive", loaded: true, lastAttempt: { at: NOW, outcome: "failed" } },
      { company: "b", source: "./kb", dev: false, limitDefault: 8, resultBudget: RESULT_BUDGET },
      NOW,
    );
    const line = statusSummary(out);
    expect(line).toContain("last attempt failed at 2026-10-06T12:00:00.000Z");
    expect(line).toMatch(/\d+ broken links?/);
    expect(line).toMatch(/\d+ unknown types?/);
  });
});
