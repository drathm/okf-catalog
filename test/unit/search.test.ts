import { describe, expect, it } from "vitest";
import { loadBundle } from "../../src/bundle/load.js";
import { DEFAULT_CAPS, type Page } from "../../src/bundle/model.js";
import type { Catalog } from "../../src/catalog/model.js";
import { deriveDocument } from "../../src/derive/derived-document.js";
import { renderDocument } from "../../src/engine/qmd-render.js";
import type { Engine, EngineHit, IndexResult } from "../../src/search/engine.js";
import { search } from "../../src/search/search.js";
import { NOW, readFixture } from "../helpers/fixtures.js";

/** An in-memory engine with qmd's observable contract: every term must match as a prefix, hits carry a raw score and its qmd mapping, and `limit` is exact. */
function fakeEngine(catalog: Catalog): Engine & { queries: string[][] } {
  const texts = new Map<string, string[]>();
  for (const page of catalog.pages.values()) {
    const text = renderDocument(deriveDocument(page)).toLowerCase();
    texts.set(
      page.path,
      text.split(/[^\p{L}\p{N}-]+/u).filter((w) => w.length > 0),
    );
  }
  const queries: string[][] = [];
  return {
    queries,
    async index(): Promise<IndexResult> {
      return {
        documents: texts.size,
        indexed: texts.size,
        updated: 0,
        unchanged: 0,
        removed: 0,
        skipped: 0,
        notIndexed: [],
        encodedFolders: [],
      };
    },
    async lex(terms, limit): Promise<EngineHit[]> {
      queries.push([...terms]);
      const hits: EngineHit[] = [];
      for (const [path, words] of texts) {
        let bm25 = 0;
        let all = true;
        for (const term of terms) {
          const n = words.filter((w) => w.startsWith(term)).length;
          if (n === 0) all = false;
          bm25 += n;
        }
        if (all && terms.length > 0) hits.push({ path, bm25, score: bm25 / (1 + bm25) });
      }
      return hits.sort((a, b) => b.bm25 - a.bm25 || (a.path < b.path ? -1 : 1)).slice(0, limit);
    },
    async status() {
      return { documents: texts.size };
    },
    async close() {},
  };
}

const base = loadBundle(
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
).catalog;
const request = (question: string, patch: Partial<Parameters<typeof search>[2]> = {}) => ({
  question,
  includeStale: false,
  limit: 8,
  ...patch,
});

describe("search: the first rung", () => {
  it("answers a keyword question from the all-terms rung with provenance on every hit", async () => {
    const r = await search(base, fakeEngine(base), request("alpha glossary"), NOW);
    expect(r.strategy).toBe("all-terms");
    expect(r.hits[0]).toMatchObject({
      path: "terms/alpha.md",
      title: "Alpha",
      type: "Term",
      status: "stable",
      trust: "human-reviewed",
      overdue: false,
      rung: "all-terms",
    });
    expect(r.hits[0]?.score).toBeGreaterThan(0);
    expect(r.terms).toEqual(["alpha", "glossary"]);
    expect(r.considered).toBeGreaterThanOrEqual(1);
  });

  it("filters by type and by topic, pushing both into the query as terms", async () => {
    const engine = fakeEngine(base);
    const byType = await search(base, engine, request("page", { type: "Note" }), NOW);
    expect(byType.hits.length).toBeGreaterThan(0);
    expect(byType.hits.every((h) => h.type === "Note")).toBe(true);
    expect(engine.queries[0]).toContain("note");
    const byTopic = await search(base, engine, request("term", { topic: "terms" }), NOW);
    expect(byTopic.hits.length).toBeGreaterThan(0);
    expect(byTopic.hits.every((h) => h.path.startsWith("terms/"))).toBe(true);
  });

  it("drops overdue pages unless asked, and flags them when asked", async () => {
    const strict = await search(base, fakeEngine(base), request("zeta"), NOW);
    expect(strict.hits.map((h) => h.path)).not.toContain("terms/zeta.md");
    expect(strict.filteredOut.stale).toBeGreaterThanOrEqual(1);
    const lenient = await search(
      base,
      fakeEngine(base),
      request("zeta", { includeStale: true }),
      NOW,
    );
    expect(lenient.hits[0]).toMatchObject({
      path: "terms/zeta.md",
      overdue: true,
      staleAfter: "2000-01-31",
    });
  });

  it("widens the pool while the filters leave it short and the rung returned a full pool", async () => {
    const pages = new Map<string, Page>(base.pages);
    const alpha = base.pages.get("terms/alpha.md");
    if (!alpha) throw new Error("alpha");
    for (let i = 0; i < 40; i++) {
      pages.set(`stale/s${i}.md`, {
        ...alpha,
        path: `stale/s${i}.md`,
        folder: "stale",
        title: `Common ${i}`,
        body: "common common common\n",
        staleAfter: { raw: "2000-01-01", form: "date", at: new Date(Date.UTC(2000, 0, 1)) },
      });
    }
    const { staleAfter: _dropped, ...rest } = alpha;
    pages.set("fresh/f.md", {
      ...rest,
      path: "fresh/f.md",
      folder: "fresh",
      title: "Common fresh",
      body: "common\n",
    });
    const catalog: Catalog = { ...base, pages };
    const r = await search(catalog, fakeEngine(catalog), request("common", { limit: 1 }), NOW);
    expect(r.hits.map((h) => h.path)).toEqual(["fresh/f.md"]);
    expect(r.pool).toBeGreaterThan(4);
    expect(r.filteredOut.stale).toBe(40);
  });
});

