import { loadBundle } from "../bundle/load.js";
import type { LoadOptions, Report } from "../bundle/model.js";
import type { Catalog } from "../catalog/model.js";
import type {
  BundleRuntimeStatus,
  Generation,
  LastRefusal,
  LockOwnerStatus,
  Network,
  PollerStatus,
  PublishedInfo,
  RefreshOutcome,
  Runtime,
  RuntimeStatus,
} from "../catalog/runtime.js";
import { type DerivedDocument, deriveDocument } from "../derive/derived-document.js";
import type { Log } from "../log.js";
import type { Engine, IndexResult } from "../search/engine.js";
import type { Loaded, Source } from "../source/source.js";

export interface PrepareResult {
  engine: Engine;
  lock: "exclusive" | "private";
  /** Why the engine rebuilt its store, when it did. */
  resetOnOpen?: string;
  /** Sources that could only be built once the work folder was known (repository sources), by bundle id. */
  sources?: ReadonlyMap<string, Source>;
}

/** One bundle of the network: its id, its source and how it loads (D76). */
export interface BundleDeps {
  id: string;
  /** The bundle's source; a repository source may be a placeholder until `prepare()` hands back the real one. */
  source: Source;
  load: LoadOptions;
}

export interface RuntimeDeps {
  /** The network's bundles, in the configuration's order; at least one. */
  bundles: readonly BundleDeps[];
  /** Runs at the start of the first load, once it succeeds: the cache folder, the lock and the engine. Never for a probe. A failure is retried by `refresh()`. */
  prepare: () => Promise<PrepareResult>;
  clock: () => Date;
  log: Log;
  /** Status fields the command owns: the lock's holder, and each repository bundle's poller by bundle id. */
  extra?: () => {
    lockOwner?: LockOwnerStatus | null;
    pollers?: Readonly<Record<string, PollerStatus | null>>;
  };
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
  | {
      kind: "docs";
      catalog: Catalog;
      report: Report;
      docs: DerivedDocument[];
      now: Date;
      published?: PublishedInfo;
      /** False when the tree was reused from disk (the first-load fallback), which keeps a refusal visible. */
      fresh?: boolean;
    }
  | {
      kind: "fatal";
      catalog: Catalog;
      report: Report;
      now: Date;
      published?: PublishedInfo;
      fresh?: boolean;
    };

/** One bundle's state inside the runtime. */
interface BundleState {
  readonly id: string;
  readonly load: LoadOptions;
  readonly integrity: "checked" | "skipped";
  source: Source;
  current: Generation | undefined;
  refreshing: Promise<RefreshOutcome> | undefined;
  lastAttempt: BundleRuntimeStatus["lastAttempt"];
  lastRefusal: LastRefusal | undefined;
}

/** An error with the detail a log may carry beside its one-line message. */
type Described = Error & { detail?: string };

/**
 * The serving runtime of a network (decisions D28, D38, D39, D72, D75). The first load begins on `start()` or the
 * first `ready()`, never before, so a probing connection costs nothing; it prepares the network once (the cache
 * folder, the lock and the engine), then loads every bundle on its own. Loading yields to the event loop between
 * its phases (walk, load, derive, index), so the handshake is answered between them; each phase itself runs
 * without yielding (measured on 736 pages: the load about 1.1 s, the engine's update about 0.7 s). A bundle the
 * loader refuses is published as a generation whose report carries the refusal, so `status` can show it, and its
 * pages leave the index (D75); a bundle whose first load throws (its source, or its index) is published as refused
 * the same way (`load-failed`), so the network serves the others; only when every bundle's first load throws does the
 * network refuse, as a one-bundle server always has. Tool calls hold a lease on the network they read; a refresh
 * of one bundle prepares its next generation while leases run, then blocks new leases, waits for the running ones,
 * indexes that bundle alone, swaps its catalog and its part of the index together, and releases. Refreshes are
 * single-flight per bundle, and every engine call that writes runs under the gate, one at a time, whichever
 * bundle it is for. A refused reload keeps the bundle's previous generation; a reload that throws keeps it too and
 * re-aligns that bundle's part of the index with it.
 */
export function createRuntime(deps: RuntimeDeps): ServingRuntime {
  if (deps.bundles.length === 0) throw new Error("a network needs at least one bundle");
  const states: BundleState[] = deps.bundles.map((bundle) => ({
    id: bundle.id,
    load: bundle.load,
    integrity: bundle.load.integrity === "require-manifest" ? "checked" : "skipped",
    source: bundle.source,
    current: undefined,
    refreshing: undefined,
    lastAttempt: undefined,
    lastRefusal: undefined,
  }));
  let engine: Engine | undefined;
  let lock: "exclusive" | "private" = "exclusive";
  let resetOnOpen: string | undefined;
  let prepared: Promise<PrepareResult> | undefined;
  let firstLoad: Promise<void> | undefined;
  let firstLoadFailed = false;
  /** Why the first load failed as a whole (the network could not be prepared, or every bundle's source threw). */
  let refusal: string | undefined;
  /** A bundle whose part of the index could not be re-aligned after a failed refresh: nothing is served until it refreshes (D39). */
  let broken: { bundle: string; message: string } | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  /** Leases requested but not yet reading (waiting for the first load or the gate): shutdown waits for them. */
  let requested = 0;
  /** Leases reading the current network: a swap waits for them. */
  let active = 0;
  let drainWaiters: Array<() => void> = [];
  let requestWaiters: Array<() => void> = [];
  let gate: Promise<void> | undefined;
  let openGate: (() => void) | undefined;
  /** The engine's writes, one after the other, whichever bundle they are for (D28, D75). */
  let writes: Promise<unknown> = Promise.resolve();

  const refusingNow = (): string | undefined => refusal ?? broken?.message;

  const counts = (report: Report, index: IndexResult) => ({
    documents: index.documents,
    notIndexed: index.notIndexed.length,
    collisions: index.collisions.length,
    encodedFolders: index.encodedFolders,
    admitted: report.admitted,
    refused: report.refusals.length,
    degraded: report.degradations.length,
  });

  /** Each admitted word no page carries, from a load just served (D77): a typo in serve.admit admits nothing. */
  const warnUnmatched = (bundle: BundleState, report: Report): void => {
    for (const word of report.unmatchedAdmits)
      deps.log.warn("serve.admit", { bundle: bundle.id, word, detail: "matches no page" });
  };

  /** `prepare()` once, kept once it succeeds; a failure is forgotten so the next attempt runs it again. */
  function prepare(): Promise<PrepareResult> {
    if (prepared === undefined) {
      prepared = deps.prepare().then(
        (result) => {
          engine = result.engine;
          lock = result.lock;
          if (result.resetOnOpen !== undefined) resetOnOpen = result.resetOnOpen;
          for (const bundle of states) {
            const source = result.sources?.get(bundle.id);
            if (source !== undefined) bundle.source = source;
          }
          return result;
        },
        (error: unknown) => {
          prepared = undefined;
          throw error;
        },
      );
    }
    return prepared;
  }

  /** Walk, load and derive one bundle, yielding between the phases; the engine is not touched here. */
  async function prepareDocs(bundle: BundleState): Promise<Prepared> {
    const loaded = await bundle.source.load();
    const next = await prepareFrom(bundle, loaded);
    if (next.kind === "fatal") noteRefusal(bundle, next, loaded);
    return next;
  }

  /** A refusal is kept for `status`; a tree reused from disk that the loader refuses is discarded, so the next load extracts it again. */
  function noteRefusal(
    bundle: BundleState,
    next: Prepared & { kind: "fatal" },
    loaded: Loaded,
  ): void {
    const fatal = next.report.fatal;
    if (fatal !== undefined) {
      bundle.lastRefusal = {
        rule: fatal.rule,
        path: fatal.path,
        detail: fatal.detail,
        ...(next.published === undefined ? {} : { commit: next.published.commit }),
      };
    }
    if (loaded.fresh === false && loaded.published !== undefined)
      bundle.source.discard?.(loaded.published.commit);
  }

  async function prepareFrom(bundle: BundleState, loaded: Loaded): Promise<Prepared> {
    const walked = loaded.walk;
    const published = loaded.published;
    await yieldToLoop();
    const options: LoadOptions = {
      ...bundle.load,
      walkRefusals: walked.refusals,
      hiddenPaths: walked.hidden,
      hiddenFolders: walked.hiddenFolders,
    };
    if (walked.fatal !== undefined) options.walkFatal = walked.fatal;
    const now = deps.clock();
    // Each bundle is its own map: two bundles are never one loadBundle call (issue 3).
    const { catalog, report } = loadBundle(bundle.id, walked.files, options, now);
    await yieldToLoop();
    const withPublished = {
      ...(published === undefined ? {} : { published }),
      ...(loaded.fresh === undefined ? {} : { fresh: loaded.fresh }),
    };
    if (report.fatal !== undefined)
      return { kind: "fatal", catalog, report, now, ...withPublished };
    const docs = [...catalog.pages.values()].map(deriveDocument);
    await yieldToLoop();
    return { kind: "docs", catalog, report, docs, now, ...withPublished };
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

  /**
   * An engine write under the gate: no new lease starts, running ones finish, then `fn` runs; writes queue one
   * after the other, whichever bundle they are for, so no two engine calls ever overlap (D28, D75).
   */
  function underGate<T>(fn: (live: Engine) => Promise<T>): Promise<T> {
    const run = writes.then(async () => {
      const live = engine;
      if (live === undefined) throw new Error("the engine is not open");
      closeGate();
      try {
        await whenDrained();
        return await fn(live);
      } finally {
        releaseGate();
      }
    });
    writes = run.catch(() => undefined);
    return run;
  }

  /** Indexes one bundle's next generation and swaps it in; a failure re-aligns that bundle's part of the index (D39). */
  function commit(bundle: BundleState, next: Prepared & { kind: "docs" }): Promise<Generation> {
    return underGate(async (live) => {
      let index: IndexResult;
      try {
        index = await live.index(bundle.id, next.docs);
      } catch (error) {
        // The engine may now hold the new tree while the old catalog stays served: put them back together. If
        // that fails too, nothing may be served until a refresh of this bundle succeeds (D39).
        const current = bundle.current;
        if (current !== undefined) {
          try {
            await live.index(bundle.id, [...current.catalog.pages.values()].map(deriveDocument));
          } catch (again) {
            broken = {
              bundle: bundle.id,
              message: `the index could not be re-aligned with the served pages of bundle ${bundle.id} after a failed refresh (${(again as Error).message}); nothing is served until a refresh succeeds`,
            };
          }
        }
        throw error;
      }
      const generation: Generation = {
        catalog: next.catalog,
        report: next.report,
        index,
        loadedAt: next.now,
        dev: bundle.load.dev,
        integrity: bundle.integrity,
        ...(next.published === undefined ? {} : { published: next.published }),
      };
      bundle.current = generation;
      if (broken?.bundle === bundle.id) broken = undefined;
      // A tree reused from disk (the first-load fallback) does not answer the refusal that made it necessary.
      if (next.fresh !== false) bundle.lastRefusal = undefined;
      if (generation.published !== undefined) bundle.source.served?.(generation.published.commit);
      return generation;
    });
  }

  const fatalGeneration = (
    bundle: BundleState,
    next: Prepared & { kind: "fatal" },
  ): Generation => ({
    catalog: next.catalog,
    report: next.report,
    index: EMPTY_INDEX,
    loadedAt: next.now,
    dev: bundle.load.dev,
    integrity: bundle.integrity,
    ...(next.published === undefined ? {} : { published: next.published }),
  });

  /**
   * Publishes a refused generation for a bundle that has nothing else to serve, and takes its pages out of the
   * index, where an earlier run may have left them (D75): an empty generation behind its link, a scoped update.
   */
  async function publishRefused(bundle: BundleState, generation: Generation): Promise<void> {
    bundle.current = generation;
    try {
      await underGate((live) => live.drop(bundle.id));
    } catch (error) {
      broken = {
        bundle: bundle.id,
        message: `the index could not take out the pages of the refused bundle ${bundle.id} (${(error as Error).message}); nothing is served until a refresh succeeds`,
      };
    }
  }

  /** One bundle's first load: load, publish; a loader refusal falls back to the tree the source last served (D43). */
  async function firstLoadOf(bundle: BundleState): Promise<void> {
    const next = await prepareDocs(bundle);
    if (next.kind === "fatal") {
      bundle.lastAttempt = { at: deps.clock(), outcome: "fatal" };
      deps.log.error("load.fatal", {
        bundle: bundle.id,
        rule: next.report.fatal?.rule,
        path: next.report.fatal?.path,
        detail: next.report.fatal?.detail,
      });
      const servedOnDisk =
        bundle.source.loadServed === undefined ? undefined : await bundle.source.loadServed();
      if (servedOnDisk !== undefined) {
        const served = await prepareFrom(bundle, servedOnDisk);
        if (served.kind === "docs") {
          const generation = await commit(bundle, served);
          deps.log.warn("load.served-previous", {
            bundle: bundle.id,
            commit: generation.published?.commit,
            refused: next.published?.commit,
          });
          warnUnmatched(bundle, generation.report);
          return;
        }
      }
      await publishRefused(bundle, fatalGeneration(bundle, next));
      return;
    }
    const generation = await commit(bundle, next);
    bundle.lastAttempt = { at: deps.clock(), outcome: "swapped" };
    deps.log.info("load.done", {
      bundle: bundle.id,
      ...counts(generation.report, generation.index),
    });
    warnUnmatched(bundle, generation.report);
  }

  /**
   * A bundle whose first load threw while another bundle loaded: published as refused (`load-failed`), its sentence
   * the failure's own, so the network serves the others and `status` names the reason (D75).
   */
  async function publishLoadFailure(bundle: BundleState, error: Described): Promise<void> {
    bundle.lastAttempt = { at: deps.clock(), outcome: "failed" };
    deps.log.error("load.failed", {
      bundle: bundle.id,
      error: error.message,
      ...(typeof error.detail === "string" ? { detail: error.detail } : {}),
    });
    const now = deps.clock();
    const { catalog, report } = loadBundle(
      bundle.id,
      [],
      { ...bundle.load, walkFatal: { path: "", rule: "load-failed", detail: error.message } },
      now,
    );
    await publishRefused(bundle, fatalGeneration(bundle, { kind: "fatal", catalog, report, now }));
  }

  /** The network's first load: prepare once, then every bundle on its own. */
  async function firstLoadBody(): Promise<void> {
    await prepare();
    const failures: Array<{ bundle: BundleState; error: Described }> = [];
    await Promise.all(
      states.map(async (bundle) => {
        try {
          await firstLoadOf(bundle);
        } catch (error) {
          failures.push({ bundle, error: error as Described });
        }
      }),
    );
    if (failures.length === states.length) {
      // Nothing loaded: the network refuses, as a one-bundle server does, naming each bundle's reason.
      for (const { bundle } of failures)
        bundle.lastAttempt = { at: deps.clock(), outcome: "failed" };
      const [only] = failures;
      if (only !== undefined && failures.length === 1) throw only.error;
      const ordered = states.map(
        (bundle) => failures.find((failure) => failure.bundle === bundle) as (typeof failures)[0],
      );
      const combined = new Error(
        ordered.map(({ bundle, error }) => `${bundle.id}: ${error.message}`).join("; "),
      ) as Described;
      const details = ordered
        .filter(({ error }) => typeof error.detail === "string")
        .map(({ bundle, error }) => `${bundle.id}: ${error.detail}`);
      if (details.length > 0) combined.detail = details.join("; ");
      throw combined;
    }
    for (const { bundle, error } of failures) await publishLoadFailure(bundle, error);
  }

  function start(): void {
    if (firstLoad !== undefined || closed) return;
    firstLoad = (async () => {
      try {
        await firstLoadBody();
      } catch (error) {
        refusal = (error as Error).message;
        firstLoadFailed = true;
        const detail = (error as Described).detail;
        deps.log.error("serve.refusing", {
          problem: refusal,
          ...(typeof detail === "string" ? { detail } : {}),
        });
        throw error;
      }
    })();
    // The handshake starts this load with nobody waiting on it; a failure is kept for `ready()` and `status()`
    // and must not surface as an unhandled rejection, which would end the process.
    firstLoad.catch(() => undefined);
  }

  /** Every bundle at its current generation, in the configuration's order. */
  const network = (): Network => {
    const bundles = states.map((bundle) => {
      if (bundle.current === undefined) throw new Error("no generation is published");
      return { id: bundle.id, generation: bundle.current };
    });
    return { bundles };
  };

  async function ready(): Promise<Network> {
    const why = refusingNow();
    if (why !== undefined) throw new Error(why);
    start();
    if (firstLoad === undefined) throw new Error("the runtime is shut down");
    await firstLoad;
    return network();
  }

  /**
   * A lease is counted from the moment it is requested, so a shutdown that follows the request waits for it; it
   * becomes active only once it reads the network, so a swap waits for readers and never for a call that is
   * itself waiting for the first load.
   */
  function lease<T>(fn: (network: Network, engine: Engine) => Promise<T>): Promise<T> {
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
        const live = engine;
        if (live === undefined) throw new Error("no generation is published");
        const served = network();
        reading = true;
        active += 1;
        return await fn(served, live);
      } finally {
        release();
      }
    })();
  }

  /** The bundle a refresh names: the only one when none is named. */
  function bundleNamed(id: string | undefined): BundleState {
    if (id === undefined) {
      const [only] = states;
      if (only !== undefined && states.length === 1) return only;
      throw new Error(
        `name the bundle to refresh: this network holds ${states.map((bundle) => bundle.id).join(", ")}`,
      );
    }
    const found = states.find((bundle) => bundle.id === id);
    if (found === undefined) throw new Error(`no bundle ${JSON.stringify(id)} in this network`);
    return found;
  }

  function refresh(id?: string): Promise<RefreshOutcome> {
    if (closed) return Promise.reject(new Error("the runtime is shut down"));
    let bundle: BundleState;
    try {
      bundle = bundleNamed(id);
    } catch (error) {
      return Promise.reject(error);
    }
    const inFlight = bundle.refreshing;
    if (inFlight !== undefined) return inFlight;
    const refreshing = (async (): Promise<RefreshOutcome> => {
      try {
        if (firstLoad === undefined) throw new Error("the first load has not started");
        if (firstLoadFailed) {
          // A first load that failed (the network, the cache, the lock, every source) is tried again from the start.
          firstLoadFailed = false;
          firstLoad = undefined;
          start();
          if (firstLoad === undefined) throw new Error("the runtime is shut down");
          await firstLoad;
          refusal = undefined;
          const generation = bundle.current as Generation;
          return generation.report.fatal === undefined
            ? { outcome: "swapped", generation }
            : { outcome: "fatal", report: generation.report };
        }
        await firstLoad;
        const next = await prepareDocs(bundle);
        if (next.kind === "fatal") {
          bundle.lastAttempt = { at: deps.clock(), outcome: "fatal" };
          deps.log.error("refresh.fatal", {
            bundle: bundle.id,
            rule: next.report.fatal?.rule,
            path: next.report.fatal?.path,
            detail: next.report.fatal?.detail,
          });
          return { outcome: "fatal", report: next.report };
        }
        const generation = await commit(bundle, next);
        bundle.lastAttempt = { at: deps.clock(), outcome: "swapped" };
        deps.log.info("refresh.done", {
          bundle: bundle.id,
          ...counts(generation.report, generation.index),
        });
        warnUnmatched(bundle, generation.report);
        return { outcome: "swapped", generation };
      } catch (error) {
        const message = (error as Error).message;
        bundle.lastAttempt = { at: deps.clock(), outcome: "failed" };
        const detail = (error as Described).detail;
        deps.log.error("refresh.failed", {
          bundle: bundle.id,
          error: message,
          ...(typeof detail === "string" ? { detail } : {}),
        });
        return { outcome: "failed", error: message };
      } finally {
        bundle.refreshing = undefined;
      }
    })();
    bundle.refreshing = refreshing;
    return refreshing;
  }

  function status(): RuntimeStatus {
    const extra = deps.extra?.() ?? {};
    const result: RuntimeStatus = {
      lock,
      loaded: states.every((bundle) => bundle.current !== undefined),
      ...(extra.lockOwner === undefined ? {} : { lockOwner: extra.lockOwner }),
      bundles: states.map((bundle) => {
        const row: BundleRuntimeStatus = {
          id: bundle.id,
          loaded: bundle.current !== undefined,
          fatal: bundle.current?.report.fatal !== undefined,
        };
        if (bundle.lastAttempt !== undefined) row.lastAttempt = bundle.lastAttempt;
        if (bundle.lastRefusal !== undefined) row.lastRefusal = bundle.lastRefusal;
        const poller = extra.pollers?.[bundle.id];
        if (poller !== undefined) row.poller = poller;
        return row;
      }),
    };
    const why = refusingNow();
    if (why !== undefined) result.refusing = why;
    if (resetOnOpen !== undefined) result.resetOnOpen = resetOnOpen;
    return result;
  }

  function shutdown(): Promise<void> {
    if (closing !== undefined) return closing;
    closed = true;
    closing = (async () => {
      for (const bundle of states) bundle.source.abort?.();
      if (firstLoad !== undefined) await firstLoad.catch(() => undefined);
      for (const bundle of states)
        if (bundle.refreshing !== undefined) await bundle.refreshing.catch(() => undefined);
      await whenNoneRequested();
      if (engine !== undefined) await engine.close();
    })();
    return closing;
  }

  return { start, ready, lease, refresh, status, shutdown };
}
