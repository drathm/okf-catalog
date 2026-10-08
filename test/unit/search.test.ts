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
function fakeEngine(
  catalog: Catalog,
  options: { qmdLike?: boolean } = {},
): Engine & { queries: string[][]; limits: number[] } {
  const texts = new Map<string, string[]>();
  for (const page of catalog.pages.values()) {
    // qmd indexes the path as a column of its own; the qmd-like engine adds its words and floors a term's
    // weight when it is in at least half the pages, as SQLite's inverse document frequency does.
    const prefix = options.qmdLike ? `${page.path} ` : "";
    const text = `${prefix}${renderDocument(deriveDocument(page))}`.toLowerCase();
    texts.set(
      page.path,
      text.split(/[^\p{L}\p{N}-]+/u).filter((w) => w.length > 0),
    );
  }
  const weight = (term: string): number => {
    if (!options.qmdLike) return 1;
    let df = 0;
    for (const words of texts.values()) if (words.some((w) => w.startsWith(term))) df += 1;
    return df * 2 >= texts.size ? 1e-6 : 1;
  };
  const queries: string[][] = [];
  const limits: number[] = [];
  return {
    queries,
    limits,
    async index(): Promise<IndexResult> {
      return {
        documents: texts.size,
        indexed: texts.size,
        updated: 0,
        unchanged: 0,
        removed: 0,
        skipped: 0,
        notIndexed: [],
        collisions: [],
        encodedFolders: [],
      };
    },
    async lex(terms, limit): Promise<EngineHit[]> {
      queries.push([...terms]);
      limits.push(limit);
      const hits: EngineHit[] = [];
      for (const [path, words] of texts) {
        let bm25 = 0;
        let all = true;
        for (const term of terms) {
          const n = words.filter((w) => w.startsWith(term)).length;
          if (n === 0) all = false;
          bm25 += n * weight(term);
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
          collisions: [],
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

describe("search: the relaxed rung after the bite 3 build review", () => {
  it("sends only the content term on each relaxed query, so type and topic tokens cannot inflate the sum", async () => {
    const engine = fakeEngine(base);
    const r = await search(base, engine, request("page zzzzunknown", { type: "Note" }), NOW);
    expect(r.strategy).toBe("relaxed");
    expect(engine.queries[0]).toEqual(["page", "zzzzunknown", "note"]);
    for (const q of engine.queries.slice(1)) expect(q).toHaveLength(1);
    for (const hit of r.hits) {
      expect(hit.rung).toBe("relaxed");
      // The fake engine scores a term by its prefix count, so the fused score is the sum of the per-term counts.
      let sum = 0;
      for (const term of r.terms) {
        const row = (await engine.lex([term], 1000)).find((x) => x.path === hit.path);
        if (row) sum += row.bm25;
      }
      expect(hit.score).toBeCloseTo(sum, 9);
    }
  });

  it("uses the relaxed pool it is given for the per-term queries", async () => {
    const engine = fakeEngine(base);
    await search(base, engine, request("alpha zzzzunknown", { relaxedPool: 100 }), NOW);
    expect(engine.limits.slice(1).every((l) => l === 101)).toBe(true);
  });

  it("says when a topic was exhausted at the cap without filling the answer", async () => {
    const files = [];
    for (let i = 0; i < 510; i++) {
      files.push({
        path: `a/p${String(i).padStart(3, "0")}.md`,
        bytes: Buffer.from(`---\ntype: Note\ntitle: Common ${i}\n---\n\ncommon word\n`),
      });
    }
    for (let i = 0; i < 10; i++) {
      files.push({
        path: `b/q${i}.md`,
        bytes: Buffer.from(`---\ntype: Note\ntitle: Rare ${i}\n---\n\ncommon word\n`),
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
    expect(big.pages.size).toBe(520);
    const engine = fakeEngine(big);
    const r = await search(big, engine, request("common word", { topic: "b", limit: 20 }), NOW);
    expect(r.pool).toBe(500);
    expect(r.topicExhausted).toBe(true);
    // The first rung widened to the cap (every page ties, so the tie check asks up to 501 rows). Each relaxed
    // per-term query starts from `limit × 4` (+1 for the tie check), never from the widened pool.
    expect(engine.limits).toContain(501);
    const perTermAsks = engine.limits.filter((_, i) => engine.queries[i]?.length === 1);
    expect(perTermAsks[0]).toBe(81);
    expect(perTermAsks.filter((l) => l === 81)).toHaveLength(r.terms.length);
    const small = await search(
      big,
      fakeEngine(big),
      request("rare", { topic: "b", limit: 20 }),
      NOW,
    );
    expect(small.topicExhausted).toBe(false);
  });
});

describe("search: frequency floor, limits and filters (bite 3 build review)", () => {
  it("ignores a term at the engine's frequency floor on the relaxed rung and names it", async () => {
    const withMd = await search(
      base,
      fakeEngine(base, { qmdLike: true }),
      request("alpha zzzzunknown md", { includeStale: true }),
      NOW,
    );
    const without = await search(
      base,
      fakeEngine(base, { qmdLike: true }),
      request("alpha zzzzunknown", { includeStale: true }),
      NOW,
    );
    expect(withMd.floored).toEqual(["md"]);
    expect(withMd.strategy).toBe("relaxed");
    expect(withMd.hits.map((h) => [h.path, h.termsMatched, h.score])).toEqual(
      without.hits.map((h) => [h.path, h.termsMatched, h.score]),
    );
  });

  it("clamps the limit to a whole number between one and twenty-five", async () => {
    const engine = fakeEngine(base);
    const big = await search(
      base,
      engine,
      request("term", { limit: 1000, includeStale: true }),
      NOW,
    );
    expect(big.pool).toBe(100);
    const nan = await search(
      base,
      engine,
      request("term", { limit: Number.NaN, includeStale: true }),
      NOW,
    );
    expect(nan.hits.length).toBeLessThanOrEqual(1);
    const half = await search(
      base,
      engine,
      request("term", { limit: 2.5, includeStale: true }),
      NOW,
    );
    expect(half.hits.length).toBeLessThanOrEqual(2);
  });

  it("counts a hit for a path the catalog does not hold as filtered out, and drops a relaxed hit under one percent of the best", async () => {
    const paths = [...base.pages.keys()].sort();
    const [p1, p2] = paths as [string, string];
    const empty: IndexResult = {
      documents: 0,
      indexed: 0,
      updated: 0,
      unchanged: 0,
      removed: 0,
      skipped: 0,
      notIndexed: [],
      collisions: [],
      encodedFolders: [],
    };
    const scripted: Engine = {
      async index() {
        return empty;
      },
      async lex(terms) {
        if (terms.length !== 1) return [];
        if (terms[0] === "alpha") return [{ path: p1, bm25: 100, score: 100 / 101 }];
        if (terms[0] === "beta") return [{ path: p2, bm25: 0.5, score: 0.5 / 1.5 }];
        if (terms[0] === "ghost") return [{ path: "nowhere/ghost.md", bm25: 3, score: 0.75 }];
        return [];
      },
      async status() {
        return { documents: 0 };
      },
      async close() {},
    };
    const floor = await search(base, scripted, request("alpha beta", { includeStale: true }), NOW);
    expect(floor.hits.map((h) => h.path)).toEqual([p1]);
    const unknown = await search(
      base,
      scripted,
      request("ghost zzzz", { includeStale: true }),
      NOW,
    );
    expect(unknown.hits).toEqual([]);
    expect(unknown.filteredOut.unknown).toBe(1);
  });
});

// The readiness ledger (issue 2's "Holds", D59): trust orders scores only inside the tie window, and drops nothing.
describe("search: the readiness ledger (D59)", () => {
  /** An engine that answers every query with the rows it was given, in that order. */
  const rowsEngine = (rows: EngineHit[]): Engine => ({
    async index(): Promise<IndexResult> {
      return {
        documents: rows.length,
        indexed: rows.length,
        updated: 0,
        unchanged: 0,
        removed: 0,
        skipped: 0,
        notIndexed: [],
        collisions: [],
        encodedFolders: [],
      };
    },
    async lex(_terms, limit) {
      return rows.slice(0, limit);
    },
    async status() {
      return { documents: rows.length };
    },
    async close() {},
  });
  const row = (path: string, bm25: number): EngineHit => ({ path, bm25, score: bm25 / (1 + bm25) });

  it("orders by trust only within 1e-9 of the score", async () => {
    expect(base.pages.get("terms/alpha.md")?.trust).toBe("human-reviewed");
    expect(base.pages.get("terms/gamma.md")?.trust).toBe("unverified");
    // 5e-10 apart: a tie, so the human-reviewed page comes first although the engine scored it lower.
    const tie = await search(
      base,
      rowsEngine([row("terms/gamma.md", 1 + 5e-10), row("terms/alpha.md", 1)]),
      request("alpha"),
      NOW,
    );
    expect(tie.hits.map((h) => h.path)).toEqual(["terms/alpha.md", "terms/gamma.md"]);
    // 2e-9 apart: the score decides, whatever the tier.
    const apart = await search(
      base,
      rowsEngine([row("terms/gamma.md", 1 + 2e-9), row("terms/alpha.md", 1)]),
      request("alpha"),
      NOW,
    );
    expect(apart.hits.map((h) => h.path)).toEqual(["terms/gamma.md", "terms/alpha.md"]);
    expect(apart.hits.map((h) => h.score)).toEqual([1 + 2e-9, 1]);
  });

  it("never drops a hit for its trust tier", async () => {
    const tiers = { alpha: "human-reviewed", beta: "machine-confirmed", gamma: "unverified" };
    for (const [name, trust] of Object.entries(tiers))
      expect(base.pages.get(`terms/${name}.md`)?.trust).toBe(trust);
    const r = await search(
      base,
      rowsEngine([row("terms/gamma.md", 3), row("terms/beta.md", 2), row("terms/alpha.md", 1)]),
      request("alpha", { includeStale: true }),
      NOW,
    );
    expect(r.hits.map((h) => [h.path, h.trust])).toEqual([
      ["terms/gamma.md", "unverified"],
      ["terms/beta.md", "machine-confirmed"],
      ["terms/alpha.md", "human-reviewed"],
    ]);
    expect(Object.values(r.filteredOut).every((n) => n === 0)).toBe(true);
  });
});

// Issue 4 (D64): tag, status and trust filters, applied after the engine returns, in the order unknown, type, topic,
// tag, status, trust, stale; nothing is added to either rung; every return carries seven counts.
describe("search: the filters (issue 4)", () => {
  type Spec = { path: string; front?: string; body?: string };
  const catalogOf = (specs: Spec[], admit = ["stable", "deprecated"]): Catalog =>
    loadBundle(
      "f",
      specs.map((s) => ({
        path: s.path,
        bytes: Buffer.from(
          `---\ntype: Note\ntitle: ${s.path}\ndescription: A page.\n${s.front ?? ""}---\n\n${s.body ?? "quokka"}\n`,
        ),
      })),
      {
        admit,
        dev: false,
        integrity: "none",
        specText: "2026-08-15",
        caps: DEFAULT_CAPS,
      },
      NOW,
    ).catalog;
  const paths = (r: { hits: Array<{ path: string }> }) => r.hits.map((h) => h.path).sort();

  it("keeps a page whose stored tag equals the requested tag in any case, and nothing looser", async () => {
    const catalog = catalogOf([
      { path: "ml.md", front: "tags: [machine-learning]\n" },
      { path: "spaced.md", front: "tags: [' machine-learning ']\n" },
      { path: "body-only.md", body: "quokka machine-learning" },
      { path: "one-tag.md", front: "tags: ['finance revenue']\n" },
      { path: "two-tags.md", front: "tags: [finance, revenue]\n" },
      { path: "list-one.md", front: "tags: [1]\n" },
      { path: "lone-one.md", front: "tags: 1\n" },
      { path: "short.md", front: "tags: [x, the]\n" },
    ]);
    const run = (tags: string[]) =>
      search(catalog, fakeEngine(catalog), request("quokka", { tags, limit: 25 }), NOW);
    const ml = await run(["Machine-Learning"]);
    expect(paths(ml)).toEqual(["ml.md"]);
    expect(ml.filteredOut.tag).toBe(7);
    expect(paths(await run(["machine"]))).toEqual([]);
    expect(paths(await run(["learning"]))).toEqual([]);
    expect(paths(await run(["finance", "revenue"]))).toEqual(["two-tags.md"]);
    expect(paths(await run(["finance revenue"]))).toEqual(["one-tag.md"]);
    expect(paths(await run(["finance", "FINANCE"]))).toEqual(["two-tags.md"]);
    expect(paths(await run(["1"]))).toEqual(["list-one.md"]);
    expect(paths(await run(["x"]))).toEqual(["short.md"]);
    expect(paths(await run(["the"]))).toEqual(["short.md"]);
  });

  it("never sends a tag, a status, a tier or a freshness value to the engine", async () => {
    const catalog = catalogOf([
      { path: "notes/a.md", front: "tags: [zebra]\n", body: "quokka" },
      { path: "notes/b.md", body: "quokka" },
    ]);
    const engine = fakeEngine(catalog);
    await search(
      catalog,
      engine,
      request("quokka", {
        type: "Note",
        topic: "notes",
        tags: ["zebra"],
        status: "stable",
        minTrust: "human-reviewed",
      }),
      NOW,
    );
    expect(engine.queries[0]).toEqual(["quokka", "notes", "note"]);
    for (const query of engine.queries) {
      for (const value of ["zebra", "stable", "human-reviewed", "human", "fresh", "any"])
        expect(query, value).not.toContain(value);
    }
  });

  it("filters by served status case-insensitively", async () => {
    const catalog = catalogOf(
      [
        { path: "omitted.md" },
        { path: "stable.md", front: "status: Stable\n" },
        { path: "old.md", front: "status: deprecated\n" },
        { path: "archived.md", front: "status: archived\n" },
      ],
      ["stable", "deprecated", "archived"],
    );
    const run = (status: string) =>
      search(catalog, fakeEngine(catalog), request("quokka", { status, limit: 25 }), NOW);
    const stable = await run("Stable");
    expect(paths(stable)).toEqual(["omitted.md", "stable.md"]);
    expect(stable.filteredOut.status).toBe(2);
    expect(paths(await run("ARCHIVED"))).toEqual(["archived.md"]);
    expect(paths(await run("deprecated"))).toEqual(["old.md"]);
    // A blank status is no filter, as a blank tag is.
    const blank = await run("   ");
    expect(paths(blank)).toEqual(["archived.md", "old.md", "omitted.md", "stable.md"]);
    expect(blank.filteredOut.status).toBe(0);
  });

  it("applies min_trust by the tier order and leaves scores alone", async () => {
    const verified = (by: string) => `verified: { by: '${by}', at: 2026-01-01T00:00:00Z }\n`;
    const catalog = catalogOf([
      { path: "h.md", front: verified("human:x"), body: "quokka quokka" },
      { path: "m.md", front: verified("process:x"), body: "quokka quokka quokka" },
      { path: "u.md", body: "quokka" },
      { path: "padded.md", front: verified("Human:y"), body: "quokka" },
    ]);
    const run = (minTrust?: "unverified" | "machine-confirmed" | "human-reviewed") =>
      search(
        catalog,
        fakeEngine(catalog),
        request("quokka", { limit: 25, ...(minTrust === undefined ? {} : { minTrust }) }),
        NOW,
      );
    const all = await run();
    const human = await run("human-reviewed");
    expect(paths(human)).toEqual(["h.md"]);
    expect(human.filteredOut.trust).toBe(3);
    const machine = await run("machine-confirmed");
    expect(paths(machine)).toEqual(["h.md", "m.md", "padded.md"]);
    expect(machine.filteredOut.trust).toBe(1);
    const floor = await run("unverified");
    expect(floor.hits.map((h) => [h.path, h.score])).toEqual(
      all.hits.map((h) => [h.path, h.score]),
    );
    expect(floor.filteredOut.trust).toBe(0);
    const score = (r: typeof all, path: string) => r.hits.find((h) => h.path === path)?.score;
    expect(score(human, "h.md")).toBe(score(all, "h.md"));
    expect(score(machine, "m.md")).toBe(score(all, "m.md"));
  });

  it("counts a path once, under the first failing check", async () => {
    const catalog = catalogOf([
      {
        path: "notes/overdue.md",
        front: "stale_after: 2000-01-01\ntags: [other]\n",
      },
      { path: "notes/tagged.md", front: "tags: [kept]\n" },
      { path: "elsewhere/tagged.md", front: "tags: [kept]\n" },
    ]);
    // The engine returns every row whatever the terms, so each page meets the checks in their order.
    const everything: Engine = {
      ...fakeEngine(catalog),
      async lex(_terms, limit) {
        return [...catalog.pages.keys()]
          .map((path) => ({ path, bm25: 1, score: 0.5 }))
          .slice(0, limit);
      },
    };
    const r = await search(
      catalog,
      everything,
      request("quokka", { tags: ["kept"], topic: "notes", limit: 25 }),
      NOW,
    );
    expect(paths(r)).toEqual(["notes/tagged.md"]);
    expect(r.filteredOut).toEqual({
      type: 0,
      topic: 1,
      tag: 1,
      status: 0,
      trust: 0,
      stale: 0,
      unknown: 0,
    });
  });

  /** 600 pages that answer `common word` with distinct scores, and two tagged ones that rank last. */
  const wide = (): Catalog =>
    catalogOf([
      ...Array.from({ length: 600 }, (_, i) => ({
        path: `a/p${String(i).padStart(3, "0")}.md`,
        body: "common word ".repeat(i + 3),
      })),
      { path: "z/t1.md", front: "tags: [rare]\n", body: "common word" },
      { path: "z/t2.md", front: "tags: [rare]\n", body: "common word common word" },
    ]);

  it("widens the first-rung pool by four under a tag filter and keeps the relaxed ask at limit × 4", async () => {
    const catalog = wide();
    const engine = fakeEngine(catalog);
    const r = await search(
      catalog,
      engine,
      request("common word", { tags: ["rare"], includeStale: true }),
      NOW,
    );
    const firstRung = engine.limits.filter((_, i) => (engine.queries[i]?.length ?? 0) > 1);
    const relaxed = engine.limits.filter((_, i) => engine.queries[i]?.length === 1);
    expect(firstRung).toEqual([33, 129, 501]);
    expect(relaxed).toEqual([33, 33]);
    expect(r.pool).toBe(500);
    expect(paths(r)).toEqual([]);
  });

  it("sets filtersExhausted only at the cap with a restrictive filter and a short answer", async () => {
    const catalog = wide();
    const at = async (patch: Partial<Parameters<typeof search>[2]>) =>
      search(
        catalog,
        fakeEngine(catalog),
        request("common word", { includeStale: true, ...patch }),
        NOW,
      );
    const tagged = await at({ tags: ["rare"] });
    expect(tagged.filtersExhausted).toBe(true);
    expect(tagged.topicExhausted).toBe(false);
    const topic = await at({ topic: "z" });
    expect(topic.filtersExhausted).toBe(true);
    expect(topic.topicExhausted).toBe(true);
    for (const patch of [{}, { minTrust: "unverified" as const }, { includeStale: true }]) {
      const open = await at(patch);
      expect(open.hits).toHaveLength(8);
      expect(open.filtersExhausted, JSON.stringify(patch)).toBe(false);
    }
    // Short at the cap with no restrictive filter (the rows the catalog does not hold): no flag.
    const ghosts: Engine = {
      ...fakeEngine(catalog),
      async lex(terms, limit) {
        const rows = Array.from({ length: 600 }, (_, i) => ({
          path: `ghost/g${i}.md`,
          bm25: 1000 - i,
          score: 0.5,
        }));
        return terms.length > 1 ? rows.slice(0, limit) : [];
      },
    };
    const unknown = await search(
      catalog,
      ghosts,
      request("common word", { includeStale: true, minTrust: "unverified" }),
      NOW,
    );
    expect(unknown.pool).toBe(500);
    expect(unknown.hits).toEqual([]);
    expect(unknown.filtersExhausted).toBe(false);
    // A small catalog runs out before the cap: a restrictive filter leaves no flag either.
    const small = await search(
      base,
      fakeEngine(base),
      request("term", { tags: ["glossary"] }),
      NOW,
    );
    expect(small.filtersExhausted).toBe(false);
  });

  it("sets filtersExhausted and topicExhausted only when the engine had more past the cap (build review A-A4)", async () => {
    // n pages hold kiwi in their bodies; one page without it carries the tag and the status and sits in folder q,
    // whose one-letter name adds no token to the query.
    const kiwis = (n: number): Catalog =>
      catalogOf([
        ...Array.from({ length: n }, (_, i) => ({
          path: `p/p${String(i).padStart(4, "0")}.md`,
          body: `${"kiwi ".repeat((i % 7) + 1)}filler${i}`,
        })),
        {
          path: "q/tagged.md",
          front: "tags: [rare]\nstatus: deprecated\n",
          body: "unrelated words",
        },
      ]);
    const run = (catalog: Catalog, patch: Partial<Parameters<typeof search>[2]>) =>
      search(catalog, fakeEngine(catalog), request("kiwi", { includeStale: true, ...patch }), NOW);
    // 300 matches: the pool is raised to the cap, but the engine runs out under it, so every match was examined.
    const ran = kiwis(300);
    for (const patch of [{ tags: ["rare"] }, { status: "deprecated" }, { topic: "q" }]) {
      const r = await run(ran, patch);
      expect(r.pool, JSON.stringify(patch)).toBe(500);
      expect(r.considered, JSON.stringify(patch)).toBe(300);
      expect(r.hits, JSON.stringify(patch)).toEqual([]);
      expect(r.filtersExhausted, JSON.stringify(patch)).toBe(false);
      expect(r.topicExhausted, JSON.stringify(patch)).toBe(false);
    }
    // 700 matches: the engine had more past the cap, so a matching page may sit there.
    const full = kiwis(700);
    for (const patch of [{ tags: ["rare"] }, { status: "deprecated" }, { topic: "q" }]) {
      const r = await run(full, patch);
      expect(r.pool, JSON.stringify(patch)).toBe(500);
      expect(r.filtersExhausted, JSON.stringify(patch)).toBe(true);
      expect(r.topicExhausted, JSON.stringify(patch)).toBe("topic" in patch);
    }
  });

  it("carries all seven counts on every return", async () => {
    const seven = ["stale", "status", "tag", "topic", "trust", "type", "unknown"];
    const none = await search(base, fakeEngine(base), request("the of and"), NOW);
    expect(Object.keys(none.filteredOut).sort()).toEqual(seven);
    expect(Object.values(none.filteredOut).every((n) => n === 0)).toBe(true);
    expect(none.filtersExhausted).toBe(false);
    const some = await search(base, fakeEngine(base), request("alpha"), NOW);
    expect(Object.keys(some.filteredOut).sort()).toEqual(seven);
  });
});
