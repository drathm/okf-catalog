import type { Report } from "../bundle/model.js";
import type { Engine, IndexResult } from "../search/engine.js";
import type { Catalog } from "./model.js";

/** One loaded and indexed state of the bundle: what every tool call reads, whole, for its duration. */
export interface Generation {
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
  /** Something threw; the previous generation stays, and the index was re-aligned with it. */
  | { outcome: "failed"; error: string };

export interface RuntimeStatus {
  lock: "exclusive" | "private";
  lastAttempt?: { at: Date; outcome: RefreshOutcome["outcome"] };
  /** Set when the server is refusing every tool because its configuration or environment is wrong; the text names the fix. */
  refusing?: string;
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

/** The runtime as the MCP adapter sees it. The composition layer implements it. */
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
