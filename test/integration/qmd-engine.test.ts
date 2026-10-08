import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStore } from "@tobilu/qmd";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBundle } from "../../src/bundle/load.js";
import { DEFAULT_CAPS } from "../../src/bundle/model.js";
import { type DerivedDocument, deriveDocument } from "../../src/derive/derived-document.js";
import { QmdEngine } from "../../src/engine/qmd.js";
import { encodePath, renderDocument } from "../../src/engine/qmd-render.js";
import { search } from "../../src/search/search.js";
import { NOW, readFixture } from "../helpers/fixtures.js";

process.env.NODE_LLAMA_CPP_SKIP_DOWNLOAD = "1";

const { catalog } = loadBundle(
  "behaviours",
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
const docs: DerivedDocument[] = [...catalog.pages.values()].map(deriveDocument);

let work: string;
let engine: QmdEngine;
beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "okf-catalog-qmd-"));
  engine = await QmdEngine.open({ bundles: ["behaviours"], dir: work });
});
afterAll(async () => {
  await engine.close();
  rmSync(work, { recursive: true, force: true });
});

describe("QmdEngine", () => {
  it("indexes every derived document, encodes the folder qmd would skip, and reports nothing unindexed", async () => {
    const result = await engine.index("behaviours", docs);
    expect(result.documents).toBe(docs.length);
    expect(result.notIndexed).toEqual([]);
    expect(result.encodedFolders).toEqual(["dist"]);
    expect((await engine.status()).documents).toBe(docs.length);
    expect(existsSync(join(work, "bundles", "behaviours", "derived"))).toBe(true);
  });

  it("finds a page by a keyword and decodes paths back to the bundle, including the encoded folder", async () => {
    const alpha = await engine.lex(["alpha", "glossary"], 5);
    expect(alpha[0]?.path).toBe("terms/alpha.md");
    expect(alpha[0]?.bundle).toBe("behaviours");
    expect(alpha[0]?.bm25).toBeGreaterThan(0);
    const skipped = await engine.lex(["skipped", "folder"], 5);
    expect(skipped.map((h) => h.path)).toContain("dist/page.md");
  });

  it("indexes a path with a backslash, which qmd itself would skip, through the codec", async () => {
    const odd: DerivedDocument = {
      path: "odd/back\\slash.md",
      title: "Backslash",
      type: "Note",
      tags: [],
      metadata: {},
      body: "zebra-backslash-marker here.\n",
    };
    const result = await engine.index("behaviours", [...docs, odd]);
    expect(result.documents).toBe(docs.length + 1);
    expect(result.notIndexed).toEqual([]);
    expect((await engine.lex(["zebra-backslash-marker"], 5))[0]?.path).toBe("odd/back\\slash.md");
  });

  it("drops a removed document on re-index and leaves only the live generation, linked by its base name", async () => {
    const result = await engine.index("behaviours", docs);
    expect(result.documents).toBe(docs.length);
    expect(await engine.lex(["zebra-backslash-marker"], 5)).toEqual([]);
    const own = join(work, "bundles", "behaviours");
    const generations = readdirSync(own).filter((n) => n.startsWith("gen-"));
    expect(generations).toHaveLength(1);
    expect(readlinkSync(join(own, "derived"))).toBe(generations[0]);
  });

  it("answers the keyword and sentence questions through search, recording the rung", async () => {
    const keyword: Array<[string, string]> = [
      ["alpha glossary", "terms/alpha.md"],
      ["beta term", "terms/beta.md"],
      ["gamma generator", "terms/gamma.md"],
      ["delta legacy", "terms/delta.md"],
      ["epsilon retired successor", "terms/epsilon.md"],
      ["eta bare mapping", "terms/eta.md"],
      ["theta offset", "terms/theta.md"],
      ["skipped folder codec", "dist/page.md"],
      ["tags one two three-four", "notes/tags-only.md"],
      ["orders agent instructions", "notes/injection.md"],
    ];
    for (const [question, gold] of keyword) {
      const r = await search(catalog, engine, { question, includeStale: true, limit: 3 }, NOW);
      expect(
        r.hits.slice(0, 3).map((h) => h.path),
        question,
      ).toContain(gold);
    }
    const sentences: Array<[string, string]> = [
      [
        "Which term is the fully described page every happy-path test starts from?",
        "terms/alpha.md",
      ],
      ["What happens to a page whose recheck datetime carries no offset?", "terms/theta.md"],
      ["Why would a search engine skip a folder named dist?", "dist/page.md"],
      [
        "Which page addresses the reader as if it were an agent and gives it orders?",
        "notes/injection.md",
      ],
      ["How does a retired term without a successor look?", "terms/epsilon.md"],
    ];
    const rungs: string[] = [];
    for (const [question, gold] of sentences) {
      const r = await search(catalog, engine, { question, includeStale: true, limit: 3 }, NOW);
      expect(
        r.hits.slice(0, 3).map((h) => h.path),
        question,
      ).toContain(gold);
      rungs.push(r.strategy);
    }
    expect(rungs).toContain("relaxed");
  });

  it("never lets a search at a macrotask boundary see a half-updated index", async () => {
    // Pins qmd's write loop: it must not yield to the event loop between documents (decision D28). A sampler
    // that runs at every macrotask boundary while `index()` is in flight may see the old count or the new one,
    // never anything between. A qmd that starts awaiting real I/O per file makes this fail.
    const many: DerivedDocument[] = Array.from({ length: 400 }, (_, i) => ({
      path: `bulk/p${i}.md`,
      title: `Bulk ${i}`,
      type: "Note",
      tags: [],
      metadata: {},
      body: `versionone body ${i}\n`,
    }));
    await engine.index("behaviours", many);
    const changed = many.map((d) => ({ ...d, body: `versiontwo body ${d.path}\n` }));
    const seen = new Set<number>();
    let stop = false;
    const sample = async (): Promise<void> => {
      if (stop) return;
      seen.add((await engine.lex(["versionone"], 1000)).length);
      setImmediate(() => void sample());
    };
    setImmediate(() => void sample());
    await engine.index("behaviours", changed);
    stop = true;
    seen.add((await engine.lex(["versionone"], 1000)).length);
    expect([...seen]).toContain(400);
    expect([...seen]).toContain(0);
    expect([...seen].every((n) => n === 0 || n === 400)).toBe(true);
    expect((await engine.lex(["versiontwo"], 1000)).length).toBe(400);
  });
});