describe("search: the relaxed rung and degenerate questions", () => {
  it("relaxes to per-term queries when no page holds every term, ranking by terms matched then summed score", async () => {
    const engine = fakeEngine(base);
    const r = await search(base, engine, request("alpha unicorn glossary"), NOW);
    expect(r.strategy).toBe("relaxed");
    expect(r.hits[0]).toMatchObject({ path: "terms/alpha.md", rung: "relaxed", termsMatched: 2 });
    expect(engine.queries.length).toBeGreaterThan(1);
  });

  it("keeps first-rung hits ahead of relaxed ones and never repeats a page", async () => {
    const r = await search(base, fakeEngine(base), request("glossary unicorn", { limit: 8 }), NOW);
    const paths = r.hits.map((h) => h.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(r.hits.some((h) => h.rung === "relaxed")).toBe(true);
  });

  it("answers a question with no content terms with no hits and the reason", async () => {
    const r = await search(base, fakeEngine(base), request("the of and"), NOW);
    expect(r).toMatchObject({
      hits: [],
      strategy: "none",
      reason: "no-content-terms",
      dropped: ["the", "of", "and"],
    });
  });

  it("orders equal scores by trust then by path, so the order is deterministic", async () => {
    const r = await search(
      base,
      fakeEngine(base),
      request("page", { type: "Note", limit: 25 }),
      NOW,
    );
    const rank = { "human-reviewed": 0, "machine-confirmed": 1, unverified: 2 } as const;
    const sorted = [...r.hits].sort(
      (a, b) => b.score - a.score || rank[a.trust] - rank[b.trust] || (a.path < b.path ? -1 : 1),
    );
    expect(r.hits.map((h) => h.path)).toEqual(sorted.map((h) => h.path));
  });
});

describe("search: ties at the engine's cut", () => {
  /** An engine whose order among equal scores changes from call to call, as qmd's does from index to index. */
  function tieEngine(tied: string[], tail: string): Engine & { limits: number[] } {
    let calls = 0;
    const limits: number[] = [];
    return {
      limits,
      async index(): Promise<IndexResult> {
        return {
          documents: tied.length + 1,
          indexed: tied.length + 1,
          updated: 0,
          unchanged: 0,
          removed: 0,
          skipped: 0,
          notIndexed: [],
          encodedFolders: [],
        };
      },
      async lex(terms, limit): Promise<EngineHit[]> {
        limits.push(limit);
        if (terms.length !== 1 || terms[0] !== "alpha") return [];
        const start = calls++ % tied.length;
        const rotated = [...tied.slice(start), ...tied.slice(0, start)];
        const rows = [
          ...rotated.map((path) => ({ path, bm25: 5, score: 5 / 6 })),
          { path: tail, bm25: 1, score: 0.5 },
        ];
        return rows.slice(0, limit);
      },
      async status() {
        return { documents: tied.length + 1 };
      },
      async close() {},
    };
  }

  it("returns the same hits whichever tied rows the engine happens to cut, by completing the tie group", async () => {
    const paths = [...base.pages.keys()].sort();
    const tied = paths.slice(0, 5);
    const tail = paths[5] as string;
    const engine = tieEngine(tied, tail);
    const seen = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const r = await search(
        base,
        engine,
        request("alpha beta", { limit: 1, includeStale: true }),
        NOW,
      );
      expect(r.hits).toHaveLength(1);
      seen.add((r.hits[0] as { path: string }).path);
    }
    // The pool of four cuts a tie group of five; the answer must not depend on which four the engine returned,
    // and the winner is the group's first page by the documented order: trust, then path.
    const trustRank = { "human-reviewed": 0, "machine-confirmed": 1, unverified: 2 } as const;
    const expected = [...tied].sort((a, b) => {
      const ta = trustRank[(base.pages.get(a) as Page).trust];
      const tb = trustRank[(base.pages.get(b) as Page).trust];
      return ta - tb || (a < b ? -1 : 1);
    })[0];
    expect([...seen]).toEqual([expected]);
    // The tail row below the tie group is never fetched into the answer, so the group was completed, not the whole index.
    expect(Math.max(...engine.limits)).toBeLessThan(500);
  });
});
