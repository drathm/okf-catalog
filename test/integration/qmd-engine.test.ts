import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@tobilu/qmd";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBundle } from "../../src/bundle/load.js";
import { DEFAULT_CAPS } from "../../src/bundle/model.js";
import { type DerivedDocument, deriveDocument } from "../../src/derive/derived-document.js";
import { QmdEngine } from "../../src/engine/qmd.js";
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
  engine = await QmdEngine.open({ company: "behaviours", dir: work });
});
afterAll(async () => {
  await engine.close();
  rmSync(work, { recursive: true, force: true });
});

describe("QmdEngine", () => {
  it("indexes every derived document, encodes the folder qmd would skip, and reports nothing unindexed", async () => {
    const result = await engine.index(docs);
    expect(result.documents).toBe(docs.length);
    expect(result.notIndexed).toEqual([]);
    expect(result.encodedFolders).toEqual(["dist"]);
    expect((await engine.status()).documents).toBe(docs.length);
    expect(existsSync(join(work, "derived"))).toBe(true);
  });

  it("finds a page by a keyword and decodes paths back to the bundle, including the encoded folder", async () => {
    const alpha = await engine.lex(["alpha", "glossary"], 5);
    expect(alpha[0]?.path).toBe("terms/alpha.md");
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
    const result = await engine.index([...docs, odd]);
    expect(result.documents).toBe(docs.length + 1);
    expect(result.notIndexed).toEqual([]);
    expect((await engine.lex(["zebra-backslash-marker"], 5))[0]?.path).toBe("odd/back\\slash.md");
  });

  it("drops a removed document on re-index and leaves only the live generation, linked by its base name", async () => {
    const result = await engine.index(docs);
    expect(result.documents).toBe(docs.length);
    expect(await engine.lex(["zebra-backslash-marker"], 5)).toEqual([]);
    const generations = readdirSync(work).filter((n) => n.startsWith("gen-"));
    expect(generations).toHaveLength(1);
    expect(readlinkSync(join(work, "derived"))).toBe(generations[0]);
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
    await engine.index(many);
    const changed = many.map((d) => ({ ...d, body: `versiontwo body ${d.path}\n` }));
    const seen = new Set<number>();
    let stop = false;
    const sample = async (): Promise<void> => {
      if (stop) return;
      seen.add((await engine.lex(["versionone"], 1000)).length);
      setImmediate(() => void sample());
    };
    setImmediate(() => void sample());
    await engine.index(changed);
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
      const e = await QmdEngine.open({ company: "rel", dir: join("cache", "rel") });
      const r = await e.index([note("a.md", "Alpha", "alpha body text")]);
      expect(r.documents).toBe(1);
      expect(r.notIndexed).toEqual([]);
      expect(readlinkSync(join("cache", "rel", "derived"))).toMatch(/^gen-\d+-\d+-1$/);
      expect((await e.lex(["alpha"], 5))[0]?.path).toBe("a.md");
      await e.close();
    } finally {
      process.chdir(previous);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("refuses a second index while one is running; the composition layer keeps refreshes single-flight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-catalog-reent-"));
    const e = await QmdEngine.open({ company: "re", dir });
    const first = e.index([note("a.md", "A", "one")]);
    await expect(e.index([note("b.md", "B", "two")])).rejects.toThrow(/already running/);
    await first;
    expect((await e.status()).documents).toBe(1);
    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a document whose path would leave the generation folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-catalog-unsafe-"));
    const e = await QmdEngine.open({ company: "un", dir });
    await expect(e.index([note("../escape.md", "E", "x")])).rejects.toThrow(
      /not a safe bundle path/,
    );
    await expect(e.index([note("/abs.md", "E", "x")])).rejects.toThrow(/not a safe bundle path/);
    expect((await e.status()).documents).toBe(0);
    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resets an index that holds another company's rows when it opens, and counts only its own collection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-catalog-shared-"));
    const a = await QmdEngine.open({ company: "aaa", dir });
    expect(a.resetOnOpen).toBeUndefined();
    await a.index([
      note("x.md", "Shared", "zebra zebra zebra"),
      note("y.md", "Other", "zebra once"),
    ]);
    await a.close();
    const b = await QmdEngine.open({ company: "bbb", dir });
    expect(b.resetOnOpen).toMatch(/aaa/);
    const r = await b.index([note("z.md", "Mine", "zebra here")]);
    expect(r.documents).toBe(1);
    expect((await b.status()).documents).toBe(1);
    expect((await b.lex(["zebra"], 1)).map((h) => h.path)).toEqual(["z.md"]);
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("pins qmd's title rule for a page titled Notes: the next second-level heading becomes the title", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-catalog-notes-"));
    const e = await QmdEngine.open({ company: "nt", dir });
    await e.index([
      note("notes.md", "Notes", "An introduction.\n\n## Real heading\n\nMore text.\n"),
    ]);
    await e.close();
    const raw = await createStore({
      dbPath: join(dir, "index.sqlite"),
      config: { collections: { nt: { path: join(dir, "derived"), pattern: "**/*.md" } } },
    });
    const listed = await raw.multiGet("nt/**");
    expect(listed.docs.map((d) => (d.doc as { title?: string }).title)).toEqual(["Real heading"]);
    await raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sums the per-term scores on the relaxed rung without the type token inflating them", async () => {
    await engine.index(docs);
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
    const e = await QmdEngine.open({ company: "col", dir });
    const r = await e.index([
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
    const e = await QmdEngine.open({ company: "nm", dir });
    const tooLong = `_${"a".repeat(251)}.md`;
    const r = await e.index([
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
    mkdirSync(join(dir, "gen-1-1-1"));
    symlinkSync("gen-nowhere", join(dir, "derived.tmp-7"));
    const e = await QmdEngine.open({ company: "gc", dir });
    expect(
      readdirSync(dir).filter((n) => n.startsWith("gen-") || n.startsWith("derived.tmp-")),
    ).toEqual([]);
    await e.index([note("a.md", "A", "x")]);
    const gens = readdirSync(dir).filter((n) => n.startsWith("gen-"));
    expect(gens).toHaveLength(1);
    expect(gens[0]).toMatch(new RegExp(`^gen-\\d+-${process.pid}-1$`));
    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// The readiness ledger (issue 2's "Holds", D59, row 27): index.md and log.md are reserved, served, never indexed.
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
      const own = await QmdEngine.open({ company: "x", dir });
      try {
        await own.index([...loaded.pages.values()].map(deriveDocument));
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

describe("QmdEngine: the readiness ledger (D59)", () => {
  it("keeps reserved files out of the index", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-catalog-qmd-reserved-"));
    const own = await QmdEngine.open({ company: "behaviours", dir });
    try {
      const result = await own.index(docs);
      expect(result.documents).toBe(catalog.pages.size);
      expect(catalog.folders.get("")?.log).toBeDefined();
      expect(catalog.folders.get("")?.index?.body).toContain("Material that is not Markdown");
      // "initialization" and "history" are written in the fixture's log.md, "material" and "lifecycle" in its root
      // index.md, and none of them in a page.
      for (const word of ["initialization", "history", "material", "lifecycle"])
        expect(await own.lex([word], 5), word).toEqual([]);
      const written = (readdirSync(join(dir, "derived"), { recursive: true }) as string[]).map(
        (p) => p.split("\\").join("/"),
      );
      expect(written.filter((p) => p.endsWith(".md")).length).toBe(catalog.pages.size);
      expect(written.filter((p) => /(^|\/)(index|log)\.md$/.test(p))).toEqual([]);
    } finally {
      await own.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
