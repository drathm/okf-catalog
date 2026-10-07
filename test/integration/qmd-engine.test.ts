import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("drops a removed document on re-index and keeps one old generation at most", async () => {
    const result = await engine.index(docs);
    expect(result.documents).toBe(docs.length);
    expect(await engine.lex(["zebra-backslash-marker"], 5)).toEqual([]);
    expect(readdirSync(work).filter((n) => n.startsWith("gen-")).length).toBeLessThanOrEqual(2);
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

  it("never lets a concurrent search see a half-updated index", async () => {
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
    const [, during] = await Promise.all([engine.index(changed), engine.lex(["versionone"], 1000)]);
    expect([0, 400]).toContain(during.length);
    expect((await engine.lex(["versiontwo"], 1000)).length).toBe(400);
  });
});
