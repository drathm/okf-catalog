import { describe, expect, it } from "vitest";
import type { BundleFile, LoadOptions } from "../../src/bundle/model.js";
import { DEFAULT_CAPS } from "../../src/bundle/model.js";
import type { Generation } from "../../src/catalog/runtime.js";
import { renderDocument } from "../../src/engine/qmd-render.js";
import type { WalkResult } from "../../src/fs/walk.js";
import type { Engine, IndexResult } from "../../src/search/engine.js";
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

/** An engine over the rendered documents it is given: prefix match on every term, counting the calls, failing once on request; `slowLexMs` makes every query yield to the loop first and read the index as it stands afterwards. */
function countingEngine(slowLexMs = 0): Engine & {
  indexCalls: number;
  closeCalls: number;
  failNext: boolean;
  failAgain: boolean;
  docs: string[];
} {
  let texts = new Map<string, string[]>();
  const state = {
    indexCalls: 0,
    closeCalls: 0,
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
      if (slowLexMs > 0) await new Promise((r) => setTimeout(r, slowLexMs));
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
    async close() {
      state.closeCalls += 1;
    },
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

describe("createRuntime (bite 4 build review, round 2)", () => {
  it("refuses, and never rejects into the void, when a first load started by the handshake fails", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const runtime = createRuntime({
        company: "b",
        source: memorySource(readFixture("behaviours")),
        prepare: async () => {
          throw new Error("the cache root cannot be read (EACCES)");
        },
        load: options,
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
        runtime.lease(async (generation: Generation, eng: Engine) =>
          search(generation.catalog, eng, { question: "note", includeStale: true, limit: 8 }, NOW),
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
    expect(runtime.status().lastAttempt?.outcome).toBe("swapped");
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
    expect((await runtime.ready()).catalog.pages.size).toBeGreaterThan(0);
    await runtime.shutdown();
  });

  it("retries a failed prepare too, running it again only until it succeeds", async () => {
    let attempts = 0;
    const engine = countingEngine();
    const runtime = createRuntime({
      company: "b",
      source: memorySource(files),
      prepare: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("the cache root cannot be read (EACCES)");
        return { engine, lock: "exclusive" as const, resetOnOpen: "the store was rebuilt" };
      },
      load: options,
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
    const generation = await runtime.ready();
    expect(generation.catalog.pages.size).toBeGreaterThan(0);
    expect(generation.published?.commit).toBe("a".repeat(40));
    expect(runtime.status().lastAttempt?.outcome).toBe("fatal");
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
    expect((await runtime.ready()).published?.commit).toBe("1".repeat(40));
    commit = "2".repeat(40);
    const r = await runtime.refresh();
    expect(r.outcome === "swapped" && r.generation.published?.commit).toBe("2".repeat(40));
    expect(served).toEqual(["1".repeat(40), "2".repeat(40)]);
    await runtime.shutdown();
    expect(aborted).toBe(1);
  });

  it("merges the command's status fields (lock owner, poller) into its own", async () => {
    const runtime = createRuntime({
      company: "b",
      source: memorySource(files),
      prepare: async () => ({ engine: countingEngine(), lock: "private" as const }),
      load: options,
      clock: () => NOW,
      log: quiet,
      extra: () => ({
        lockOwner: { pid: 4242, startedAt: "2026-10-07T00:00:00Z", alive: true },
        poller: { intervalMs: 60_000, lastOutcome: "unchanged" },
      }),
    });
    runtime.start();
    await runtime.ready();
    expect(runtime.status()).toMatchObject({
      lock: "private",
      loaded: true,
      lockOwner: { pid: 4242, alive: true },
      poller: { intervalMs: 60_000, lastOutcome: "unchanged" },
    });
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
      company: "b",
      source,
      prepare: async () => ({ engine: countingEngine(), lock: "exclusive" as const }),
      load: options,
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
    expect(runtime.status().lastRefusal).toMatchObject({
      commit: "b".repeat(40),
      rule: "symlink",
      path: "link.md",
    });
    expect(runtime.status().fatal).toBe(false);
    expect(discarded).toEqual(["b".repeat(40)]);
    await runtime.shutdown();
    const nothingServed: Source = { ...source, loadServed: async () => undefined };
    const bare = build(nothingServed as ReturnType<typeof memorySource>, countingEngine());
    bare.runtime.start();
    await bare.runtime.ready();
    expect(bare.runtime.status()).toMatchObject({ loaded: true, fatal: true });
    await bare.runtime.shutdown();
  });
});
