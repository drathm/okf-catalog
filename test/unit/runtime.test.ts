import { describe, expect, it } from "vitest";
import type { BundleFile, LoadOptions } from "../../src/bundle/model.js";
import { DEFAULT_CAPS } from "../../src/bundle/model.js";
import type { Generation } from "../../src/catalog/runtime.js";
import { renderDocument } from "../../src/engine/qmd-render.js";
import type { WalkResult } from "../../src/fs/walk.js";
import type { Engine, IndexResult } from "../../src/search/engine.js";
import { search } from "../../src/search/search.js";
import { createRuntime } from "../../src/serve/runtime.js";
import { NOW, readFixture } from "../helpers/fixtures.js";

const options: LoadOptions = {
  admit: ["stable", "deprecated"],
  dev: false,
  integrity: "require-manifest",
  specText: "2026-08-15",
  caps: DEFAULT_CAPS,
};
const quiet = { error() {}, warn() {}, info() {}, debug() {} };

/** A source over in-memory files, swappable between loads, that can also be made to throw. */
function memorySource(initial: BundleFile[]) {
  let files = initial;
  let throwing: string | undefined;
  return {
    kind: "local" as const,
    load: (): WalkResult => {
      if (throwing !== undefined) throw new Error(throwing);
      return { files, hidden: [], hiddenFolders: [], refusals: [] };
    },
    describe: () => "./kb",
    set: (next: BundleFile[]) => {
      files = next;
    },
    fail: (message: string | undefined) => {
      throwing = message;
    },
  };
}

/** An engine over the rendered documents it is given: prefix match on every term, counting the calls, failing once on request. */
function countingEngine(): Engine & {
  indexCalls: number;
  failNext: boolean;
  failAgain: boolean;
  docs: string[];
} {
  let texts = new Map<string, string[]>();
  const state = {
    indexCalls: 0,
    failNext: false,
    failAgain: false,
    docs: [] as string[],
    async index(docs: Parameters<Engine["index"]>[0]): Promise<IndexResult> {
      state.indexCalls += 1;
      if (state.failNext) {
        state.failNext = state.failAgain;
        state.failAgain = false;
        throw new Error("the store broke");
      }
      state.docs = docs.map((d) => d.path).sort();
      texts = new Map(
        docs.map((d) => [
          d.path,
          `${d.path} ${renderDocument(d)}`
            .toLowerCase()
            .split(/[^\p{L}\p{N}\p{M}-]+/u)
            .filter((w) => w.length > 0),
        ]),
      );
      return {
        documents: docs.length,
        indexed: docs.length,
        updated: 0,
        unchanged: 0,
        removed: 0,
        skipped: 0,
        notIndexed: [],
        collisions: [],
        encodedFolders: [],
      };
    },
    async lex(terms: readonly string[], limit: number) {
      const hits = [];
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
      return { documents: state.docs.length };
    },
    async close() {},
  };
  return state;
}

function build(
  source: ReturnType<typeof memorySource>,
  engine: Engine,
  patch: Partial<LoadOptions> = {},
) {
  let prepared = 0;
  const runtime = createRuntime({
    company: "b",
    source,
    prepare: async () => {
      prepared += 1;
      return { engine, lock: "exclusive" as const };
    },
    load: { ...options, ...patch },
    clock: () => NOW,
    log: quiet,
  });
  return { runtime, prepared: () => prepared };
}

