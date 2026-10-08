import { loadBundle } from "../bundle/load.js";
import type { LoadOptions, RefusalRule, Report } from "../bundle/model.js";
import type { Catalog } from "../catalog/model.js";
import {
  type BundleRuntimeStatus,
  type Generation,
  INDEX_BROKEN,
  type LastRefusal,
  LOAD_FAILED,
  LOADING,
  type LockOwnerStatus,
  type Network,
  type PollerStatus,
  type PublishedInfo,
  type RefreshOutcome,
  type Runtime,
  type RuntimeStatus,
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
  /** The first-load deadline in milliseconds; `FIRST_LOAD_DEADLINE_MS` unless a test shortens it. */
  firstLoadDeadlineMs?: number;
}

/**
 * How long a tool call waits for the first load of a network of more than one bundle (D75): once every bundle's
 * first load has landed, or this long after the loads began, the network answers from the bundles that have
 * landed, and a bundle still loading is reported as `loading` (not searched, refused by name, shown in `status`)
 * until its load lands and publishes it. Twenty seconds holds a cold clone of a small repository and a load of a few
 * thousand pages; a clone that hangs (git's own timeout is 300 s) no longer holds back every other bundle's first
 * answer. A network of one bundle waits for its one load, as version 0 did: it has nothing else to answer from.
 */
export const FIRST_LOAD_DEADLINE_MS = 20_000;

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

/**
 * The sentence a bundle whose part of the index is broken is refused with, beyond one bundle (D39, per bundle): when
 * it is tried again, which for a local bundle, having no poller, is a restart; the engine's words, which may name the
 * cache folder, go to the log as the record's detail.
 */
export function brokenSentence(kind: Source["kind"]): string {
  return kind === "git"
    ? "the index could not be brought in line with this bundle's pages; it is tried again at the bundle's next poll, and the log has the detail"
    : "the index could not be brought in line with this bundle's pages; it is tried again when the server restarts, and the log has the detail";
}

/** A network of one bundle refuses as a whole for the same failure, as version 0 did (D39, D74). */
export function brokenRefusal(kind: Source["kind"]): string {
  return kind === "git"
    ? "the index could not be re-aligned with the served pages; nothing is served until the bundle's next poll succeeds, and the log has the detail"
    : "the index could not be re-aligned with the served pages; nothing is served until the server restarts, and the log has the detail";
}

/** An engine failure as the model is told it: the engine's own words, which may name the cache folder, go to the log. */
export const ENGINE_FAILED = "the index could not take this bundle's pages; the log has the detail";
/** Why a bundle serves nothing yet: its first load has not landed. */
export const STILL_LOADING = "the bundle's first load has not finished; it is served when it lands";
/** Why a bundle was never loaded: the network itself could not be prepared. */
export const NOT_PREPARED =
  "the network could not be prepared, so the bundle was not loaded; the network's refusal says why";

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
interface Held {
  readonly id: string;
  readonly load: LoadOptions;
  readonly integrity: "checked" | "skipped";
  source: Source;
  /** What the bundle serves, or the refusal published for it; undefined until its first load lands. */
  current: Generation | undefined;
  /** Its first load, while it runs and after: a refresh of the bundle waits for it until it has landed. */
  loading: Promise<void> | undefined;
  /** Whether its first load has landed, whatever its outcome. */
  landed: boolean;
  /** Why its first load threw, until the bundle loads: the network refuses when every bundle's first load threw (D75). */
  failed: Described | undefined;
  /** Its part of the index could not be brought in line with what it serves (D39, per bundle): the sentence it is refused with. */
  broken: string | undefined;
  refreshing: Promise<RefreshOutcome> | undefined;
  lastAttempt: BundleRuntimeStatus["lastAttempt"];
  lastRefusal: LastRefusal | undefined;
  /** The refusals published for it without a load of its own (broken, loading, not loaded), by rule and sentence. */
  readonly synthetic: Map<string, Generation>;
}

/** An error with the detail a log may carry beside its one-line message, and whether it is the index's. */
type Described = Error & { detail?: string; index?: true };

