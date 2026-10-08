import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBundle } from "../../src/bundle/load.js";
import { DEFAULT_CAPS } from "../../src/bundle/model.js";
import { deriveDocument } from "../../src/derive/derived-document.js";
import { QmdEngine } from "../../src/engine/qmd.js";
import { search } from "../../src/search/search.js";
import { NOW, readFixture } from "../helpers/fixtures.js";

process.env.NODE_LLAMA_CPP_SKIP_DOWNLOAD = "1";

/**
 * The fixture rank guard of decision D66: the fifteen questions of `qmd-engine.test.ts` ("answers the keyword and
 * sentence questions…") over the behaviours fixture, through the real engine, relaxed and strict, limit 8. Each
 * answer's ordered paths are pinned in `test/expected/ranks.json`, taken after R1. The search may change no engine
 * rank; a change of admission re-pins the file with UPDATE_EXPECTED=1, and the failure names the answers that differ.
 */
const QUESTIONS = [
  "alpha glossary",
  "beta term",
  "gamma generator",
  "delta legacy",
  "epsilon retired successor",
  "eta bare mapping",
  "theta offset",
  "skipped folder codec",
  "tags one two three-four",
  "orders agent instructions",
  "Which term is the fully described page every happy-path test starts from?",
  "What happens to a page whose recheck datetime carries no offset?",
  "Why would a search engine skip a folder named dist?",
  "Which page addresses the reader as if it were an agent and gives it orders?",
  "How does a retired term without a successor look?",
];
const pinFile = join(dirname(fileURLToPath(import.meta.url)), "..", "expected", "ranks.json");

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

let work: string;
let engine: QmdEngine;
beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "okf-catalog-rank-guard-"));
  engine = await QmdEngine.open({ bundles: ["behaviours"], dir: work });
  await engine.index("behaviours", [...catalog.pages.values()].map(deriveDocument));
});
afterAll(async () => {
  await engine.close();
  rmSync(work, { recursive: true, force: true });
});

describe("the fixture rank guard (D66)", () => {
  it("answers the fifteen questions over the behaviours fixture in the pinned order, relaxed and strict", async () => {
    const actual: Record<string, string[]> = {};
    for (const relax of [true, false]) {
      for (const question of QUESTIONS) {
        const r = await search(
          catalog,
          engine,
          { question, includeStale: true, limit: 8, relax },
          NOW,
        );
        actual[`${relax ? "relaxed" : "strict"}: ${question}`] = r.hits.map((h) => h.path);
      }
    }
    if (process.env.UPDATE_EXPECTED === "1")
      writeFileSync(pinFile, `${JSON.stringify(actual, null, 2)}\n`);
    expect(existsSync(pinFile), "no pin: run the suite once with UPDATE_EXPECTED=1").toBe(true);
    const expected = JSON.parse(readFileSync(pinFile, "utf8")) as Record<string, string[]>;
    const differing = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter(
      (key) => JSON.stringify(expected[key]) !== JSON.stringify(actual[key]),
    );
    expect(differing, "answers that differ from test/expected/ranks.json").toEqual([]);
    expect(Object.keys(actual)).toHaveLength(30);
  });
});
