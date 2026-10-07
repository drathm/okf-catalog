import type { Report } from "../bundle/model.js";
import type { Engine, IndexResult } from "../search/engine.js";
import type { Catalog } from "./model.js";

/** One loaded and indexed state of the bundle: what every tool call reads, whole, for its duration. */
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

export type RefreshOutcome =
  | { outcome: "swapped"; generation: Generation }
  /** The reloaded bundle was refused; the previous generation stays. */
  | { outcome: "fatal"; report: Report }
  /** Something threw; the previous generation stays. The index is re-aligned with it when that is possible; when it is not, the runtime refuses until a refresh succeeds. */
  | { outcome: "failed"; error: string };

export interface RuntimeStatus {
  lock: "exclusive" | "private";
  /** Whether a generation is published; false before the first load lands or while it keeps failing. */
  loaded: boolean;
  lastAttempt?: { at: Date; outcome: "swapped" | "fatal" | "failed" };
  /** The fixed sentence every tool answers with while the server cannot serve. */
  refusing?: string;
  /** Why the engine rebuilt its store at open, when it did (D48). */
  resetOnOpen?: string;
  /** The process holding the company lock, when this one runs in the private fallback; null when not applicable. */
  lockOwner?: LockOwnerStatus | null;
  /** The poller's state, for a repository source. */
  poller?: PollerStatus | null;
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
  /** Resolves when the first generation is published; rejects when the server is refusing. */
  ready(): Promise<Generation>;
  /** Runs `fn` against the current generation and its engine, holding them for the call's duration. */
  lease<T>(fn: (generation: Generation, engine: Engine) => Promise<T>): Promise<T>;
  refresh(): Promise<RefreshOutcome>;
  status(): RuntimeStatus;
  shutdown(): Promise<void>;
}