/** An engine failure, told with a fixed sentence; the engine's words travel as the detail, for the log. */
function engineFailure(error: unknown): Described {
  const described = new Error(ENGINE_FAILED) as Described;
  described.detail = (error as Error).message;
  described.index = true;
  return described;
}

/** A served generation's pages, as the engine indexes them. */
const pagesOf = (generation: Generation | undefined): DerivedDocument[] =>
  generation === undefined ? [] : [...generation.catalog.pages.values()].map(deriveDocument);

/**
 * The serving runtime of a network (decisions D28, D38, D39, D72, D75). The first load begins on `start()` or the
 * first `ready()`, never before, so a probing connection costs nothing; it prepares the network once (the cache
 * folder, the lock and the engine), then loads every bundle on its own and publishes each as its load lands. Loading
 * yields to the event loop between its phases (walk, load, derive, index), so the handshake is answered between
 * them; each phase itself runs without yielding (measured on 736 pages: the load about 1.1 s, the engine's update
 * about 0.7 s). A bundle the loader refuses is published as a generation whose report carries the refusal, so
 * `status` can show it, and its pages leave the index (D75); a bundle whose first load throws (its source, or its
 * index) is published as refused the same way (`load-failed`), so the network serves the others; when every
 * bundle's first load threw the network refuses, naming each, as a one-bundle server always has. A bundle whose part
 * of the index cannot be brought in line with what it serves (a drop that fails, or a failed refresh whose
 * re-alignment fails too) is refused alone as `index-broken` until a later write of it succeeds (D39, per bundle); a
 * network of one bundle refuses as a whole meanwhile, as version 0 did. Tool calls hold a lease on the network they
 * read; a refresh of one bundle prepares its next generation while leases run, then blocks new leases, waits for the
 * running ones, indexes that bundle alone, swaps its catalog and its part of the index together, and releases.
 * Refreshes are single-flight per bundle, and every engine call that writes runs under the gate, one at a time,
 * whichever bundle it is for. A refused reload keeps the bundle's previous generation; a reload that throws keeps it
 * too and re-aligns that bundle's part of the index with it.
 */
