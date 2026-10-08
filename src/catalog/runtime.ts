import type { Report } from "../bundle/model.js";
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

/** One bundle of the network as a tool call reads it: its id and its current generation. */
export interface ServedBundle {
  id: string;
  generation: Generation;
}

/**
 * The network as every tool call reads it, whole, for its duration (D72): each configured bundle, in the
 * configuration's order, at its current generation; a bundle that is refused, or whose source failed at the first
 * load, is there with a generation whose report carries the refusal.
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
  /** Whether that generation is itself a refusal (D39), which a poller tick keeps retrying. */
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
  /** The fixed sentence every tool answers with while the network cannot serve. */
  refusing?: string;
  /** Why the engine rebuilt its store at open, when it did (D48). */
  resetOnOpen?: string;
  /** The process holding the network's lock, when this one runs in the private fallback; null when not applicable. */
  lockOwner?: LockOwnerStatus | null;
  /** Each bundle's state, in the configuration's order. */
  bundles: BundleRuntimeStatus[];
}

/** Plain values the tools need from the configuration, so the adapter never imports the configuration module. */
export interface ToolOptions {
  company: string;
  /** The source as written in the configuration, never a cache path. */
  source: string;
  dev: boolean;
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
  /** Runs `fn` against the network's current generations and its engine, holding them for the call's duration. */
  lease<T>(fn: (network: Network, engine: Engine) => Promise<T>): Promise<T>;
  /** Refreshes one bundle; the id may be left out only when the network holds one bundle. */
  refresh(bundle?: string): Promise<RefreshOutcome>;
  status(): RuntimeStatus;
  shutdown(): Promise<void>;
}