describe("createRuntime", () => {
  it("does nothing until started, then prepares once and publishes the first generation", async () => {
    const source = memorySource(readFixture("behaviours"));
    const { runtime, prepared } = build(source, countingEngine());
    await new Promise((r) => setTimeout(r, 20));
    expect(prepared()).toBe(0);
    runtime.start();
    const generation = await runtime.ready();
    expect(prepared()).toBe(1);
    expect(generation.catalog.pages.size).toBeGreaterThan(0);
    expect(generation.integrity).toBe("checked");
    expect(runtime.status().lastAttempt?.outcome).toBe("swapped");
    runtime.start();
    await runtime.ready();
    expect(prepared()).toBe(1);
    await runtime.shutdown();
  });

  it("runs one index for two concurrent refreshes, and a search during a refresh never sees an unknown path", async () => {
    const files = readFixture("behaviours");
    const source = memorySource(files);
    const engine = countingEngine();
    const { runtime } = build(source, engine);
    runtime.start();
    await runtime.ready();
    expect(engine.indexCalls).toBe(1);
    const renamed = files.map((f) =>
      f.path.startsWith("terms/") && f.path !== "terms/index.md"
        ? { ...f, path: f.path.replace("terms/", "terms/") }
        : f,
    );
    source.set(renamed);
    const [a, b] = await Promise.all([runtime.refresh(), runtime.refresh()]);
    expect(a.outcome).toBe("swapped");
    expect(b.outcome).toBe("swapped");
    expect(engine.indexCalls).toBe(2);
    // Searches issued while another refresh is in flight must read one catalog and one index.
    source.set(files.filter((f) => !f.path.startsWith("notes/")));
    const refreshing = runtime.refresh();
    const during = await Promise.all(
      Array.from({ length: 5 }, () =>
        runtime.lease(async (generation: Generation, eng: Engine) =>
          search(
            generation.catalog,
            eng,
            { question: "term glossary", includeStale: true, limit: 5 },
            NOW,
          ),
        ),
      ),
    );
    await refreshing;
    for (const r of during) expect(r.filteredOut.unknown).toBe(0);
    await runtime.shutdown();
  });

  it("keeps the previous generation on a fatal reload and on a throwing one, re-indexing after a failure", async () => {
    const files = readFixture("behaviours");
    const source = memorySource(files);
    const engine = countingEngine();
    const { runtime } = build(source, engine);
    runtime.start();
    const first = await runtime.ready();
    source.set(files.filter((f) => f.path !== "manifest.json"));
    const fatal = await runtime.refresh();
    expect(fatal.outcome).toBe("fatal");
    expect(await runtime.ready()).toBe(first);
    expect(runtime.status().lastAttempt?.outcome).toBe("fatal");
    source.set(files);
    engine.failNext = true;
    const failed = await runtime.refresh();
    expect(failed.outcome).toBe("failed");
    expect(await runtime.ready()).toBe(first);
    // One call failed, then one re-aligned the index with the generation still served.
    expect(engine.indexCalls).toBe(3);
    expect(engine.docs).toEqual([...first.catalog.pages.keys()].sort());
    await runtime.shutdown();
  });

  it("publishes a refused bundle as a generation with the fatal report, so status can show it", async () => {
    const source = memorySource(readFixture("no-manifest"));
    const { runtime } = build(source, countingEngine());
    runtime.start();
    const generation = await runtime.ready();
    expect(generation.report.fatal?.rule).toBe("manifest-missing");
    expect(generation.catalog.pages.size).toBe(0);
    await runtime.shutdown();
  });

  it("refuses with the sentence when the first load throws, and rejects a refresh after shutdown", async () => {
    const source = memorySource(readFixture("behaviours"));
    source.fail("the bundle folder ./kb does not exist or cannot be read");
    const { runtime } = build(source, countingEngine());
    runtime.start();
    await expect(runtime.ready()).rejects.toThrow(/does not exist/);
    expect(runtime.status().refusing).toMatch(/does not exist/);
    await expect(runtime.lease(async () => 1)).rejects.toThrow(/does not exist/);
    await runtime.shutdown();
    await runtime.shutdown();
    await expect(runtime.refresh()).rejects.toThrow(/shut down/);
  });

  it("shutdown waits for a lease in flight", async () => {
    const source = memorySource(readFixture("behaviours"));
    const { runtime } = build(source, countingEngine());
    runtime.start();
    await runtime.ready();
    let released = false;
    const lease = runtime.lease(async () => {
      await new Promise((r) => setTimeout(r, 50));
      released = true;
      return 1;
    });
    const closing = runtime.shutdown();
    await closing;
    expect(released).toBe(true);
    await lease;
  });
});

describe("createRuntime: a re-index that fails too (bite 4 build review)", () => {
  it("refuses until a refresh succeeds when the index cannot be re-aligned after a failed refresh", async () => {
    const files = readFixture("behaviours");
    const source = memorySource(files);
    const engine = countingEngine();
    const { runtime } = build(source, engine);
    runtime.start();
    await runtime.ready();
    engine.failNext = true;
    engine.failAgain = true;
    const failed = await runtime.refresh();
    expect(failed.outcome).toBe("failed");
    expect(runtime.status().refusing).toMatch(/re-aligned|realign/i);
    await expect(runtime.lease(async () => 1)).rejects.toThrow(/re-aligned|realign/i);
    const recovered = await runtime.refresh();
    expect(recovered.outcome).toBe("swapped");
    expect(runtime.status().refusing).toBeUndefined();
    expect(await runtime.lease(async () => 1)).toBe(1);
    await runtime.shutdown();
  });
});
