import { describe, expect, it } from "vitest";
import type { BundleFile, LoadOptions } from "../../src/bundle/model.js";
import { DEFAULT_CAPS } from "../../src/bundle/model.js";
import type {
  BundleRuntimeStatus,
  Generation,
  Network,
  Runtime,
} from "../../src/catalog/runtime.js";
import { renderDocument } from "../../src/engine/qmd-render.js";
import type { WalkResult } from "../../src/fs/walk.js";
import type { Engine, EngineHit, IndexResult } from "../../src/search/engine.js";
import { search } from "../../src/search/search.js";
import { createRuntime } from "../../src/serve/runtime.js";
import type { Loaded, Source } from "../../src/source/source.js";
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
    load: async (): Promise<Loaded> => {
      if (throwing !== undefined) throw new Error(throwing);
      const walk: WalkResult = { files, hidden: [], hiddenFolders: [], refusals: [] };
      return { walk };
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

/**
 * An engine over the rendered documents it is given, a part per bundle: prefix match on every term, counting the
 * calls, failing once on request; `slowLexMs` makes every query yield to the loop first and read the index as it
 * stands afterwards, and `slowIndexMs` every index or drop. `overlaps` counts any engine call that began while a
 * write (an index or a drop) was running, and any write that began while another call was running.
 */
function countingEngine(
  slowLexMs = 0,
  slowIndexMs = 0,
): Engine & {
  indexCalls: number;
  closeCalls: number;
  failNext: boolean;
  failAgain: boolean;
  /** Bundles every index and drop of which throws, with a message that names a cache path, as a file system's would. */
  failing: Set<string>;
  docs: string[];
  calls: Array<{ call: "index" | "drop"; bundle: string }>;
  byBundle: Map<string, string[]>;
  overlaps: number;
} {
  const texts = new Map<string, Map<string, string[]>>();
  let writing = 0;
  let reading = 0;
  const state = {
    indexCalls: 0,
    closeCalls: 0,
    failNext: false,
    failAgain: false,
    failing: new Set<string>(),
    docs: [] as string[],
    calls: [] as Array<{ call: "index" | "drop"; bundle: string }>,
    byBundle: new Map<string, string[]>(),
    overlaps: 0,
    async index(bundle: string, docs: Parameters<Engine["index"]>[1]): Promise<IndexResult> {
      if (writing > 0 || reading > 0) state.overlaps += 1;
      writing += 1;
      try {
        state.indexCalls += 1;
        state.calls.push({ call: docs.length === 0 ? "drop" : "index", bundle });
        if (slowIndexMs > 0) await new Promise((r) => setTimeout(r, slowIndexMs));
        if (state.failNext) {
          state.failNext = state.failAgain;
          state.failAgain = false;
          throw new Error("the store broke");
        }
        if (state.failing.has(bundle)) {
          throw new Error(
            `EACCES: permission denied, mkdir '/cache/okf-catalog/net/bundles/${bundle}/gen-1'`,
          );
        }
        state.docs = docs.map((d) => d.path).sort();
        state.byBundle.set(bundle, state.docs);
        texts.set(
          bundle,
          new Map(
            docs.map((d) => [
              d.path,
              `${d.path} ${renderDocument(d)}`
                .toLowerCase()
                .split(/[^\p{L}\p{N}\p{M}-]+/u)
                .filter((w) => w.length > 0),
            ]),
          ),
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
      } finally {
        writing -= 1;
      }
    },
    async lex(terms: readonly string[], limit: number) {
      if (writing > 0) state.overlaps += 1;
      reading += 1;
      try {
        if (slowLexMs > 0) await new Promise((r) => setTimeout(r, slowLexMs));
        const hits: EngineHit[] = [];
        for (const [bundle, pages] of texts) {
          for (const [path, words] of pages) {
            let bm25 = 0;
            let all = true;
            for (const term of terms) {
              const n = words.filter((w) => w.startsWith(term)).length;
              if (n === 0) all = false;
              bm25 += n;
            }
            if (all && terms.length > 0)
              hits.push({ bundle, path, bm25, score: bm25 / (1 + bm25) });
          }
        }
        return hits.sort((a, b) => b.bm25 - a.bm25 || (a.path < b.path ? -1 : 1)).slice(0, limit);
      } finally {
        reading -= 1;
      }
    },
    async drop(bundle: string): Promise<IndexResult> {
      return state.index(bundle, []);
    },
    async status() {
      return { documents: state.docs.length };
    },
    async close() {
      state.closeCalls += 1;
    },
  };
  return state;
}

/** The generation a network serves for a bundle, the only one by default. */
const generationOf = (network: Network, id = "b"): Generation => {
  const found = network.bundles.find((bundle) => bundle.id === id);
  if (found === undefined) throw new Error(`no bundle ${id}`);
  return found.generation;
};
/** A bundle's part of the runtime's status, the only one by default. */
const own = (runtime: Runtime, id = "b"): BundleRuntimeStatus => {
  const found = runtime.status().bundles.find((bundle) => bundle.id === id);
  if (found === undefined) throw new Error(`no bundle ${id}`);
  return found;
};

function build(
  source: ReturnType<typeof memorySource>,
  engine: Engine,
  patch: Partial<LoadOptions> = {},
) {
  let prepared = 0;
  const runtime = createRuntime({
    bundles: [{ id: "b", source, load: { ...options, ...patch } }],
    prepare: async () => {
      prepared += 1;
      return { engine, lock: "exclusive" as const };
    },
    clock: () => NOW,
    log: quiet,
  });
  return { runtime, prepared: () => prepared };
}

/** A network of two bundles, `a` and `b`, over one engine. */
function network(
  a: ReturnType<typeof memorySource>,
  b: ReturnType<typeof memorySource>,
  engine: Engine,
) {
  return createRuntime({
    bundles: [
      { id: "a", source: a, load: options },
      { id: "b", source: b, load: options },
    ],
    prepare: async () => ({ engine, lock: "exclusive" as const }),
    clock: () => NOW,
    log: quiet,
  });
}

/**
 * The engine's rows for a question that a served bundle's catalog holds: what a search admits (the search over
 * several catalogs has tests of its own).
 */
const searchIn = (runtime: Runtime, question: string) =>
  runtime.lease(async (served, eng) => {
    const catalogs = new Map(
      served.bundles
        .filter((bundle) => bundle.generation.report.fatal === undefined)
        .map((bundle) => [bundle.id, bundle.generation.catalog]),
    );
    const rows = await eng.lex(question.split(" "), 50);
    return { hits: rows.filter((row) => catalogs.get(row.bundle)?.pages.has(row.path) === true) };
  });

describe("createRuntime", () => {
  it("does nothing until started, then prepares once and publishes the first generation", async () => {
    const source = memorySource(readFixture("behaviours"));
    const { runtime, prepared } = build(source, countingEngine());
    await new Promise((r) => setTimeout(r, 20));
    expect(prepared()).toBe(0);
    runtime.start();
    const generation = generationOf(await runtime.ready());
    expect(prepared()).toBe(1);
    expect(generation.catalog.pages.size).toBeGreaterThan(0);
    expect(generation.catalog.bundle).toBe("b");
    expect(generation.integrity).toBe("checked");
    expect(own(runtime).lastAttempt?.outcome).toBe("swapped");
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
        runtime.lease(async (served: Network, eng: Engine) =>
          search(
            generationOf(served).catalog,
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
    const first = generationOf(await runtime.ready());
    source.set(files.filter((f) => f.path !== "manifest.json"));
    const fatal = await runtime.refresh();
    expect(fatal.outcome).toBe("fatal");
    expect(generationOf(await runtime.ready())).toBe(first);
    expect(own(runtime).lastAttempt?.outcome).toBe("fatal");
    source.set(files);
    engine.failNext = true;
    const failed = await runtime.refresh();
    expect(failed.outcome).toBe("failed");
    expect(generationOf(await runtime.ready())).toBe(first);
    // One call failed, then one re-aligned the index with the generation still served.
    expect(engine.indexCalls).toBe(3);
    expect(engine.docs).toEqual([...first.catalog.pages.keys()].sort());
    await runtime.shutdown();
  });

  it("publishes a refused bundle as a generation with the fatal report, so status can show it, and takes its pages out of the index", async () => {
    const source = memorySource(readFixture("no-manifest"));
    const engine = countingEngine();
    const { runtime } = build(source, engine);
    runtime.start();
    const generation = generationOf(await runtime.ready());
    expect(generation.report.fatal?.rule).toBe("manifest-missing");
    expect(generation.catalog.pages.size).toBe(0);
    // A bundle refused at first load, with no tree to fall back on, leaves the index (D75).
    expect(engine.calls).toEqual([{ call: "drop", bundle: "b" }]);
    expect(own(runtime)).toMatchObject({ loaded: true, fatal: true });
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

// The readiness ledger (issue 2's "Holds", D59, row 37): only admitted pages are written for the engine.
describe("createRuntime: the readiness ledger (D59)", () => {
  it("hands the engine the admitted pages only", async () => {
    const engine = countingEngine();
    const { runtime } = build(memorySource(readFixture("behaviours")), engine);
    runtime.start();
    const generation = generationOf(await runtime.ready());
    expect(engine.docs).toEqual([...generation.catalog.pages.keys()].sort());
    expect(engine.docs).toHaveLength(17);
    for (const path of [
      "notes/draft.md",
      "notes/unknown-status.md",
      "index.md",
      "log.md",
      "terms/index.md",
      "references/attachment.txt",
      "manifest.json",
    ])
      expect(engine.docs, path).not.toContain(path);
    await runtime.shutdown();
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
    // A fixed sentence for the model, saying when it is tried again; the engine's words go to the log (C-I-A4).
    expect(runtime.status().refusing).not.toContain("the store broke");
    expect(runtime.status().refusing).toMatch(/until the server restarts/);
    await expect(runtime.lease(async () => 1)).rejects.toThrow(/re-aligned|realign/i);
    const recovered = await runtime.refresh();
    expect(recovered.outcome).toBe("swapped");
    expect(runtime.status().refusing).toBeUndefined();
    expect(await runtime.lease(async () => 1)).toBe(1);
    await runtime.shutdown();
  });
});

describe("createRuntime (bite 4 build review, round 2)", () => {
  it("refuses, and never rejects into the void, when a first load started by the handshake fails", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const runtime = createRuntime({
        bundles: [{ id: "b", source: memorySource(readFixture("behaviours")), load: options }],
        prepare: async () => {
          throw new Error("the cache root cannot be read (EACCES)");
        },
        clock: () => NOW,
        log: quiet,
      });
      runtime.start();
      await new Promise((r) => setTimeout(r, 30));
      expect(rejections).toEqual([]);
      expect(runtime.status().refusing).toMatch(/cannot be read/);
      await expect(runtime.ready()).rejects.toThrow(/cannot be read/);
      await runtime.shutdown();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("never serves the new index against the old catalog while a refresh that adds pages swaps (the gate, with a slow engine)", async () => {
    const files = readFixture("behaviours");
    const source = memorySource(files.filter((f) => !f.path.startsWith("notes/")));
    const engine = countingEngine(5);
    const { runtime } = build(source, engine, { integrity: "none" });
    runtime.start();
    await runtime.ready();
    source.set(files);
    const refreshing = runtime.refresh();
    const during = await Promise.all(
      Array.from({ length: 5 }, () =>
        runtime.lease(async (served: Network, eng: Engine) =>
          search(
            generationOf(served).catalog,
            eng,
            { question: "note", includeStale: true, limit: 8 },
            NOW,
          ),
        ),
      ),
    );
    expect((await refreshing).outcome).toBe("swapped");
    for (const r of during) expect(r.filteredOut.unknown).toBe(0);
    await runtime.shutdown();
  });

  it("shuts down during the first load by waiting for it, closing the engine once", async () => {
    const engine = countingEngine();
    const { runtime } = build(memorySource(readFixture("behaviours")), engine);
    runtime.start();
    await runtime.shutdown();
    expect(engine.closeCalls).toBe(1);
    expect(own(runtime).lastAttempt?.outcome).toBe("swapped");
    await expect(runtime.lease(async () => 1)).rejects.toThrow(/shut down/);
  });
});

describe("createRuntime (bite 5: a source that fails, falls back and reports)", () => {
  const files = readFixture("behaviours");

  it("retries a failed first load on refresh, then clears the refusal", async () => {
    const source = memorySource(files);
    source.fail("the repository r could not be fetched; the log has git's message");
    const { runtime } = build(source, countingEngine());
    runtime.start();
    await expect(runtime.ready()).rejects.toThrow(/could not be fetched/);
    expect(runtime.status()).toMatchObject({
      loaded: false,
      refusing: expect.stringMatching(/fetched/),
    });
    const still = await runtime.refresh();
    expect(still.outcome).toBe("failed");
    expect(runtime.status().refusing).toMatch(/fetched/);
    source.fail(undefined);
    const recovered = await runtime.refresh();
    expect(recovered.outcome).toBe("swapped");
    expect(runtime.status()).toMatchObject({ loaded: true });
    expect(runtime.status().refusing).toBeUndefined();
    expect(generationOf(await runtime.ready()).catalog.pages.size).toBeGreaterThan(0);
    await runtime.shutdown();
  });

  it("retries a failed prepare too, running it again only until it succeeds", async () => {
    let attempts = 0;
    const engine = countingEngine();
    const runtime = createRuntime({
      bundles: [{ id: "b", source: memorySource(files), load: options }],
      prepare: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("the cache root cannot be read (EACCES)");
        return { engine, lock: "exclusive" as const, resetOnOpen: "the store was rebuilt" };
      },
      clock: () => NOW,
      log: quiet,
    });
    runtime.start();
    await expect(runtime.ready()).rejects.toThrow(/EACCES/);
    expect((await runtime.refresh()).outcome).toBe("swapped");
    expect(attempts).toBe(2);
    expect((await runtime.refresh()).outcome).toBe("swapped");
    expect(attempts).toBe(2);
    expect(runtime.status().resetOnOpen).toBe("the store was rebuilt");
    await runtime.shutdown();
  });

  it("serves the tree the source last served when the loader refuses the fetched commit at first load", async () => {
    const good: Loaded = {
      walk: { files, hidden: [], hiddenFolders: [], refusals: [] },
      published: { commit: "a".repeat(40), fetchedAt: NOW },
    };
    const refused: Loaded = {
      walk: {
        files: [],
        hidden: [],
        hiddenFolders: [],
        refusals: [],
        fatal: {
          path: "link.md",
          rule: "symlink",
          detail: "a symbolic link in the published tree",
        },
      },
      published: { commit: "b".repeat(40), fetchedAt: NOW },
    };
    const served: string[] = [];
    const source: Source = {
      kind: "git",
      load: async () => refused,
      loadServed: async () => good,
      served: (commit) => void served.push(commit),
      describe: () => "git@h:o/r.git",
    };
    const { runtime } = build(source as ReturnType<typeof memorySource>, countingEngine());
    runtime.start();
    const generation = generationOf(await runtime.ready());
    expect(generation.catalog.pages.size).toBeGreaterThan(0);
    expect(generation.published?.commit).toBe("a".repeat(40));
    expect(own(runtime).lastAttempt?.outcome).toBe("fatal");
    expect(served).toEqual(["a".repeat(40)]);
    await runtime.shutdown();
  });

  it("tells the source which commit is served after each swap, keeps the published commit on the generation, and aborts the source at shutdown", async () => {
    const served: string[] = [];
    let commit = "1".repeat(40);
    let aborted = 0;
    const source: Source = {
      kind: "git",
      load: async () => ({
        walk: { files, hidden: [], hiddenFolders: [], refusals: [] },
        published: { commit, fetchedAt: NOW },
      }),
      served: (c) => void served.push(c),
      describe: () => "git@h:o/r.git",
      abort: () => {
        aborted += 1;
      },
    };
    const { runtime } = build(source as ReturnType<typeof memorySource>, countingEngine());
    runtime.start();
    expect(generationOf(await runtime.ready()).published?.commit).toBe("1".repeat(40));
    commit = "2".repeat(40);
    const r = await runtime.refresh();
    expect(r.outcome === "swapped" && r.generation.published?.commit).toBe("2".repeat(40));
    expect(served).toEqual(["1".repeat(40), "2".repeat(40)]);
    await runtime.shutdown();
    expect(aborted).toBe(1);
  });

  it("merges the command's status fields (lock owner, each bundle's poller) into its own", async () => {
    const runtime = createRuntime({
      bundles: [{ id: "b", source: memorySource(files), load: options }],
      prepare: async () => ({ engine: countingEngine(), lock: "private" as const }),
      clock: () => NOW,
      log: quiet,
      extra: () => ({
        lockOwner: { pid: 4242, startedAt: "2026-10-07T00:00:00Z", alive: true },
        pollers: { b: { intervalMs: 60_000, lastOutcome: "unchanged" } },
      }),
    });
    runtime.start();
    await runtime.ready();
    expect(runtime.status()).toMatchObject({
      lock: "private",
      loaded: true,
      lockOwner: { pid: 4242, alive: true },
    });
    expect(own(runtime).poller).toEqual({ intervalMs: 60_000, lastOutcome: "unchanged" });
    await runtime.shutdown();
  });

  it("warns at each load of every admitted word that matches no page (D77, build review A-E1)", async () => {
    const records: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const log = {
      error() {},
      warn: (event: string, fields: Record<string, unknown> = {}) =>
        void records.push({ event, fields }),
      info() {},
      debug() {},
    };
    const runtime = createRuntime({
      bundles: [
        {
          id: "b",
          source: memorySource(readFixture("behaviours")),
          load: { ...options, admit: ["stable", "deprecated", "depreciated"] },
        },
      ],
      prepare: async () => ({ engine: countingEngine(), lock: "exclusive" as const }),
      clock: () => NOW,
      log,
    });
    runtime.start();
    const generation = generationOf(await runtime.ready());
    expect(generation.report.unmatchedAdmits).toEqual(["depreciated"]);
    expect(records).toEqual([
      {
        event: "serve.admit",
        fields: { bundle: "b", word: "depreciated", detail: "matches no page" },
      },
    ]);
    // A refresh that swaps loads again and says so again; the configuration has not changed.
    expect((await runtime.refresh()).outcome).toBe("swapped");
    expect(records.filter((r) => r.event === "serve.admit")).toHaveLength(2);
    await runtime.shutdown();
  });

  it("logs the detail a failing load carries on refresh.failed, beside the one-line message", async () => {
    const records: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const log = {
      error: (event: string, fields: Record<string, unknown> = {}) =>
        void records.push({ event, fields }),
      warn() {},
      info() {},
      debug() {},
    };
    const files = readFixture("behaviours");
    let failing = false;
    const source: Source = {
      kind: "git",
      load: async () => {
        if (failing) {
          const error = new Error(
            "the repository r could not be fetched; the log has git's message",
          ) as Error & { detail?: string };
          error.detail = "fatal: unable to access 'https://host/r.git/': HTTP 401";
          throw error;
        }
        return { walk: { files, hidden: [], hiddenFolders: [], refusals: [] } };
      },
      describe: () => "r",
    };
    const runtime = createRuntime({
      bundles: [{ id: "b", source, load: options }],
      prepare: async () => ({ engine: countingEngine(), lock: "exclusive" as const }),
      clock: () => NOW,
      log,
    });
    runtime.start();
    await runtime.ready();
    failing = true;
    expect((await runtime.refresh()).outcome).toBe("failed");
    const record = records.find((r) => r.event === "refresh.failed");
    expect(record?.fields.error).toMatch(/could not be fetched/);
    expect(record?.fields.detail).toMatch(/HTTP 401/);
    expect(record?.fields.bundle).toBe("b");
    await runtime.shutdown();
  });

  it("says in status which commit was refused and why, discards a reused tree the loader refused, and flags a refusal it serves", async () => {
    const files = readFixture("behaviours");
    const refused: Loaded = {
      walk: {
        files: [],
        hidden: [],
        hiddenFolders: [],
        refusals: [],
        fatal: {
          path: "link.md",
          rule: "symlink",
          detail: "a symbolic link in the published tree",
        },
      },
      published: { commit: "b".repeat(40), fetchedAt: NOW },
      fresh: false,
    };
    const good: Loaded = {
      walk: { files, hidden: [], hiddenFolders: [], refusals: [] },
      published: { commit: "a".repeat(40), fetchedAt: NOW },
      fresh: false,
    };
    const discarded: string[] = [];
    const source: Source = {
      kind: "git",
      load: async () => refused,
      loadServed: async () => good,
      served: () => undefined,
      discard: (commit) => void discarded.push(commit),
      describe: () => "git@h:o/r.git",
    };
    const { runtime } = build(source as ReturnType<typeof memorySource>, countingEngine());
    runtime.start();
    await runtime.ready();
    expect(own(runtime).lastRefusal).toMatchObject({
      commit: "b".repeat(40),
      rule: "symlink",
      path: "link.md",
    });
    expect(own(runtime).fatal).toBe(false);
    expect(discarded).toEqual(["b".repeat(40)]);
    await runtime.shutdown();
    const nothingServed: Source = { ...source, loadServed: async () => undefined };
    const bare = build(nothingServed as ReturnType<typeof memorySource>, countingEngine());
    bare.runtime.start();
    await bare.runtime.ready();
    expect(bare.runtime.status()).toMatchObject({ loaded: true });
    expect(own(bare.runtime)).toMatchObject({ loaded: true, fatal: true });
    await bare.runtime.shutdown();
  });
});

// Issue 3 and D75: each bundle loads, fails and refreshes on its own, in one index, one engine call at a time.
describe("createRuntime: a network of bundles (D75)", () => {
  it("serves the other bundles when one has no manifest", async () => {
    const engine = countingEngine();
    const runtime = network(
      memorySource(readFixture("behaviours")),
      memorySource(readFixture("no-manifest")),
      engine,
    );
    runtime.start();
    const served = await runtime.ready();
    expect(served.bundles.map((bundle) => bundle.id)).toEqual(["a", "b"]);
    expect(generationOf(served, "a").report.fatal).toBeUndefined();
    expect(generationOf(served, "b").report.fatal?.rule).toBe("manifest-missing");
    expect(runtime.status().refusing).toBeUndefined();
    expect(own(runtime, "a")).toMatchObject({ loaded: true, fatal: false });
    expect(own(runtime, "b")).toMatchObject({ loaded: true, fatal: true });
    // The refused bundle's pages leave the index (D75); the other's are searched.
    expect(engine.byBundle.get("b")).toEqual([]);
    const hits = (await searchIn(runtime, "alpha glossary")).hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.bundle === "a")).toBe(true);
    await runtime.shutdown();
    // A bundle whose source throws at first load is published as refused, and the others serve.
    const failing = memorySource(readFixture("spec-example"));
    failing.fail("the bundle folder ./gone does not exist or cannot be read");
    const halfEngine = countingEngine();
    const half = network(memorySource(readFixture("behaviours")), failing, halfEngine);
    half.start();
    const partial = await half.ready();
    // Its pages leave the index too, where an earlier run may have left them (D75; C-A-B1).
    expect(halfEngine.calls).toContainEqual({ call: "drop", bundle: "b" });
    expect(generationOf(partial, "b").report.fatal).toEqual({
      path: "",
      rule: "load-failed",
      detail: "the bundle folder ./gone does not exist or cannot be read",
    });
    expect(own(half, "b")).toMatchObject({
      loaded: true,
      fatal: true,
      lastAttempt: { outcome: "failed" },
    });
    expect(half.status().refusing).toBeUndefined();
    expect((await searchIn(half, "alpha")).hits.length).toBeGreaterThan(0);
    // Its source back, a refresh of that bundle serves it.
    failing.fail(undefined);
    expect((await half.refresh("b")).outcome).toBe("swapped");
    expect((await searchIn(half, "revenue")).hits.some((hit) => hit.bundle === "b")).toBe(true);
    await half.shutdown();
    // Only when every bundle's first load throws does the network refuse, naming each.
    const none = memorySource(readFixture("behaviours"));
    none.fail("the bundle folder ./one does not exist or cannot be read");
    const neither = memorySource(readFixture("behaviours"));
    neither.fail("the bundle folder ./two does not exist or cannot be read");
    const down = network(none, neither, countingEngine());
    down.start();
    await expect(down.ready()).rejects.toThrow(/\.\/one.*\.\/two/);
    expect(down.status().refusing).toMatch(/a: .*\.\/one.*; b: .*\.\/two/);
    await down.shutdown();
  });

  it("refreshes one bundle and keeps its previous generation on failure", async () => {
    const engine = countingEngine();
    const a = memorySource(readFixture("behaviours"));
    const specExample = readFixture("spec-example");
    const b = memorySource(specExample);
    const runtime = network(a, b, engine);
    runtime.start();
    const first = await runtime.ready();
    const firstB = generationOf(first, "b");
    const firstA = generationOf(first, "a");
    const pagesOfA = engine.byBundle.get("a");
    const calls = engine.calls.length;
    // A refused reload of b keeps b's previous generation, and both bundles stay searchable.
    b.set(specExample.filter((f) => f.path !== "manifest.json"));
    expect((await runtime.refresh("b")).outcome).toBe("fatal");
    expect(generationOf(await runtime.ready(), "b")).toBe(firstB);
    // A reload of b that fails in the engine is re-aligned with b's previous pages; a is never touched.
    b.set(specExample);
    engine.failNext = true;
    expect((await runtime.refresh("b")).outcome).toBe("failed");
    expect(generationOf(await runtime.ready(), "b")).toBe(firstB);
    expect(engine.byBundle.get("b")).toEqual([...firstB.catalog.pages.keys()].sort());
    // A reload of b whose source throws keeps it too.
    b.fail("the bundle folder ./b does not exist or cannot be read");
    expect((await runtime.refresh("b")).outcome).toBe("failed");
    expect(generationOf(await runtime.ready(), "b")).toBe(firstB);
    expect(engine.calls.slice(calls).every((call) => call.bundle === "b")).toBe(true);
    expect(engine.byBundle.get("a")).toEqual(pagesOfA);
    expect(generationOf(await runtime.ready(), "a")).toBe(firstA);
    const both = await searchIn(runtime, "revenue");
    expect(both.hits.some((hit) => hit.bundle === "b")).toBe(true);
    expect((await searchIn(runtime, "alpha glossary")).hits[0]?.bundle).toBe("a");
    expect(own(runtime, "b").lastAttempt?.outcome).toBe("failed");
    expect(own(runtime, "a").lastAttempt?.outcome).toBe("swapped");
    // A refresh names its bundle once the network holds more than one; an unknown bundle is refused.
    await expect(runtime.refresh()).rejects.toThrow(/name the bundle.*a, b/);
    await expect(runtime.refresh("zz")).rejects.toThrow(/no bundle "zz"/);
    await runtime.shutdown();
  });

  it("keeps refresh single-flight per bundle and commits one at a time", async () => {
    const engine = countingEngine(2, 15);
    const a = memorySource(readFixture("behaviours"));
    const b = memorySource(readFixture("spec-example"));
    const runtime = network(a, b, engine);
    runtime.start();
    await runtime.ready();
    // The first load indexed both bundles, one call after the other.
    expect(engine.calls).toEqual([
      expect.objectContaining({ call: "index" }),
      expect.objectContaining({ call: "index" }),
    ]);
    expect(engine.overlaps).toBe(0);
    const before = engine.calls.length;
    const first = runtime.refresh("a");
    const second = runtime.refresh("a");
    const other = runtime.refresh("b");
    const searches = Array.from({ length: 4 }, () => searchIn(runtime, "term"));
    const outcomes = await Promise.all([first, second, other]);
    await Promise.all(searches);
    expect(outcomes.map((o) => o.outcome)).toEqual(["swapped", "swapped", "swapped"]);
    // Two refreshes of one bundle ran one index(); the other bundle's ran its own; no engine call overlapped.
    const made = engine.calls.slice(before);
    expect(made.filter((call) => call.bundle === "a")).toHaveLength(1);
    expect(made.filter((call) => call.bundle === "b")).toHaveLength(1);
    expect(engine.overlaps).toBe(0);
    await runtime.shutdown();
  });
});

// D39 per bundle (the fold of bite c's build reviews, C-I-A1, C-I-A2, C-I-A4, C-I-A5, C-A-A1): a bundle whose part of
// the index cannot be brought in line is refused as index-broken, alone, with a fixed sentence; the others serve.
describe("createRuntime: one bundle's index failure is its own (D39 per bundle)", () => {
  /** A log that keeps every record. */
  const recording = () => {
    const records: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
    const at =
      (level: string) =>
      (event: string, fields: Record<string, unknown> = {}) =>
        void records.push({ level, event, fields });
    return {
      records,
      log: { error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug") },
    };
  };

  it("publishes a refused bundle whose pages cannot leave the index as index-broken, while the other serves", async () => {
    const engine = countingEngine();
    engine.failing.add("b");
    const { records, log } = recording();
    const runtime = createRuntime({
      bundles: [
        { id: "a", source: memorySource(readFixture("behaviours")), load: options },
        { id: "b", source: memorySource(readFixture("no-manifest")), load: options },
      ],
      prepare: async () => ({ engine, lock: "exclusive" as const }),
      clock: () => NOW,
      log,
    });
    runtime.start();
    const served = await runtime.ready();
    expect(runtime.status().refusing).toBeUndefined();
    expect(generationOf(served, "a").report.fatal).toBeUndefined();
    const fatal = generationOf(served, "b").report.fatal;
    expect(fatal?.rule).toBe("index-broken");
    expect(fatal?.path).toBe("");
    // A local bundle has no poller: the sentence says it is tried again at a restart, and names no path.
    expect(fatal?.detail).toMatch(/tried again when the server restarts/);
    expect(fatal?.detail).not.toMatch(/EACCES|\/cache\//);
    expect(own(runtime, "b")).toMatchObject({ loaded: true, fatal: true });
    expect(own(runtime, "a")).toMatchObject({ loaded: true, fatal: false });
    const hits = (await searchIn(runtime, "alpha glossary")).hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.bundle === "a")).toBe(true);
    // The engine's words go to the log, as the record's detail.
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "index.broken",
        fields: expect.objectContaining({ bundle: "b", detail: expect.stringMatching(/EACCES/) }),
      }),
    );
    await runtime.shutdown();
  });

  it("keeps each broken bundle apart: another bundle's refresh, or its recovery, leaves a broken bundle broken", async () => {
    const engine = countingEngine();
    const runtime = network(
      memorySource(readFixture("behaviours")),
      memorySource(readFixture("spec-example")),
      engine,
    );
    runtime.start();
    await runtime.ready();
    // a's refresh fails in the engine, and so does putting its pages back: a alone is index-broken.
    engine.failing.add("a");
    expect((await runtime.refresh("a")).outcome).toBe("failed");
    expect(runtime.status().refusing).toBeUndefined();
    expect(generationOf(await runtime.ready(), "a").report.fatal?.rule).toBe("index-broken");
    expect(own(runtime, "a").fatal).toBe(true);
    expect(own(runtime, "b").fatal).toBe(false);
    expect((await searchIn(runtime, "revenue")).hits.some((hit) => hit.bundle === "b")).toBe(true);
    // b breaks the same way: two broken bundles, each its own.
    engine.failing.add("b");
    expect((await runtime.refresh("b")).outcome).toBe("failed");
    const both = await runtime.ready();
    expect(generationOf(both, "a").report.fatal?.rule).toBe("index-broken");
    expect(generationOf(both, "b").report.fatal?.rule).toBe("index-broken");
    // b recovers: b serves again, and a stays broken until its own write succeeds (C-I-B1).
    engine.failing.delete("b");
    expect((await runtime.refresh("b")).outcome).toBe("swapped");
    const after = await runtime.ready();
    expect(generationOf(after, "b").report.fatal).toBeUndefined();
    expect(generationOf(after, "a").report.fatal?.rule).toBe("index-broken");
    expect(own(runtime, "a").fatal).toBe(true);
    engine.failing.delete("a");
    expect((await runtime.refresh("a")).outcome).toBe("swapped");
    expect(generationOf(await runtime.ready(), "a").report.fatal).toBeUndefined();
    expect(own(runtime, "a").fatal).toBe(false);
    await runtime.shutdown();
  });

  it("puts a broken bundle's served pages back at its next refresh, even one the loader refuses", async () => {
    const engine = countingEngine();
    const files = readFixture("behaviours");
    const a = memorySource(files);
    const runtime = network(a, memorySource(readFixture("spec-example")), engine);
    runtime.start();
    const first = generationOf(await runtime.ready(), "a");
    engine.failing.add("a");
    expect((await runtime.refresh("a")).outcome).toBe("failed");
    expect(generationOf(await runtime.ready(), "a").report.fatal?.rule).toBe("index-broken");
    // The engine is back and the reload is refused: the previous generation, re-aligned, is served again.
    engine.failing.delete("a");
    a.set(files.filter((f) => f.path !== "manifest.json"));
    expect((await runtime.refresh("a")).outcome).toBe("fatal");
    expect(generationOf(await runtime.ready(), "a")).toBe(first);
    expect(engine.byBundle.get("a")).toEqual([...first.catalog.pages.keys()].sort());
    await runtime.shutdown();
  });

  it("names an engine failure at the first load with a fixed sentence, the engine's words in the log", async () => {
    const engine = countingEngine();
    const { records, log } = recording();
    // Only b's index of its pages fails; its drop, an index of nothing, works.
    const failingIndex: Engine = {
      ...engine,
      index: async (bundle, docs) => {
        if (bundle === "b" && docs.length > 0)
          throw new Error("ENOSPC: no space left on device, write '/cache/okf-catalog/net/x'");
        return engine.index(bundle, docs);
      },
      drop: async (bundle) => engine.index(bundle, []),
      lex: (terms, limit) => engine.lex(terms, limit),
    };
    const runtime = createRuntime({
      bundles: [
        { id: "a", source: memorySource(readFixture("behaviours")), load: options },
        { id: "b", source: memorySource(readFixture("spec-example")), load: options },
      ],
      prepare: async () => ({ engine: failingIndex, lock: "exclusive" as const }),
      clock: () => NOW,
      log,
    });
    runtime.start();
    const served = await runtime.ready();
    const fatal = generationOf(served, "b").report.fatal;
    expect(fatal?.rule).toBe("load-failed");
    expect(fatal?.detail).not.toMatch(/ENOSPC|\/cache\//);
    expect(fatal?.detail).toMatch(/the log has the detail/);
    expect(engine.calls).toContainEqual({ call: "drop", bundle: "b" });
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "load.failed",
        fields: expect.objectContaining({ bundle: "b", detail: expect.stringMatching(/ENOSPC/) }),
      }),
    );
    await runtime.shutdown();
  });

  it("refuses a one-bundle network whose refused bundle's pages cannot leave the index, rechecking once the load lands", async () => {
    const engine = countingEngine();
    engine.failing.add("b");
    const { runtime } = build(memorySource(readFixture("no-manifest")), engine);
    // ready() starts the first load and waits for it; the refusal it meets after the wait is answered (C-I-A5).
    await expect(runtime.ready()).rejects.toThrow(/re-aligned|realign/i);
    expect(runtime.status().refusing).toMatch(/until the server restarts/);
    expect(runtime.status().refusing).not.toMatch(/EACCES|\/cache\//);
    await expect(runtime.lease(async () => 1)).rejects.toThrow(/re-aligned|realign/i);
    await runtime.shutdown();
  });
});

// The first-load deadline (the fold of bite c's build reviews, C-A-A4): one bundle whose load hangs (a clone that
// blocks) holds back no other bundle's answer for longer than the deadline; it is reported as loading meanwhile.
describe("createRuntime: the first-load deadline (D75)", () => {
  /** A source whose load waits until it is released, or rejects when it is aborted, as a hung git would. */
  function hangingSource(files: BundleFile[]) {
    let release: (() => void) | undefined;
    let abort: ((error: Error) => void) | undefined;
    let loads = 0;
    return {
      kind: "git" as const,
      load: (): Promise<Loaded> => {
        loads += 1;
        return new Promise<Loaded>((resolve, reject) => {
          release = () => resolve({ walk: { files, hidden: [], hiddenFolders: [], refusals: [] } });
          abort = reject;
        });
      },
      describe: () => "git@example.test:acme/slow.git",
      abort: () => abort?.(new Error("the transport was aborted")),
      release: () => release?.(),
      loads: () => loads,
    };
  }

  it("answers from the bundles that have landed once the deadline passes, the slow one loading, and serves it when it lands", async () => {
    const engine = countingEngine();
    const slow = hangingSource(readFixture("spec-example"));
    const warnings: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const runtime = createRuntime({
      bundles: [
        { id: "a", source: memorySource(readFixture("behaviours")), load: options },
        { id: "b", source: slow, load: options },
      ],
      prepare: async () => ({ engine, lock: "exclusive" as const }),
      clock: () => NOW,
      log: { ...quiet, warn: (event, fields = {}) => void warnings.push({ event, fields }) },
      firstLoadDeadlineMs: 40,
    });
    runtime.start();
    const started = Date.now();
    const served = await runtime.ready();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(generationOf(served, "a").report.fatal).toBeUndefined();
    const loading = generationOf(served, "b").report.fatal;
    expect(loading?.rule).toBe("loading");
    expect(loading?.detail).toMatch(/first load has not finished/);
    expect(runtime.status().refusing).toBeUndefined();
    expect(own(runtime, "b")).toMatchObject({ loaded: false, fatal: true });
    expect(
      (await searchIn(runtime, "alpha glossary")).hits.every((hit) => hit.bundle === "a"),
    ).toBe(true);
    expect(warnings).toContainEqual({
      event: "load.slow",
      fields: expect.objectContaining({ bundle: "b" }),
    });
    // A refresh of the slow bundle (its poller's tick) is that first load: it waits for it, and loads nothing twice.
    const refreshing = runtime.refresh("b");
    slow.release();
    expect((await refreshing).outcome).toBe("swapped");
    expect(slow.loads()).toBe(1);
    const after = await runtime.ready();
    expect(generationOf(after, "b").report.fatal).toBeUndefined();
    expect((await searchIn(runtime, "revenue")).hits.some((hit) => hit.bundle === "b")).toBe(true);
    await runtime.shutdown();
  });

  it("publishes the slow bundle when its load lands, with no call waiting on it", async () => {
    const slow = hangingSource(readFixture("spec-example"));
    const runtime = createRuntime({
      bundles: [
        { id: "a", source: memorySource(readFixture("behaviours")), load: options },
        { id: "b", source: slow, load: options },
      ],
      prepare: async () => ({ engine: countingEngine(), lock: "exclusive" as const }),
      clock: () => NOW,
      log: quiet,
      firstLoadDeadlineMs: 20,
    });
    runtime.start();
    await runtime.ready();
    expect(own(runtime, "b").loaded).toBe(false);
    slow.release();
    for (let i = 0; i < 100 && !own(runtime, "b").loaded; i += 1)
      await new Promise((r) => setTimeout(r, 10));
    expect(own(runtime, "b")).toMatchObject({ loaded: true, fatal: false });
    expect(generationOf(await runtime.ready(), "b").report.fatal).toBeUndefined();
    await runtime.shutdown();
  });

  it("waits for a network of one bundle's one load past the deadline, as version 0 did", async () => {
    const slow = hangingSource(readFixture("behaviours"));
    const runtime = createRuntime({
      bundles: [{ id: "b", source: slow, load: options }],
      prepare: async () => ({ engine: countingEngine(), lock: "exclusive" as const }),
      clock: () => NOW,
      log: quiet,
      firstLoadDeadlineMs: 10,
    });
    runtime.start();
    let answered = false;
    const pending = runtime.ready().then((network) => {
      answered = true;
      return network;
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(answered).toBe(false);
    slow.release();
    expect(generationOf(await pending).report.fatal).toBeUndefined();
    await runtime.shutdown();
  });

  it("shuts down while a slow first load still runs, aborting its transport", async () => {
    const slow = hangingSource(readFixture("spec-example"));
    const runtime = createRuntime({
      bundles: [
        { id: "a", source: memorySource(readFixture("behaviours")), load: options },
        { id: "b", source: slow, load: options },
      ],
      prepare: async () => ({ engine: countingEngine(), lock: "exclusive" as const }),
      clock: () => NOW,
      log: quiet,
      firstLoadDeadlineMs: 20,
    });
    runtime.start();
    await runtime.ready();
    await runtime.shutdown();
    expect(own(runtime, "b")).toMatchObject({ loaded: true, fatal: true });
  });
});
