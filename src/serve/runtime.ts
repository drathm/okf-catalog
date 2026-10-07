import { loadBundle } from "../bundle/load.js";
import type { LoadOptions, Report } from "../bundle/model.js";
import type { Catalog } from "../catalog/model.js";
import type { Generation, RefreshOutcome, Runtime, RuntimeStatus } from "../catalog/runtime.js";
import { type DerivedDocument, deriveDocument } from "../derive/derived-document.js";
import type { WalkResult } from "../fs/walk.js";
import type { Log } from "../log.js";
import type { Engine, IndexResult } from "../search/engine.js";

export interface RuntimeDeps {
  company: string;
  source: { load(): WalkResult; describe(): string };
  /** Runs once, at the start of the first load: the cache folder, the lock and the engine. Never for a probe. */
  prepare: () => Promise<{ engine: Engine; lock: "exclusive" | "private" }>;
  load: LoadOptions;
  clock: () => Date;
  log: Log;
}

export interface ServingRuntime extends Runtime {
  start(): void;
}

const EMPTY_INDEX: IndexResult = {
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

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type Prepared =
  | { kind: "docs"; catalog: Catalog; report: Report; docs: DerivedDocument[]; now: Date }
  | { kind: "fatal"; catalog: Catalog; report: Report; now: Date };

/**
 * The serving runtime (decisions D28, D38, D39). The first load begins on `start()` or the first `ready()`,
 * never before, so a probing connection costs nothing. Loading yields to the event loop between its phases, so
 * the handshake is answered between them; only the engine's own update does not yield. Tool calls hold a lease
 * on the generation they read; a refresh prepares the next generation while leases run, then blocks new leases,
 * waits for the running ones, indexes, swaps catalog and index together, and releases. A refused reload keeps
 * the previous generation; a reload that throws keeps it too and re-aligns the index with it. A refused first
 * load is published as a generation whose report carries the refusal, so `status` can show it.
 */
export function createRuntime(deps: RuntimeDeps): ServingRuntime {
  let engine: Engine | undefined;
  let lock: "exclusive" | "private" = "exclusive";
  let current: Generation | undefined;
  let firstLoad: Promise<Generation> | undefined;
  let refreshing: Promise<RefreshOutcome> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let refusing: string | undefined;
  let lastAttempt: RuntimeStatus["lastAttempt"];
  /** Leases requested but not yet reading (waiting for the first load or the gate): shutdown waits for them. */
  let requested = 0;
  /** Leases reading the current generation: a swap waits for them. */
  let active = 0;
  let drainWaiters: Array<() => void> = [];
  let requestWaiters: Array<() => void> = [];
  let gate: Promise<void> | undefined;
  let openGate: (() => void) | undefined;

  const integrity = deps.load.integrity === "require-manifest" ? "checked" : "skipped";

  const counts = (report: Report, index: IndexResult) => ({
    documents: index.documents,
    notIndexed: index.notIndexed.length,
    collisions: index.collisions.length,
    encodedFolders: index.encodedFolders,
    admitted: report.admitted,
    refused: report.refusals.length,
    degraded: report.degradations.length,
  });

  /** Walk, load and derive, yielding between the phases; the engine is not touched here. */
  async function prepareDocs(): Promise<Prepared> {
    const walked = deps.source.load();
    await yieldToLoop();
    const options: LoadOptions = {
      ...deps.load,
      walkRefusals: walked.refusals,
      hiddenPaths: walked.hidden,
      hiddenFolders: walked.hiddenFolders,
    };
    if (walked.fatal !== undefined) options.walkFatal = walked.fatal;
    const now = deps.clock();
    const { catalog, report } = loadBundle(deps.company, walked.files, options, now);
    await yieldToLoop();
    if (report.fatal !== undefined) return { kind: "fatal", catalog, report, now };
    const docs = [...catalog.pages.values()].map(deriveDocument);
    await yieldToLoop();
    return { kind: "docs", catalog, report, docs, now };
  }

  const whenDrained = (): Promise<void> =>
    active === 0 ? Promise.resolve() : new Promise((resolve) => drainWaiters.push(resolve));
  const whenNoneRequested = (): Promise<void> =>
    requested === 0 ? Promise.resolve() : new Promise((resolve) => requestWaiters.push(resolve));

  function closeGate(): void {
    gate = new Promise((resolve) => {
      openGate = resolve;
    });
  }
  function releaseGate(): void {
    const open = openGate;
    gate = undefined;
    openGate = undefined;
    open?.();
  }

  /** Under the gate: no new lease starts, running ones finish, then the index is rebuilt and the generation swapped. */
  async function commit(prepared: Prepared & { kind: "docs" }): Promise<Generation> {
    const live = engine;
    if (live === undefined) throw new Error("the engine is not open");
    closeGate();
    try {
      await whenDrained();
      let index: IndexResult;
      try {
        index = await live.index(prepared.docs);
      } catch (error) {
        // The engine may now hold the new tree while the old catalog stays served: put them back together. If
        // that fails too, nothing may be served until a refresh succeeds (D39).
        if (current !== undefined) {
          try {
            await live.index([...current.catalog.pages.values()].map(deriveDocument));
          } catch (again) {
            refusing = `the index could not be re-aligned with the served pages after a failed refresh (${(again as Error).message}); nothing is served until a refresh succeeds`;
          }
        }
        throw error;
      }
      const generation: Generation = {
        catalog: prepared.catalog,
        report: prepared.report,
        index,
        loadedAt: prepared.now,
        dev: deps.load.dev,
        integrity,
      };
      current = generation;
      return generation;
    } finally {
      releaseGate();
    }
  }

  function start(): void {
    if (firstLoad !== undefined || closed) return;
    firstLoad = (async () => {
      try {
        const prepared = await deps.prepare();
        engine = prepared.engine;
        lock = prepared.lock;
        const next = await prepareDocs();
        if (next.kind === "fatal") {
          current = {
            catalog: next.catalog,
            report: next.report,
            index: EMPTY_INDEX,
            loadedAt: next.now,
            dev: deps.load.dev,
            integrity,
          };
          lastAttempt = { at: deps.clock(), outcome: "fatal" };
          deps.log.error("load.fatal", {
            rule: next.report.fatal?.rule,
            path: next.report.fatal?.path,
            detail: next.report.fatal?.detail,
          });
          return current;
        }
        const generation = await commit(next);
        lastAttempt = { at: deps.clock(), outcome: "swapped" };
        deps.log.info("load.done", counts(generation.report, generation.index));
        return generation;
      } catch (error) {
        refusing = (error as Error).message;
        lastAttempt = { at: deps.clock(), outcome: "failed" };
        deps.log.error("serve.refusing", { problem: refusing });
        throw error;
      }
    })();
  }

  async function ready(): Promise<Generation> {
    if (refusing !== undefined) throw new Error(refusing);
    start();
    if (firstLoad === undefined) throw new Error("the runtime is shut down");
    return firstLoad;
  }

  /**
   * A lease is counted from the moment it is requested, so a shutdown that follows the request waits for it; it
   * becomes active only once it reads a generation, so a swap waits for readers and never for a call that is
   * itself waiting for the first load.
   */
  function lease<T>(fn: (generation: Generation, engine: Engine) => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error("the runtime is shut down"));
    requested += 1;
    let reading = false;
    const release = (): void => {
      if (reading) {
        active -= 1;
        if (active === 0) {
          const waiters = drainWaiters;
          drainWaiters = [];
          for (const resolve of waiters) resolve();
        }
      }
      requested -= 1;
      if (requested === 0) {
        const waiters = requestWaiters;
        requestWaiters = [];
        for (const resolve of waiters) resolve();
      }
    };
    return (async () => {
      try {
        await ready();
        while (gate !== undefined) await gate;
        const generation = current;
        const live = engine;
        if (generation === undefined || live === undefined) {
          throw new Error("no generation is published");
        }
        reading = true;
        active += 1;
        return await fn(generation, live);
      } finally {
        release();
      }
    })();
  }

  function refresh(): Promise<RefreshOutcome> {
    if (closed) return Promise.reject(new Error("the runtime is shut down"));
    if (refreshing !== undefined) return refreshing;
    refreshing = (async (): Promise<RefreshOutcome> => {
      try {
        if (firstLoad === undefined) throw new Error("the first load has not started");
        await firstLoad;
        const next = await prepareDocs();
        if (next.kind === "fatal") {
          lastAttempt = { at: deps.clock(), outcome: "fatal" };
          deps.log.error("refresh.fatal", {
            rule: next.report.fatal?.rule,
            path: next.report.fatal?.path,
            detail: next.report.fatal?.detail,
          });
          return { outcome: "fatal", report: next.report };
        }
        const generation = await commit(next);
        refusing = undefined;
        lastAttempt = { at: deps.clock(), outcome: "swapped" };
        deps.log.info("refresh.done", counts(generation.report, generation.index));
        return { outcome: "swapped", generation };
      } catch (error) {
        const message = (error as Error).message;
        lastAttempt = { at: deps.clock(), outcome: "failed" };
        deps.log.error("refresh.failed", { error: message });
        return { outcome: "failed", error: message };
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  }

  function status(): RuntimeStatus {
    const result: RuntimeStatus = { lock };
    if (lastAttempt !== undefined) result.lastAttempt = lastAttempt;
    if (refusing !== undefined) result.refusing = refusing;
    return result;
  }

  function shutdown(): Promise<void> {
    if (closing !== undefined) return closing;
    closed = true;
    closing = (async () => {
      if (firstLoad !== undefined) await firstLoad.catch(() => undefined);
      if (refreshing !== undefined) await refreshing.catch(() => undefined);
      await whenNoneRequested();
      if (engine !== undefined) await engine.close();
      deps.log.info("serve.shutdown", { reason: "closed" });
    })();
    return closing;
  }

  return { start, ready, lease, refresh, status, shutdown };
}