describe("QmdEngine: directories, generations and other companies (bite 3 build review)", () => {
  const note = (path: string, title: string, body: string): DerivedDocument => ({
    path,
    title,
    type: "Note",
    tags: [],
    metadata: {},
    body,
  });

  it("works from a relative directory and links the live generation by its base name", async () => {
    const base = mkdtempSync(join(tmpdir(), "okf-catalog-rel-"));
    const previous = process.cwd();
    process.chdir(base);
    try {
      const e = await QmdEngine.open({ bundles: ["rel"], dir: join("cache", "rel") });
      const r = await e.index("rel", [note("a.md", "Alpha", "alpha body text")]);
      expect(r.documents).toBe(1);
      expect(r.notIndexed).toEqual([]);
      expect(readlinkSync(join("cache", "rel", "bundles", "rel", "derived"))).toMatch(
        /^gen-\d+-\d+-1$/,
      );
      expect((await e.lex(["alpha"], 5))[0]?.path).toBe("a.md");
      await e.close();
    } finally {
      process.chdir(previous);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("refuses a second index while one is running; the composition layer keeps refreshes single-flight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-catalog-reent-"));
    const e = await QmdEngine.open({ bundles: ["re", "rf"], dir });
    const first = e.index("re", [note("a.md", "A", "one")]);
    await expect(e.index("re", [note("b.md", "B", "two")])).rejects.toThrow(/already running/);
    // One engine call at a time across bundles too: the composition layer serializes commits (D28, D75).
    await expect(e.index("rf", [note("c.md", "C", "three")])).rejects.toThrow(/already running/);
    await first;
    expect((await e.status()).documents).toBe(1);
    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a document whose path would leave the generation folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-catalog-unsafe-"));
    const e = await QmdEngine.open({ bundles: ["un"], dir });
    await expect(e.index("un", [note("../escape.md", "E", "x")])).rejects.toThrow(
      /not a safe bundle path/,
    );
    await expect(e.index("un", [note("/abs.md", "E", "x")])).rejects.toThrow(
      /not a safe bundle path/,
    );
    // A bundle the engine was not opened with has no collection to write to.
    await expect(e.index("zz", [note("a.md", "A", "x")])).rejects.toThrow(/not a bundle/);
    await expect(e.drop("zz")).rejects.toThrow(/not a bundle/);
    expect((await e.status()).documents).toBe(0);
    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rebuilds a store holding a collection that is not a configured bundle, and counts only the configured ones", async () => {
    // The version 0 case: another company's rows (D48's sibling in open()).
    const dir = mkdtempSync(join(tmpdir(), "okf-catalog-shared-"));
    const a = await QmdEngine.open({ bundles: ["aaa"], dir });
    expect(a.resetOnOpen).toBeUndefined();
    await a.index("aaa", [
      note("x.md", "Shared", "zebra zebra zebra"),
      note("y.md", "Other", "zebra once"),
    ]);
    await a.close();
    const b = await QmdEngine.open({ bundles: ["bbb"], dir });
    expect(b.resetOnOpen).toMatch(/aaa/);
    const r = await b.index("bbb", [note("z.md", "Mine", "zebra here")]);
    expect(r.documents).toBe(1);
    expect((await b.status()).documents).toBe(1);
    expect((await b.lex(["zebra"], 1)).map((h) => h.path)).toEqual(["z.md"]);
    await b.close();
    // A bundle dropped from the configuration (finding 5): qmd deletes its collection's row at open and leaves its
    // pages active and searchable, so the store is rebuilt and the bundle that stays scores alone.
    const two = await QmdEngine.open({ bundles: ["aaa", "bbb"], dir });
    expect(two.resetOnOpen).toBeUndefined();
    const own = [note("x.md", "Shared", "zebra zebra zebra"), note("y.md", "Other", "zebra once")];
    await two.index("aaa", own);
    await two.index("bbb", [note("z.md", "Mine", "zebra here"), note("w.md", "More", "kiwi")]);
    await two.close();
    const one = await QmdEngine.open({ bundles: ["aaa"], dir });
    expect(one.resetOnOpen).toMatch(/bbb/);
    expect((await one.status()).documents).toBe(0);
    expect((await one.index("aaa", own)).documents).toBe(2);
    const alone = mkdtempSync(join(tmpdir(), "okf-catalog-alone-"));
    const fresh = await QmdEngine.open({ bundles: ["aaa"], dir: alone });
    await fresh.index("aaa", own);
    expect(await one.lex(["zebra"], 5)).toEqual(await fresh.lex(["zebra"], 5));
    await fresh.close();
    await one.close();
    rmSync(alone, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("pins qmd's title rule for a page titled Notes: the next second-level heading becomes the title", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-catalog-notes-"));
    const e = await QmdEngine.open({ bundles: ["nt"], dir });
    await e.index("nt", [
      note("notes.md", "Notes", "An introduction.\n\n## Real heading\n\nMore text.\n"),
    ]);
    await e.close();
    const raw = await createStore({
      dbPath: join(dir, "index.sqlite"),
      config: {
        collections: { nt: { path: join(dir, "bundles", "nt", "derived"), pattern: "**/*.md" } },
      },
    });
    const listed = await raw.multiGet("nt/**");
    expect(listed.docs.map((d) => (d.doc as { title?: string }).title)).toEqual(["Real heading"]);
    await raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sums the per-term scores on the relaxed rung without the type token inflating them", async () => {
    await engine.index("behaviours", docs);
    const r = await search(
      catalog,
      engine,
      { question: "alpha dist zzzzunknown", type: "Term", includeStale: true, limit: 8 },
      NOW,
    );
    const relaxed = r.hits.filter((h) => h.rung === "relaxed");
    expect(relaxed.length).toBeGreaterThan(0);
    for (const hit of relaxed) {
      let sum = 0;
      for (const term of r.terms) {
        const row = (await engine.lex([term], 500)).find((x) => x.path === hit.path);
        if (row) sum += row.bm25;
      }
      expect(hit.score, hit.path).toBeCloseTo(sum, 6);
    }
  });
});

describe("QmdEngine: collisions, odd names and housekeeping (bite 3 build review)", () => {
  const note = (path: string, title: string, body: string): DerivedDocument => ({
    path,
    title,
    type: "Note",
    tags: [],
    metadata: {},
    body,
  });

  it("keeps one page when two paths collide by case or Unicode form, and names what it dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-catalog-collide-"));
    const e = await QmdEngine.open({ bundles: ["col"], dir });
    const r = await e.index("col", [
      note("notes/alpha.md", "Lower", "kumquat only"),
      note("notes/Alpha.md", "Upper", "pineapple only"),
      note("caf\u00e9.md", "Composed", "lychee only"),
      note("cafe\u0301.md", "Decomposed", "durian only"),
    ]);
    expect(r.documents).toBe(2);
    expect(r.collisions).toEqual([
      { kept: "cafe\u0301.md", dropped: "caf\u00e9.md" },
      { kept: "notes/Alpha.md", dropped: "notes/alpha.md" },
    ]);
    expect(r.notIndexed).toEqual(["caf\u00e9.md", "notes/alpha.md"]);
    expect((await e.lex(["pineapple"], 5)).map((h) => h.path)).toEqual(["notes/Alpha.md"]);
    expect(await e.lex(["kumquat"], 5)).toEqual([]);
    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("indexes a name qmd would read as a drive letter, and reports a name the file system cannot hold instead of failing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-catalog-names-"));
    const e = await QmdEngine.open({ bundles: ["nm"], dir });
    const tooLong = `_${"a".repeat(251)}.md`;
    const r = await e.index("nm", [
      note("Q:A.md", "Colon", "citrus only"),
      note(tooLong, "Long", "mango only"),
      note("plain.md", "Plain", "papaya only"),
    ]);
    expect(r.notIndexed).toEqual([tooLong]);
    expect(r.documents).toBe(2);
    expect((await e.lex(["citrus"], 5)).map((h) => h.path)).toEqual(["Q:A.md"]);
    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("names generations by time, process and sequence, and clears stale links and orphan generations on open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-catalog-gc-"));
    const own = join(dir, "bundles", "gc");
    mkdirSync(join(own, "gen-1-1-1"), { recursive: true });
    symlinkSync("gen-nowhere", join(own, "derived.tmp-7"));
    const e = await QmdEngine.open({ bundles: ["gc"], dir });
    expect(
      readdirSync(own).filter((n) => n.startsWith("gen-") || n.startsWith("derived.tmp-")),
    ).toEqual([]);
    await e.index("gc", [note("a.md", "A", "x")]);
    const gens = readdirSync(own).filter((n) => n.startsWith("gen-"));
    expect(gens).toHaveLength(1);
    expect(gens[0]).toMatch(new RegExp(`^gen-\\d+-${process.pid}-1$`));
    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("QmdEngine: the exhausted flags (build review A-A4)", () => {
  it("says the pool is full only when the real engine had more matches past the cap", async () => {
    // The adversarial reviewer's probe: n pages hold kiwi; one more, without it, carries the tag; limit 8.
    for (const [n, exhausted] of [
      [300, false],
      [700, true],
    ] as const) {
      const files = Array.from({ length: n }, (_, i) => ({
        path: `p/p${String(i).padStart(4, "0")}.md`,
        bytes: Buffer.from(
          `---\ntype: Note\ntitle: P${i}\ndescription: A page.\n---\n\n${"kiwi ".repeat((i % 7) + 1)} filler${i}\n`,
        ),
      }));
      files.push({
        path: "q/tagged.md",
        bytes: Buffer.from(
          "---\ntype: Note\ntitle: T\ndescription: A page.\ntags: [rare]\n---\n\nunrelated words\n",
        ),
      });
      const loaded = loadBundle(
        "x",
        files,
        {
          admit: ["stable", "deprecated"],
          dev: false,
          integrity: "none",
          specText: "2026-08-15",
          caps: DEFAULT_CAPS,
        },
        NOW,
      ).catalog;
      const dir = mkdtempSync(join(tmpdir(), "okf-catalog-qmd-exhausted-"));
      const own = await QmdEngine.open({ bundles: ["x"], dir });
      try {
        await own.index("x", [...loaded.pages.values()].map(deriveDocument));
        const r = await search(
          loaded,
          own,
          { question: "kiwi", tags: ["rare"], includeStale: true, limit: 8 },
          NOW,
        );
        expect(r.pool, String(n)).toBe(500);
        expect(r.considered, String(n)).toBe(Math.min(n, 500));
        expect(r.hits, String(n)).toEqual([]);
        expect(r.filtersExhausted, String(n)).toBe(exhausted);
      } finally {
        await own.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

// The readiness ledger (issue 2's "Holds", D59, row 27): index.md and log.md are reserved, served, never indexed.
describe("QmdEngine: the readiness ledger (D59)", () => {
  it("keeps reserved files out of the index", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-catalog-qmd-reserved-"));
    const own = await QmdEngine.open({ bundles: ["behaviours"], dir });
    try {
      const result = await own.index("behaviours", docs);
      expect(result.documents).toBe(catalog.pages.size);
      expect(catalog.folders.get("")?.log).toBeDefined();
      expect(catalog.folders.get("")?.index?.body).toContain("Material that is not Markdown");
      // "initialization" and "history" are written in the fixture's log.md, "material" and "lifecycle" in its root
      // index.md, and none of them in a page.
      for (const word of ["initialization", "history", "material", "lifecycle"])
        expect(await own.lex([word], 5), word).toEqual([]);
      const written = (
        readdirSync(join(dir, "bundles", "behaviours", "derived"), { recursive: true }) as string[]
      ).map((p) => p.split("\\").join("/"));
      expect(written.filter((p) => p.endsWith(".md")).length).toBe(catalog.pages.size);
      expect(written.filter((p) => /(^|\/)(index|log)\.md$/.test(p))).toEqual([]);
    } finally {
      await own.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Section 4 of the plan for 0.2 to 0.4 (D73, D75): one collection per bundle in the network's database. Findings
// 1, 3, 4 and 5 are tests here, so a qmd release that breaks one fails first.
describe("QmdEngine: a network of bundles (D73, D75)", () => {
  const note = (path: string, body: string): DerivedDocument => ({
    path,
    title: path.replace(/\.md$/, ""),
    type: "Note",
    tags: [],
    metadata: {},
    body,
  });
  const dirs: string[] = [];
  const temp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "okf-catalog-net-"));
    dirs.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  /** The scores of a query by bundle and path. */
  const scores = async (e: QmdEngine, terms: string[]): Promise<Record<string, number>> =>
    Object.fromEntries((await e.lex(terms, 50)).map((h) => [`${h.bundle}:${h.path}`, h.score]));
  /** Eight pages, the term in three of them: p1 and p2 of the first half, p5 of the second. */
  const eight = Array.from({ length: 8 }, (_, i) =>
    note(`p${i + 1}.md`, [1, 2, 5].includes(i + 1) ? `zebra page ${i + 1}` : `plain page ${i + 1}`),
  );

  it("scores pages on one scale across bundles", async () => {
    // Finding 3: one FTS5 table serves every collection of a database, so N, n(q) and avgdl are the whole table's.
    const one = await QmdEngine.open({ bundles: ["aa"], dir: temp() });
    await one.index("aa", eight);
    const two = await QmdEngine.open({ bundles: ["aa", "bb"], dir: temp() });
    await two.index("aa", eight.slice(0, 4));
    await two.index("bb", eight.slice(4));
    const inOne = await scores(one, ["zebra"]);
    const inTwo = await scores(two, ["zebra"]);
    expect(Object.keys(inOne).sort()).toEqual(["aa:p1.md", "aa:p2.md", "aa:p5.md"]);
    expect(Object.keys(inTwo).sort()).toEqual(["aa:p1.md", "aa:p2.md", "bb:p5.md"]);
    expect(inTwo["aa:p1.md"]).toBe(inOne["aa:p1.md"]);
    expect(inTwo["aa:p2.md"]).toBe(inOne["aa:p2.md"]);
    expect(inTwo["bb:p5.md"]).toBe(inOne["aa:p5.md"]);
    // A separate database holding half the pages scores on its own scale: scores never compare across databases.
    const apart = await QmdEngine.open({ bundles: ["aa"], dir: temp() });
    await apart.index("aa", eight.slice(0, 4));
    const inApart = await scores(apart, ["zebra"]);
    expect(inApart["aa:p1.md"]).not.toBe(inOne["aa:p1.md"]);
    for (const e of [one, two, apart]) await e.close();
  });

  it("re-indexes one bundle without touching another", async () => {
    // Finding 1: update({ collections }) scans and deactivates inside the named collection only.
    const e = await QmdEngine.open({ bundles: ["aa", "bb"], dir: temp() });
    const aa = [1, 2, 3, 4].map((i) => note(`a${i}.md`, `common apple ${i}`));
    const bb = [1, 2, 3, 4].map((i) => note(`b${i}.md`, `common berry ${i}`));
    expect((await e.index("aa", aa)).indexed).toBe(4);
    expect((await e.index("bb", bb)).indexed).toBe(4);
    const shrunk = await e.index("aa", aa.slice(0, 3));
    expect(shrunk).toMatchObject({ documents: 3, removed: 1, unchanged: 3, indexed: 0 });
    expect((await e.status("bb")).documents).toBe(4);
    expect((await e.status()).documents).toBe(7);
    const common = await e.lex(["common"], 50);
    expect(
      common
        .filter((h) => h.bundle === "bb")
        .map((h) => h.path)
        .sort(),
    ).toEqual(bb.map((d) => d.path));
    expect(common.filter((h) => h.bundle === "aa")).toHaveLength(3);
    const again = await e.index("aa", aa.slice(0, 3));
    expect(again).toMatchObject({ unchanged: 3, removed: 0, indexed: 0, updated: 0 });
    await e.close();
  });

  it("takes a dropped bundle's pages out of search and the statistics", async () => {
    // Finding 4 and D75: an empty generation behind the bundle's own link and a scoped update deactivate its pages,
    // and a deactivated page leaves the FTS table, so the other bundle scores as if it were alone.
    const aa = [1, 2, 3, 4].map((i) => note(`a${i}.md`, i < 3 ? `kiwi apple ${i}` : `apple ${i}`));
    const bb = [1, 2, 3, 4].map((i) => note(`b${i}.md`, `kiwi kiwi berry ${i}`));
    const e = await QmdEngine.open({ bundles: ["aa", "bb"], dir: temp() });
    await e.index("aa", aa);
    await e.index("bb", bb);
    const before = await scores(e, ["kiwi"]);
    expect(Object.keys(before).filter((k) => k.startsWith("bb:"))).toHaveLength(4);
    const dropped = await e.drop("bb");
    expect(dropped).toMatchObject({ documents: 0, removed: 4 });
    expect((await e.status("bb")).documents).toBe(0);
    const after = await scores(e, ["kiwi"]);
    expect(Object.keys(after).sort()).toEqual(["aa:a1.md", "aa:a2.md"]);
    const alone = await QmdEngine.open({ bundles: ["aa"], dir: temp() });
    await alone.index("aa", aa);
    expect(after).toEqual(await scores(alone, ["kiwi"]));
    expect(after["aa:a1.md"]).not.toBe(before["aa:a1.md"]);
    // A later good load is an ordinary re-index.
    expect((await e.index("bb", bb)).documents).toBe(4);
    expect(await scores(e, ["kiwi"])).toEqual(before);
    await e.close();
    await alone.close();
  });

  it("keeps each bundle's generations under bundles/<id>, and clears the version 0 link and generations at the root", async () => {
    const dir = temp();
    // What a version 0 server left at the root of its folder: its link, a temporary link and generations.
    mkdirSync(join(dir, "gen-1-1-1"));
    mkdirSync(join(dir, "gen-2-2-2"));
    symlinkSync("gen-2-2-2", join(dir, "derived"));
    symlinkSync("gen-nowhere", join(dir, "derived.tmp-3"));
    const e = await QmdEngine.open({ bundles: ["aa", "bb"], dir });
    // The store and its sidecars stay; nothing else of version 0's is left at the root.
    expect(readdirSync(dir).filter((n) => !n.startsWith("index.sqlite"))).toEqual(["bundles"]);
    await e.index("aa", [note("a.md", "apple")]);
    await e.index("bb", [note("b.md", "berry")]);
    const generation = (id: string): string[] =>
      readdirSync(join(dir, "bundles", id)).filter((n) => n.startsWith("gen-"));
    const [firstA] = generation("aa");
    const [firstB] = generation("bb");
    expect(readlinkSync(join(dir, "bundles", "aa", "derived"))).toBe(firstA);
    expect(readlinkSync(join(dir, "bundles", "bb", "derived"))).toBe(firstB);
    await e.index("aa", [note("a.md", "apple again")]);
    expect(generation("aa")).toHaveLength(1);
    expect(generation("aa")).not.toEqual([firstA]);
    expect(generation("bb")).toEqual([firstB]);
    expect(readdirSync(join(dir, "bundles")).sort()).toEqual(["aa", "bb"]);
    await e.close();
  });

  it("opens a version 0 store under the new layout without a reindex (P19)", async () => {
    // A company's store as version 0 wrote it: collection `acme`, rooted at <dir>/derived, linked to a generation.
    const dir = temp();
    const pages = [note("terms/a.md", "apple"), note("terms/b.md", "berry")];
    mkdirSync(join(dir, "gen-1-1-1"));
    for (const doc of pages) {
      const target = join(dir, "gen-1-1-1", encodePath(doc.path));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, renderDocument(doc, { metadataBlock: false }));
    }
    symlinkSync("gen-1-1-1", join(dir, "derived"));
    const v0 = await createStore({
      dbPath: join(dir, "index.sqlite"),
      config: { collections: { acme: { path: join(dir, "derived"), pattern: "**/*.md" } } },
    });
    expect((await v0.update()).indexed).toBe(2);
    await v0.close();
    const e = await QmdEngine.open({ bundles: ["acme"], dir });
    expect(e.resetOnOpen).toBeUndefined();
    expect(existsSync(join(dir, "derived"))).toBe(false);
    expect(existsSync(join(dir, "gen-1-1-1"))).toBe(false);
    expect((await e.status("acme")).documents).toBe(2);
    expect(await e.index("acme", pages)).toMatchObject({ documents: 2, unchanged: 2, indexed: 0 });
    await e.close();
  });
});