export function createRuntime(deps: RuntimeDeps): ServingRuntime {
  if (deps.bundles.length === 0) throw new Error("a network needs at least one bundle");
  const states: Held[] = deps.bundles.map((bundle) => ({
    id: bundle.id,
    load: bundle.load,
    integrity: bundle.load.integrity === "require-manifest" ? "checked" : "skipped",
    source: bundle.source,
    current: undefined,
    loading: undefined,
    landed: false,
    failed: undefined,
    broken: undefined,
    refreshing: undefined,
    lastAttempt: undefined,
    lastRefusal: undefined,
    synthetic: new Map(),
  }));
  let engine: Engine | undefined;
  let lock: "exclusive" | "private" = "exclusive";
  let resetOnOpen: string | undefined;
  let prepared: Promise<PrepareResult> | undefined;
  let firstLoad: Promise<void> | undefined;
  let firstLoadFailed = false;
  /** Why the first load failed as a whole: the network could not be prepared, or its one bundle's load threw. */
  let refusal: string | undefined;
  /** That failure was the index's: its one bundle's first load could not be indexed. */
  let refusalIndex = false;
  /** The network could not be prepared (the cache folder, the lock, the store): no bundle was loaded. */
  let prepareFailed = false;
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

  /** Every bundle's first load threw, beyond one bundle: the network refuses, naming each bundle's reason (D75). */
  const everyFirstLoadFailed = (): boolean =>
    states.length > 1 && states.every((bundle) => bundle.failed !== undefined);

  /**
   * Why the network refuses as a whole, or undefined: it could not be prepared, or its one bundle's load threw
   * (`refusal`); its one bundle's index is broken (version 0's D39, D74); or every bundle's first load threw.
   */
  function refusingNow(): string | undefined {
    if (refusal !== undefined) return refusal;
    if (states.length === 1) {
      const only = states[0] as Held;
      return only.broken === undefined ? undefined : brokenRefusal(only.source.kind);
    }
    if (everyFirstLoadFailed())
      return states
        .map((bundle) => `${bundle.id}: ${(bundle.failed as Described).message}`)
        .join("; ");
    return undefined;
  }

  /** Whether the network's refusal is the index's: its one bundle's first load could not be indexed, or it is broken. */
  function refusingFromIndex(): boolean {
    if (refusal !== undefined) return refusalIndex;
    return states.length === 1 && (states[0] as Held).broken !== undefined;
  }

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
  const warnUnmatched = (bundle: Held, report: Report): void => {
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
  async function prepareDocs(bundle: Held): Promise<Prepared> {
    const loaded = await bundle.source.load();
    const next = await prepareFrom(bundle, loaded);
    if (next.kind === "fatal") noteRefusal(bundle, next, loaded);
    return next;
  }

  /** A refusal is kept for `status`; a tree reused from disk that the loader refuses is discarded, so the next load extracts it again. */
  function noteRefusal(bundle: Held, next: Prepared & { kind: "fatal" }, loaded: Loaded): void {
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

  async function prepareFrom(bundle: Held, loaded: Loaded): Promise<Prepared> {
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

  /** The bundle's part of the index is in line with what it serves again: it is no longer broken. */
  function mended(bundle: Held): void {
    if (bundle.broken === undefined) return;
    bundle.broken = undefined;
    deps.log.info("index.mended", { bundle: bundle.id });
  }

  /** The bundle's part of the index could not be brought in line: refused alone until a later write succeeds (D39). */
  function brokenBy(bundle: Held, error: unknown): void {
    bundle.broken = brokenSentence(bundle.source.kind);
    deps.log.error("index.broken", { bundle: bundle.id, detail: (error as Error).message });
  }

  /** Indexes one bundle's next generation and swaps it in; a failure re-aligns that bundle's part of the index (D39). */
  function commit(bundle: Held, next: Prepared & { kind: "docs" }): Promise<Generation> {
    return underGate(async (live) => {
      let index: IndexResult;
      try {
        index = await live.index(bundle.id, next.docs);
      } catch (error) {
        // The engine may now hold part of the new tree while the bundle serves its old catalog: put them back
        // together. If that fails too, this bundle alone is refused until a later write of it succeeds (D39).
        if (bundle.current !== undefined) {
          try {
            await live.index(bundle.id, pagesOf(bundle.current));
            mended(bundle);
          } catch (again) {
            brokenBy(bundle, again);
          }
        }
        throw engineFailure(error);
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
      bundle.failed = undefined;
      mended(bundle);
      // A tree reused from disk (the first-load fallback) does not answer the refusal that made it necessary.
      if (next.fresh !== false) bundle.lastRefusal = undefined;
      if (generation.published !== undefined) bundle.source.served?.(generation.published.commit);
      return generation;
    });
  }

  /** Puts a broken bundle's part of the index back in line with what it serves, its pages or none; never throws. */
  async function realign(bundle: Held): Promise<void> {
    try {
      await underGate((live) => live.index(bundle.id, pagesOf(bundle.current)));
      mended(bundle);
    } catch (error) {
      brokenBy(bundle, error);
    }
  }

  const fatalGeneration = (bundle: Held, next: Prepared & { kind: "fatal" }): Generation => ({
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
   * index, where an earlier run may have left them (D75): an empty generation behind its link, a scoped update. When
   * that fails, the bundle is index-broken (D39, per bundle).
   */
  async function publishRefused(bundle: Held, generation: Generation): Promise<void> {
    bundle.current = generation;
    try {
      await underGate((live) => live.drop(bundle.id));
      mended(bundle);
    } catch (error) {
      brokenBy(bundle, error);
    }
  }

  /** A generation that serves nothing and says why, without a load of its own; built once per rule and sentence. */
  function synthetic(bundle: Held, rule: RefusalRule, detail: string): Generation {
    const key = `${rule}\n${detail}`;
    const known = bundle.synthetic.get(key);
    if (known !== undefined) return known;
    const now = deps.clock();
    const { catalog, report } = loadBundle(
      bundle.id,
      [],
      { ...bundle.load, walkFatal: { path: "", rule, detail } },
      now,
    );
    const generation: Generation = {
      catalog,
      report,
      index: EMPTY_INDEX,
      loadedAt: now,
      dev: bundle.load.dev,
      integrity: bundle.integrity,
    };
    bundle.synthetic.set(key, generation);
    return generation;
  }

  /**
   * What a tool call reads of a bundle: the refusal of a broken bundle; else what it serves, or the refusal published
   * for it; else why it serves nothing yet (its one load threw, the network was not prepared, or it is still loading).
   */
  function viewOf(bundle: Held): Generation {
    if (bundle.broken !== undefined) return synthetic(bundle, INDEX_BROKEN, bundle.broken);
    if (bundle.current !== undefined) return bundle.current;
    if (bundle.failed !== undefined) return synthetic(bundle, LOAD_FAILED, bundle.failed.message);
    if (prepareFailed) return synthetic(bundle, LOAD_FAILED, NOT_PREPARED);
    return synthetic(bundle, LOADING, STILL_LOADING);
  }

  /** One bundle's first load: load, publish; a loader refusal falls back to the tree the source last served (D43). */
  async function loadFirst(bundle: Held): Promise<void> {
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
   * One bundle's first load, published as it lands. Beyond one bundle, a load that throws (its source, or its index)
   * is published as refused (`load-failed`), its sentence the failure's own, so the network serves the others and
   * `status` names the reason (D75); a network of one bundle refuses as a whole instead, as version 0 did.
   */
  async function firstLoadOf(bundle: Held): Promise<void> {
    try {
      await loadFirst(bundle);
    } catch (error) {
      const described = error as Described;
      bundle.lastAttempt = { at: deps.clock(), outcome: "failed" };
      bundle.failed = described;
      deps.log.error("load.failed", {
        bundle: bundle.id,
        error: described.message,
        ...(typeof described.detail === "string" ? { detail: described.detail } : {}),
      });
      if (states.length === 1) throw error;
      const now = deps.clock();
      const { catalog, report } = loadBundle(
        bundle.id,
        [],
        { ...bundle.load, walkFatal: { path: "", rule: LOAD_FAILED, detail: described.message } },
        now,
      );
      await publishRefused(
        bundle,
        fatalGeneration(bundle, { kind: "fatal", catalog, report, now }),
      );
      if (everyFirstLoadFailed()) {
        // Nothing loaded: the network refuses, naming each bundle's reason, as a one-bundle server does.
        const details = states
          .filter((held) => typeof held.failed?.detail === "string")
          .map((held) => `${held.id}: ${held.failed?.detail}`);
        deps.log.error("serve.refusing", {
          problem: refusingNow(),
          ...(details.length > 0 ? { detail: details.join("; ") } : {}),
        });
      }
    } finally {
      bundle.landed = true;
    }
  }

  /**
   * Beyond one bundle, the first load answers once every bundle's load has landed or the deadline has passed,
   * whichever comes first; a load still running goes on, and publishes its bundle when it lands (D75).
   */
  async function landedOrDeadline(loads: readonly Promise<void>[]): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(
        () => resolve("deadline"),
        deps.firstLoadDeadlineMs ?? FIRST_LOAD_DEADLINE_MS,
      );
      timer.unref();
    });
    try {
      const first = await Promise.race([
        Promise.all(loads).then(() => "landed" as const),
        deadline,
      ]);
      if (first === "deadline") {
        for (const bundle of states.filter((held) => !held.landed))
          deps.log.warn("load.slow", {
            bundle: bundle.id,
            detail:
              "its first load has not landed by the deadline; the network answers without it until it does",
          });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  function start(): void {
    if (firstLoad !== undefined || closed) return;
    firstLoad = (async () => {
      try {
        try {
          await prepare();
        } catch (error) {
          prepareFailed = true;
          throw error;
        }
        prepareFailed = false;
        const loads = states.map((bundle) => {
          bundle.landed = false;
          const loading = firstLoadOf(bundle);
          bundle.loading = loading;
          return loading;
        });
        if (states.length === 1) await Promise.all(loads);
        else await landedOrDeadline(loads);
      } catch (error) {
        refusal = (error as Error).message;
        refusalIndex = (error as Described).index === true;
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

  /** Every bundle as a tool call reads it, in the configuration's order. */
  const network = (): Network => ({
    bundles: states.map((bundle) => ({ id: bundle.id, generation: viewOf(bundle) })),
  });

  async function ready(): Promise<Network> {
    const why = refusingNow();
    if (why !== undefined) throw new Error(why);
    start();
    if (firstLoad === undefined) throw new Error("the runtime is shut down");
    await firstLoad;
    // The load just awaited may itself have made the network refuse (every bundle failed, or the one broke).
    const after = refusingNow();
    if (after !== undefined) throw new Error(after);
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
  function bundleNamed(id: string | undefined): Held {
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

  /** A first load's outcome for one bundle, as a refresh reports it. */
  function outcomeOf(bundle: Held): RefreshOutcome {
    if (bundle.broken !== undefined) return { outcome: "failed", error: bundle.broken };
    const current = bundle.current;
    if (current === undefined)
      return { outcome: "failed", error: bundle.failed?.message ?? "the bundle did not load" };
    const fatal = current.report.fatal;
    if (fatal === undefined) return { outcome: "swapped", generation: current };
    return fatal.rule === LOAD_FAILED
      ? { outcome: "failed", error: fatal.detail }
      : { outcome: "fatal", report: current.report };
  }

  function refresh(id?: string): Promise<RefreshOutcome> {
    if (closed) return Promise.reject(new Error("the runtime is shut down"));
    let bundle: Held;
    try {
      bundle = bundleNamed(id);
    } catch (error) {
      return Promise.reject(error);
    }
    const inFlight = bundle.refreshing;
    if (inFlight !== undefined) return inFlight;
    const refreshing = (async (): Promise<RefreshOutcome> => {
      let committing = false;
      try {
        if (firstLoad === undefined) throw new Error("the first load has not started");
        if (firstLoadFailed) {
          // A first load that failed as a whole (the network could not be prepared, or its one bundle's load threw)
          // is tried again from the start.
          firstLoadFailed = false;
          firstLoad = undefined;
          start();
          if (firstLoad === undefined) throw new Error("the runtime is shut down");
          await firstLoad;
          refusal = undefined;
          refusalIndex = false;
          return outcomeOf(bundle);
        }
        await firstLoad;
        // The bundle's own first load, still running: this refresh is that load.
        if (!bundle.landed && bundle.loading !== undefined) {
          await bundle.loading;
          return outcomeOf(bundle);
        }
        const next = await prepareDocs(bundle);
        if (next.kind === "fatal") {
          bundle.lastAttempt = { at: deps.clock(), outcome: "fatal" };
          deps.log.error("refresh.fatal", {
            bundle: bundle.id,
            rule: next.report.fatal?.rule,
            path: next.report.fatal?.path,
            detail: next.report.fatal?.detail,
          });
          // The previous generation stays; a broken bundle's part of the index is put back in line with it (D39).
          if (bundle.broken !== undefined) await realign(bundle);
          return { outcome: "fatal", report: next.report };
        }
        committing = true;
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
        // A load that threw before any write: a broken bundle's index is put back in line all the same (D39).
        if (!committing && bundle.broken !== undefined && engine !== undefined)
          await realign(bundle);
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
          fatal: viewOf(bundle).report.fatal !== undefined,
        };
        if (bundle.lastAttempt !== undefined) row.lastAttempt = bundle.lastAttempt;
        if (bundle.lastRefusal !== undefined) row.lastRefusal = bundle.lastRefusal;
        const poller = extra.pollers?.[bundle.id];
        if (poller !== undefined) row.poller = poller;
        return row;
      }),
    };
    const why = refusingNow();
    if (why !== undefined) {
      result.refusing = why;
      if (refusingFromIndex()) result.refusingIndex = true;
    }
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
        if (bundle.loading !== undefined) await bundle.loading.catch(() => undefined);
      for (const bundle of states)
        if (bundle.refreshing !== undefined) await bundle.refreshing.catch(() => undefined);
      await whenNoneRequested();
      if (engine !== undefined) await engine.close();
    })();
    return closing;
  }

  return { start, ready, snapshot: network, lease, refresh, status, shutdown };
}
