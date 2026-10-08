import type { RefusalRule, Report } from "../bundle/model.js";
import type { Engine, IndexResult } from "../search/engine.js";
import type { Catalog } from "./model.js";

/** Where a repository bundle's generation came from. */
export interface PublishedInfo {
  /** The fetched commit of the published branch. */
  commit: string;
  /** When that fetch succeeded. */
  fetchedAt: Date;
}

export interface LockOwnerStatus {
  pid: number;
  startedAt: string;
  /** Whether that process answers the signal-zero test when `status` runs. */
  alive: boolean;
}

export type PollerOutcome = "unchanged" | "refreshed" | "failed" | "gone" | "skipped";

export interface PollerStatus {
  intervalMs: number;
  lastTick?: Date;
  lastOutcome?: PollerOutcome;
}

/** One loaded and indexed state of one bundle. A refused bundle has one too, whose report carries the refusal. */
export interface Generation {
  /** For a repository source: the commit this generation came from, and when it was fetched. */
  published?: PublishedInfo;
  catalog: Catalog;
  report: Report;
  index: IndexResult;
  loadedAt: Date;
  dev: boolean;
  integrity: "checked" | "skipped";
}

/** The rule of a bundle whose first load threw while another bundle loaded (D75). */
export const LOAD_FAILED: RefusalRule = "load-failed";
/** The rule of a bundle whose part of the index could not be brought in line with what it serves (D39, per bundle). */
export const INDEX_BROKEN: RefusalRule = "index-broken";
/** The rule of a bundle whose first load had not landed when the network began to answer (D75). */
export const LOADING: RefusalRule = "loading";

/**
 * How a bundle stands for a tool call: served; refused by the loader; or one of the three states the runtime
 * publishes as a refusal of its own (a first load that threw, an index that could not be brought in line, a first
 * load still running).
 */
export type ServingState = "serving" | "refused" | "load-failed" | "index-broken" | "loading";

/** A generation's standing: its refusal's rule names the runtime's own states; any other refusal is the loader's. */
export function servingStateOf(generation: Generation): ServingState {
  const rule = generation.report.fatal?.rule;
  if (rule === undefined) return "serving";
  if (rule === "load-failed" || rule === "index-broken" || rule === "loading") return rule;
  return "refused";
}

/** One bundle of the network as a tool call reads it: its id and its current generation. */
export interface ServedBundle {
  id: string;
  generation: Generation;
}

/**
 * The network as every tool call reads it, whole, for its duration (D72): each configured bundle, in the
 * configuration's order, at its current generation; a bundle that is refused, whose first load failed or has not
 * landed, or whose part of the index is broken, is there with a generation whose report carries the refusal.
 */
export interface Network {
  bundles: readonly ServedBundle[];
}

/** One bundle's refresh. */
export type RefreshOutcome =
  | { outcome: "swapped"; generation: Generation }
  /** The reloaded bundle was refused; the previous generation stays. */
  | { outcome: "fatal"; report: Report }
  /** Something threw; the previous generation stays. The index is re-aligned with it when that is possible; when it is not, the runtime refuses until a refresh succeeds. */
  | { outcome: "failed"; error: string };

export interface LastRefusal {
  /** The fetched commit, for a repository source. */
  commit?: string;
  rule: string;
  path: string;
  detail: string;
}

/** One bundle's part of the runtime's state (D75). */
export interface BundleRuntimeStatus {
  id: string;
  /** Whether the bundle has a generation published, a refusal included. */
  loaded: boolean;
  /** Whether what it serves is a refusal (the loader's, a failed first load, a broken index), which a poller tick keeps retrying. */
  fatal: boolean;
  /** The last commit or load the loader refused, and why; a fixed publish clears it. */
  lastRefusal?: LastRefusal;
  lastAttempt?: { at: Date; outcome: "swapped" | "fatal" | "failed" };
  /** The bundle's poller, for a repository bundle; null when it has none. */
  poller?: PollerStatus | null;
}

export interface RuntimeStatus {
  lock: "exclusive" | "private";
  /** Whether every bundle has a generation published; false before the first load lands or while it keeps failing. */
  loaded: boolean;
  /**
   * The fixed sentence every tool answers with while the network cannot serve: it could not be prepared, its one
   * bundle failed or is broken, or every bundle's first load threw; `status` beyond one bundle still answers.
   */
  refusing?: string;
  /**
   * Set when that refusal is the index's, not the configuration's or what the network needs to start: its one
   * bundle's part of the index could not be brought in line, or its first load could not be indexed (D39, D74). The
   * tools then say what refuses rather than ask for the configuration to be fixed, which would not fix it.
   */
  refusingIndex?: true;
  /** Why the engine rebuilt its store at open, when it did (D48). */
  resetOnOpen?: string;
  /** The process holding the network's lock, when this one runs in the private fallback; null when not applicable. */
  lockOwner?: LockOwnerStatus | null;
  /** Each bundle's state, in the configuration's order. */
  bundles: BundleRuntimeStatus[];
}

/** One bundle as the configuration names it, for `status`: its id, its source as written (never a cache path), its kind. */
export interface BundleOption {
  id: string;
  source: string;
  sourceKind: "local" | "git";
}

/** Plain values the tools need from the configuration, so the adapter never imports the configuration module. */
export interface ToolOptions {
  /** The network's name: a `company:` file's company (D-G). */
  network: string;
  /** Every bundle of the network, in the configuration's order. */
  bundles: readonly BundleOption[];
  limitDefault: number;
  resultBudget: number;
}

/** The runtime as the MCP adapter sees it. The composition layer implements it.
 * Never call `refresh()` from inside a `lease` callback: a swap waits for the active leases and the lease would
 * wait for the swap.
 */
export interface Runtime {
  /** Begins the first load if it has not begun; idempotent. The adapter calls it when a connection completes `initialize`. */
  start?(): void;
  /** Resolves with the network as it stands once every bundle's first load has run; rejects while it refuses. */
  ready(): Promise<Network>;
  /**
   * The network as it stands now, without waiting and even while it refuses: each bundle's generation, or the
   * refusal that says why it serves nothing. What `status` answers with beyond one bundle while the network refuses.
   */
  snapshot(): Network;
  /** Runs `fn` against the network's current generations and its engine, holding them for the call's duration. */
  lease<T>(fn: (network: Network, engine: Engine) => Promise<T>): Promise<T>;
  /** Refreshes one bundle; the id may be left out only when the network holds one bundle. */
  refresh(bundle?: string): Promise<RefreshOutcome>;
  status(): RuntimeStatus;
  shutdown(): Promise<void>;
}
